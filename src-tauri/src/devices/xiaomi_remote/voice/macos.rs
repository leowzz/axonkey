use super::atvv::AtvvDecoder;
use crate::audio_service::signal_monitor::{now_ms, NativeMonitorSnapshot, SignalMonitor};
use crate::audio_service::{clamp_gain_db, diagnostics::AudioDiagnostics, AudioServiceStatus};
use crate::devices::cmiot_a15::recording::RecordingMode;
use crate::devices::tcl_rc902v::atvv::{
    hex_bytes, upsample_8k_to_16k, AtvvSession as Rc902vAtvvSession,
    SessionAction as Rc902vSessionAction, SessionEvent as Rc902vSessionEvent,
};
use std::{
    ffi::{c_char, c_void, CString},
    sync::{
        atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const EVENT_AUDIO_PACKET: i32 = 1;
const EVENT_CODEC_SYNC: i32 = 2;
const EVENT_SESSION_START: i32 = 3;
const EVENT_SESSION_STOP: i32 = 4;
const EVENT_RECEIVED: i32 = 5;
const EVENT_REJECTED: i32 = 6;
const EVENT_READ_ERROR: i32 = 7;
const EVENT_RENDERED: i32 = 8;
const EVENT_DIAGNOSTICS: i32 = 9;
const EVENT_LOG: i32 = 10;
const EVENT_CONTROL: i32 = 11;
const EVENT_OUTPUT_RESET: i32 = 12;
const EVENT_RSSI: i32 = 13;
const EVENT_CONNECTION_RESET: i32 = 14;
const EVENT_NEGOTIATE: i32 = 15;
const EVENT_TIMER_TICK: i32 = 16;
const EVENT_STOPPING: i32 = 17;

type EventCallback = unsafe extern "C" fn(*mut c_void, i32, *const u8, usize, i32, i32);

#[repr(C)]
struct NativeCallbacks {
    context: *mut c_void,
    on_event: EventCallback,
}

extern "C" {
    fn axonkey_macos_audio_create(
        callbacks: *const NativeCallbacks,
        external_input: bool,
        target_address: *const c_char,
    ) -> *mut c_void;
    fn axonkey_macos_audio_set_recording(bridge: *mut c_void, recording: bool);
    fn axonkey_macos_audio_set_rc902_mode(bridge: *mut c_void, rc902_mode: bool);
    fn axonkey_macos_audio_send_command(
        bridge: *mut c_void,
        bytes: *const u8,
        length: usize,
    ) -> bool;
    fn axonkey_macos_audio_rc902_ready(bridge: *mut c_void);
    fn axonkey_macos_audio_rc902_session_state(bridge: *mut c_void, active: bool, session_id: u8);
    fn axonkey_macos_audio_rc902_error(bridge: *mut c_void, message: *const c_char);
    fn axonkey_macos_audio_start(bridge: *mut c_void);
    fn axonkey_macos_audio_refresh(bridge: *mut c_void);
    fn axonkey_macos_audio_restart(bridge: *mut c_void) -> bool;
    fn axonkey_macos_audio_stop(bridge: *mut c_void);
    fn axonkey_macos_audio_destroy(bridge: *mut c_void);
    fn axonkey_macos_audio_driver_installed() -> bool;
    fn axonkey_macos_audio_state(bridge: *mut c_void) -> i32;
    fn axonkey_macos_audio_bluetooth_connected(bridge: *mut c_void) -> bool;
    fn axonkey_macos_audio_monitor(
        bridge: *mut c_void,
        snapshot: *mut NativeMonitorSnapshot,
    ) -> bool;
    fn axonkey_macos_audio_forwarding(bridge: *mut c_void) -> bool;
    fn axonkey_macos_audio_copy_error(
        bridge: *mut c_void,
        buffer: *mut c_char,
        capacity: usize,
    ) -> usize;
    fn axonkey_macos_audio_enqueue(bridge: *mut c_void, samples: *const i16, count: usize) -> bool;
    fn axonkey_macos_audio_set_stretch_compensation(bridge: *mut c_void, enabled: bool) -> bool;
    fn axonkey_macos_audio_set_gain_db(bridge: *mut c_void, gain_db: f32);
}

struct Shared {
    recording_indicator: crate::recording_overlay::RecordingSource,
    a15: bool,
    rc902: bool,
    rc902_label: &'static str,
    a15_connected: AtomicBool,
    a15_recording: AtomicBool,
    a15_received: AtomicBool,
    event_version: AtomicU64,
    diagnostics: AudioDiagnostics,
    bridge: AtomicPtr<c_void>,
    output_enabled: AtomicBool,
    decoder: Mutex<AtvvDecoder>,
    rc902v_session: Mutex<Rc902vAtvvSession>,
    rc902v_resample_prev: Mutex<Option<i16>>,
    #[cfg(test)]
    rc902_sent_commands: Mutex<Vec<Vec<u8>>>,
    signal_monitor: Mutex<SignalMonitor>,
}

pub struct AudioService {
    shared: Arc<Shared>,
    callback_context: *const Shared,
}

unsafe impl Send for AudioService {}
unsafe impl Sync for AudioService {}

impl AudioService {
    pub fn signal_snapshot(&self, after: Option<u64>, clear: bool) -> serde_json::Value {
        let generation = {
            let mut monitor = self.shared.signal_monitor.lock().unwrap();
            if clear {
                monitor.clear();
            }
            monitor.poll(now_ms());
            monitor.generation
        };
        // Never hold the monitor mutex while dispatching to the native main thread.
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        let mut sample = NativeMonitorSnapshot::default();
        let connected =
            !bridge.is_null() && unsafe { axonkey_macos_audio_monitor(bridge, &mut sample) };
        let now = now_ms();
        let mut monitor = self.shared.signal_monitor.lock().unwrap();
        // Ignore a read overtaken by clearing/closing the monitor.
        if monitor.generation == generation && !bridge.is_null() {
            monitor.observe(now, sample);
        }
        monitor.snapshot(now, connected, if clear { None } else { after })
    }

    pub fn stop_signal_monitor(&self) {
        self.shared.signal_monitor.lock().unwrap().clear();
    }

    pub fn level(&self) -> crate::audio_service::AudioLevel {
        self.shared.diagnostics.level()
    }

    pub fn start() -> Self {
        Self::create(false, false, "RC003", None)
    }

    pub fn start_for(target_identity: Option<String>) -> Self {
        // An instance without an address must not fall back to an arbitrary RC003.
        let target = CString::new(target_identity.unwrap_or_default()).unwrap_or_default();
        Self::create(false, false, "RC003", Some(target))
    }

    pub fn start_rc902(kind: &str, target_identity: Option<String>) -> Self {
        let label = if kind == "tclRc902n" {
            "TCL RC902N"
        } else {
            "TCL RC902V"
        };
        let target = CString::new(target_identity.unwrap_or_default()).unwrap_or_default();
        Self::create(false, true, label, Some(target))
    }

    pub fn start_a15() -> Self {
        Self::create(true, false, "A15", None)
    }

    fn create(
        a15: bool,
        rc902: bool,
        rc902_label: &'static str,
        target_address: Option<CString>,
    ) -> Self {
        log::info!(target: "axonkey::audio", "Starting macOS audio service");
        let shared = Arc::new(Shared {
            recording_indicator: Default::default(),
            a15,
            rc902,
            rc902_label,
            a15_connected: AtomicBool::new(false),
            a15_recording: AtomicBool::new(false),
            a15_received: AtomicBool::new(false),
            event_version: AtomicU64::new(0),
            diagnostics: AudioDiagnostics::default(),
            bridge: AtomicPtr::new(std::ptr::null_mut()),
            output_enabled: AtomicBool::new(false),
            decoder: Mutex::new(AtvvDecoder::default()),
            rc902v_session: Mutex::new(Rc902vAtvvSession::default()),
            rc902v_resample_prev: Mutex::new(None),
            #[cfg(test)]
            rc902_sent_commands: Mutex::new(Vec::new()),
            signal_monitor: Mutex::new(SignalMonitor::default()),
        });
        let callback_context = Arc::into_raw(Arc::clone(&shared));
        let callbacks = NativeCallbacks {
            context: callback_context.cast_mut().cast(),
            on_event: native_event_callback,
        };
        let bridge = unsafe {
            let bridge = axonkey_macos_audio_create(
                &callbacks,
                a15,
                target_address
                    .as_ref()
                    .map_or(std::ptr::null(), |address| address.as_ptr()),
            );
            if !bridge.is_null() && rc902 {
                axonkey_macos_audio_set_rc902_mode(bridge, true);
            }
            bridge
        };
        shared.bridge.store(bridge, Ordering::Release);
        if !bridge.is_null() {
            log::info!(target: "axonkey::audio", "macOS audio bridge created; output is fixed to MiRemoteV 2ch");
        } else {
            log::error!(target: "axonkey::audio", "Cannot create the macOS audio bridge");
        }
        Self {
            shared,
            callback_context,
        }
    }

    pub fn refresh(&self) {
        log::debug!(target: "axonkey::audio", "Refreshing macOS audio state");
        if !self.shared.output_enabled.load(Ordering::Acquire) {
            return;
        }
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_refresh(bridge) };
            self.sync_a15_recording(bridge);
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        let was_enabled = self.shared.output_enabled.swap(enabled, Ordering::AcqRel);
        if was_enabled == enabled {
            return;
        }
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            return;
        }
        if enabled {
            log::info!(target: "axonkey::audio", "Enabling macOS audio output: MiRemoteV 2ch");
            unsafe {
                axonkey_macos_audio_start(bridge);
                self.sync_a15_recording(bridge);
            };
        } else {
            log::info!(target: "axonkey::audio", "Disabling macOS audio output");
            unsafe { axonkey_macos_audio_stop(bridge) };
        }
    }

    pub fn restart(&self) -> Result<(), String> {
        if !self.shared.output_enabled.load(Ordering::Acquire) {
            return Err("设备语音服务未启用".into());
        }
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            return Err("无法连接 macOS 音频服务".into());
        }
        if unsafe { axonkey_macos_audio_restart(bridge) } {
            self.sync_a15_recording(bridge);
            Ok(())
        } else {
            Err(native_error(bridge)
                .unwrap_or_else(|| "未检测到 MiRemoteV 2ch，请安装驱动后重试".into()))
        }
    }

    pub fn pause(&self) {
        log::info!(target: "axonkey::audio", "Pausing macOS audio bridge");
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_stop(bridge) };
        }
    }

    pub fn resume(&self) {
        log::info!(target: "axonkey::audio", "Resuming macOS audio bridge");
        if !self.shared.output_enabled.load(Ordering::Acquire) {
            return;
        }
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe {
                axonkey_macos_audio_start(bridge);
                self.sync_a15_recording(bridge);
            };
        }
    }

    pub fn set_stretch_compensation(&self, enabled: bool) -> Result<(), String> {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            return Err("无法连接 macOS 音频服务".into());
        }
        if unsafe { axonkey_macos_audio_set_stretch_compensation(bridge, enabled) } {
            Ok(())
        } else {
            Err("请松开语音键，等待尾音结束后再切换补偿".into())
        }
    }

    pub fn set_gain_db(&self, gain: i16) -> Result<(), String> {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            log::error!(target: "axonkey::audio", "Cannot set audio gain because the macOS bridge is unavailable");
            return Err("无法连接 macOS 音频服务".into());
        }
        let gain_db = clamp_gain_db(gain);
        unsafe { axonkey_macos_audio_set_gain_db(bridge, f32::from(gain_db)) };
        Ok(())
    }

    pub fn status(&self) -> AudioServiceStatus {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            log::error!(target: "axonkey::audio", "Cannot read macOS audio status because the bridge is unavailable");
            return AudioServiceStatus {
                driver_installed: unsafe { axonkey_macos_audio_driver_installed() },
                state: "error".into(),
                error: Some("Cannot create the macOS audio bridge".into()),
                ..AudioServiceStatus::default()
            };
        }
        let state_code = unsafe { axonkey_macos_audio_state(bridge) };
        let mut status = AudioServiceStatus {
            driver_installed: unsafe { axonkey_macos_audio_driver_installed() },
            state: state_name(state_code).into(),
            bluetooth_connected: unsafe { axonkey_macos_audio_bluetooth_connected(bridge) },
            forwarding: unsafe { axonkey_macos_audio_forwarding(bridge) },
            output_ready: self.shared.output_enabled.load(Ordering::Acquire)
                && matches!(state_code, 3..=6),
            error: native_error(bridge),
            ..AudioServiceStatus::default()
        };
        if self.shared.a15 {
            status.bluetooth_connected = self.shared.a15_connected.load(Ordering::Acquire);
            status.received_data = self.shared.a15_received.load(Ordering::Acquire);
            status.event_version = self.shared.event_version.load(Ordering::Acquire);
            if state_code == 5 && !status.bluetooth_connected {
                status.state = "disconnected".into();
            }
        }
        status
    }

    fn sync_a15_recording(&self, bridge: *mut c_void) {
        if self.shared.a15 {
            unsafe {
                axonkey_macos_audio_set_recording(
                    bridge,
                    self.shared.a15_recording.load(Ordering::Acquire),
                );
            }
        }
    }

    pub(crate) fn set_a15_input_state(&self, connected: bool, recording: bool) {
        self.shared
            .a15_connected
            .store(connected, Ordering::Release);
        self.shared.recording_indicator.set(recording);
        if self.shared.a15_recording.swap(recording, Ordering::AcqRel) != recording {
            self.shared.a15_received.store(false, Ordering::Release);
            self.shared.event_version.fetch_add(1, Ordering::AcqRel);
            let bridge = self.shared.bridge.load(Ordering::Acquire);
            if !bridge.is_null() {
                unsafe { axonkey_macos_audio_set_recording(bridge, recording) };
            }
        }
    }

    pub(crate) fn push_a15_pcm(&self, samples: &[i16]) {
        if !self.shared.a15_recording.load(Ordering::Acquire) {
            return;
        }
        self.shared.a15_received.store(true, Ordering::Release);
        self.shared.diagnostics.received(40);
        self.shared.diagnostics.decoded(samples);
        if !self.shared.output_enabled.load(Ordering::Acquire) {
            return;
        }
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        let success = !bridge.is_null()
            && unsafe { axonkey_macos_audio_enqueue(bridge, samples.as_ptr(), samples.len()) };
        self.shared.diagnostics.scheduled(samples.len(), success);
    }

    pub(crate) fn set_recording_mode(&self, mode: RecordingMode) {
        if !self.shared.rc902 {
            return;
        }
        // Release rc902v_session before dispatching to the main-queue Obj-C bridge.
        let action = self
            .shared
            .rc902v_session
            .lock()
            .map(|mut session| session.set_recording_mode(mode, Instant::now()))
            .unwrap_or_default();
        apply_rc902v_action(&self.shared, action);
    }

    pub(crate) fn handle_voice_key_edge(&self, pressed: bool) {
        if !self.shared.rc902 || !self.shared.output_enabled.load(Ordering::Acquire) {
            return;
        }
        // Release rc902v_session before dispatching to the main-queue Obj-C bridge.
        let action = self
            .shared
            .rc902v_session
            .lock()
            .map(|mut session| session.on_voice_key_edge(pressed, Instant::now()))
            .unwrap_or_default();
        apply_rc902v_action(&self.shared, action);
    }
}

impl Drop for AudioService {
    fn drop(&mut self) {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_stop(bridge) };
        }
        let bridge = self
            .shared
            .bridge
            .swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_destroy(bridge) };
        }
        self.shared.recording_indicator.set(false);
        unsafe { drop(Arc::from_raw(self.callback_context)) };
    }
}

fn state_name(code: i32) -> &'static str {
    match code {
        0 => "stopped",
        1 => "driverMissing",
        2 => "bluetoothUnavailable",
        3 => "scanning",
        4 => "connecting",
        5 => "ready",
        6 => "forwarding",
        7 => "error",
        _ => "unknown",
    }
}

fn native_error(bridge: *mut c_void) -> Option<String> {
    let mut buffer = vec![0_i8; 512];
    let length =
        unsafe { axonkey_macos_audio_copy_error(bridge, buffer.as_mut_ptr(), buffer.len()) };
    if length == 0 {
        return None;
    }
    let bytes = buffer
        .iter()
        .take(length.min(buffer.len().saturating_sub(1)))
        .map(|value| *value as u8)
        .collect::<Vec<_>>();
    String::from_utf8(bytes)
        .ok()
        .filter(|value| !value.is_empty())
}

fn apply_rc902v_action(shared: &Shared, action: Rc902vSessionAction) {
    let label = shared.rc902_label;
    let bridge = shared.bridge.load(Ordering::Acquire);
    for command in action.tx_commands {
        log::info!(
            target: "axonkey::audio",
            "macOS {label} ATVV TX len={} hex={}",
            command.len(),
            hex_bytes(&command)
        );
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_send_command(bridge, command.as_ptr(), command.len()) };
        }
        #[cfg(test)]
        if bridge.is_null() {
            if let Ok(mut sent) = shared.rc902_sent_commands.lock() {
                sent.push(command);
            }
        }
    }

    for event in action.events {
        match event {
            Rc902vSessionEvent::Capabilities(caps) => {
                log::info!(
                    target: "axonkey::audio",
                    "macOS {label} CAPS_RESP: version=0x{:04x} codecs=0x{:02x} model=0x{:02x} frame_size={} extra=0x{:02x} vendor_len={}",
                    caps.version.wire_code(),
                    caps.codecs_mask,
                    caps.raw_model,
                    caps.frame_size,
                    caps.extra,
                    caps.vendor_data.len()
                );
                if !bridge.is_null() {
                    unsafe { axonkey_macos_audio_rc902_ready(bridge) };
                }
            }
            Rc902vSessionEvent::SessionStarted {
                stream_id,
                sample_rate,
            } => {
                if let Ok(mut prev) = shared.rc902v_resample_prev.lock() {
                    *prev = None;
                }
                shared.recording_indicator.set(true);
                log::info!(
                    target: "axonkey::audio",
                    "macOS {label} ATVV voice forwarding started: stream_id={stream_id} sample_rate={sample_rate}"
                );
                if !bridge.is_null() {
                    unsafe { axonkey_macos_audio_rc902_session_state(bridge, true, stream_id) };
                }
            }
            Rc902vSessionEvent::PcmChunk {
                sample_rate,
                samples,
            } => {
                let samples = if sample_rate == 8_000 {
                    shared
                        .rc902v_resample_prev
                        .lock()
                        .map(|mut prev| upsample_8k_to_16k(&samples, &mut prev))
                        .unwrap_or_default()
                } else {
                    samples
                };
                if samples.is_empty() {
                    continue;
                }
                shared.diagnostics.decoded(&samples);
                if let Ok(mut monitor) = shared.signal_monitor.lock() {
                    monitor.waveform(now_ms(), &samples);
                }
                let success = !bridge.is_null()
                    && unsafe {
                        axonkey_macos_audio_enqueue(bridge, samples.as_ptr(), samples.len())
                    };
                shared.diagnostics.scheduled(samples.len(), success);
            }
            Rc902vSessionEvent::SessionStopped { stream_id, reason } => {
                if let Ok(mut prev) = shared.rc902v_resample_prev.lock() {
                    *prev = None;
                }
                shared.recording_indicator.set(false);
                log::info!(
                    target: "axonkey::audio",
                    "macOS {label} ATVV voice forwarding stopped: stream_id={stream_id} reason=0x{reason:02x}"
                );
                if !bridge.is_null() {
                    unsafe { axonkey_macos_audio_rc902_session_state(bridge, false, stream_id) };
                }
            }
            Rc902vSessionEvent::Error(message) => {
                shared.recording_indicator.set(false);
                log::warn!(target: "axonkey::audio", "{message}");
                if !bridge.is_null() {
                    if let Ok(c_message) = CString::new(message) {
                        unsafe { axonkey_macos_audio_rc902_error(bridge, c_message.as_ptr()) };
                    }
                }
            }
            Rc902vSessionEvent::Disconnected => {
                if let Ok(mut prev) = shared.rc902v_resample_prev.lock() {
                    *prev = None;
                }
                shared.recording_indicator.set(false);
            }
        }
    }
}

unsafe extern "C" fn native_event_callback(
    context: *mut c_void,
    event: i32,
    data: *const u8,
    length: usize,
    value1: i32,
    value2: i32,
) {
    if context.is_null() {
        return;
    }
    let shared = &*(context.cast::<Shared>());
    match event {
        EVENT_NEGOTIATE => {
            if shared.rc902 {
                let action = shared
                    .rc902v_session
                    .lock()
                    .map(|mut session| session.begin_negotiation(Instant::now()))
                    .unwrap_or_default();
                apply_rc902v_action(shared, action);
            }
        }
        EVENT_TIMER_TICK => {
            if shared.rc902 {
                let action = shared
                    .rc902v_session
                    .lock()
                    .map(|mut session| session.poll_timers(Instant::now()))
                    .unwrap_or_default();
                apply_rc902v_action(shared, action);
            }
        }
        EVENT_STOPPING => {
            if shared.rc902 {
                let action = shared
                    .rc902v_session
                    .lock()
                    .map(|mut session| {
                        let mut out = session.abort_active_stream().unwrap_or_default();
                        let mut disconnected = session.disconnect();
                        out.tx_commands.append(&mut disconnected.tx_commands);
                        out.events.append(&mut disconnected.events);
                        out
                    })
                    .unwrap_or_default();
                apply_rc902v_action(shared, action);
            }
        }
        EVENT_AUDIO_PACKET if !data.is_null() && length > 0 => {
            let packet = std::slice::from_raw_parts(data, length);
            if shared.rc902 {
                let action = shared
                    .rc902v_session
                    .lock()
                    .map(|mut session| session.handle_audio(packet, Instant::now()))
                    .unwrap_or_default();
                apply_rc902v_action(shared, action);
                return;
            }
            let Ok(mut decoder) = shared.decoder.lock() else {
                shared.diagnostics.rejected();
                return;
            };
            let frames = decoder.append(packet, value1.max(1) as usize);
            shared
                .diagnostics
                .decoder_pending(decoder.pending_bytes(), 0);
            drop(decoder);
            let bridge = shared.bridge.load(Ordering::Acquire);
            for samples in frames {
                shared.diagnostics.decoded(&samples);
                // Bluetooth/decode callback, never the realtime audio render callback.
                if let Ok(mut monitor) = shared.signal_monitor.lock() {
                    monitor.waveform(now_ms(), &samples);
                }
                let success = !bridge.is_null()
                    && axonkey_macos_audio_enqueue(bridge, samples.as_ptr(), samples.len());
                shared.diagnostics.scheduled(samples.len(), success);
            }
        }
        EVENT_RSSI => {
            if let Ok(mut monitor) = shared.signal_monitor.lock() {
                monitor.rssi(now_ms(), value1, value2 != 0);
            }
        }
        EVENT_CONNECTION_RESET => {
            if shared.rc902 {
                let action = shared
                    .rc902v_session
                    .lock()
                    .map(|mut session| session.disconnect())
                    .unwrap_or_default();
                apply_rc902v_action(shared, action);
            }
            if !shared.a15 {
                shared.recording_indicator.set(false);
            }
            if let Ok(mut monitor) = shared.signal_monitor.lock() {
                monitor.disconnected();
            }
        }
        EVENT_CODEC_SYNC => {
            if !shared.rc902 {
                if let Ok(mut decoder) = shared.decoder.lock() {
                    shared
                        .diagnostics
                        .decoder_pending(0, decoder.pending_bytes());
                    decoder.synchronize(value1, value2);
                }
            }
        }
        EVENT_SESSION_START | EVENT_SESSION_STOP => {
            // A15 recording follows HID control even without a selected audio output.
            if !shared.a15 {
                shared.recording_indicator.set(event == EVENT_SESSION_START);
            }
            if !shared.rc902 {
                if let Ok(mut decoder) = shared.decoder.lock() {
                    shared
                        .diagnostics
                        .decoder_pending(0, decoder.pending_bytes());
                    decoder.reset_session();
                }
            }
            if let Ok(mut monitor) = shared.signal_monitor.lock() {
                monitor.session(event == EVENT_SESSION_START);
            }
            let state = if event == EVENT_SESSION_START {
                "started"
            } else {
                "stopped"
            };
            log::info!(target: "axonkey::audio", "macOS voice session {state}: session_id={value1}");
        }
        EVENT_RECEIVED => shared.diagnostics.received(value1.max(0) as usize),
        EVENT_REJECTED => shared.diagnostics.rejected(),
        EVENT_READ_ERROR => shared.diagnostics.read_error(),
        EVENT_RENDERED => shared.diagnostics.output(value1.max(0) as usize, 0, false),
        EVENT_CONTROL => {
            shared.diagnostics.control(value1 as u8);
            if shared.rc902 && !data.is_null() && length > 0 {
                let bytes = std::slice::from_raw_parts(data, length);
                log::info!(
                    target: "axonkey::audio",
                    "macOS {} ATVV CTL opcode=0x{:02x} len={} hex={}",
                    shared.rc902_label,
                    bytes[0],
                    bytes.len(),
                    hex_bytes(bytes)
                );
                let action = shared
                    .rc902v_session
                    .lock()
                    .map(|mut session| session.handle_control(bytes, Instant::now()))
                    .unwrap_or_default();
                apply_rc902v_action(shared, action);
            }
        }
        EVENT_OUTPUT_RESET => shared.diagnostics.discarded_buffers(value1.max(0) as usize),
        EVENT_DIAGNOSTICS | EVENT_LOG if !data.is_null() => {
            let message = String::from_utf8_lossy(std::slice::from_raw_parts(data, length));
            if event == EVENT_DIAGNOSTICS {
                if value1 & 2 != 0 {
                    shared.diagnostics.note_native_activity();
                }
                if let Some(report) = shared
                    .diagnostics
                    .report_macos(value1 & 1 != 0, Duration::from_millis(value2.max(0) as u64))
                {
                    log::info!(target: "axonkey::audio", "macOS {} audio diagnostics: {report} {message}", shared.rc902_label);
                }
            } else if value1 != 0 {
                log::warn!(target: "axonkey::audio", "{message}");
            } else {
                log::info!(target: "axonkey::audio", "{message}");
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_shared(a15: bool) -> Shared {
        Shared {
            recording_indicator: Default::default(),
            a15,
            rc902: false,
            rc902_label: "RC003",
            a15_connected: AtomicBool::new(false),
            a15_recording: AtomicBool::new(false),
            a15_received: AtomicBool::new(false),
            event_version: AtomicU64::new(0),
            diagnostics: AudioDiagnostics::default(),
            bridge: AtomicPtr::new(std::ptr::null_mut()),
            output_enabled: AtomicBool::new(false),
            decoder: Mutex::new(AtvvDecoder::default()),
            rc902v_session: Mutex::new(Rc902vAtvvSession::default()),
            rc902v_resample_prev: Mutex::new(None),
            rc902_sent_commands: Mutex::new(Vec::new()),
            signal_monitor: Mutex::new(SignalMonitor::default()),
        }
    }

    fn indicator_service(a15: bool) -> AudioService {
        let shared = Arc::new(test_shared(a15));
        AudioService {
            callback_context: Arc::into_raw(shared.clone()),
            shared,
        }
    }

    #[test]
    fn rc003_indicator_follows_sessions_disconnect_and_service_drop() {
        let service = indicator_service(false);
        let shared = service.shared.clone();
        for (event, expected) in [
            (EVENT_SESSION_START, true),
            (EVENT_SESSION_STOP, false),
            (EVENT_SESSION_START, true),
            (EVENT_CONNECTION_RESET, false),
            (EVENT_SESSION_START, true),
        ] {
            unsafe {
                native_event_callback(
                    service.callback_context.cast_mut().cast(),
                    event,
                    std::ptr::null(),
                    0,
                    0,
                    0,
                );
            }
            assert_eq!(shared.recording_indicator.is_active(), expected);
        }
        drop(service);
        assert!(!shared.recording_indicator.is_active());
    }

    #[test]
    fn a15_indicator_tracks_hid_even_without_audio_output() {
        let service = indicator_service(true);
        service.set_a15_input_state(true, true);
        assert!(service.shared.recording_indicator.is_active());
        for event in [EVENT_SESSION_STOP, EVENT_CONNECTION_RESET] {
            unsafe {
                native_event_callback(
                    service.callback_context.cast_mut().cast(),
                    event,
                    std::ptr::null(),
                    0,
                    0,
                    0,
                );
            }
            assert!(service.shared.recording_indicator.is_active());
        }
        service.set_a15_input_state(false, false);
        assert!(!service.shared.recording_indicator.is_active());
        service.set_a15_input_state(true, true);
        let shared = service.shared.clone();
        drop(service);
        assert!(!shared.recording_indicator.is_active());
    }

    #[test]
    fn native_packets_record_decode_and_enqueue_failure_separately() {
        let shared = test_shared(false);
        let context = (&shared as *const Shared).cast_mut().cast();
        let packet = [0x11; 120];
        unsafe {
            native_event_callback(context, EVENT_RECEIVED, std::ptr::null(), 0, 120, 0);
            native_event_callback(
                context,
                EVENT_AUDIO_PACKET,
                packet.as_ptr(),
                packet.len(),
                120,
                0,
            );
        }
        let report = shared
            .diagnostics
            .report_macos(true, Duration::from_secs(1))
            .unwrap();
        assert!(report.contains("rx_packets=1 rx_bytes=120"));
        assert!(report.contains("decoded_samples=240"));
        assert!(report.contains(
            "scheduled_samples=0 completed_buffers=0 rendered_samples=0 enqueue_failures=1"
        ));
    }

    #[test]
    fn partial_decoder_frames_are_accounted_on_sync_and_stop() {
        let shared = test_shared(false);
        let context = (&shared as *const Shared).cast_mut().cast();
        let packet = [0x11; 60];
        unsafe {
            native_event_callback(
                context,
                EVENT_AUDIO_PACKET,
                packet.as_ptr(),
                packet.len(),
                120,
                0,
            );
        }
        let report = shared
            .diagnostics
            .report_macos(true, Duration::from_secs(1))
            .unwrap();
        assert!(report.contains("decoded_samples=0"));
        assert!(report.contains("decoder_pending_bytes=60 decoder_discarded_bytes=0"));
        unsafe {
            native_event_callback(context, EVENT_CODEC_SYNC, std::ptr::null(), 0, 0, 0);
            native_event_callback(
                context,
                EVENT_AUDIO_PACKET,
                packet.as_ptr(),
                packet.len(),
                120,
                0,
            );
            native_event_callback(context, EVENT_SESSION_STOP, std::ptr::null(), 0, 0, 0);
        }
        let report = shared
            .diagnostics
            .report_macos(false, Duration::from_secs(1))
            .unwrap();
        assert!(report.contains("decoder_pending_bytes=0 decoder_discarded_bytes=120"));
        assert!(report.contains("decoded_samples=0"));
    }

    #[test]
    fn native_telemetry_does_not_take_the_decoder_lock() {
        let shared = test_shared(false);
        let context = (&shared as *const Shared).cast_mut().cast();
        let _guard = shared.decoder.lock().unwrap();
        unsafe {
            native_event_callback(context, EVENT_READ_ERROR, std::ptr::null(), 0, 0, 0);
            native_event_callback(context, EVENT_RENDERED, std::ptr::null(), 0, 240, 0);
            native_event_callback(context, EVENT_OUTPUT_RESET, std::ptr::null(), 0, 2, 0);
        }
        let report = shared
            .diagnostics
            .report_macos(false, Duration::from_secs(1))
            .unwrap();
        assert!(report.contains("completed_buffers=1 rendered_samples=240"));
        assert!(report.contains("notification_read_errors=1"));
        assert!(report.contains("discarded_pending_buffers=2"));
    }

    #[test]
    fn rc902_on_request_hold_and_click_toggle_drive_atvv_commands() {
        let mut base = test_shared(false);
        base.rc902 = true;
        base.rc902_label = "TCL RC902V";
        base.output_enabled.store(true, Ordering::Release);
        let shared = Arc::new(base);
        let service = AudioService {
            callback_context: Arc::into_raw(shared.clone()),
            shared: shared.clone(),
        };
        let context = service.callback_context.cast_mut().cast();

        let caps = [0x0b_u8, 0x01, 0x00, 0x02, 0x00, 0x00, 0xa0, 0x01, 0x00];
        unsafe {
            native_event_callback(context, EVENT_NEGOTIATE, std::ptr::null(), 0, 0, 0);
            native_event_callback(context, EVENT_CONTROL, caps.as_ptr(), caps.len(), 0x0b, 0);
        }
        assert_eq!(
            std::mem::take(&mut *shared.rc902_sent_commands.lock().unwrap()),
            vec![vec![0x0a, 0x01, 0x00, 0x00, 0x03, 0x00]]
        );

        // Hold mode: START_SEARCH + press -> MIC_OPEN([0x0c, 0x00]) -> AUDIO_START -> release sends MIC_CLOSE(0).
        service.set_recording_mode(RecordingMode::Hold);
        let start_search = [0x08_u8];
        let start_stream = [0x04_u8, 0x00, 0x02, 0x00];
        unsafe {
            native_event_callback(
                context,
                EVENT_CONTROL,
                start_search.as_ptr(),
                start_search.len(),
                0x08,
                0,
            );
        }
        service.handle_voice_key_edge(true);
        assert_eq!(
            std::mem::take(&mut *shared.rc902_sent_commands.lock().unwrap()),
            vec![vec![0x0c, 0x00]]
        );
        unsafe {
            native_event_callback(
                context,
                EVENT_CONTROL,
                start_stream.as_ptr(),
                start_stream.len(),
                0x04,
                0,
            );
        }
        assert!(shared.recording_indicator.is_active());
        service.handle_voice_key_edge(false);
        assert!(!shared.recording_indicator.is_active());
        assert_eq!(
            std::mem::take(&mut *shared.rc902_sent_commands.lock().unwrap()),
            vec![vec![0x0d, 0x00]]
        );
        let stop_ack = [0x00_u8, 0x00];
        unsafe {
            native_event_callback(
                context,
                EVENT_CONTROL,
                stop_ack.as_ptr(),
                stop_ack.len(),
                0x00,
                0,
            );
        }

        // Click mode: 1st press + release keeps recording; 2nd press sends MIC_CLOSE(0).
        service.set_recording_mode(RecordingMode::Click);
        service.handle_voice_key_edge(true);
        unsafe {
            native_event_callback(
                context,
                EVENT_CONTROL,
                start_search.as_ptr(),
                start_search.len(),
                0x08,
                0,
            );
            native_event_callback(
                context,
                EVENT_CONTROL,
                start_stream.as_ptr(),
                start_stream.len(),
                0x04,
                0,
            );
        }
        assert_eq!(
            std::mem::take(&mut *shared.rc902_sent_commands.lock().unwrap()),
            vec![vec![0x0c, 0x00]]
        );
        service.handle_voice_key_edge(false);
        assert!(shared.recording_indicator.is_active());
        assert!(shared.rc902_sent_commands.lock().unwrap().is_empty());

        service.handle_voice_key_edge(true);
        assert!(!shared.recording_indicator.is_active());
        assert_eq!(
            std::mem::take(&mut *shared.rc902_sent_commands.lock().unwrap()),
            vec![vec![0x0d, 0x00]]
        );
    }

    #[test]
    fn worker_thread_audio_calls_complete_while_joining_without_main_runloop() {
        let worker = std::thread::Builder::new()
            .name("Axonkey devices".into())
            .spawn(|| {
                let service = AudioService::start_a15();
                let status = service.status();
                assert_eq!(status.state, "stopped");
                service.set_a15_input_state(true, true);
                service.push_a15_pcm(&[0; 160]);
                service.set_a15_input_state(false, false);
                let status = service.status();
                assert!(!status.bluetooth_connected);
                assert!(!status.forwarding);
            })
            .unwrap();
        worker.join().unwrap();
    }
}
