use super::atvv::AtvvDecoder;
use crate::audio_service::signal_monitor::{now_ms, NativeMonitorSnapshot, SignalMonitor};
use crate::audio_service::{clamp_gain_db, diagnostics::AudioDiagnostics, AudioServiceStatus};
use std::{
    ffi::{c_char, c_void},
    sync::{
        atomic::{AtomicBool, AtomicPtr, Ordering},
        Arc, Mutex,
    },
    time::Duration,
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

type EventCallback = unsafe extern "C" fn(*mut c_void, i32, *const u8, usize, i32, i32);

#[repr(C)]
struct NativeCallbacks {
    context: *mut c_void,
    on_event: EventCallback,
}

extern "C" {
    fn axonkey_macos_audio_create(callbacks: *const NativeCallbacks) -> *mut c_void;
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
    fn axonkey_macos_audio_battery_level(bridge: *mut c_void) -> i32;
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
    diagnostics: AudioDiagnostics,
    bridge: AtomicPtr<c_void>,
    output_enabled: AtomicBool,
    decoder: Mutex<AtvvDecoder>,
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
        log::info!(target: "axonkey::audio", "Starting macOS audio service");
        let shared = Arc::new(Shared {
            diagnostics: AudioDiagnostics::default(),
            bridge: AtomicPtr::new(std::ptr::null_mut()),
            output_enabled: AtomicBool::new(false),
            decoder: Mutex::new(AtvvDecoder::default()),
            signal_monitor: Mutex::new(SignalMonitor::default()),
        });
        let callback_context = Arc::into_raw(Arc::clone(&shared));
        let callbacks = NativeCallbacks {
            context: callback_context.cast_mut().cast(),
            on_event: native_event_callback,
        };
        let bridge = unsafe { axonkey_macos_audio_create(&callbacks) };
        shared.bridge.store(bridge, Ordering::Release);
        if !bridge.is_null() {
            log::info!(target: "axonkey::audio", "macOS audio bridge created; waiting for an output device");
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
        }
    }

    pub fn set_output_device(&self, device: Option<String>) {
        let enabled = device
            .as_deref()
            .map(str::trim)
            .is_some_and(|name| name == "MiRemoteV" || name == "MiRemoteV 2ch");
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
            unsafe { axonkey_macos_audio_start(bridge) };
        } else {
            log::info!(target: "axonkey::audio", "Disabling macOS audio output");
            unsafe { axonkey_macos_audio_stop(bridge) };
        }
    }

    pub fn restart(&self) -> Result<(), String> {
        if !self.shared.output_enabled.load(Ordering::Acquire) {
            return Err("未选择语音输出设备".into());
        }
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            return Err("无法连接 macOS 音频服务".into());
        }
        if unsafe { axonkey_macos_audio_restart(bridge) } {
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
            unsafe { axonkey_macos_audio_start(bridge) };
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
        log::info!(target: "axonkey::audio", "Updating audio gain to {gain_db} dB");
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
        AudioServiceStatus {
            driver_installed: unsafe { axonkey_macos_audio_driver_installed() },
            state: state_name(state_code).into(),
            bluetooth_connected: unsafe { axonkey_macos_audio_bluetooth_connected(bridge) },
            forwarding: unsafe { axonkey_macos_audio_forwarding(bridge) },
            output_ready: self.shared.output_enabled.load(Ordering::Acquire)
                && matches!(state_code, 3..=6),
            battery_level: battery_level_from_native(unsafe {
                axonkey_macos_audio_battery_level(bridge)
            }),
            error: native_error(bridge),
            ..AudioServiceStatus::default()
        }
    }
}

impl Drop for AudioService {
    fn drop(&mut self) {
        let bridge = self
            .shared
            .bridge
            .swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !bridge.is_null() {
            unsafe {
                axonkey_macos_audio_stop(bridge);
                axonkey_macos_audio_destroy(bridge);
            }
        }
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

fn battery_level_from_native(level: i32) -> Option<u8> {
    u8::try_from(level).ok().filter(|level| *level <= 100)
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
        EVENT_AUDIO_PACKET if !data.is_null() && length > 0 => {
            let Ok(mut decoder) = shared.decoder.lock() else {
                shared.diagnostics.rejected();
                return;
            };
            let packet = std::slice::from_raw_parts(data, length);
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
            if let Ok(mut monitor) = shared.signal_monitor.lock() {
                monitor.disconnected();
            }
        }
        EVENT_CODEC_SYNC => {
            if let Ok(mut decoder) = shared.decoder.lock() {
                shared
                    .diagnostics
                    .decoder_pending(0, decoder.pending_bytes());
                decoder.synchronize(value1, value2);
            }
        }
        EVENT_SESSION_START | EVENT_SESSION_STOP => {
            if let Ok(mut decoder) = shared.decoder.lock() {
                shared
                    .diagnostics
                    .decoder_pending(0, decoder.pending_bytes());
                decoder.reset_session();
            }
            if let Ok(mut monitor) = shared.signal_monitor.lock() {
                monitor.session(event == EVENT_SESSION_START);
            }
            let state = if event == EVENT_SESSION_START {
                "started"
            } else {
                "stopped"
            };
            log::info!(target: "axonkey::audio", "macOS RC003 voice session {state}: session_id={value1}");
        }
        EVENT_RECEIVED => shared.diagnostics.received(value1.max(0) as usize),
        EVENT_REJECTED => shared.diagnostics.rejected(),
        EVENT_READ_ERROR => shared.diagnostics.read_error(),
        EVENT_RENDERED => shared.diagnostics.output(value1.max(0) as usize, 0, false),
        EVENT_CONTROL => shared.diagnostics.control(value1 as u8),
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
                    log::info!(target: "axonkey::audio", "macOS RC003 audio diagnostics: {report} {message}");
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

    #[test]
    fn native_packets_record_decode_and_enqueue_failure_separately() {
        let shared = Shared {
            diagnostics: AudioDiagnostics::default(),
            bridge: AtomicPtr::new(std::ptr::null_mut()),
            output_enabled: AtomicBool::new(false),
            decoder: Mutex::new(AtvvDecoder::default()),
            signal_monitor: Mutex::new(SignalMonitor::default()),
        };
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
        let shared = Shared {
            diagnostics: AudioDiagnostics::default(),
            bridge: AtomicPtr::new(std::ptr::null_mut()),
            output_enabled: AtomicBool::new(false),
            decoder: Mutex::new(AtvvDecoder::default()),
            signal_monitor: Mutex::new(SignalMonitor::default()),
        };
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
        let shared = Shared {
            diagnostics: AudioDiagnostics::default(),
            bridge: AtomicPtr::new(std::ptr::null_mut()),
            output_enabled: AtomicBool::new(false),
            decoder: Mutex::new(AtvvDecoder::default()),
            signal_monitor: Mutex::new(SignalMonitor::default()),
        };
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
    fn accepts_only_valid_native_battery_percentages() {
        assert_eq!(battery_level_from_native(-1), None);
        assert_eq!(battery_level_from_native(0), Some(0));
        assert_eq!(battery_level_from_native(100), Some(100));
        assert_eq!(battery_level_from_native(101), None);
    }
}
