use super::{cursor_delta, InputServiceStatus, NativeBehavior, NativeSettings, WheelDirection};
#[cfg(test)]
use super::{repeatable_click, RepeatableClick, TriggerBehaviors};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
#[cfg(not(test))]
use tauri::Emitter;

const WAIT_TIMEOUT_MS: u32 = 50;
const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const OBE_PCM_FRAME_SAMPLES: usize = 320;

#[cfg(windows)]
struct QuarborContext {
    reader: Option<super::windows_quarbor::Client>,
    switch_profile: Option<Arc<dyn Fn(super::ProfileDirection, bool) + Send + Sync>>,
    keyboard: RemoteKeyboard,
    events: std::collections::VecDeque<super::windows_quarbor::Event>,
    keys: std::collections::VecDeque<RemoteKeyEvent>,
    voice_taps: std::collections::VecDeque<Instant>,
    pointer_moves: std::collections::VecDeque<crate::devices::hisense_rcf3b65::PointerPosition>,
    device_id: Option<String>,
    device_kind: Option<String>,
    descriptor: Option<&'static crate::devices::device_descriptor::DeviceDescriptor>,
    descriptor_engine: Option<crate::devices::engine::DescriptorEngine>,
    a15_voice: crate::devices::cmiot_a15::voice::VoiceStream,
    a15_pcm: std::collections::VecDeque<crate::devices::cmiot_a15::voice::PcmFrame>,
    obe_voice: crate::devices::obe_rcu_r5::voice::VoiceStream,
    obe_pcm: std::collections::VecDeque<Vec<i16>>,
    obe_pcm_accumulator: Vec<i16>,
    a15_voice_errors: u64,
    obe_voice_errors: u64,
    a15_recording: crate::devices::cmiot_a15::recording::RecordingControl,
    last_pipe_attempt: Instant,
    last_sequence: Option<u64>,
    dropped: u64,
    error: Option<String>,
    usage_error: Option<u32>,
    state_epoch: u64,
}

#[cfg(windows)]
impl Default for QuarborContext {
    fn default() -> Self {
        Self {
            reader: None,
            switch_profile: None,
            keyboard: RemoteKeyboard::default(),
            events: std::collections::VecDeque::new(),
            keys: std::collections::VecDeque::new(),
            voice_taps: std::collections::VecDeque::new(),
            pointer_moves: std::collections::VecDeque::new(),
            device_id: None,
            device_kind: None,
            descriptor: crate::devices::descriptor_registry::descriptor_for_kind("rc003"),
            descriptor_engine: None,
            a15_voice: Default::default(),
            a15_pcm: Default::default(),
            obe_voice: Default::default(),
            obe_pcm: Default::default(),
            obe_pcm_accumulator: Default::default(),
            a15_voice_errors: 0,
            obe_voice_errors: 0,
            a15_recording: Default::default(),
            last_pipe_attempt: Instant::now() - Duration::from_secs(2),
            last_sequence: None,
            dropped: 0,
            error: None,
            usage_error: None,
            state_epoch: 0,
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyBackend {
    Driver(super::remote_actions::HidKey),
    Virtual(u16),
}

#[cfg(windows)]
#[derive(Default)]
struct RemoteKeyboard {
    held: Vec<(super::remote_actions::HidKey, KeyBackend)>,
}

#[cfg(windows)]
impl RemoteKeyboard {
    fn edge_with(
        &mut self,
        key: super::remote_actions::HidKey,
        down: bool,
        supported: bool,
        mut emit_driver: impl FnMut(super::remote_actions::HidKey, bool) -> std::io::Result<()>,
        mut emit_virtual: impl FnMut(u16, bool) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        let held = self.held.iter().position(|(held, _)| *held == key);
        if !down {
            if let Some(index) = held {
                let (_, backend) = self.held.remove(index);
                match backend {
                    // A key pressed through the persistent Quarbor output device cannot
                    // be cleared by SendInput; propagate the error so the pipe resets.
                    KeyBackend::Driver(driver_key) => emit_driver(driver_key, false)?,
                    KeyBackend::Virtual(virtual_key) => emit_virtual(virtual_key, false)?,
                }
            }
            return Ok(());
        }
        if held.is_some() {
            return Ok(());
        }
        let backend = if supported {
            match emit_driver(key, true) {
                Ok(()) => KeyBackend::Driver(key),
                Err(error) => {
                    log::warn!(
                        target: "axonkey::input",
                        "Universal driver key output failed; trying SendInput fallback: {error}"
                    );
                    let virtual_key = virtual_key_for_hid(key).ok_or(error)?;
                    emit_virtual(virtual_key, true)?;
                    KeyBackend::Virtual(virtual_key)
                }
            }
        } else {
            let virtual_key = virtual_key_for_hid(key).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    format!(
                        "No SendInput mapping for HID {:#06X}/{:#06X}",
                        key.page, key.usage
                    ),
                )
            })?;
            emit_virtual(virtual_key, true)?;
            KeyBackend::Virtual(virtual_key)
        };
        self.held.push((key, backend));
        Ok(())
    }

    fn reset(
        &mut self,
        mut emit_driver: impl FnMut(super::remote_actions::HidKey, bool),
        mut emit_virtual: impl FnMut(u16, bool),
    ) {
        for (_, backend) in self.held.drain(..).rev() {
            match backend {
                KeyBackend::Driver(key) => emit_driver(key, false),
                KeyBackend::Virtual(key) => emit_virtual(key, false),
            }
        }
    }
}

#[cfg(windows)]
fn quarbor_wait_with_timeout(
    context: &mut QuarborContext,
    timeout_ms: u32,
    ble_monitor: &BleLinkMonitor,
    interrupted: impl Fn() -> bool,
) {
    if !context.keys.is_empty() || !context.pointer_moves.is_empty() || interrupted() {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
    let Some(device_id) = context.device_id.as_deref() else {
        return;
    };
    if context.reader.is_none()
        && !device_id.is_empty()
        && context.last_pipe_attempt.elapsed() >= DEVICE_POLL_INTERVAL
    {
        context.last_pipe_attempt = Instant::now();
        match super::windows_quarbor::Client::connect(device_id) {
            Ok(reader) => {
                context.reader = Some(reader);
                context.last_sequence = None;
                context.usage_error = None;
                context.error = None;
                log::info!(target: "axonkey::input", "Quarbor Universal duplex pipe connected: {device_id}");
            }
            Err(error) => quarbor_read_error(
                context,
                format!("Quarbor Universal connect ({device_id}): {error}"),
            ),
        }
    }
    // Bound both work and waiting; a busy device must not starve shutdown/status.
    for _ in 0..64 {
        let Some(reader) = context.reader.as_mut() else {
            break;
        };
        match reader.poll() {
            Ok(Some(event)) => {
                if matches!(event, super::windows_quarbor::Event::Report { .. }) {
                    ble_monitor.note_connected();
                }
                quarbor_accept_event(context, event);
                if !context.keys.is_empty() {
                    return;
                }
            }
            Ok(None) => {
                if !context.events.is_empty() || interrupted() || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(
                    Duration::from_millis(2)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(error) => {
                context.reader = None;
                quarbor_release_inputs(context, ReleaseReason::PipeError);
                quarbor_read_error(context, format!("Quarbor Universal receive: {error}"));
                break;
            }
        }
    }
    if context.reader.is_none() && !interrupted() {
        thread::sleep(deadline.saturating_duration_since(Instant::now()));
    }
}

#[cfg(windows)]
fn quarbor_read_error(context: &mut QuarborContext, error: String) {
    if context.error.as_ref() != Some(&error) {
        log::warn!(target: "axonkey::input", "{error}");
        context.error = Some(error);
    }
}

#[cfg(windows)]
fn quarbor_accept_event(context: &mut QuarborContext, event: super::windows_quarbor::Event) {
    use super::windows_quarbor::Event;
    match &event {
        Event::Hello(metadata) => {
            context.dropped = metadata.dropped;
            if metadata.status != 0 {
                quarbor_read_error(
                    context,
                    format!("Quarbor HID read NTSTATUS=0x{:08X}", metadata.status),
                );
            }
        }
        Event::Report { metadata, bytes } => {
            if context
                .last_sequence
                .is_some_and(|last| last.checked_add(1) != Some(metadata.sequence))
                || metadata.dropped > context.dropped
            {
                log::warn!(target: "axonkey::input", "Quarbor HID report gap: previous={:?}, current={}, dropped={}", context.last_sequence, metadata.sequence, metadata.dropped);
                quarbor_release_inputs(context, ReleaseReason::ReportGap);
            }
            context.last_sequence = Some(metadata.sequence);
            context.dropped = metadata.dropped;
            if is_hisense_rcf3b65(context) {
                if let Some(position) = crate::devices::hisense_rcf3b65::parse_pointer_report(bytes)
                {
                    context.usage_error = None;
                    if context.pointer_moves.len() == 64 {
                        context.pointer_moves.pop_front();
                    }
                    context.pointer_moves.push_back(position);
                    context.events.push_back(event);
                    return;
                }
            }
            if let Some(descriptor) = context.descriptor {
                context.usage_error = None;
                let engine = context
                    .descriptor_engine
                    .get_or_insert_with(Default::default);
                for (key, pressed) in engine.accept(descriptor, bytes) {
                    if let Some(button) = descriptor_event_key(descriptor, &key) {
                        context.keys.push_back(RemoteKeyEvent { button, pressed });
                    }
                }
                let audio_engine = descriptor.reports.values().find_map(|report| {
                    (report.encoding
                        == crate::devices::device_descriptor::ReportEncoding::GattStream
                        && report.report_id == bytes.first().copied()
                        && report.length.is_none_or(|length| length == bytes.len()))
                    .then(|| report.attributes.get("engine").map(String::as_str))
                    .flatten()
                });
                if matches!(audio_engine, Some("cmiot-a15.g7221" | "tcl-rc802a.ico")) {
                    match context.a15_voice.feed(bytes) {
                        Ok(Some(frame)) => {
                            if context.a15_pcm.len() == 32 {
                                context.a15_pcm.pop_front();
                            }
                            context.a15_pcm.push_back(frame);
                        }
                        Ok(None) => {}
                        Err(error) => {
                            context.a15_voice_errors += 1;
                            if context.a15_voice_errors == 1 || context.a15_voice_errors % 128 == 0
                            {
                                log::warn!(target: "axonkey::audio", "A15 FC decode: {error}; errors={}", context.a15_voice_errors);
                            }
                        }
                    }
                } else if audio_engine == Some("obe-rcu-r5.sbc") {
                    match context.obe_voice.feed(bytes) {
                        Ok(Some(samples)) => {
                            context.obe_pcm_accumulator.extend(samples);
                            while context.obe_pcm_accumulator.len() >= OBE_PCM_FRAME_SAMPLES {
                                let frame: Vec<_> = context
                                    .obe_pcm_accumulator
                                    .drain(..OBE_PCM_FRAME_SAMPLES)
                                    .collect();
                                if context.obe_pcm.len() == 32 {
                                    context.obe_pcm.pop_front();
                                }
                                context.obe_pcm.push_back(frame);
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            context.obe_voice_errors += 1;
                            if context.obe_voice_errors == 1 || context.obe_voice_errors % 128 == 0
                            {
                                log::warn!(target: "axonkey::audio", "OBE_RCU_R5 SBC decode: {error}; errors={}", context.obe_voice_errors);
                            }
                        }
                    }
                }
            } else {
                context.state_epoch = context.state_epoch.wrapping_add(1);
            }
        }
        Event::Status(metadata) => {
            if metadata.status == 0 && metadata.dropped > context.dropped {
                quarbor_release_inputs(context, ReleaseReason::StatusDropped);
            }
            context.dropped = metadata.dropped;
            if metadata.status != 0 {
                quarbor_release_inputs(context, ReleaseReason::StatusError);
                quarbor_reset_driver_output(context);
                quarbor_read_error(
                    context,
                    format!("Quarbor HID read NTSTATUS=0x{:08X}", metadata.status),
                );
            } else {
                context.error = None;
            }
        }
        Event::Capabilities(_) => {
            // Pipe readiness does not mean the BLE peripheral is awake. Reset
            // local state without writing FB 00 to an idle physical device.
            if recording_voice(context).is_some() {
                context.a15_recording.reset();
                context.a15_voice.reset();
                context.obe_voice.reset();
                context.a15_pcm.clear();
                context.obe_pcm.clear();
                context.obe_pcm_accumulator.clear();
            }
            // Each connection starts with a neutral output state.
            quarbor_reset_driver_output(context);
        }
        Event::CommandAccepted(id) => {
            log::debug!(target: "axonkey::input", "Quarbor command accepted: request_id={id}");
        }
    }
    context.events.push_back(event);
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
enum ReleaseReason {
    ReportGap,
    StatusDropped,
    StatusError,
    BleDisconnect,
    PipeError,
    OutputError,
    Shutdown,
    #[cfg(test)]
    Test,
}

#[cfg(windows)]
fn quarbor_reset_driver_output(context: &mut QuarborContext) {
    if let Some(client) = context.reader.as_mut().filter(|client| client.ready()) {
        if let Err(error) = client.reset_input() {
            quarbor_output_error(context, error);
        }
    }
}

#[cfg(windows)]
fn is_hisense_rcf3b65(context: &QuarborContext) -> bool {
    context.device_kind.as_deref() == Some(crate::devices::hisense_rcf3b65::KIND)
        || context.descriptor.is_some_and(|descriptor| {
            descriptor.id == crate::devices::hisense_rcf3b65::DESCRIPTOR_ID
        })
}

#[cfg(windows)]
fn quarbor_release_inputs(context: &mut QuarborContext, reason: ReleaseReason) {
    context.pointer_moves.clear();
    let voice_engine = recording_voice(context).map(|voice| voice.engine.as_str());
    let voice = recording_voice(context);
    let voice_key = recording_voice(context).and_then(|voice| {
        context
            .descriptor
            .and_then(|descriptor| descriptor_event_key(descriptor, &voice.trigger_key))
    });
    let gap_recovery = matches!(
        reason,
        ReleaseReason::ReportGap | ReleaseReason::StatusDropped
    );
    let preserve_recording = gap_recovery && context.a15_recording.preserves_recording_on_gap();
    if !gap_recovery {
        context.keys.retain(|key| !key.pressed);
    }
    if !preserve_recording {
        // Never replay a queued start after recording has been reset.
        context.keys.retain(|key| Some(key.button) != voice_key);
        if !matches!(reason, ReleaseReason::BleDisconnect) {
            if let Err(error) = context
                .a15_recording
                .stop(|report| send_recording_report(voice_engine, &mut context.reader, report))
            {
                quarbor_read_error(context, format!("A15 recording stop: {error}"));
            }
        }
        context.a15_recording.reset();
    }
    context.a15_voice.reset();
    context.obe_voice.reset();
    context
        .a15_voice
        .synchronize(context.a15_recording.is_recording());
    context
        .obe_voice
        .synchronize(context.a15_recording.is_recording());
    context.a15_pcm.clear();
    context.obe_pcm.clear();
    context.obe_pcm_accumulator.clear();
    let mut driver_release_error = None;
    context.keyboard.reset(
        |key, down| {
            if let Some(client) = context.reader.as_mut() {
                if let Err(error) = client.send_key(key.page, key.usage, down) {
                    if driver_release_error.is_none() {
                        driver_release_error = Some(error);
                    }
                }
            }
        },
        |key, down| {
            let _ = send_remote_virtual_key(key, down);
        },
    );
    if let Some(error) = driver_release_error {
        context.reader = None;
        quarbor_read_error(
            context,
            format!("Quarbor Universal keyboard release: {error}"),
        );
    }
    context.state_epoch = context.state_epoch.wrapping_add(1);
    if let (Some(descriptor), Some(engine)) =
        (context.descriptor, context.descriptor_engine.as_mut())
    {
        let preserved = voice
            .filter(|_| preserve_recording)
            .map(|voice| vec![voice.trigger_key.as_str()])
            .unwrap_or_default();
        for (key, pressed) in engine.release_except(&preserved) {
            if let Some(button) = descriptor_event_key(descriptor, &key) {
                context.keys.push_back(RemoteKeyEvent { button, pressed });
            }
        }
    }
}

#[cfg(windows)]
fn descriptor_event_key(
    descriptor: &'static crate::devices::device_descriptor::DeviceDescriptor,
    id: &str,
) -> Option<&'static str> {
    let input = descriptor.inputs.iter().find(|input| input.id == id)?;
    Some(crate::devices::descriptor_registry::input_key(input))
}

#[cfg(all(windows, test))]
fn quarbor_decode_usages(context: &mut QuarborContext, usages: impl IntoIterator<Item = u16>) {
    let mut bytes = vec![1];
    for usage in usages.into_iter().take(3) {
        bytes.extend(usage.to_le_bytes());
    }
    bytes.resize(7, 0);
    let Some(descriptor) = crate::devices::descriptor_registry::descriptor_for_kind("rc003") else {
        return;
    };
    context.descriptor = Some(descriptor);
    let engine = context
        .descriptor_engine
        .get_or_insert_with(Default::default);
    for (key, pressed) in engine.accept(descriptor, &bytes) {
        if let Some(button) = descriptor_event_key(descriptor, &key) {
            context.keys.push_back(RemoteKeyEvent { button, pressed });
        }
    }
}

#[cfg(test)]
fn rc003_button_for_usage(usage: u16) -> Option<&'static str> {
    let descriptor = crate::devices::descriptor_registry::descriptor_for_kind("rc003")?;
    descriptor.inputs.iter().find_map(|input| {
        input
            .sources
            .iter()
            .any(|source| source.page == Some(7) && source.usage == Some(usage))
            .then(|| crate::devices::descriptor_registry::input_key(input))
    })
}

pub(super) fn original_key_for_button(button: &str) -> Option<super::remote_actions::HidKey> {
    crate::devices::descriptor_registry::registered_kinds()
        .into_iter()
        .find_map(|kind| crate::devices::descriptor_registry::original_usage(kind, button))
        .map(|(page, usage)| super::remote_actions::HidKey { page, usage })
}

#[cfg(windows)]
fn quarbor_output_error(context: &mut QuarborContext, error: std::io::Error) {
    // Closing the writer makes the driver clear its queue and submit neutral
    // reports, including keys whose release was rejected or only partly sent.
    context.reader = None;
    quarbor_read_error(
        context,
        format!("Quarbor Universal keyboard output: {error}"),
    );
    quarbor_release_inputs(context, ReleaseReason::OutputError);
}

#[cfg(not(test))]
type EventApp = tauri::AppHandle;
#[cfg(test)]
type EventApp = ();

type ManagedInput = Arc<dyn Fn(std::collections::BTreeMap<String, f64>, Vec<String>) + Send + Sync>;

struct Shared {
    recording_requests: Mutex<Vec<(bool, std::sync::mpsc::SyncSender<Result<bool, String>>)>>,
    instance_id: Option<String>,
    settings: RwLock<NativeSettings>,
    settings_revision: AtomicU64,
    status: Mutex<InputServiceStatus>,
    event_app: RwLock<Option<EventApp>>,
    stop: AtomicBool,
    driver_gate: Arc<AtomicBool>,
    driver_paused: AtomicBool,
    managed_event: Option<Arc<dyn Fn(String, bool) + Send + Sync>>,
    managed_input: Option<ManagedInput>,
    managed_remote_owned: AtomicBool,
}

pub struct InputService {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl InputService {
    pub fn start(driver_gate: Arc<AtomicBool>) -> Self {
        log::info!(target: "axonkey::input", "Starting Windows input service");
        let shared = Arc::new(Shared {
            recording_requests: Mutex::new(Vec::new()),
            instance_id: None,
            settings: RwLock::new(NativeSettings::default()),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            driver_gate,
            driver_paused: AtomicBool::new(false),
            managed_event: None,
            managed_input: None,
            managed_remote_owned: AtomicBool::new(false),
        });
        let worker_shared = Arc::clone(&shared);
        #[cfg(windows)]
        let worker = thread::Builder::new()
            .name("Axonkey Quarbor Universal input".into())
            .spawn(move || worker_loop(worker_shared))
            .ok();
        #[cfg(not(windows))]
        let worker = thread::Builder::new()
            .name("Axonkey Quarbor Universal input".into())
            .spawn(move || worker_loop(worker_shared))
            .ok();
        if worker.is_none() {
            shared.status.lock().unwrap().error = Some("Cannot start the input worker".into());
            log::error!(target: "axonkey::input", "Cannot start the Windows input worker thread");
        }
        Self {
            shared,
            worker: Mutex::new(worker),
        }
    }

    pub fn update_settings(&self, mut settings: NativeSettings) -> Result<(), String> {
        for triggers in settings.behaviors.values_mut() {
            super::sanitize_platform_triggers(triggers);
        }
        for profile in settings.quick_profiles.values_mut() {
            for triggers in profile.behaviors.values_mut() {
                super::sanitize_platform_triggers(triggers);
            }
        }
        let behavior_count = settings
            .behaviors
            .values()
            .map(|triggers| {
                triggers.click.len() + triggers.double_click.len() + triggers.long_press.len()
            })
            .sum::<usize>();
        log::info!(
            target: "axonkey::input",
            "Input settings updated: enabled={}, behaviors={behavior_count}",
            settings.enabled,
        );
        let mut current = self
            .shared
            .settings
            .write()
            .map_err(|_| "Input settings lock is unavailable")?;
        let changed = current.remote_settings_changed(&settings);
        *current = settings;
        if changed {
            self.shared
                .settings_revision
                .fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn wait_for_driver_pause(&self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.shared.driver_paused.load(Ordering::Acquire) {
            if !self.shared.driver_gate.load(Ordering::Acquire) {
                return Err("驱动升级尚未暂停输入服务。".into());
            }
            if Instant::now() >= deadline {
                return Err("等待输入服务释放驱动连接超时，请再次尝试升级。".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Ok(())
    }

    pub fn pause_for_driver_migration(&self) -> Result<(), String> {
        self.shared.driver_gate.store(true, Ordering::Release);
        self.wait_for_driver_pause()
    }

    pub fn resume_after_driver_migration(&self) {
        self.shared.driver_gate.store(false, Ordering::Release);
    }

    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }

    pub fn set_event_app(&self, app: tauri::AppHandle) {
        super::profile_switch::set_event_app(app.clone());
        #[cfg(not(test))]
        if let Ok(mut event_app) = self.shared.event_app.write() {
            *event_app = Some(app);
        }
        #[cfg(test)]
        let _ = app;
    }

    pub fn status(&self) -> InputServiceStatus {
        self.shared
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| InputServiceStatus {
                error: Some("Input status lock is unavailable".into()),
                ..InputServiceStatus::default()
            })
    }

    pub fn set_managed_remote_owned(&self, owned: bool) -> bool {
        self.shared
            .managed_remote_owned
            .store(owned, Ordering::Release);
        true
    }
}

impl Drop for InputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Each RC003/A15 instance owns one Quarbor pipe and one action state machine.
#[cfg(windows)]
pub(super) struct ManagedQuarborChannel {
    pub(super) kind: String,
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

#[cfg(windows)]
impl ManagedQuarborChannel {
    #[cfg(not(test))]
    pub(super) fn start(
        instance_id: String,
        target: String,
        kind: String,
        settings: NativeSettings,
        app: tauri::AppHandle,
        driver_gate: Arc<AtomicBool>,
        emit: Arc<dyn Fn(String, bool) + Send + Sync>,
        input: ManagedInput,
    ) -> Self {
        let switch_app = app.clone();
        let switch_id = instance_id.clone();
        let switch_profile = Arc::new(move |direction, wrap| {
            use tauri::Manager;
            switch_app
                .state::<crate::DeviceManager>()
                .switch_instance_profile(&switch_id, direction, wrap);
        });
        let event_app = Some(app);
        let shared = Arc::new(Shared {
            recording_requests: Mutex::new(Vec::new()),
            instance_id: Some(instance_id.clone()),
            settings: RwLock::new(settings),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(event_app),
            stop: AtomicBool::new(false),
            driver_gate,
            driver_paused: AtomicBool::new(false),
            managed_event: Some(emit),
            managed_input: Some(input),
            managed_remote_owned: AtomicBool::new(false),
        });
        let worker_shared = Arc::clone(&shared);
        let descriptor_kind = kind.clone();
        let worker = thread::Builder::new()
            .name(format!("Axonkey Quarbor {instance_id}"))
            .spawn(move || {
                let mut context = QuarborContext {
                    switch_profile: Some(switch_profile),
                    descriptor: crate::devices::descriptor_registry::descriptor_for_kind(
                        &descriptor_kind,
                    ),
                    descriptor_engine: Some(Default::default()),
                    a15_voice: if descriptor_kind == "tclRc802a" {
                        crate::devices::tcl_rc802a::voice_stream()
                    } else {
                        Default::default()
                    },
                    device_kind: Some(descriptor_kind),
                    ..Default::default()
                };
                run_context(&mut context, &worker_shared, target);
            })
            .ok();
        Self {
            kind,
            shared,
            worker: Mutex::new(worker),
        }
    }

    pub(super) fn update_settings(&self, settings: NativeSettings) {
        if let Ok(mut current) = self.shared.settings.write() {
            let changed = current.remote_settings_changed(&settings);
            *current = settings;
            // The device manager syncs every read cycle; unchanged settings must
            // preserve the physical press and any actions waiting on a delay.
            if changed {
                self.shared
                    .settings_revision
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub(super) fn toggle_recording(
        &self,
        reply: std::sync::mpsc::SyncSender<Result<bool, String>>,
    ) {
        self.shared
            .recording_requests
            .lock()
            .unwrap()
            .push((false, reply));
    }

    pub(super) fn stop_recording(&self, reply: std::sync::mpsc::SyncSender<Result<bool, String>>) {
        self.shared
            .recording_requests
            .lock()
            .unwrap()
            .push((true, reply));
    }

    pub(super) fn status(&self) -> InputServiceStatus {
        self.shared
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| InputServiceStatus {
                error: Some("Managed Quarbor status lock is unavailable".into()),
                ..InputServiceStatus::default()
            })
    }

    pub(super) fn stop(&self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[cfg(test)]
    pub(super) fn start_for_test(
        driver_gate: Arc<AtomicBool>,
        released_batches: Arc<Mutex<Vec<Vec<(u16, u32)>>>>,
        input: ManagedInput,
    ) -> Self {
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let shared = Arc::new(Shared {
            recording_requests: Mutex::new(Vec::new()),
            instance_id: Some("test-quarbor".into()),
            settings: RwLock::new(NativeSettings::default()),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus {
                capture_active: true,
                cmiot_a15_recording: true,
                ..InputServiceStatus::default()
            }),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            driver_gate,
            driver_paused: AtomicBool::new(false),
            managed_event: None,
            managed_input: Some(input),
            managed_remote_owned: AtomicBool::new(false),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("Axonkey Quarbor test".into())
            .spawn(move || {
                MOUSE_KEY_BATCHES.with(|events| events.borrow_mut().clear());
                let mut context = QuarborContext {
                    descriptor: crate::devices::descriptor_registry::descriptor_for_kind(
                        "cmiotA15",
                    ),
                    descriptor_engine: Some(Default::default()),
                    device_kind: Some("cmiotA15".into()),
                    last_pipe_attempt: Instant::now(),
                    ..Default::default()
                };
                if let (Some(descriptor), Some(engine)) =
                    (context.descriptor, context.descriptor_engine.as_mut())
                {
                    let _ = engine.accept(descriptor, &[1, 0, 0, 0x52, 0, 0, 0, 0, 0]);
                }
                context
                    .keyboard
                    .edge_with(
                        super::remote_actions::HidKey {
                            page: 7,
                            usage: 0x04,
                        },
                        true,
                        false,
                        |_, _| Ok(()),
                        send_remote_virtual_key,
                    )
                    .unwrap();
                MOUSE_KEY_BATCHES.with(|events| events.borrow_mut().clear());
                let _ = ready_tx.send(());
                run_context(&mut context, &worker_shared, String::new());
                MOUSE_KEY_BATCHES.with(|events| {
                    *released_batches.lock().unwrap() = events.borrow().clone();
                });
            })
            .ok();
        let _ = ready_rx.recv_timeout(Duration::from_secs(2));
        Self {
            kind: "cmiotA15".into(),
            shared,
            worker: Mutex::new(worker),
        }
    }
}

#[cfg(windows)]
impl Drop for ManagedQuarborChannel {
    fn drop(&mut self) {
        self.stop();
    }
}

fn worker_loop(shared: Arc<Shared>) {
    // Global settings remain available, but physical devices are owned by the registry.
    while !shared.stop.load(Ordering::Relaxed) {
        shared.driver_paused.store(
            shared.driver_gate.load(Ordering::Acquire),
            Ordering::Release,
        );
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(windows)]
fn run_context(context: &mut QuarborContext, shared: &Shared, target: String) {
    #[cfg(not(test))]
    let started = Instant::now();
    #[cfg(not(test))]
    let mut shared_mobile = super::mobile_quarbor::register_shared_channel();
    let mut ble_monitor = BleLinkMonitor::start(&target, Arc::clone(&shared.driver_gate));
    context.device_id = Some(target);
    let mut actions = super::remote_actions::RemoteActions::default();
    if let Some(instance_id) = shared.instance_id.as_deref() {
        let kind = context.device_kind.as_deref().unwrap_or("rc003");
        actions.set_source(instance_id, kind, kind);
    }
    let mut state_epoch = context.state_epoch;
    while !shared.stop.load(Ordering::Relaxed) {
        if shared.driver_gate.load(Ordering::Acquire) {
            break;
        }
        quarbor_wait_with_timeout(context, WAIT_TIMEOUT_MS, &ble_monitor, || {
            #[cfg(not(test))]
            let mobile_pending = shared_mobile.has_pending();
            #[cfg(test)]
            let mobile_pending = false;
            shared.stop.load(Ordering::Relaxed)
                || shared.driver_gate.load(Ordering::Acquire)
                || ble_monitor.has_disconnect()
                || mobile_pending
        });
        if ble_monitor.take_disconnect() {
            quarbor_handle_ble_disconnect(context);
        }
        if shared.stop.load(Ordering::Acquire) || shared.driver_gate.load(Ordering::Acquire) {
            break;
        }
        #[cfg(not(test))]
        if sony_voice_input(context).is_some() {
            if let (Some(id), Some(app)) = (
                shared.instance_id.as_deref(),
                shared.event_app.read().ok().and_then(|app| app.clone()),
            ) {
                use tauri::Manager;
                if let Some(audio) = app.try_state::<crate::audio_service::AudioServiceManager>() {
                    context.voice_taps = audio.take_voice_taps(id, started);
                }
            }
        }
        quarbor_publish_events(context, shared);
        #[cfg(not(test))]
        shared_mobile.pump(&mut context.reader);
        process_remote_actions(
            context,
            shared,
            &mut actions,
            &mut state_epoch,
            Instant::now(),
        );
    }
    #[cfg(not(test))]
    shared_mobile.unregister(&mut context.reader);
    quarbor_shutdown_context(context, shared, &mut actions);
}

#[cfg(windows)]
fn quarbor_handle_ble_disconnect(context: &mut QuarborContext) {
    log::info!(
        target: "axonkey::input",
        "BLE peripheral link disconnected; releasing active inputs ({:?})",
        context.device_id
    );
    quarbor_release_inputs(context, ReleaseReason::BleDisconnect);
    quarbor_reset_driver_output(context);
}

#[cfg(windows)]
fn quarbor_shutdown_context(
    context: &mut QuarborContext,
    shared: &Shared,
    actions: &mut super::remote_actions::RemoteActions,
) {
    actions.cancel();
    quarbor_release_inputs(context, ReleaseReason::Shutdown);
    if recording_voice(context).is_some() {
        shared.status.lock().unwrap().capture_active = false;
        publish_a15_recording(shared, false);
    }
    if rc902_voice(context).is_some() {
        publish_rc902_voice_key_edge(shared, false);
    }
    if let Some(client) = context.reader.as_mut() {
        if client.ready() {
            let _ = client.reset_input();
        }
        if client.has_pending_work() {
            if let Err(error) = client.finish_pending(Duration::from_millis(300)) {
                quarbor_read_error(
                    context,
                    format!("Quarbor shutdown flush not confirmed: {error}"),
                );
            }
        }
    }
    context.reader = None; // Driver disconnect cleanup releases delivered keys.
    while let Some(key) = context.keys.pop_front() {
        if shared.managed_input.is_none() {
            emit_remote_key_event(shared, key.button, key.pressed);
        }
    }
    publish_descriptor_input(context, shared);
    shared.status.lock().unwrap().capture_active = false;
}

#[cfg(windows)]
fn ble_address_for_device_id(target: &str) -> Option<u64> {
    let id = target.to_ascii_uppercase();
    let segment = crate::devices::shared::bluetooth_hid_service(&id)?
        .split('\\')
        .next()?;
    let address = segment.rsplit('_').next()?;
    (address.len() == 12 && address.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| u64::from_str_radix(address, 16).ok())
        .flatten()
}

#[cfg(windows)]
fn record_ble_connection_status(
    was_connected: &AtomicBool,
    disconnects: &AtomicU64,
    armed: bool,
    connected: bool,
) {
    if connected {
        was_connected.store(true, Ordering::Release);
    } else if armed && was_connected.swap(false, Ordering::AcqRel) {
        disconnects.fetch_add(1, Ordering::AcqRel);
    }
}

#[cfg(windows)]
struct BleLinkMonitor {
    was_connected: Arc<AtomicBool>,
    disconnects: Arc<AtomicU64>,
    observed: u64,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

#[cfg(windows)]
impl BleLinkMonitor {
    fn start(target: &str, driver_gate: Arc<AtomicBool>) -> Self {
        let was_connected = Arc::new(AtomicBool::new(false));
        let disconnects = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        #[cfg(not(test))]
        let worker = ble_address_for_device_id(target).and_then(|address| {
            let monitor_connected = Arc::clone(&was_connected);
            let monitor_disconnects = Arc::clone(&disconnects);
            let monitor_stop = Arc::clone(&stop);
            thread::Builder::new()
                .name("Axonkey BLE link monitor".into())
                .spawn(move || {
                    ble_link_monitor_loop(
                        address,
                        monitor_connected,
                        monitor_disconnects,
                        monitor_stop,
                        driver_gate,
                    );
                })
                .ok()
        });
        #[cfg(test)]
        let worker = {
            let _ = (target, driver_gate);
            None
        };
        Self {
            was_connected,
            disconnects,
            observed: 0,
            stop,
            worker,
        }
    }

    fn note_connected(&self) {
        if !self.was_connected.swap(true, Ordering::AcqRel) {
            if let Some(worker) = &self.worker {
                worker.thread().unpark();
            }
        }
    }

    fn has_disconnect(&self) -> bool {
        self.disconnects.load(Ordering::Acquire) != self.observed
    }

    fn take_disconnect(&mut self) -> bool {
        let current = self.disconnects.load(Ordering::Acquire);
        if current == self.observed {
            return false;
        }
        self.observed = current;
        true
    }
}

#[cfg(windows)]
impl Drop for BleLinkMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

#[cfg(all(windows, not(test)))]
fn ble_link_monitor_loop(
    address: u64,
    was_connected: Arc<AtomicBool>,
    disconnects: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    driver_gate: Arc<AtomicBool>,
) {
    use windows::{
        Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothLEDevice},
        Foundation::TypedEventHandler,
    };

    // Paired BTHLEDevice nodes stay present and keep their Quarbor pipe open
    // when the BLE peripheral sleeps or loses radio link; watch the live ACL
    // connection status passively without opening GATT services.
    let Ok(_apartment) = crate::windows_runtime::initialize_mta() else {
        return;
    };
    while !stop.load(Ordering::Acquire) && !driver_gate.load(Ordering::Acquire) {
        let request =
            crate::windows_runtime::BluetoothRequest::new(Duration::from_secs(5), Some(&stop));
        let Ok(device) = request.run("BLE link monitor open", || {
            BluetoothLEDevice::FromBluetoothAddressAsync(address)
        }) else {
            thread::park_timeout(Duration::from_secs(2));
            continue;
        };
        let event_connected = Arc::clone(&was_connected);
        let event_disconnects = Arc::clone(&disconnects);
        let handler = TypedEventHandler::<BluetoothLEDevice, _>::new(move |sender, _| {
            if let Some(device) = sender.as_ref() {
                let armed = event_connected.load(Ordering::Acquire);
                if let Ok(status) = device.ConnectionStatus() {
                    record_ble_connection_status(
                        &event_connected,
                        &event_disconnects,
                        armed,
                        status == BluetoothConnectionStatus::Connected,
                    );
                }
            }
            Ok(())
        });
        let token = device.ConnectionStatusChanged(&handler).ok();
        let armed = was_connected.load(Ordering::Acquire);
        if let Ok(status) = device.ConnectionStatus() {
            record_ble_connection_status(
                &was_connected,
                &disconnects,
                armed,
                status == BluetoothConnectionStatus::Connected,
            );
        }
        while !stop.load(Ordering::Acquire) && !driver_gate.load(Ordering::Acquire) {
            thread::park_timeout(Duration::from_millis(100));
            let armed = was_connected.load(Ordering::Acquire);
            match device.ConnectionStatus() {
                Ok(status) => record_ble_connection_status(
                    &was_connected,
                    &disconnects,
                    armed,
                    status == BluetoothConnectionStatus::Connected,
                ),
                Err(_) => {
                    record_ble_connection_status(&was_connected, &disconnects, armed, false);
                    break;
                }
            }
        }
        if let Some(token) = token {
            let _ = device.RemoveConnectionStatusChanged(token);
        }
        let _ = device.Close();
    }
}

#[cfg(windows)]
fn recording_voice(
    context: &QuarborContext,
) -> Option<&'static crate::devices::device_descriptor::VoiceDescriptor> {
    context.descriptor?.voices.iter().find(|voice| {
        matches!(
            voice.engine.as_str(),
            "cmiot-a15.g7221" | "obe-rcu-r5.sbc" | "tcl-rc802a.ico"
        )
    })
}

#[cfg(windows)]
fn rc902_voice(
    context: &QuarborContext,
) -> Option<&'static crate::devices::device_descriptor::VoiceDescriptor> {
    context
        .descriptor?
        .voices
        .iter()
        .find(|voice| voice.engine == "tcl-rc902v-atvv")
}

#[cfg(windows)]
fn sony_voice_input(
    context: &QuarborContext,
) -> Option<&'static crate::devices::device_descriptor::InputDescriptor> {
    if context.device_kind.as_deref() != Some("rmfTx800c") {
        return None;
    }
    let voice = rc902_voice(context)?;
    context.descriptor?.inputs.iter().find(|input| {
        input.id == voice.trigger_key
            && input.target.is_some()
            && input.sources.iter().any(|source| {
                source.report == "voice-control" && source.field.as_deref() == Some("start-search")
            })
    })
}

#[cfg(windows)]
fn send_recording_report(
    engine: Option<&str>,
    reader: &mut Option<super::windows_quarbor::Client>,
    mut report: [u8; 2],
) -> std::io::Result<()> {
    if matches!(engine, Some("cmiot-a15.g7221" | "tcl-rc802a.ico")) {
        if engine == Some("tcl-rc802a.ico") {
            report[0] = 0xeb;
        }
        send_a15_recording_report(reader, report)
    } else {
        Ok(())
    }
}

#[cfg(all(windows, not(test)))]
fn send_a15_recording_report(
    reader: &mut Option<super::windows_quarbor::Client>,
    report: [u8; 2],
) -> std::io::Result<()> {
    let client = reader.as_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "A15 recording control disconnected",
        )
    })?;
    client.write_physical_output(&report).map(|_| ())
}

#[cfg(all(windows, test))]
fn send_a15_recording_report(
    _reader: &mut Option<super::windows_quarbor::Client>,
    report: [u8; 2],
) -> std::io::Result<()> {
    if FAIL_NEXT_A15_RECORDING_REPORT.with(|fail| fail.replace(false)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "A15 recording control write failed",
        ));
    }
    A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().push(report));
    Ok(())
}

#[cfg(windows)]
fn publish_a15_recording(shared: &Shared, recording: bool) {
    #[cfg(not(test))]
    if let Some(app) = shared.event_app.read().ok().and_then(|app| app.clone()) {
        use tauri::Manager;
        if let Some(audio) = app.try_state::<crate::audio_service::AudioServiceManager>() {
            let connected = shared.status.lock().unwrap().capture_active;
            audio.set_a15_input_state(shared.instance_id.as_deref(), connected, recording);
        }
    }
    let changed = if let Ok(mut status) = shared.status.lock() {
        let changed = status.cmiot_a15_recording != recording;
        status.cmiot_a15_recording = recording;
        changed
    } else {
        false
    };
    if changed {
        #[cfg(not(test))]
        if let Ok(app) = shared.event_app.read() {
            if let Some(app) = app.as_ref() {
                let _ = app.emit(
                    "axonkey-device-recording",
                    serde_json::json!({"instanceId": shared.instance_id, "recording": recording}),
                );
            }
        }
    }
}

#[cfg(windows)]
fn publish_rc902_voice_key_edge(shared: &Shared, pressed: bool) {
    #[cfg(not(test))]
    if let Some(app) = shared.event_app.read().ok().and_then(|app| app.clone()) {
        use tauri::Manager;
        if let Some(audio) = app.try_state::<crate::audio_service::AudioServiceManager>() {
            audio.handle_voice_key_edge(shared.instance_id.as_deref(), pressed);
        }
    }
    #[cfg(test)]
    {
        let _ = shared;
        RC902_VOICE_KEY_EDGES.with(|edges| edges.borrow_mut().push(pressed));
    }
}

#[cfg(windows)]
fn publish_descriptor_input(context: &mut QuarborContext, shared: &Shared) {
    if let Some((values, pressed)) = context
        .descriptor_engine
        .as_mut()
        .and_then(|engine| engine.take_update())
    {
        if let Some(emit) = &shared.managed_input {
            let key = |id: &str| {
                context
                    .descriptor
                    .and_then(|descriptor| descriptor_event_key(descriptor, id))
                    .map(str::to_owned)
            };
            emit(
                values
                    .into_iter()
                    .filter_map(|(id, value)| key(&id).map(|key| (key, value)))
                    .collect(),
                pressed.into_iter().filter_map(|id| key(&id)).collect(),
            );
        }
    }
}

#[cfg(windows)]
fn process_remote_actions(
    context: &mut QuarborContext,
    shared: &Shared,
    actions: &mut super::remote_actions::RemoteActions,
    state_epoch: &mut u64,
    now: Instant,
) {
    let voice_engine = recording_voice(context).map(|voice| voice.engine.as_str());
    while let Some(frame) = context.a15_pcm.pop_front() {
        forward_a15_pcm(shared, frame);
    }
    while let Some(samples) = context.obe_pcm.pop_front() {
        forward_obe_pcm(shared, samples);
    }
    process_remote_actions_inner(context, shared, actions, state_epoch, now);
    for (stop, reply) in std::mem::take(&mut *shared.recording_requests.lock().unwrap()) {
        let result = if shared.status.lock().unwrap().capture_active
            && shared.settings.read().unwrap().enabled
        {
            if stop {
                context
                    .a15_recording
                    .stop(|report| send_recording_report(voice_engine, &mut context.reader, report))
                    .map(|()| false)
                    .map_err(|error| format!("A15 录音控制失败：{error}"))
            } else {
                context
                    .a15_recording
                    .toggle(|report| {
                        send_recording_report(voice_engine, &mut context.reader, report)
                    })
                    .map_err(|error| format!("A15 录音控制失败：{error}"))
            }
        } else {
            Err("设备录音通道未连接".into())
        };
        context
            .a15_voice
            .synchronize(context.a15_recording.is_recording());
        context
            .obe_voice
            .synchronize(context.a15_recording.is_recording());
        if !context.a15_recording.is_recording() {
            context.obe_pcm_accumulator.clear();
        }
        publish_a15_recording(shared, context.a15_recording.is_recording());
        let _ = reply.send(result);
    }
    publish_descriptor_input(context, shared);
    context
        .a15_voice
        .synchronize(context.a15_recording.is_recording());
    context
        .obe_voice
        .synchronize(context.a15_recording.is_recording());
    if !context.a15_recording.is_recording() {
        context.obe_pcm_accumulator.clear();
    }
    if recording_voice(context).is_some() {
        publish_a15_recording(shared, context.a15_recording.is_recording());
    }
}

#[cfg(windows)]
fn process_remote_actions_inner(
    context: &mut QuarborContext,
    shared: &Shared,
    actions: &mut super::remote_actions::RemoteActions,
    state_epoch: &mut u64,
    now: Instant,
) {
    let voice_engine = recording_voice(context).map(|voice| voice.engine.as_str());
    if *state_epoch != context.state_epoch {
        actions.cancel();
        *state_epoch = context.state_epoch;
    }
    let Ok(settings) = shared.settings.read() else {
        actions.cancel();
        quarbor_output_error(
            context,
            std::io::Error::other("Input settings lock unavailable"),
        );
        return;
    };
    actions.synchronize(
        shared.settings_revision.load(Ordering::Relaxed),
        settings.enabled,
    );
    if let Err(error) = context.a15_recording.synchronize(
        settings.cmiot_a15_recording_mode,
        settings.enabled,
        |report| send_recording_report(voice_engine, &mut context.reader, report),
    ) {
        quarbor_output_error(context, error);
        actions.cancel();
        return;
    }
    context
        .a15_voice
        .synchronize(context.a15_recording.is_recording());
    context
        .obe_voice
        .synchronize(context.a15_recording.is_recording());
    if !context.a15_recording.is_recording() {
        context.obe_pcm_accumulator.clear();
    }
    if settings.enabled {
        while let Some(position) = context.pointer_moves.pop_front() {
            send_absolute_mouse_move(position.x, position.y);
        }
    } else {
        context.pointer_moves.clear();
    }
    while let Some(key) = context.keys.pop_front() {
        if shared.managed_input.is_none() {
            emit_remote_key_event(shared, key.button, key.pressed);
        }
        if let Some(voice) = recording_voice(context).filter(|voice| {
            context
                .descriptor
                .and_then(|descriptor| descriptor_event_key(descriptor, &voice.trigger_key))
                == Some(key.button)
        }) {
            if let Err(error) = context.a15_recording.edge(key.pressed, |report| {
                send_recording_report(Some(&voice.engine), &mut context.reader, report)
            }) {
                quarbor_output_error(context, error);
                actions.cancel();
                return;
            }
            publish_a15_recording(shared, context.a15_recording.is_recording());
            context
                .a15_voice
                .synchronize(context.a15_recording.is_recording());
            context
                .obe_voice
                .synchronize(context.a15_recording.is_recording());
            if !context.a15_recording.is_recording() {
                context.obe_pcm_accumulator.clear();
            }
        }
        if rc902_voice(context).and_then(|voice| {
            context
                .descriptor
                .and_then(|descriptor| descriptor_event_key(descriptor, &voice.trigger_key))
        }) == Some(key.button)
        {
            publish_rc902_voice_key_edge(shared, key.pressed);
        }
        actions.edge(key.button, key.pressed, &settings, now);
    }
    if let Some(input) = sony_voice_input(context).filter(|_| settings.enabled) {
        let button = crate::devices::descriptor_registry::input_key(input);
        for at in std::mem::take(&mut context.voice_taps) {
            for down in [true, false] {
                if let Some(engine) = context.descriptor_engine.as_mut() {
                    engine.set_button_state(&input.id, down);
                    publish_descriptor_input(context, shared);
                }
                actions.edge(button, down, &settings, at);
            }
        }
    } else {
        context.voice_taps.clear();
    }
    let mut output_error = None;
    actions.tick(now, |output| {
        if output_error.is_some() {
            return;
        }
        output_error = emit_remote_output(
            context,
            output,
            shared.instance_id.as_deref().unwrap_or("legacy-rc003"),
        )
        .err();
    });
    if let Some(error) = output_error {
        quarbor_output_error(context, error);
        actions.cancel();
    }
}

#[cfg(windows)]
fn emit_remote_output(
    context: &mut QuarborContext,
    output: super::remote_actions::Output,
    instance_id: &str,
) -> std::io::Result<()> {
    use super::remote_actions::Output;
    match output {
        Output::LibraryTrigger(input, sources) => {
            crate::library_usage::record_trigger(&format!("{instance_id}:{input}"), &sources)
        }
        Output::CursorMove(direction, distance) => {
            let (dx, dy) = cursor_delta(direction, distance);
            let driver_supported = context
                .reader
                .as_ref()
                .is_some_and(|client| client.supports_mouse_move());
            let mut sent_by_driver = false;
            if driver_supported {
                if let Some(client) = context.reader.as_mut() {
                    if let Err(error) = send_driver_mouse_move(client, dx, dy, 0, 0) {
                        log::warn!(
                            target: "axonkey::input",
                            "Universal driver cursor movement failed; trying SendInput fallback: {error}"
                        );
                        if !client.ready() {
                            quarbor_output_error(context, error);
                        }
                    } else {
                        sent_by_driver = true;
                    }
                }
            }
            if !sent_by_driver {
                send_mouse_move(dx, dy);
            }
        }
        Output::MouseClick(button) => {
            let driver_usage = mouse_button_usage(button).filter(|usage| {
                context
                    .reader
                    .as_ref()
                    .is_some_and(|client| client.supports_key(0x09, *usage))
            });
            let mut sent_by_driver = false;
            if let (Some(usage), Some(client)) = (driver_usage, context.reader.as_mut()) {
                match client.tap_key(0x09, usage) {
                    Ok(_) => sent_by_driver = true,
                    Err(error) => {
                        log::warn!(
                            target: "axonkey::input",
                            "Universal driver mouse button failed; trying SendInput fallback: {error}"
                        );
                        if !client.ready() {
                            quarbor_output_error(context, error);
                        }
                    }
                }
            }
            if !sent_by_driver {
                send_mouse_click(button);
            }
        }
        Output::Wheel(direction) => {
            let (wheel, pan) = driver_wheel_delta(direction);
            let driver_supported = context
                .reader
                .as_ref()
                .is_some_and(|client| client.supports_mouse_move());
            let mut sent_by_driver = false;
            if driver_supported {
                if let Some(client) = context.reader.as_mut() {
                    if let Err(error) = send_driver_mouse_move(client, 0, 0, wheel, pan) {
                        log::warn!(
                            target: "axonkey::input",
                            "Universal driver wheel failed; trying SendInput fallback: {error}"
                        );
                        if !client.ready() {
                            quarbor_output_error(context, error);
                        }
                    } else {
                        sent_by_driver = true;
                    }
                }
            }
            if !sent_by_driver {
                send_wheel_with_axis(wheel_delta(direction), wheel_horizontal(direction));
            }
        }
        Output::SwitchProfile(direction, wrap) => {
            if let Some(switch) = &context.switch_profile {
                switch(direction, wrap);
                return Ok(());
            }
            let device = if recording_voice(context).is_some() {
                super::profile_switch::DeviceId::CmiotA15
            } else {
                super::profile_switch::DeviceId::Rc003
            };
            super::profile_switch::execute(device, direction, wrap)
        }
        Output::TypeText(text) => send_unicode_text(&text),
        Output::CopyText(text) => super::text_output::copy_text(&text),
        Output::Paste(text) => paste_text(&text),
        Output::OpenPath(path) => super::launch::execute(&NativeBehavior::OpenPath {
            enabled: true,
            path,
        }),
        Output::OpenApp(path) => super::launch::execute(&NativeBehavior::OpenApp {
            enabled: true,
            path,
        }),
        Output::OpenWebsite(url) => {
            super::launch::execute(&NativeBehavior::OpenWebsite { enabled: true, url })
        }
        Output::RunCommand {
            command,
            working_directory,
        } => super::launch::execute(&NativeBehavior::RunCommand {
            enabled: true,
            command,
            working_directory,
            title: None,
        }),
        Output::HttpRequest {
            method,
            url,
            headers,
            body,
        } => super::launch::execute(&NativeBehavior::HttpRequest {
            enabled: true,
            method,
            url,
            headers,
            body,
            title: None,
        }),
        Output::Key(key, down) => {
            let supported = context
                .reader
                .as_ref()
                .is_some_and(|client| client.supports_key(key.page, key.usage));
            // Some A15 consumer usages have no Windows/driver output equivalent.
            // They remain configurable inputs; do not reconnect the capture pipe
            // merely because their unconfigured original action cannot be emitted.
            if !supported
                && virtual_key_for_hid(key).is_none()
                && recording_voice(context).is_some()
            {
                if down {
                    log::warn!(target: "axonkey::input", "A15 original usage has no output mapping: {:04X}/{:04X}", key.page, key.usage);
                }
                return Ok(());
            }
            context.keyboard.edge_with(
                key,
                down,
                supported,
                |driver_key, driver_down| {
                    let client = context.reader.as_mut().ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::NotConnected,
                            "Quarbor driver unavailable for key output",
                        )
                    })?;
                    client
                        .send_key(driver_key.page, driver_key.usage, driver_down)
                        .map(|_| ())
                },
                send_remote_virtual_key,
            )?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn quarbor_publish_events(context: &mut QuarborContext, shared: &Shared) {
    use super::windows_quarbor::Event;
    while let Some(event) = context.events.pop_front() {
        match event {
            Event::Hello(_) => {}
            Event::Capabilities(caps) => {
                log::info!(target: "axonkey::input", "Quarbor Universal capture ready: report_bytes={}, queue_capacity={}, flags=0x{:X}, report_ids={:02X?}", caps.input_report_bytes, caps.queue_capacity, caps.flags, caps.report_ids);
            }
            Event::Report { .. } | Event::Status(_) | Event::CommandAccepted(_) => {}
        }
    }
    let mut status = shared.status.lock().unwrap();
    status.backend_ready = true;
    status.hardware_id = context.device_id.clone();
    status.capture_active = context.reader.as_ref().is_some_and(|reader| reader.ready());
    status.device_connected = context.reader.is_some();
    status.error = context.error.clone();
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteKeyEvent {
    button: &'static str,
    pressed: bool,
}

#[cfg(not(test))]
fn emit_remote_key_event(shared: &Shared, button: &'static str, pressed: bool) {
    if let Some(emit) = &shared.managed_event {
        emit(button.to_string(), pressed);
        return;
    }
    let app = shared
        .event_app
        .read()
        .ok()
        .and_then(|event_app| event_app.clone());
    if let Some(app) = app {
        let _ = app.emit("axonkey-remote-key", RemoteKeyEvent { button, pressed });
    }
}

#[cfg(not(test))]
fn forward_pcm(shared: &Shared, samples: &[i16]) {
    if let Some(app) = shared.event_app.read().ok().and_then(|app| app.clone()) {
        use tauri::Manager;
        if let Some(audio) = app.try_state::<crate::audio_service::AudioServiceManager>() {
            audio.push_a15_pcm(shared.instance_id.as_deref(), samples);
        }
    }
}

#[cfg(not(test))]
fn forward_a15_pcm(shared: &Shared, frame: crate::devices::cmiot_a15::voice::PcmFrame) {
    forward_pcm(shared, &frame.samples);
}

#[cfg(not(test))]
fn forward_obe_pcm(shared: &Shared, samples: Vec<i16>) {
    forward_pcm(shared, &samples);
}

#[cfg(test)]
fn forward_a15_pcm(_shared: &Shared, _frame: crate::devices::cmiot_a15::voice::PcmFrame) {}

#[cfg(test)]
fn forward_obe_pcm(_shared: &Shared, _samples: Vec<i16>) {}

fn wheel_delta(direction: WheelDirection) -> i32 {
    match direction {
        WheelDirection::Up => 120,
        WheelDirection::Down => -120,
        WheelDirection::Left => -120,
        WheelDirection::Right => 120,
    }
}

fn driver_wheel_delta(direction: WheelDirection) -> (i32, i32) {
    match direction {
        WheelDirection::Up => (1, 0),
        WheelDirection::Down => (-1, 0),
        WheelDirection::Left => (0, -1),
        WheelDirection::Right => (0, 1),
    }
}

fn mouse_button_usage(button: super::MouseButton) -> Option<u16> {
    match button {
        super::MouseButton::Left => Some(1),
        super::MouseButton::Right => Some(2),
        super::MouseButton::Middle => Some(3),
        // Universal's mouse collection currently has no XBUTTON usages.
        super::MouseButton::Back | super::MouseButton::Forward => None,
    }
}

#[cfg(windows)]
fn mouse_move_steps(value: i32) -> impl Iterator<Item = i32> {
    let mut remaining = value;
    std::iter::from_fn(move || {
        if remaining == 0 {
            return None;
        }
        let step = remaining.clamp(-127, 127);
        remaining -= step;
        Some(step)
    })
}

#[cfg(windows)]
fn send_driver_mouse_move(
    client: &mut super::windows_quarbor::Client,
    x: i32,
    y: i32,
    wheel: i32,
    pan: i32,
) -> std::io::Result<()> {
    let mut x_steps = mouse_move_steps(x);
    let mut y_steps = mouse_move_steps(y);
    let mut wheel_steps = mouse_move_steps(wheel);
    let mut pan_steps = mouse_move_steps(pan);
    loop {
        let step = (
            x_steps.next().unwrap_or(0),
            y_steps.next().unwrap_or(0),
            wheel_steps.next().unwrap_or(0),
            pan_steps.next().unwrap_or(0),
        );
        if step == (0, 0, 0, 0) {
            return Ok(());
        }
        client.move_mouse(step.0, step.1, step.2, step.3)?;
    }
}

/// Mappings produced by the Windows mouse service originate outside the RC003
/// driver, so they stay on SendInput. RC003 actions are handled separately by
/// `emit_remote_output` and are sent back through the Universal pipe.
pub(super) fn execute_mouse_behavior(behavior: &NativeBehavior, hold_ms: u64) {
    match behavior {
        // The mouse service is available to users who do not install the
        // RC003 Universal driver, so all mouse output stays on SendInput.
        NativeBehavior::Wheel { direction, .. } => {
            send_wheel_with_axis(wheel_delta(*direction), wheel_horizontal(*direction));
        }
        NativeBehavior::CursorMove {
            direction,
            distance,
            ..
        } => {
            let (dx, dy) = cursor_delta(*direction, *distance);
            send_mouse_move(dx, dy);
        }
        NativeBehavior::Mouse { button, .. } => send_mouse_click(*button),
        NativeBehavior::TypeText { text, .. } => send_unicode_text(text),
        NativeBehavior::CopyText { text, .. } => super::text_output::copy_text(text),
        NativeBehavior::Paste { text, .. } => paste_text(text),
        NativeBehavior::OpenPath { .. }
        | NativeBehavior::OpenApp { .. }
        | NativeBehavior::OpenWebsite { .. }
        | NativeBehavior::RunCommand { .. }
        | NativeBehavior::HttpRequest { .. } => super::launch::execute(behavior),
        NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. } => {
            if let Some(keys) = behavior_chord(behavior) {
                if !send_mouse_chord_with(&keys, hold_ms, send_keyboard_inputs) {
                    log::warn!(
                        target: "axonkey::input",
                        "Mouse keyboard injection incomplete; target may have higher privileges"
                    );
                }
            }
        }
        NativeBehavior::SwitchProfile {
            direction, wrap, ..
        } => super::profile_switch::execute(
            super::profile_switch::DeviceId::Mouse,
            *direction,
            *wrap,
        ),
        NativeBehavior::Delay { .. }
        | NativeBehavior::QuickOverlay { .. }
        | NativeBehavior::ClipboardOverlay { .. }
        | NativeBehavior::Disabled { .. } => {}
    }
}

fn normalize_injected_virtual_key(key: u16) -> u16 {
    match key {
        0x10 => 0xa0, // VK_SHIFT -> VK_LSHIFT
        0x11 => 0xa2, // VK_CONTROL -> VK_LCONTROL
        0x12 => 0xa4, // VK_MENU -> VK_LMENU
        other => other,
    }
}

fn is_extended_virtual_key(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 // PageUp, PageDown, End, Home, Left, Up, Right, Down
        | 0x2d      // Insert
        | 0x2e      // Delete
        | 0x5b      // VK_LWIN
        | 0x5c      // VK_RWIN
        | 0x6f      // VK_DIVIDE
        | 0x90      // VK_NUMLOCK
        | 0xa3      // VK_RCONTROL
        | 0xa5 // VK_RMENU
    ) || (unsafe { MapVirtualKeyW(u32::from(vk), 4) } >> 8) == 0xe0
}

fn virtual_key_input(key: u16) -> Input {
    let vk = normalize_injected_virtual_key(key);
    let scan_code = unsafe { MapVirtualKeyW(u32::from(vk), 0) as u16 };
    let extended = is_extended_virtual_key(vk);
    Input {
        kind: 1,
        value: InputValue {
            keyboard: KeyboardInput {
                virtual_key: vk,
                scan_code,
                flags: u32::from(extended),
                time: 0,
                extra_info: 0,
            },
        },
    }
}

/// Zero hold submits a complete tap in one batch; a configured hold separates
/// down and up for applications that need time to recognize a pressed key.
fn send_mouse_chord_with(
    keys: &[u16],
    hold_ms: u64,
    mut send: impl FnMut(&[Input]) -> usize,
) -> bool {
    if keys.is_empty() {
        return true;
    }
    let downs: Vec<Input> = keys.iter().copied().map(virtual_key_input).collect();
    let release = |mut input: Input| {
        unsafe {
            input.value.keyboard.flags |= 2;
        }
        input
    };
    let all_ups: Vec<Input> = downs.iter().copied().rev().map(release).collect();
    if hold_ms == 0 {
        let mut tap = downs.clone();
        tap.extend(all_ups.iter().copied());
        let sent = send(&tap).min(tap.len());
        if sent == tap.len() {
            return true;
        }
        // A partial SendInput call may have pressed some keys. Release every
        // key whose matching up event was not accepted by the same call.
        let pressed = sent.min(downs.len());
        let released = sent.saturating_sub(downs.len()).min(pressed);
        let cleanup: Vec<Input> = downs[..pressed]
            .iter()
            .copied()
            .rev()
            .take(pressed.saturating_sub(released))
            .map(release)
            .collect();
        if !cleanup.is_empty() {
            let _ = send(&cleanup);
        }
        return false;
    }
    let pressed = send(&downs).min(downs.len());
    if pressed == downs.len() {
        thread::sleep(Duration::from_millis(hold_ms.min(1000)));
    }
    let ups: Vec<Input> = downs[..pressed]
        .iter()
        .copied()
        .rev()
        .map(release)
        .collect();
    let released = if ups.is_empty() {
        0
    } else {
        send(&ups).min(ups.len())
    };
    pressed == downs.len() && released == ups.len()
}

fn send_keyboard_inputs(inputs: &[Input]) -> usize {
    #[cfg(test)]
    {
        MOUSE_KEY_BATCHES.with(|batches| {
            batches.borrow_mut().push(
                inputs
                    .iter()
                    .map(|input| {
                        let key = unsafe { input.value.keyboard };
                        (key.virtual_key, key.flags)
                    })
                    .collect(),
            )
        });
        inputs.len()
    }
    #[cfg(not(test))]
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<Input>() as i32,
        ) as usize
    }
}

fn behavior_chord(behavior: &NativeBehavior) -> Option<Vec<u16>> {
    match behavior {
        NativeBehavior::Key { key, .. } => parse_chord(key),
        NativeBehavior::Shortcut { keys, .. } => {
            let chord = keys
                .iter()
                .filter_map(|key| parse_chord(key))
                .flatten()
                .fold(Vec::new(), |mut result, key| {
                    if !result.contains(&key) {
                        result.push(key);
                    }
                    result
                });
            (!chord.is_empty()).then_some(chord)
        }
        NativeBehavior::Wheel { .. }
        | NativeBehavior::CursorMove { .. }
        | NativeBehavior::Mouse { .. }
        | NativeBehavior::TypeText { .. }
        | NativeBehavior::CopyText { .. }
        | NativeBehavior::OpenPath { .. }
        | NativeBehavior::Paste { .. }
        | NativeBehavior::OpenApp { .. }
        | NativeBehavior::OpenWebsite { .. }
        | NativeBehavior::RunCommand { .. }
        | NativeBehavior::HttpRequest { .. }
        | NativeBehavior::Delay { .. }
        | NativeBehavior::SwitchProfile { .. }
        | NativeBehavior::QuickOverlay { .. }
        | NativeBehavior::ClipboardOverlay { .. }
        | NativeBehavior::Disabled { .. } => None,
    }
}

fn hid_key_for_virtual_key(key: u16) -> Option<super::remote_actions::HidKey> {
    let (page, usage) = match key {
        0x41..=0x5a => (7, key - 0x41 + 4),
        0x31..=0x39 => (7, key - 0x31 + 0x1e),
        0x30 => (7, 0x27),
        0x70..=0x7b => (7, key - 0x70 + 0x3a),
        0x7c..=0x87 => (7, key - 0x7c + 0x68),
        0x11 | 0xa2 => (7, 0xe0),
        0xa3 => (7, 0xe4),
        0x10 | 0xa0 => (7, 0xe1),
        0xa1 => (7, 0xe5),
        0x12 | 0xa4 => (7, 0xe2),
        0xa5 => (7, 0xe6),
        0x5b => (7, 0xe3),
        0x5c => (7, 0xe7),
        0x0d => (7, 0x28),
        0x1b => (7, 0x29),
        0x08 => (7, 0x2a),
        0x09 => (7, 0x2b),
        0x20 => (7, 0x2c),
        0xbd => (7, 0x2d),
        0xbb => (7, 0x2e),
        0xdb => (7, 0x2f),
        0xdd => (7, 0x30),
        0xdc => (7, 0x31),
        0xba => (7, 0x33),
        0xde => (7, 0x34),
        0xc0 => (7, 0x35),
        0xbc => (7, 0x36),
        0xbe => (7, 0x37),
        0xbf => (7, 0x38),
        0x2d => (7, 0x49),
        0x24 => (7, 0x4a),
        0x21 => (7, 0x4b),
        0x2e => (7, 0x4c),
        0x23 => (7, 0x4d),
        0x22 => (7, 0x4e),
        0x27 => (7, 0x4f),
        0x25 => (7, 0x50),
        0x28 => (7, 0x51),
        0x26 => (7, 0x52),
        // Volume controls belong to the Consumer Control collection exposed
        // by the Universal driver, rather than the legacy keyboard usages.
        0xad => (0x0c, 0x00e2),
        0xaf => (0x0c, 0x00e9),
        0xae => (0x0c, 0x00ea),
        0xb0 => (0x0c, 0xb5),
        0xb1 => (0x0c, 0xb6),
        0xb2 => (0x0c, 0xb7),
        0xb3 => (0x0c, 0xcd),
        _ => return None,
    };
    Some(super::remote_actions::HidKey { page, usage })
}

fn virtual_key_for_hid(key: super::remote_actions::HidKey) -> Option<u16> {
    (1..=255)
        .filter(|virtual_key| !matches!(virtual_key, 0x10..=0x12))
        .find(|virtual_key| hid_key_for_virtual_key(*virtual_key) == Some(key))
        .or(match (key.page, key.usage) {
            (7, 0xf1) => Some(0x08),
            (7, 0x80) => Some(0xaf),
            (7, 0x81) => Some(0xae),
            // A15 reports Confirm as Consumer Menu Pick, rather than keyboard Enter.
            (0x0c, 0x41) => Some(0x0d),
            _ => None,
        })
}

fn send_remote_virtual_key(key: u16, down: bool) -> std::io::Result<()> {
    let mut input = virtual_key_input(key);
    if !down {
        unsafe {
            input.value.keyboard.flags |= 2;
        }
    }
    if send_keyboard_inputs(&[input]) == 1 {
        return Ok(());
    }
    Err(std::io::Error::other(format!(
        "SendInput virtual key {key:#04X} {} failed",
        if down { "down" } else { "up" }
    )))
}

pub(super) fn managed_hold_chord(behavior: &NativeBehavior) -> Option<Vec<u16>> {
    let mut chord = Vec::new();
    for hid_key in behavior_hid_chord(behavior)? {
        let vk = virtual_key_for_hid(hid_key)?;
        if !chord.contains(&vk) {
            chord.push(vk);
        }
    }
    (!chord.is_empty()).then_some(chord)
}

pub(super) fn send_managed_held_key(key: u16, down: bool) {
    if let Err(error) = send_remote_virtual_key(key, down) {
        log::warn!(target: "axonkey::input", "{error}");
    }
}

#[cfg(test)]
pub(super) fn take_test_keyboard_batches() -> Vec<Vec<(u16, u32)>> {
    MOUSE_KEY_BATCHES.with(|batches| std::mem::take(&mut *batches.borrow_mut()))
}

/// Convert the existing key names into USB HID usages, never scan codes or
/// platform keyboard events. The driver resolves the descriptor/report ID.
pub(super) fn behavior_hid_chord(
    behavior: &NativeBehavior,
) -> Option<Vec<super::remote_actions::HidKey>> {
    let mut result = Vec::new();
    for key in behavior_chord(behavior)? {
        let key = hid_key_for_virtual_key(key)?;
        if !result.contains(&key) {
            result.push(key);
        }
    }
    Some(result)
}

#[cfg(test)]
fn emit_remote_key_event(_shared: &Shared, _button: &'static str, _pressed: bool) {}

fn parse_chord(value: &str) -> Option<Vec<u16>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed
        .split('+')
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    if trimmed == "+" || trimmed.ends_with("++") {
        parts.push("+");
    }
    let mut keys = Vec::new();
    for part in parts {
        let key = virtual_key_for_name(part.trim())?;
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    (!keys.is_empty()).then_some(keys)
}

fn virtual_key_for_name(value: &str) -> Option<u16> {
    let upper = value.to_ascii_uppercase();
    let named = match upper.as_str() {
        "CTRL" | "CONTROL" => 0x11,
        "LCTRL" => 0xa2,
        "RCTRL" => 0xa3,
        "SHIFT" => 0x10,
        "LSHIFT" => 0xa0,
        "RSHIFT" => 0xa1,
        "ALT" => 0x12,
        "LALT" | "OPTION" | "LOPTION" => 0xa4,
        "RALT" | "ROPTION" => 0xa5,
        "WIN" | "LWIN" | "CMD" | "COMMAND" => 0x5b,
        "RWIN" | "RCMD" | "RCOMMAND" => 0x5c,
        "ESC" | "ESCAPE" => 0x1b,
        "ENTER" | "RETURN" => 0x0d,
        "SPACE" => 0x20,
        "TAB" => 0x09,
        "BACKSPACE" => 0x08,
        "DELETE" => 0x2e,
        "INSERT" => 0x2d,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "UP" | "ARROWUP" => 0x26,
        "DOWN" | "ARROWDOWN" => 0x28,
        "LEFT" | "ARROWLEFT" => 0x25,
        "RIGHT" | "ARROWRIGHT" => 0x27,
        "VOLUMEMUTE" => 0xad,
        "VOLUMEDOWN" => 0xae,
        "VOLUMEUP" => 0xaf,
        "MEDIAPLAYPAUSE" => 0xb3,
        "MEDIANEXT" => 0xb0,
        "MEDIAPREVIOUS" => 0xb1,
        "MEDIASTOP" => 0xb2,
        ";" | ":" => 0xba,
        "=" | "+" => 0xbb,
        "," | "，" | "<" => 0xbc,
        "-" | "_" => 0xbd,
        "." | "。" | ">" => 0xbe,
        "/" | "?" | "？" => 0xbf,
        "`" | "~" => 0xc0,
        "[" | "{" | "【" => 0xdb,
        "\\" | "|" => 0xdc,
        "]" | "}" | "】" => 0xdd,
        "'" | "\"" => 0xde,
        _ => 0,
    };
    if named != 0 {
        return Some(named);
    }
    if upper.len() == 1 {
        let byte = upper.as_bytes()[0];
        if byte.is_ascii_alphanumeric() {
            return Some(byte as u16);
        }
    }
    if let Some(number) = upper
        .strip_prefix('F')
        .and_then(|number| number.parse::<u16>().ok())
    {
        if (1..=24).contains(&number) {
            return Some(0x6f + number);
        }
    }
    None
}

pub(super) fn behavior_error(behavior: &NativeBehavior) -> Option<String> {
    match behavior {
        NativeBehavior::Key { key, .. } if behavior_hid_chord(behavior).is_none() => {
            Some(format!("不支持的按键：{key}"))
        }
        NativeBehavior::Shortcut { keys, .. }
            if keys.is_empty()
                || keys.iter().any(|key| parse_chord(key).is_none())
                || behavior_hid_chord(behavior).is_none() =>
        {
            Some("快捷键包含当前系统不支持的按键".into())
        }
        NativeBehavior::QuickOverlay { profile_id, .. } if profile_id.trim().is_empty() => {
            Some("未选择快捷交互配置".into())
        }
        _ => None,
    }
}

#[allow(dead_code)]
pub(super) fn validate_settings(settings: &NativeSettings) -> Result<(), String> {
    for (button, triggers) in settings.behaviors.iter().chain(
        settings
            .quick_profiles
            .values()
            .flat_map(|profile| profile.behaviors.iter()),
    ) {
        for behavior in triggers.iter() {
            if !behavior.enabled() {
                continue;
            }
            if let Some(error) = behavior_error(behavior) {
                return Err(format!("{button}: {error}"));
            }
        }
    }
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
#[allow(dead_code)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct WinMonitorInfo {
    size: u32,
    monitor: WinRect,
    work: WinRect,
    flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct KeyboardInput {
    virtual_key: u16,
    scan_code: u16,
    flags: u32,
    time: u32,
    extra_info: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
union InputValue {
    mouse: MouseInput,
    keyboard: KeyboardInput,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Input {
    kind: u32,
    value: InputValue,
}

fn wheel_input(delta: i32, horizontal: bool) -> Input {
    Input {
        kind: 0, // INPUT_MOUSE
        value: InputValue {
            mouse: MouseInput {
                dx: 0,
                dy: 0,
                mouse_data: delta as u32,
                flags: if horizontal { 0x1000 } else { 0x0800 },
                time: 0,
                extra_info: 0,
            },
        },
    }
}

#[cfg(test)]
thread_local! {
    static A15_RECORDING_REPORTS: std::cell::RefCell<Vec<[u8; 2]>> = const { std::cell::RefCell::new(Vec::new()) };
    static FAIL_NEXT_A15_RECORDING_REPORT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static RC902_VOICE_KEY_EDGES: std::cell::RefCell<Vec<bool>> = const { std::cell::RefCell::new(Vec::new()) };
    static MOUSE_KEY_BATCHES: std::cell::RefCell<Vec<Vec<(u16, u32)>>> = const { std::cell::RefCell::new(Vec::new()) };
    static WHEEL_EVENTS: std::cell::RefCell<Vec<i32>> = const { std::cell::RefCell::new(Vec::new()) };
    static MOUSE_MOVES: std::cell::RefCell<Vec<(i32, i32)>> = const { std::cell::RefCell::new(Vec::new()) };
    static ABSOLUTE_MOUSE_MOVES: std::cell::RefCell<Vec<(i32, i32, u32)>> = const { std::cell::RefCell::new(Vec::new()) };
    static MOUSE_BUTTON_EVENTS: std::cell::RefCell<Vec<(u32, u32)>> = const { std::cell::RefCell::new(Vec::new()) };
    static UNICODE_EVENTS: std::cell::RefCell<Vec<(u16, u32)>> = const { std::cell::RefCell::new(Vec::new()) };
    static VIRTUAL_KEY_EDGES: std::cell::RefCell<Vec<(u16, u16, u32)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn wheel_horizontal(direction: WheelDirection) -> bool {
    matches!(direction, WheelDirection::Left | WheelDirection::Right)
}

fn send_wheel_with_axis(delta: i32, horizontal: bool) {
    let input = wheel_input(delta, horizontal);
    #[cfg(test)]
    {
        WHEEL_EVENTS.with(|events| {
            events
                .borrow_mut()
                .push(unsafe { input.value.mouse.mouse_data } as i32)
        });
    }
    #[cfg(not(test))]
    {
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            log::warn!(target: "axonkey::input", "Wheel injection failed: delta={delta}, error={}; target may have higher privileges", std::io::Error::last_os_error());
        }
    }
}

fn send_mouse_click(button: super::MouseButton) {
    let (down, up, mouse_data) = match button {
        super::MouseButton::Left => (0x0002, 0x0004, 0),
        super::MouseButton::Right => (0x0008, 0x0010, 0),
        super::MouseButton::Middle => (0x0020, 0x0040, 0),
        super::MouseButton::Back => (0x0080, 0x0100, 1),
        super::MouseButton::Forward => (0x0080, 0x0100, 2),
    };
    for flags in [down, up] {
        let input = Input {
            kind: 0,
            value: InputValue {
                mouse: MouseInput {
                    dx: 0,
                    dy: 0,
                    mouse_data,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        };
        #[cfg(test)]
        MOUSE_BUTTON_EVENTS.with(|events| {
            let mouse = unsafe { input.value.mouse };
            events.borrow_mut().push((mouse.flags, mouse.mouse_data));
        });
        #[cfg(not(test))]
        {
            let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
            if sent != 1 {
                log::warn!(target: "axonkey::input", "Mouse click injection failed: button={button:?}, flags=0x{flags:X}, error={}", std::io::Error::last_os_error());
            }
        }
    }
}

fn send_mouse_move(dx: i32, dy: i32) {
    #[cfg(test)]
    {
        MOUSE_MOVES.with(|events| events.borrow_mut().push((dx, dy)));
        return;
    }
    #[cfg(not(test))]
    {
        let mut point = WinPoint { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            log::warn!(target: "axonkey::input", "Cursor position unavailable: {}", std::io::Error::last_os_error());
            return;
        }
        let vx = unsafe { GetSystemMetrics(76) };
        let vy = unsafe { GetSystemMetrics(77) };
        let vw = unsafe { GetSystemMetrics(78) }.max(1);
        let vh = unsafe { GetSystemMetrics(79) }.max(1);
        let x = (point.x + dx).clamp(vx, vx + vw - 1);
        let y = (point.y + dy).clamp(vy, vy + vh - 1);
        let range_x = (vw - 1).max(1) as i64;
        let range_y = (vh - 1).max(1) as i64;
        let abs_x = ((x - vx) as i64 * 65535 / range_x) as i32;
        let abs_y = ((y - vy) as i64 * 65535 / range_y) as i32;
        const MOUSEEVENTF_MOVE: u32 = 0x0001;
        const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;
        const MOUSEEVENTF_VIRTUALDESK: u32 = 0x4000;
        let input = Input {
            kind: 0,
            value: InputValue {
                mouse: MouseInput {
                    dx: abs_x,
                    dy: abs_y,
                    mouse_data: 0,
                    flags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    time: 0,
                    extra_info: 0,
                },
            },
        };
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            log::warn!(target: "axonkey::input", "Cursor move injection failed: dx={dx}, dy={dy}, error={}", std::io::Error::last_os_error());
        }
    }
}

/// Pure relative pointer motion for Axonkey Mobile trackpad.
/// Uses `MOUSEEVENTF_MOVE` without `ABSOLUTE` or `VIRTUALDESK` and never calls `GetCursorPos`.
pub(super) fn inject_relative_motion(dx: i32, dy: i32) -> Result<(), String> {
    #[cfg(test)]
    {
        MOUSE_MOVES.with(|events| events.borrow_mut().push((dx, dy)));
        return Ok(());
    }
    #[cfg(not(test))]
    {
        const MOUSEEVENTF_MOVE: u32 = 0x0001;
        let input = Input {
            kind: 0,
            value: InputValue {
                mouse: MouseInput {
                    dx,
                    dy,
                    mouse_data: 0,
                    flags: MOUSEEVENTF_MOVE,
                    time: 0,
                    extra_info: 0,
                },
            },
        };
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            return Err(format!(
                "Relative pointer injection failed (dx={dx}, dy={dy}): {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

pub(super) fn inject_mouse_button_edge(
    button: super::MouseButton,
    down: bool,
) -> Result<(), String> {
    let (down_flag, up_flag, mouse_data) = match button {
        super::MouseButton::Left => (0x0002, 0x0004, 0),
        super::MouseButton::Right => (0x0008, 0x0010, 0),
        super::MouseButton::Middle => (0x0020, 0x0040, 0),
        super::MouseButton::Back => (0x0080, 0x0100, 1),
        super::MouseButton::Forward => (0x0080, 0x0100, 2),
    };
    let flags = if down { down_flag } else { up_flag };
    let input = Input {
        kind: 0,
        value: InputValue {
            mouse: MouseInput {
                dx: 0,
                dy: 0,
                mouse_data,
                flags,
                time: 0,
                extra_info: 0,
            },
        },
    };
    #[cfg(test)]
    {
        MOUSE_BUTTON_EVENTS.with(|events| {
            let mouse = unsafe { input.value.mouse };
            events.borrow_mut().push((mouse.flags, mouse.mouse_data));
        });
        return Ok(());
    }
    #[cfg(not(test))]
    {
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            return Err(format!(
                "Mouse button injection failed (button={button:?}, down={down}): {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

pub(super) fn inject_wheel_delta(delta: i32, horizontal: bool) -> Result<(), String> {
    let input = wheel_input(delta, horizontal);
    #[cfg(test)]
    {
        WHEEL_EVENTS.with(|events| {
            events
                .borrow_mut()
                .push(unsafe { input.value.mouse.mouse_data } as i32)
        });
        return Ok(());
    }
    #[cfg(not(test))]
    {
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            return Err(format!(
                "Wheel injection failed (delta={delta}, horizontal={horizontal}): {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

pub(super) fn inject_virtual_key_edge(key: &str, down: bool) -> Result<(), String> {
    let behavior = super::NativeBehavior::Key {
        enabled: true,
        key: key.to_owned(),
    };
    let Some(keys) = behavior_chord(&behavior) else {
        return Err(format!("Unsupported virtual key: {key}"));
    };
    let mut inputs = Vec::with_capacity(keys.len());
    for vk in keys {
        let mut input = virtual_key_input(vk);
        if !down {
            unsafe {
                input.value.keyboard.flags |= 0x0002; // KEYEVENTF_KEYUP
            }
        }
        inputs.push(input);
    }
    #[cfg(test)]
    {
        VIRTUAL_KEY_EDGES.with(|events| {
            events.borrow_mut().extend(inputs.iter().map(|input| {
                let kb = unsafe { input.value.keyboard };
                (kb.virtual_key, kb.scan_code, kb.flags)
            }));
        });
        return Ok(());
    }
    #[cfg(not(test))]
    {
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            )
        };
        if sent as usize != inputs.len() {
            return Err(format!(
                "Keyboard edge injection failed (key={key}, down={down}): {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

pub(super) fn normalize_primary_to_virtual_desk(
    u: f64,
    v: f64,
    primary: (i32, i32, i32, i32),
    virtual_desk: (i32, i32, i32, i32),
) -> (i32, i32) {
    let u = u.clamp(0.0, 1.0);
    let v = v.clamp(0.0, 1.0);
    let (lm, tm, wm, hm) = primary;
    let (vx, vy, vw, vh) = virtual_desk;
    let wm = wm.max(1);
    let hm = hm.max(1);
    let vw = vw.max(1);
    let vh = vh.max(1);

    let px = f64::from(lm) + u * f64::from(wm - 1);
    let py = f64::from(tm) + v * f64::from(hm - 1);
    let clamped_px = px.clamp(f64::from(vx), f64::from(vx + vw - 1));
    let clamped_py = py.clamp(f64::from(vy), f64::from(vy + vh - 1));

    let denom_x = f64::from((vw - 1).max(1));
    let denom_y = f64::from((vh - 1).max(1));
    let abs_x = (65535.0 * (clamped_px - f64::from(vx)) / denom_x)
        .round()
        .clamp(0.0, 65535.0) as i32;
    let abs_y = (65535.0 * (clamped_py - f64::from(vy)) / denom_y)
        .round()
        .clamp(0.0, 65535.0) as i32;
    (abs_x, abs_y)
}

#[cfg(all(target_os = "windows", not(test)))]
fn primary_monitor_physical_rect() -> (i32, i32, i32, i32) {
    const MONITOR_DEFAULTTOPRIMARY: u32 = 1;
    let monitor = unsafe { MonitorFromPoint(WinPoint { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let mut info = WinMonitorInfo {
        size: std::mem::size_of::<WinMonitorInfo>() as u32,
        monitor: WinRect::default(),
        work: WinRect::default(),
        flags: 0,
    };
    if monitor != 0 && unsafe { GetMonitorInfoW(monitor, &mut info) } != 0 {
        let w = (info.monitor.right - info.monitor.left).max(1);
        let h = (info.monitor.bottom - info.monitor.top).max(1);
        return (info.monitor.left, info.monitor.top, w, h);
    }
    let w = unsafe { GetSystemMetrics(0) }.max(1);
    let h = unsafe { GetSystemMetrics(1) }.max(1);
    (0, 0, w, h)
}

/// Maps normalized `[0, 1]` coordinates onto the primary monitor's physical pixel rectangle,
/// then normalizes across the full virtual desktop (`SM_XVIRTUALSCREEN..SM_CXVIRTUALSCREEN`,
/// `SM_YVIRTUALSCREEN..SM_CYVIRTUALSCREEN`) with `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`.
pub(super) fn inject_absolute_virtual_desk(u: f64, v: f64) -> Result<(), String> {
    if !u.is_finite() || !v.is_finite() {
        return Err("Absolute pointer coordinates must be finite".into());
    }
    const MOUSEEVENTF_MOVE: u32 = 0x0001;
    const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;
    const MOUSEEVENTF_VIRTUALDESK: u32 = 0x4000;
    const FLAGS: u32 = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

    #[cfg(test)]
    {
        let (abs_x, abs_y) =
            normalize_primary_to_virtual_desk(u, v, (0, 0, 1920, 1080), (0, 0, 1920, 1080));
        ABSOLUTE_MOUSE_MOVES.with(|events| {
            events.borrow_mut().push((abs_x, abs_y, FLAGS));
        });
        return Ok(());
    }

    #[cfg(all(target_os = "windows", not(test)))]
    {
        let primary = primary_monitor_physical_rect();
        let vx = unsafe { GetSystemMetrics(76) };
        let vy = unsafe { GetSystemMetrics(77) };
        let vw = unsafe { GetSystemMetrics(78) }.max(1);
        let vh = unsafe { GetSystemMetrics(79) }.max(1);
        let (abs_x, abs_y) = normalize_primary_to_virtual_desk(u, v, primary, (vx, vy, vw, vh));
        let input = Input {
            kind: 0,
            value: InputValue {
                mouse: MouseInput {
                    dx: abs_x,
                    dy: abs_y,
                    mouse_data: 0,
                    flags: FLAGS,
                    time: 0,
                    extra_info: 0,
                },
            },
        };
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            return Err(format!(
                "Absolute virtual desk pointer injection failed (u={u:.4}, v={v:.4}): {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    #[cfg(all(not(target_os = "windows"), not(test)))]
    {
        let _ = (u, v, FLAGS);
        Err("Absolute virtual desk pointer injection is only supported on Windows".into())
    }
}

pub(super) fn send_absolute_mouse_move(abs_x: u16, abs_y: u16) {
    const MOUSEEVENTF_MOVE: u32 = 0x0001;
    const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;
    let input = Input {
        kind: 0,
        value: InputValue {
            mouse: MouseInput {
                dx: i32::from(abs_x),
                dy: i32::from(abs_y),
                mouse_data: 0,
                flags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                time: 0,
                extra_info: 0,
            },
        },
    };
    #[cfg(test)]
    {
        ABSOLUTE_MOUSE_MOVES.with(|events| {
            let mouse = unsafe { input.value.mouse };
            events.borrow_mut().push((mouse.dx, mouse.dy, mouse.flags));
        });
    }
    #[cfg(not(test))]
    {
        let sent = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
        if sent != 1 {
            log::warn!(
                target: "axonkey::input",
                "Absolute cursor move injection failed: x={abs_x}, y={abs_y}, error={}",
                std::io::Error::last_os_error()
            );
        }
    }
}

fn paste_text(text: &str) {
    super::text_output::paste_with(text, || {
        let keys = behavior_chord(&NativeBehavior::Shortcut {
            enabled: true,
            keys: vec!["Ctrl".into(), "V".into()],
        })
        .unwrap();
        send_mouse_chord_with(&keys, 0, send_keyboard_inputs);
    });
}

fn send_unicode_text(text: &str) {
    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const KEYEVENTF_UNICODE: u32 = 0x0004;
    let mut expected_events = 0;
    let mut sent_events = 0;
    for code_unit in text.encode_utf16() {
        let input = |flags| Input {
            kind: INPUT_KEYBOARD,
            value: InputValue {
                keyboard: KeyboardInput {
                    virtual_key: 0,
                    scan_code: code_unit,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        };
        let inputs = [
            input(KEYEVENTF_UNICODE),
            input(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
        ];
        expected_events += inputs.len() as u32;
        #[cfg(test)]
        {
            UNICODE_EVENTS.with(|events| {
                events.borrow_mut().extend(inputs.iter().map(|input| {
                    let key = unsafe { input.value.keyboard };
                    (key.scan_code, key.flags)
                }))
            });
            sent_events += inputs.len() as u32;
        }
        #[cfg(not(test))]
        {
            sent_events += unsafe {
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    std::mem::size_of::<Input>() as i32,
                )
            };
        }
    }
    log::info!(target: "axonkey::input", "Mapped text input output: expected_events={expected_events}, sent_events={sent_events}");
    if sent_events != expected_events {
        log::warn!(target: "axonkey::input", "Mapped text input injection incomplete: expected_events={expected_events}, sent_events={sent_events}");
    }
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn MapVirtualKeyW(code: u32, map_type: u32) -> u32;
    fn SendInput(input_count: u32, inputs: *const Input, input_size: i32) -> u32;
    fn GetCursorPos(point: *mut WinPoint) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn MonitorFromPoint(point: WinPoint, flags: u32) -> isize;
    fn GetMonitorInfoW(monitor: isize, info: *mut WinMonitorInfo) -> i32;
}

#[cfg(not(target_os = "windows"))]
#[allow(non_snake_case)]
unsafe fn MapVirtualKeyW(code: u32, map_type: u32) -> u32 {
    match (code, map_type) {
        (0xa0, 0) => 0x2a,
        (0xa2 | 0xa3, 0) => 0x1d,
        (0xa4 | 0xa5, 0) => 0x38,
        (0xa3, 4) => 0xe01d,
        (0xa5, 4) => 0xe038,
        (0x5b, 0) => 0x5b,
        (0x5c, 0) => 0x5c,
        _ => 0,
    }
}

#[cfg(not(target_os = "windows"))]
#[allow(non_snake_case)]
unsafe fn SendInput(_input_count: u32, _inputs: *const Input, _input_size: i32) -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    mod managed_regressions {
        use super::*;
        use crate::input_service::remote_actions::RemoteActions;
        use serde_json::json;

        struct Harness {
            channel: ManagedQuarborChannel,
            context: QuarborContext,
            actions: RemoteActions,
            epoch: u64,
            start: Instant,
        }

        impl Harness {
            fn new(settings: NativeSettings) -> Self {
                MOUSE_KEY_BATCHES.with(|events| events.borrow_mut().clear());
                UNICODE_EVENTS.with(|events| events.borrow_mut().clear());
                Self {
                    channel: ManagedQuarborChannel {
                        kind: "cmiotA15".into(),
                        shared: Arc::new(Shared {
                            recording_requests: Mutex::new(Vec::new()),
                            instance_id: Some("test-device".into()),
                            settings: RwLock::new(settings),
                            settings_revision: AtomicU64::new(0),
                            status: Mutex::new(InputServiceStatus::default()),
                            event_app: RwLock::new(None),
                            stop: AtomicBool::new(false),
                            driver_gate: Arc::new(AtomicBool::new(false)),
                            driver_paused: AtomicBool::new(false),
                            managed_event: None,
                            managed_input: None,
                            managed_remote_owned: AtomicBool::new(false),
                        }),
                        worker: Mutex::new(None),
                    },
                    context: QuarborContext::default(),
                    actions: RemoteActions::default(),
                    epoch: 0,
                    start: Instant::now(),
                }
            }

            fn tick(&mut self, settings: &NativeSettings, ms: u64, edges: &[bool]) {
                self.channel.update_settings(settings.clone());
                self.context
                    .keys
                    .extend(edges.iter().map(|pressed| RemoteKeyEvent {
                        button: "up",
                        pressed: *pressed,
                    }));
                process_remote_actions(
                    &mut self.context,
                    &self.channel.shared,
                    &mut self.actions,
                    &mut self.epoch,
                    self.start + Duration::from_millis(ms),
                );
            }
        }

        fn a15_report(context: &mut QuarborContext, sequence: u64, bytes: Vec<u8>) {
            use crate::input_service::windows_quarbor::{Event, Metadata};
            quarbor_accept_event(
                context,
                Event::Report {
                    metadata: Metadata {
                        sequence,
                        dropped: context.dropped,
                        ..Default::default()
                    },
                    bytes,
                },
            );
        }

        #[test]
        fn sony_atvv_tap_runs_the_instance_shortcut_and_releases_its_keys() {
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true,
                "behaviors": {
                    "rmf-tx800c.voice": {"click": [{"type": "shortcut", "keys": ["Ctrl", "K"]}]}
                }
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.context.device_kind = Some("rmfTx800c".into());
            harness.context.descriptor =
                crate::devices::descriptor_registry::bundled_descriptor_for_kind("rmfTx800c");
            harness.context.descriptor_engine = Some(Default::default());
            let updates = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&updates);
            Arc::get_mut(&mut harness.channel.shared)
                .unwrap()
                .managed_input = Some(Arc::new(move |_, pressed| {
                captured.lock().unwrap().push(pressed);
            }));
            RC902_VOICE_KEY_EDGES.with(|edges| edges.borrow_mut().clear());

            a15_report(&mut harness.context, 1, vec![4, 0x89, 0, 0, 0]);
            harness.tick(&settings, 0, &[]);
            harness.context.voice_taps.push_back(harness.start);
            harness.tick(&settings, 10, &[]);
            harness.tick(&settings, 700, &[]);

            assert_eq!(
                take_test_keyboard_batches(),
                [
                    vec![(0xa2, 0)],
                    vec![(0x4b, 0)],
                    vec![(0x4b, 2)],
                    vec![(0xa2, 2)]
                ]
            );
            assert_eq!(
                *updates.lock().unwrap(),
                [
                    vec!["rmf-tx800c.tv"],
                    vec!["rmf-tx800c.tv", "rmf-tx800c.voice"],
                    vec!["rmf-tx800c.tv"]
                ]
            );
            assert!(harness.context.keyboard.held.is_empty());
            RC902_VOICE_KEY_EDGES.with(|edges| assert!(edges.borrow().is_empty()));
        }

        #[test]
        fn a15_click_report_gaps_preserve_real_voice_edges_and_release_right_alt() {
            use crate::input_service::windows_quarbor::{Event, Metadata};
            for status_drop in [false, true] {
                let settings: NativeSettings = serde_json::from_value(json!({
                    "enabled": true,
                    "cmiotA15RecordingMode": "click",
                    "behaviors": {"cmiotA15.voice": {"click": [{"type": "key", "key": "RAlt"}]}}
                }))
                .unwrap();
                let mut harness = Harness::new(settings.clone());
                harness.context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_remote\instance".into());
                harness.context.descriptor =
                    crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
                A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
                let mut voice = vec![0; 21];
                voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
                a15_report(&mut harness.context, 1, voice.clone());
                harness.tick(&settings, 0, &[]);
                assert_eq!(harness.context.keyboard.held.len(), 1);

                if status_drop {
                    quarbor_accept_event(
                        &mut harness.context,
                        Event::Status(Metadata {
                            dropped: 1,
                            ..Default::default()
                        }),
                    );
                } else {
                    a15_report(&mut harness.context, 3, voice.clone());
                }
                assert!(
                    harness.context.keys.is_empty(),
                    "no synthetic voice release"
                );
                harness.tick(&settings, 10, &[]);
                assert!(harness.context.a15_recording.is_recording());
                assert!(harness.channel.status().cmiot_a15_recording);
                assert!(harness.context.keyboard.held.is_empty());
                MOUSE_KEY_BATCHES.with(|events| {
                    assert_eq!(*events.borrow(), [vec![(0xa5, 1)], vec![(0xa5, 3)]]);
                });
                let mut sequence = harness.context.last_sequence.unwrap();
                for _ in 0..4 {
                    sequence += 1;
                    a15_report(&mut harness.context, sequence, voice.clone());
                }
                harness.tick(&settings, 20, &[]);
                assert!(harness.context.keyboard.held.is_empty());
                assert!(harness.context.a15_recording.is_recording());

                voice[3] = 0;
                sequence += 1;
                a15_report(&mut harness.context, sequence, voice.clone());
                harness.tick(&settings, 30, &[]);
                assert!(harness.context.a15_recording.is_recording());
                voice[3] = 1;
                sequence += 1;
                a15_report(&mut harness.context, sequence, voice.clone());
                harness.tick(&settings, 40, &[]);
                assert!(!harness.context.a15_recording.is_recording());
                // A gap after the stop must not turn repeated held F8 into a new press.
                a15_report(&mut harness.context, sequence + 2, voice);
                harness.tick(&settings, 50, &[]);
                assert!(!harness.context.a15_recording.is_recording());
                assert!(harness.context.keyboard.held.is_empty());
                A15_RECORDING_REPORTS.with(|reports| {
                    assert_eq!(*reports.borrow(), [[0xfb, 1], [0xfb, 0]]);
                });
            }
        }

        #[test]
        fn a15_click_report_gap_discards_pcm_and_resynchronizes_at_next_fc_group() {
            use crate::devices::cmiot_a15::recording::RecordingMode;
            let mut context = QuarborContext::default();
            context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_remote\instance".into());
            context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            context
                .a15_recording
                .synchronize(RecordingMode::Click, true, |_| Ok::<_, ()>(()))
                .unwrap();
            context
                .a15_recording
                .edge(true, |_| Ok::<_, ()>(()))
                .unwrap();
            context.a15_voice.synchronize(true);
            let reports = [
                vec![
                    0xfc, 0x4b, 0x5f, 0, 0, 0x48, 0xbc, 0x92, 0xd4, 0xde, 0xeb, 0x0e, 0xc1, 0x9e,
                    0x2d, 0x5f, 0xb0, 0x56, 0xe6, 0x9a, 0x06,
                ],
                vec![
                    0xfc, 0x4b, 0x5f, 1, 0, 1, 0xef, 0x2e, 0xb0, 0x4d, 0x0c, 0x71, 0xec, 0x7c,
                    0xbc, 0x18, 0x30, 0x8c, 0x31, 0xbb, 0xad,
                ],
                vec![
                    0xfc, 0x4b, 0x5f, 2, 0, 0xf2, 2, 0xb2, 0x92, 0x95, 6, 0x21, 0x91, 4, 0, 0x1d,
                    0, 0, 0, 0, 0,
                ],
            ];
            for (index, report) in reports.iter().enumerate() {
                a15_report(&mut context, index as u64 + 1, report.clone());
            }
            assert_eq!(context.a15_pcm.len(), 1);
            a15_report(&mut context, 4, reports[0].clone());
            a15_report(&mut context, 6, reports[1].clone());
            a15_report(&mut context, 7, reports[2].clone());
            assert!(context.a15_recording.is_recording());
            assert!(context.a15_pcm.is_empty());
            for (index, report) in reports.iter().enumerate() {
                a15_report(&mut context, index as u64 + 8, report.clone());
            }
            let frame = context.a15_pcm.pop_front().unwrap();
            assert_eq!(frame.group, 0x5f4b);
            assert_eq!(frame.samples.len(), 320);
            assert!(context.a15_pcm.is_empty());
        }

        #[test]
        fn a15_hold_gaps_and_click_connection_errors_still_stop_recording() {
            use crate::input_service::windows_quarbor::{Event, Metadata};
            for (mode, reason) in [
                ("hold", ReleaseReason::ReportGap),
                ("hold", ReleaseReason::StatusDropped),
                ("click", ReleaseReason::StatusError),
                ("click", ReleaseReason::PipeError),
                ("click", ReleaseReason::OutputError),
                ("click", ReleaseReason::Shutdown),
            ] {
                let settings: NativeSettings = serde_json::from_value(json!({
                    "enabled": true, "cmiotA15RecordingMode": mode
                }))
                .unwrap();
                let mut harness = Harness::new(settings.clone());
                harness.context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_remote\instance".into());
                harness.context.descriptor =
                    crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
                A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
                let mut voice = vec![0; 21];
                voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
                a15_report(&mut harness.context, 1, voice);
                harness.tick(&settings, 0, &[]);
                match reason {
                    ReleaseReason::ReportGap => a15_report(&mut harness.context, 3, vec![0xfc; 21]),
                    ReleaseReason::StatusDropped | ReleaseReason::StatusError => {
                        quarbor_accept_event(
                            &mut harness.context,
                            Event::Status(Metadata {
                                dropped: 1,
                                status: if matches!(reason, ReleaseReason::StatusError) {
                                    0xc0000001
                                } else {
                                    0
                                },
                                ..Default::default()
                            }),
                        );
                    }
                    ReleaseReason::OutputError => quarbor_output_error(
                        &mut harness.context,
                        std::io::Error::other("test output failure"),
                    ),
                    _ => quarbor_release_inputs(&mut harness.context, reason),
                }
                harness.tick(&settings, 10, &[]);
                assert!(
                    !harness.context.a15_recording.is_recording(),
                    "{mode}: {reason:?}"
                );
                assert!(!harness.channel.status().cmiot_a15_recording);
                assert!(harness.context.a15_pcm.is_empty());
                A15_RECORDING_REPORTS.with(|reports| {
                    assert_eq!(
                        *reports.borrow(),
                        [[0xfb, 1], [0xfb, 0]],
                        "{mode}: {reason:?}"
                    );
                });
            }
        }

        #[test]
        fn stopping_a15_from_overlay_never_restarts_recording_on_repeated_clicks() {
            let settings = NativeSettings {
                enabled: true,
                ..Default::default()
            };
            let mut harness = Harness::new(settings.clone());
            harness.context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_remote\instance".into());
            harness.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            harness.channel.shared.status.lock().unwrap().capture_active = true;
            A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
            let (reply, result) = std::sync::mpsc::sync_channel(1);
            harness.channel.toggle_recording(reply);
            harness.tick(&settings, 1, &[]);
            assert!(result.try_recv().unwrap().unwrap());
            for ms in [2, 3] {
                let (reply, result) = std::sync::mpsc::sync_channel(1);
                harness.channel.stop_recording(reply);
                harness.tick(&settings, ms, &[]);
                assert!(!result.try_recv().unwrap().unwrap());
                assert!(!harness.channel.status().cmiot_a15_recording);
            }
            A15_RECORDING_REPORTS
                .with(|reports| assert_eq!(*reports.borrow(), [[0xfb, 1], [0xfb, 0]]));
        }

        #[test]
        fn manual_a15_recording_is_scoped_to_its_channel_and_rejects_disconnection() {
            let settings = NativeSettings {
                enabled: true,
                ..Default::default()
            };
            let mut first = Harness::new(settings.clone());
            let second = Harness::new(settings.clone());
            first.context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_remote\instance".into());
            first.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            first.channel.shared.status.lock().unwrap().capture_active = true;
            A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
            for (ms, expected) in [(1, true), (2, false)] {
                let (reply, result) = std::sync::mpsc::sync_channel(1);
                first.channel.toggle_recording(reply);
                first.tick(&settings, ms, &[]);
                assert_eq!(result.try_recv().unwrap().unwrap(), expected);
                assert_eq!(first.channel.status().cmiot_a15_recording, expected);
                assert!(!second.channel.status().cmiot_a15_recording);
            }
            A15_RECORDING_REPORTS
                .with(|reports| assert_eq!(*reports.borrow(), [[0xfb, 1], [0xfb, 0]]));
            first.channel.shared.status.lock().unwrap().capture_active = false;
            let (reply, result) = std::sync::mpsc::sync_channel(1);
            first.channel.toggle_recording(reply);
            first.tick(&settings, 3, &[]);
            assert!(result.try_recv().unwrap().is_err());
            assert!(!first.channel.status().cmiot_a15_recording);
        }

        #[test]
        fn xbox_quarbor_reports_drive_mapping_analog_feedback_and_disconnect_release() {
            use crate::input_service::windows_quarbor::{Event, Metadata};
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true,
                "behaviors": {"xbox.a": {"click": [{"type": "key", "key": "A"}]}}
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.context.device_id = Some(r"HID\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002045E_PID&02E0\C&1B61B8A0&0&0000".into());
            harness.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("xboxBluetooth");
            let updates = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&updates);
            Arc::get_mut(&mut harness.channel.shared)
                .unwrap()
                .managed_input = Some(Arc::new(move |values, pressed| {
                captured.lock().unwrap().push((values, pressed));
            }));
            let bytes = vec![1, 0, 128, 0, 128, 0, 128, 0, 128, 0, 2, 0, 0, 0, 1, 0];
            for (sequence, bytes) in [(1, bytes.clone()), (2, vec![2, 1])] {
                quarbor_accept_event(
                    &mut harness.context,
                    Event::Report {
                        metadata: Metadata {
                            sequence,
                            ..Default::default()
                        },
                        bytes,
                    },
                );
                harness.tick(&settings, sequence * 10, &[]);
            }
            {
                let updates = updates.lock().unwrap();
                let (values, pressed) = updates.last().unwrap();
                assert_eq!(values["xbox.a"], 1.0);
                assert!((values["xbox.lt"] - 512.0 / 1023.0).abs() < 0.0001);
                assert!(pressed.contains(&"xbox.a".to_string()));
                assert!(pressed.contains(&"xbox.guide".to_string()));
                assert!(!pressed.contains(&"xbox.lt".to_string()));
            }
            assert!(harness.context.usage_error.is_none());
            assert_eq!(harness.context.keyboard.held.len(), 1);
            quarbor_release_inputs(&mut harness.context, ReleaseReason::Test);
            harness.tick(&settings, 40, &[]);
            let updates = updates.lock().unwrap();
            assert!(updates
                .last()
                .unwrap()
                .0
                .values()
                .all(|value| *value == 0.0));
            assert!(updates.last().unwrap().1.is_empty());
            assert!(harness.context.keyboard.held.is_empty());
            MOUSE_KEY_BATCHES.with(|events| {
                assert_eq!(*events.borrow(), vec![vec![(0x41, 0)], vec![(0x41, 2)]])
            });
            assert_eq!(
                harness.context.events.len(),
                2,
                "original reports remain available until the batch is drained"
            );
        }

        #[test]
        fn a15_voice_records_and_maps_right_alt_in_both_recording_modes() {
            use crate::input_service::windows_quarbor::{Event, Metadata};

            for mode in ["hold", "click"] {
                A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
                let settings: NativeSettings = serde_json::from_value(json!({
                    "enabled": true,
                    "cmiotA15RecordingMode": mode,
                    "behaviors": {"cmiotA15.voice": {"click": [{"type": "key", "key": "RAlt"}]}}
                }))
                .unwrap();
                let mut harness = Harness::new(settings.clone());
                harness.context.device_id = Some(
                    r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_AABBCCDDEEFF\instance".into()
                );
                harness.context.descriptor =
                    crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
                let mut sequence = 0;
                for (index, down) in [true, false, true, false].into_iter().enumerate() {
                    // Real driver traffic repeats each F8 report four times.
                    for _ in 0..4 {
                        sequence += 1;
                        let mut bytes = vec![0; 21];
                        bytes[..4].copy_from_slice(&[0xf8, 0x82, 3, u8::from(down)]);
                        quarbor_accept_event(
                            &mut harness.context,
                            Event::Report {
                                metadata: Metadata {
                                    sequence,
                                    ..Default::default()
                                },
                                bytes,
                            },
                        );
                    }
                    harness.tick(&settings, index as u64 * 1000, &[]);
                    assert_eq!(
                        harness.context.a15_recording.is_recording(),
                        if mode == "hold" { down } else { index < 2 }
                    );
                    assert_eq!(harness.context.keyboard.held.len(), usize::from(down));
                    MOUSE_KEY_BATCHES.with(|events| assert_eq!(events.borrow().len(), index + 1));
                }
                MOUSE_KEY_BATCHES.with(|events| {
                    assert_eq!(
                        *events.borrow(),
                        vec![
                            vec![(0xa5, 1)],
                            vec![(0xa5, 3)],
                            vec![(0xa5, 1)],
                            vec![(0xa5, 3)],
                        ]
                    )
                });
                A15_RECORDING_REPORTS.with(|reports| {
                    assert_eq!(
                        *reports.borrow(),
                        if mode == "hold" {
                            vec![[0xfb, 1], [0xfb, 0], [0xfb, 1], [0xfb, 0]]
                        } else {
                            vec![[0xfb, 1], [0xfb, 0]]
                        }
                    )
                });
            }
        }

        #[test]
        fn rc802a_windows_channel_sends_eb_and_decodes_ec_into_the_audio_queue() {
            A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true, "cmiotA15RecordingMode": "hold",
                "behaviors": {"tcl-rc802a.voice": {"click": [{"type":"key", "key":"RAlt"}]}}
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("tclRc802a");
            harness.context.a15_voice = crate::devices::tcl_rc802a::voice_stream();
            let reports = crate::devices::cmiot_a15::voice::ico_test_reports(0xec);
            a15_report(&mut harness.context, 1, vec![1, 0, 0, 0xad, 0, 0, 0, 0, 0]);
            harness.tick(&settings, 0, &[]);
            assert!(harness.context.a15_recording.is_recording());
            for (index, report) in reports[0].iter().enumerate() {
                a15_report(&mut harness.context, index as u64 + 2, report.to_vec());
            }
            let pcm = harness.context.a15_pcm.front().unwrap();
            assert_eq!(pcm.samples.len(), 320);
            assert_eq!(pcm.sample_rate, 16000);
            assert!(pcm.samples.iter().all(|sample| sample & 3 == 0));
            a15_report(&mut harness.context, 5, vec![1, 0, 0, 0, 0, 0, 0, 0, 0]);
            harness.tick(&settings, 100, &[]);
            assert!(!harness.context.a15_recording.is_recording());
            A15_RECORDING_REPORTS
                .with(|reports| assert_eq!(*reports.borrow(), [[0xeb, 1], [0xeb, 0]]));
        }

        #[test]
        fn obe_keyboard_voice_records_without_sending_recording_hid() {
            for mode in ["hold", "click"] {
                A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
                let settings: NativeSettings = serde_json::from_value(json!({
                    "enabled": true,
                    "cmiotA15RecordingMode": mode,
                    "behaviors": {"obeRcuR5.voice": {"click": [{"type": "key", "key": "RAlt"}]}}
                }))
                .unwrap();
                let mut harness = Harness::new(settings.clone());
                harness.context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&011D5A_PID&C081_REV&0000_C9B5965E4F92\8&30D338AA&0&001F".into());
                harness.context.descriptor =
                    crate::devices::descriptor_registry::descriptor_for_kind("obeRcuR5");
                for (index, down) in [true, false, true, false].into_iter().enumerate() {
                    a15_report(
                        &mut harness.context,
                        index as u64 + 1,
                        vec![1, 0, 0, if down { 0x73 } else { 0 }, 0, 0, 0, 0, 0],
                    );
                    harness.tick(&settings, index as u64 * 1000, &[]);
                    assert_eq!(harness.context.keyboard.held.len(), usize::from(down));
                    assert_eq!(
                        harness.context.a15_recording.is_recording(),
                        if mode == "hold" { down } else { index < 2 }
                    );
                }
                MOUSE_KEY_BATCHES.with(|events| {
                    assert_eq!(
                        *events.borrow(),
                        [
                            vec![(0xa5, 1)],
                            vec![(0xa5, 3)],
                            vec![(0xa5, 1)],
                            vec![(0xa5, 3)]
                        ]
                    )
                });
                A15_RECORDING_REPORTS.with(|reports| assert!(reports.borrow().is_empty()));
            }
        }

        #[test]
        fn rc902_assistant_key_forwards_voice_edges_without_hid_output_reports() {
            for (kind, behavior_key) in [
                ("tclRc902n", "tcl-rc902n.assistant"),
                ("tclRc902v", "tcl-rc902v.assistant"),
            ] {
                for mode in ["hold", "click"] {
                    A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
                    RC902_VOICE_KEY_EDGES.with(|edges| edges.borrow_mut().clear());
                    let settings: NativeSettings = serde_json::from_value(json!({
                        "enabled": true,
                        "cmiotA15RecordingMode": mode,
                        "behaviors": {behavior_key: {"click": [{"type": "key", "key": "RAlt"}]}}
                    }))
                    .unwrap();
                    let mut harness = Harness::new(settings.clone());
                    harness.context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010417_PID&0304_REV&0001_A1B2C3D4E5F6\8&1&0&001F".into());
                    harness.context.descriptor =
                        crate::devices::descriptor_registry::descriptor_for_kind(kind);
                    for (index, down) in [true, false, true, false].into_iter().enumerate() {
                        a15_report(
                            &mut harness.context,
                            index as u64 + 1,
                            if down {
                                vec![0x03, 0x21, 0x02]
                            } else {
                                vec![0x03, 0x00, 0x00]
                            },
                        );
                        harness.tick(&settings, index as u64 * 1000, &[]);
                        assert_eq!(harness.context.keyboard.held.len(), usize::from(down));
                    }
                    RC902_VOICE_KEY_EDGES.with(|edges| {
                        assert_eq!(*edges.borrow(), vec![true, false, true, false]);
                    });
                    A15_RECORDING_REPORTS.with(|reports| assert!(reports.borrow().is_empty()));
                }
            }
        }

        #[test]
        fn a15_instances_keep_report_edges_mappings_and_profile_switches_separate() {
            let make_settings = |key: &str| {
                serde_json::from_value::<NativeSettings>(json!({
                "enabled": true, "behaviors": {"cmiotA15.up": {"click": [{"type":"key", "key":key}]}}
            })).unwrap()
            };
            let first_settings = make_settings("A");
            let second_settings = make_settings("B");
            let mut first = Harness::new(first_settings.clone());
            let mut second = Harness::new(second_settings.clone());
            let node = |address: &str| {
                format!(
                    r"BTHLEDEVICE\{{00001812-0000-1000-8000-00805F9B34FB}}_DEV_VID&010416_PID&0300_REV&0100_{address}\instance"
                )
            };
            first.context.device_id = Some(node("AABBCCDDEE01"));
            first.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            second.context.device_id = Some(
                r"BTHLEDEVICE{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&050416_PID&0300_REV&0505_0CF3CE7F241E\8&11237C06&0&0025".into(),
            );
            second.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            let report = |context: &mut QuarborContext, sequence, down| {
                quarbor_accept_event(
                    context,
                    super::super::super::windows_quarbor::Event::Report {
                        metadata: super::super::super::windows_quarbor::Metadata {
                            sequence,
                            ..Default::default()
                        },
                        bytes: vec![1, 0, 0, if down { 0x52 } else { 0 }, 0, 0, 0, 0, 0],
                    },
                );
            };
            report(&mut first.context, 1, true);
            report(&mut second.context, 1, true);
            first.tick(&first_settings, 0, &[]);
            second.tick(&second_settings, 0, &[]);
            report(&mut first.context, 2, false);
            first.tick(&first_settings, 50, &[]);
            assert_eq!(second.context.keyboard.held.len(), 1);
            report(&mut second.context, 2, false);
            second.tick(&second_settings, 80, &[]);
            MOUSE_KEY_BATCHES.with(|events| {
                assert_eq!(
                    *events.borrow(),
                    vec![
                        vec![(0x41, 0)],
                        vec![(0x42, 0)],
                        vec![(0x41, 2)],
                        vec![(0x42, 2)]
                    ]
                )
            });
            let switches = Arc::new(Mutex::new(Vec::new()));
            for (id, harness) in [("first", &mut first), ("second", &mut second)] {
                let switches = Arc::clone(&switches);
                harness.context.switch_profile = Some(Arc::new(move |direction, wrap| {
                    switches.lock().unwrap().push((id, direction, wrap))
                }));
            }
            emit_remote_output(
                &mut first.context,
                crate::input_service::remote_actions::Output::SwitchProfile(
                    super::super::super::ProfileDirection::Next,
                    true,
                ),
                "test-instance",
            )
            .unwrap();
            assert_eq!(switches.lock().unwrap().len(), 1);
            assert_eq!(switches.lock().unwrap()[0].0, "first");
        }

        #[test]
        fn repeated_settings_preserve_wait_and_following_key() {
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true, "behaviors": {"up": {"click": [
                    {"type": "key", "key": "A"},
                    {"type": "delay", "ms": 100},
                    {"type": "key", "key": "B"}
                ]}}
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.tick(&settings, 0, &[true, false]);
            for ms in (8..100).step_by(8) {
                harness.tick(&settings, ms, &[]);
            }
            MOUSE_KEY_BATCHES.with(|events| {
                assert_eq!(*events.borrow(), vec![vec![(0x41, 0)], vec![(0x41, 2)]])
            });
            harness.tick(&settings, 100, &[]);
            MOUSE_KEY_BATCHES.with(|events| {
                assert_eq!(
                    *events.borrow(),
                    vec![
                        vec![(0x41, 0)],
                        vec![(0x41, 2)],
                        vec![(0x42, 0)],
                        vec![(0x42, 2)]
                    ]
                )
            });
        }

        #[test]
        fn repeated_settings_preserve_type_text_press_until_release() {
            let text = "中文🙂\nsecond line";
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true, "behaviors": {"up": {"click": [
                    {"type": "typeText", "text": text}
                ]}}
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.tick(&settings, 0, &[true]);
            for ms in (8..80).step_by(8) {
                harness.tick(&settings, ms, &[]);
            }
            UNICODE_EVENTS.with(|events| assert!(events.borrow().is_empty()));
            harness.tick(&settings, 80, &[false]);
            harness.tick(&settings, 88, &[]);
            UNICODE_EVENTS.with(|events| {
                let events = events.borrow();
                assert_eq!(events.len(), text.encode_utf16().count() * 2);
                let typed: Vec<u16> = events
                    .iter()
                    .filter(|(_, flags)| *flags == 4)
                    .map(|(unit, _)| *unit)
                    .collect();
                assert_eq!(String::from_utf16(&typed).unwrap(), text);
                assert!(events
                    .chunks_exact(2)
                    .all(|pair| pair[0].0 == pair[1].0 && pair[1].1 == 6));
            });
        }

        #[test]
        fn changed_mapping_or_disable_still_cancels_pending_type_text() {
            for disable in [false, true] {
                let mut settings: NativeSettings = serde_json::from_value(json!({
                    "enabled": true, "behaviors": {"up": {"click": [
                        {"type": "delay", "ms": 100},
                        {"type": "typeText", "text": "must not be typed"}
                    ]}}
                }))
                .unwrap();
                let mut harness = Harness::new(settings.clone());
                harness.tick(&settings, 0, &[true, false]);
                if disable {
                    settings.enabled = false;
                } else {
                    settings.behaviors.clear();
                }
                harness.tick(&settings, 80, &[]);
                harness.tick(&settings, 100, &[]);
                UNICODE_EVENTS.with(|events| assert!(events.borrow().is_empty()));
            }
        }

        #[test]
        fn hisense_rcf3b65_pointer_reports_drive_absolute_mouse_without_key_edges() {
            let mut settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true,
                "behaviors": {}
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.context.device_kind = Some("hisenseRcf3b65".into());
            harness.context.descriptor = None;
            ABSOLUTE_MOUSE_MOVES.with(|events| events.borrow_mut().clear());

            a15_report(
                &mut harness.context,
                1,
                vec![0x3f, 0x10, 0x90, 0x63, 0x27, 0x0d, 0x00, 0x00, 0x00],
            );
            a15_report(
                &mut harness.context,
                2,
                vec![0x3f, 0x10, 0x90, 0x63, 0xd5, 0x0d, 0x00, 0x00, 0x00],
            );
            assert!(harness.context.keys.is_empty());
            harness.tick(&settings, 0, &[]);
            ABSOLUTE_MOUSE_MOVES.with(|events| {
                assert_eq!(
                    *events.borrow(),
                    vec![(50_977, 6_734, 0x8001), (50_977, 7_082, 0x8001)]
                );
            });
            MOUSE_KEY_BATCHES.with(|events| assert!(events.borrow().is_empty()));

            ABSOLUTE_MOUSE_MOVES.with(|events| events.borrow_mut().clear());
            settings.enabled = false;
            a15_report(
                &mut harness.context,
                3,
                vec![0x3f, 0x10, 0x90, 0x63, 0xd5, 0x0d, 0x00, 0x00, 0x00],
            );
            harness.tick(&settings, 16, &[]);
            ABSOLUTE_MOUSE_MOVES.with(|events| assert!(events.borrow().is_empty()));

            let mut other = Harness::new(
                serde_json::from_value(json!({"enabled": true, "behaviors": {}})).unwrap(),
            );
            other.context.device_kind = Some("cmiotA15".into());
            other.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            a15_report(
                &mut other.context,
                1,
                vec![0x3f, 0x10, 0x90, 0x63, 0x27, 0x0d, 0x00, 0x00, 0x00],
            );
            other.tick(
                &serde_json::from_value(json!({"enabled": true, "behaviors": {}})).unwrap(),
                0,
                &[],
            );
            ABSOLUTE_MOUSE_MOVES.with(|events| assert!(events.borrow().is_empty()));
            assert!(other.context.keys.is_empty());
        }

        #[test]
        fn ble_link_disconnect_releases_held_keys_repeats_and_voice_without_dead_radio_write() {
            A15_RECORDING_REPORTS.with(|reports| reports.borrow_mut().clear());
            WHEEL_EVENTS.with(|events| events.borrow_mut().clear());
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true,
                "cmiotA15RecordingMode": "click",
                "behaviors": {
                    "cmiotA15.up": {"click": [{"type": "key", "key": "A"}]},
                    "cmiotA15.down": {"click": [{"type": "wheel", "direction": "down"}]}
                }
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.context.device_id = Some(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_AABBCCDDEEFF\instance".into(),
            );
            harness.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            let updates = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&updates);
            Arc::get_mut(&mut harness.channel.shared)
                .unwrap()
                .managed_input = Some(Arc::new(move |values, pressed| {
                captured.lock().unwrap().push((values, pressed));
            }));

            a15_report(
                &mut harness.context,
                1,
                vec![1, 0, 0, 0x52, 0x51, 0, 0, 0, 0],
            );
            let mut voice = vec![0; 21];
            voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
            a15_report(&mut harness.context, 2, voice);
            harness.tick(&settings, 0, &[]);

            assert_eq!(harness.context.keyboard.held.len(), 1);
            assert!(harness.context.a15_recording.is_recording());
            MOUSE_KEY_BATCHES.with(|events| assert_eq!(*events.borrow(), vec![vec![(0x41, 0)]]));
            WHEEL_EVENTS.with(|events| assert_eq!(*events.borrow(), [-120]));
            A15_RECORDING_REPORTS.with(|reports| assert_eq!(*reports.borrow(), [[0xfb, 1]]));
            assert_eq!(updates.lock().unwrap().last().unwrap().1.len(), 3);

            // Simulate BLE peripheral radio drop while buttons and recording remain active.
            quarbor_handle_ble_disconnect(&mut harness.context);
            harness.tick(&settings, 500, &[]);
            harness.tick(&settings, 600, &[]);

            assert!(harness.context.keyboard.held.is_empty());
            assert!(!harness.context.a15_recording.is_recording());
            assert!(!harness.channel.status().cmiot_a15_recording);
            MOUSE_KEY_BATCHES.with(|events| {
                assert_eq!(*events.borrow(), vec![vec![(0x41, 0)], vec![(0x41, 2)]]);
            });
            WHEEL_EVENTS.with(|events| {
                assert_eq!(
                    *events.borrow(),
                    [-120],
                    "wheel repeat must stop on BLE disconnect"
                );
            });
            A15_RECORDING_REPORTS.with(|reports| {
                assert_eq!(
                    *reports.borrow(),
                    [[0xfb, 1]],
                    "must not write FB 00 to an offline BLE peripheral"
                );
            });
            assert!(updates.lock().unwrap().last().unwrap().1.is_empty());

            // RC902V voice hold must also emit a false edge and release its held key on BLE drop.
            RC902_VOICE_KEY_EDGES.with(|edges| edges.borrow_mut().clear());
            MOUSE_KEY_BATCHES.with(|events| events.borrow_mut().clear());
            let rc902_settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true,
                "behaviors": {"tcl-rc902v.assistant": {"click": [{"type": "key", "key": "RAlt"}]}}
            }))
            .unwrap();
            let mut rc902 = Harness::new(rc902_settings.clone());
            rc902.context.device_id = Some(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010417_PID&0304_REV&0001_A1B2C3D4E5F6\8&1&0&001F".into(),
            );
            rc902.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("tclRc902v");
            a15_report(&mut rc902.context, 1, vec![0x03, 0x21, 0x02]);
            rc902.tick(&rc902_settings, 0, &[]);
            assert_eq!(rc902.context.keyboard.held.len(), 1);
            quarbor_handle_ble_disconnect(&mut rc902.context);
            rc902.tick(&rc902_settings, 100, &[]);
            assert!(rc902.context.keyboard.held.is_empty());
            RC902_VOICE_KEY_EDGES.with(|edges| assert_eq!(*edges.borrow(), [true, false]));
            MOUSE_KEY_BATCHES.with(|events| {
                assert_eq!(*events.borrow(), vec![vec![(0xa5, 1)], vec![(0xa5, 3)]])
            });
        }

        #[test]
        fn shutdown_cancels_delayed_sequences_and_releases_held_inputs() {
            UNICODE_EVENTS.with(|events| events.borrow_mut().clear());
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true,
                "behaviors": {
                    "up": {"click": [
                        {"type": "delay", "ms": 100},
                        {"type": "typeText", "text": "must not run"}
                    ]},
                    "cmiotA15.confirm": {"click": [{"type": "key", "key": "Enter"}]}
                }
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
            a15_report(&mut harness.context, 1, vec![3, 0x41, 0]);
            harness.tick(&settings, 0, &[true, false]);
            assert_eq!(harness.context.keyboard.held.len(), 1);

            quarbor_shutdown_context(
                &mut harness.context,
                &harness.channel.shared,
                &mut harness.actions,
            );
            assert!(harness.context.keyboard.held.is_empty());
            harness.tick(&settings, 200, &[]);
            UNICODE_EVENTS.with(|events| assert!(events.borrow().is_empty()));
        }

        #[test]
        fn unconsumed_presses_are_dropped_on_disconnect_and_output_errors() {
            let settings: NativeSettings = serde_json::from_value(json!({
                "enabled": true,
                "cmiotA15RecordingMode": "click",
                "behaviors": {
                    "cmiotA15.up": {
                        "click": [{"type": "key", "key": "A"}],
                        "doubleClick": [{"type": "typeText", "text": "phantom"}]
                    }
                }
            }))
            .unwrap();
            let mut harness = Harness::new(settings.clone());
            harness.context.descriptor =
                crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");

            // Press arrives in context.keys, then BLE disconnects before process_remote_actions runs.
            a15_report(&mut harness.context, 1, vec![1, 0, 0, 0x52, 0, 0, 0, 0, 0]);
            assert_eq!(harness.context.keys.len(), 1);
            quarbor_handle_ble_disconnect(&mut harness.context);
            assert!(harness.context.keys.iter().all(|key| !key.pressed));

            harness.tick(&settings, 0, &[]);
            harness.tick(&settings, 100, &[]);
            harness.tick(&settings, 400, &[]);
            MOUSE_KEY_BATCHES.with(|events| assert!(events.borrow().is_empty()));
            UNICODE_EVENTS.with(|events| assert!(events.borrow().is_empty()));

            // OutputError during a15_recording.edge must also drop trailing unconsumed presses.
            FAIL_NEXT_A15_RECORDING_REPORT.with(|fail| fail.set(true));
            let mut voice = vec![0; 21];
            voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
            a15_report(&mut harness.context, 2, voice);
            a15_report(&mut harness.context, 3, vec![1, 0, 0, 0x52, 0, 0, 0, 0, 0]);
            assert_eq!(harness.context.keys.len(), 2);
            harness.tick(&settings, 500, &[]);
            assert!(harness.context.keys.iter().all(|key| !key.pressed));
            harness.tick(&settings, 600, &[]);
            harness.tick(&settings, 950, &[]);
            MOUSE_KEY_BATCHES.with(|events| assert!(events.borrow().is_empty()));
            UNICODE_EVENTS.with(|events| assert!(events.borrow().is_empty()));
        }
    }

    #[test]
    fn text_input_preserves_clipboard_and_paste_uses_shortcut() {
        let text = "中文🙂\nsecond line";
        super::super::text_output::CLIPBOARD.with(|value| *value.borrow_mut() = "original".into());
        UNICODE_EVENTS.with(|events| events.borrow_mut().clear());
        execute_mouse_behavior(
            &NativeBehavior::TypeText {
                enabled: true,
                text: text.into(),
            },
            0,
        );
        let typed = UNICODE_EVENTS.with(|events| {
            events
                .borrow()
                .iter()
                .filter(|(_, flags)| *flags == 4)
                .map(|(unit, _)| *unit)
                .collect::<Vec<_>>()
        });
        assert_eq!(String::from_utf16(&typed).unwrap(), text);
        super::super::text_output::CLIPBOARD.with(|value| assert_eq!(*value.borrow(), "original"));
        UNICODE_EVENTS.with(|events| events.borrow_mut().clear());
        MOUSE_KEY_BATCHES.with(|events| events.borrow_mut().clear());
        execute_mouse_behavior(
            &NativeBehavior::Paste {
                enabled: true,
                text: text.into(),
            },
            0,
        );
        super::super::text_output::CLIPBOARD.with(|value| assert_eq!(*value.borrow(), text));
        UNICODE_EVENTS.with(|events| assert!(events.borrow().is_empty()));
        MOUSE_KEY_BATCHES.with(|events| {
            assert_eq!(
                events.borrow().concat(),
                vec![(0xa2, 0), (0x56, 0), (0x56, 2), (0xa2, 2)]
            )
        });
    }

    #[test]
    fn mouse_updates_preserve_remote_sequences_and_held_keys() {
        use super::super::remote_actions::{Output, RemoteActions};

        for change in [
            "mouse_mapping",
            "mouse_options",
            "remote_mapping",
            "disabled",
        ] {
            let mut settings: NativeSettings = serde_json::from_value(serde_json::json!({
                "enabled": true,
                "behaviors": {
                    "up": {"click": [
                        {"type": "paste", "text": "first"},
                        {"type": "delay", "ms": 100},
                        {"type": "paste", "text": "second"}
                    ]},
                    "voice": {"click": [{"type": "key", "key": "RAlt"}]},
                    "mouse.top.up": {"click": [{"type": "key", "key": "A"}]}
                }
            }))
            .unwrap();
            let service = InputService {
                shared: Arc::new(Shared {
                    recording_requests: Mutex::new(Vec::new()),
                    instance_id: None,
                    settings: RwLock::new(settings.clone()),
                    settings_revision: AtomicU64::new(1),
                    status: Mutex::new(InputServiceStatus::default()),
                    event_app: RwLock::new(None),
                    stop: AtomicBool::new(false),
                    driver_gate: Arc::new(AtomicBool::new(false)),
                    driver_paused: AtomicBool::new(false),
                    managed_event: None,
                    managed_input: None,
                    managed_remote_owned: AtomicBool::new(false),
                }),
                worker: Mutex::new(None),
            };
            let now = Instant::now();
            let mut actions: RemoteActions = RemoteActions::default();
            actions.synchronize(1, true);
            actions.edge("up", true, &settings, now);
            actions.edge("up", false, &settings, now);
            actions.edge("voice", true, &settings, now);
            let mut initial = Vec::new();
            actions.tick(now, |output| initial.push(output));
            assert!(initial.contains(&Output::Paste("first".into())));
            assert!(initial
                .iter()
                .any(|output| matches!(output, Output::Key(_, true))));

            match change {
                "mouse_mapping" => settings.behaviors.remove("mouse.top.up"),
                "mouse_options" => {
                    settings.mouse_enabled = false;
                    settings.mouse_edge_width = 16;
                    settings.mouse_key_hold_ms = 25;
                    settings.mouse_vertical_scroll_interval_ms = 100;
                    settings.mouse_horizontal_scroll_interval_ms = 100;
                    settings.mouse_scroll_sensitivity = 200;
                    settings.mouse_ignore_scroll_acceleration = false;
                    None
                }
                "remote_mapping" => settings.behaviors.remove("up"),
                "disabled" => {
                    settings.enabled = false;
                    None
                }
                _ => unreachable!(),
            };
            service.update_settings(settings.clone()).unwrap();
            actions.synchronize(
                service.shared.settings_revision.load(Ordering::Relaxed),
                settings.enabled,
            );
            let mut remaining = Vec::new();
            actions.tick(now + Duration::from_millis(100), |output| {
                remaining.push(output)
            });

            if change.starts_with("mouse_") {
                assert_eq!(remaining, [Output::Paste("second".into())]);
                actions.edge("voice", false, &settings, now + Duration::from_millis(101));
                remaining.clear();
                actions.tick(now + Duration::from_millis(101), |output| {
                    remaining.push(output)
                });
            }
            assert!(matches!(remaining.as_slice(), [Output::Key(_, false)]));
        }
    }

    #[test]
    fn mouse_profile_switches_retain_the_mouse_execution_source() {
        super::super::profile_switch::REQUESTS.with(|requests| requests.borrow_mut().clear());

        execute_mouse_behavior(
            &NativeBehavior::SwitchProfile {
                enabled: true,
                direction: super::super::ProfileDirection::Previous,
                wrap: false,
            },
            10,
        );

        super::super::profile_switch::REQUESTS.with(|requests| {
            assert_eq!(
                serde_json::to_value(&*requests.borrow()).unwrap(),
                serde_json::json!([
                    {"deviceId": "mouse", "direction": "previous", "wrap": false},
                ])
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn remote_profile_switches_retain_the_rc003_execution_source() {
        super::super::profile_switch::REQUESTS.with(|requests| requests.borrow_mut().clear());

        emit_remote_output(
            &mut QuarborContext::default(),
            super::super::remote_actions::Output::SwitchProfile(
                super::super::ProfileDirection::Next,
                true,
            ),
            "test-instance",
        )
        .unwrap();

        super::super::profile_switch::REQUESTS.with(|requests| {
            assert_eq!(
                serde_json::to_value(&*requests.borrow()).unwrap(),
                serde_json::json!([
                    {"deviceId": "rc003", "direction": "next", "wrap": true},
                ])
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn input_worker_can_pause_again_after_startup_without_opening_a_device() {
        let gate = Arc::new(AtomicBool::new(true));
        // Automatic hardware discovery is disabled in unit tests.
        let service = InputService::start(gate.clone());
        service.wait_for_driver_pause().unwrap();
        assert!(!service.status().backend_ready);
        service.resume_after_driver_migration();
        let deadline = Instant::now() + Duration::from_secs(2);
        while service.shared.driver_paused.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "worker must resume");
            thread::sleep(Duration::from_millis(5));
        }
        service.pause_for_driver_migration().unwrap();
        assert!(!service.status().backend_ready);
        assert!(!service.status().capture_active);
        service.shutdown();
    }

    #[cfg(windows)]
    #[test]
    fn observes_parsed_keyboard_usages_without_duplicate_edges() {
        let mut context = QuarborContext::default();
        quarbor_decode_usages(&mut context, [0x28]);
        let stroke = context.keys.pop_front().unwrap();
        assert_eq!(
            stroke,
            RemoteKeyEvent {
                button: "confirm",
                pressed: true
            }
        );
        quarbor_decode_usages(&mut context, [0x28]);
        assert!(context.keys.is_empty());
        quarbor_decode_usages(&mut context, []);
        assert!(!context.keys.pop_front().unwrap().pressed);
    }

    #[cfg(windows)]
    #[test]
    fn mouse_clicks_emit_matching_down_up_and_unshifted_xbutton_data() {
        for (button, expected) in [
            (super::super::MouseButton::Left, [(0x2, 0), (0x4, 0)]),
            (super::super::MouseButton::Right, [(0x8, 0), (0x10, 0)]),
            (super::super::MouseButton::Middle, [(0x20, 0), (0x40, 0)]),
            (super::super::MouseButton::Back, [(0x80, 1), (0x100, 1)]),
            (super::super::MouseButton::Forward, [(0x80, 2), (0x100, 2)]),
        ] {
            MOUSE_BUTTON_EVENTS.with(|events| events.borrow_mut().clear());
            execute_mouse_behavior(
                &NativeBehavior::Mouse {
                    enabled: true,
                    button,
                },
                0,
            );
            MOUSE_BUTTON_EVENTS.with(|events| assert_eq!(*events.borrow(), expected));
        }
    }

    #[test]
    fn software_mouse_shortcut_uses_send_input_batches() {
        MOUSE_KEY_BATCHES.with(|batches| batches.borrow_mut().clear());
        execute_mouse_behavior(
            &NativeBehavior::Shortcut {
                enabled: true,
                keys: vec!["Ctrl".into(), "C".into()],
            },
            0,
        );
        MOUSE_KEY_BATCHES.with(|batches| {
            assert_eq!(
                *batches.borrow(),
                vec![vec![(0xa2, 0), (0x43, 0), (0x43, 2), (0xa2, 2)]]
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn remote_mouse_outputs_fall_back_to_send_input_when_driver_is_unavailable() {
        use super::super::remote_actions::Output;

        let mut context = QuarborContext::default();
        WHEEL_EVENTS.with(|events| events.borrow_mut().clear());
        MOUSE_MOVES.with(|moves| moves.borrow_mut().clear());
        MOUSE_BUTTON_EVENTS.with(|events| events.borrow_mut().clear());

        emit_remote_output(
            &mut context,
            Output::Wheel(WheelDirection::Up),
            "test-instance",
        )
        .unwrap();
        emit_remote_output(
            &mut context,
            Output::CursorMove(WheelDirection::Right, 37),
            "test-instance",
        )
        .unwrap();
        emit_remote_output(
            &mut context,
            Output::MouseClick(super::super::MouseButton::Left),
            "test-instance",
        )
        .unwrap();
        emit_remote_output(
            &mut context,
            Output::MouseClick(super::super::MouseButton::Middle),
            "test-instance",
        )
        .unwrap();

        WHEEL_EVENTS.with(|events| assert_eq!(*events.borrow(), [120]));
        MOUSE_MOVES.with(|moves| assert_eq!(*moves.borrow(), [(37, 0)]));
        MOUSE_BUTTON_EVENTS
            .with(|events| assert_eq!(*events.borrow(), [(2, 0), (4, 0), (0x20, 0), (0x40, 0)]));
    }

    #[cfg(windows)]
    #[test]
    fn remote_mouse_clicks_fall_back_to_send_input() {
        use super::super::remote_actions::Output;

        let mut context = QuarborContext::default();
        MOUSE_BUTTON_EVENTS.with(|events| events.borrow_mut().clear());
        emit_remote_output(
            &mut context,
            Output::MouseClick(super::super::MouseButton::Right),
            "test-instance",
        )
        .unwrap();
        MOUSE_BUTTON_EVENTS.with(|events| assert_eq!(*events.borrow(), [(8, 0), (16, 0)]));
    }

    #[cfg(windows)]
    #[test]
    fn remote_cursor_moves_fall_back_to_send_input() {
        use super::super::remote_actions::Output;

        let mut context = QuarborContext::default();
        MOUSE_MOVES.with(|moves| moves.borrow_mut().clear());
        emit_remote_output(
            &mut context,
            Output::CursorMove(WheelDirection::Right, 37),
            "test-instance",
        )
        .unwrap();
        MOUSE_MOVES.with(|moves| assert_eq!(*moves.borrow(), [(37, 0)]));
    }

    #[cfg(windows)]
    #[test]
    fn report_gaps_and_read_errors_release_observed_keys() {
        use super::super::windows_quarbor::{Event, Metadata};
        let metadata = |sequence, dropped, status| Metadata {
            sequence,
            dropped,
            status,
        };
        let mut context = QuarborContext::default();
        for sequence in [1, 3] {
            quarbor_accept_event(
                &mut context,
                Event::Report {
                    metadata: metadata(sequence, 0, 0),
                    bytes: vec![1, 0x3e, 0, 0, 0, 0, 0],
                },
            );
        }
        let phases: Vec<_> = context.keys.drain(..).map(|key| key.pressed).collect();
        assert_eq!(
            phases,
            [true, false, true],
            "gap releases stale state before restoring current state"
        );
        quarbor_accept_event(&mut context, Event::Status(metadata(3, 1, 0)));
        assert!(!context.keys.pop_front().unwrap().pressed);
        assert!(context
            .descriptor_engine
            .as_mut()
            .unwrap()
            .release_all()
            .is_empty());
        quarbor_accept_event(&mut context, Event::Status(metadata(3, 1, 0xc0000001)));
        assert!(context.error.as_ref().unwrap().contains("C0000001"));
        quarbor_accept_event(&mut context, Event::Status(metadata(3, 1, 0)));
        assert!(context.error.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn parser_failures_preserve_raw_reports_and_shutdown_releases_state() {
        use super::super::windows_quarbor::{Event, Metadata};
        let mut context = QuarborContext::default();
        quarbor_decode_usages(&mut context, [0x3e]);
        context.keys.clear();
        let bytes = vec![9, 0xff, 0, 0x3e];
        quarbor_accept_event(
            &mut context,
            Event::Report {
                metadata: Metadata {
                    sequence: 1,
                    dropped: 0,
                    status: 0,
                },
                bytes: bytes.clone(),
            },
        );
        let Event::Report {
            bytes: received, ..
        } = context.events.pop_front().unwrap()
        else {
            panic!("raw event missing")
        };
        assert_eq!(received, bytes);
        assert!(
            context.keys.is_empty(),
            "decoder failure must not invent key events"
        );
        quarbor_release_inputs(&mut context, ReleaseReason::Test);
        assert!(!context.keys.pop_front().unwrap().pressed);
        quarbor_release_inputs(&mut context, ReleaseReason::Test);
        assert!(context.keys.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn decodes_special_usages_into_regular_sources() {
        for (usage, button) in [
            (0x00f1, "back"),
            (0x0080, "volumeUp"),
            (0x0081, "volumeDown"),
        ] {
            let mut context = QuarborContext::default();
            quarbor_decode_usages(&mut context, [usage]);
            let stroke = context.keys.pop_front().expect("special usage report");
            assert_eq!(
                stroke,
                RemoteKeyEvent {
                    button,
                    pressed: true
                }
            );
        }
    }

    #[test]
    fn wheel_events_use_signed_windows_notches_without_mouse_movement() {
        for delta in [120, -120] {
            let input = wheel_input(delta, false);
            assert_eq!(input.kind, 0);
            let mouse = unsafe { input.value.mouse };
            assert_eq!(mouse.flags, 0x0800);
            assert_eq!(mouse.mouse_data as i32, delta);
            assert_eq!((mouse.dx, mouse.dy), (0, 0));
        }
    }

    #[test]
    fn continuous_wheel_does_not_bypass_other_gestures_or_sequences() {
        let mut triggers: TriggerBehaviors = serde_json::from_value(serde_json::json!({
            "click": [{"type":"wheel", "direction":"down"}]
        }))
        .unwrap();
        assert_eq!(
            repeatable_click(&triggers),
            Some(RepeatableClick::Wheel(WheelDirection::Down))
        );
        let wheel = triggers.click[0].clone();
        triggers.double_click.push(wheel.clone());
        assert_eq!(repeatable_click(&triggers), None);
        triggers.double_click.clear();
        triggers.long_press.push(wheel.clone());
        assert_eq!(repeatable_click(&triggers), None);
        triggers.long_press.clear();
        triggers.click.push(wheel);
        assert_eq!(repeatable_click(&triggers), None);
        assert!(serde_json::from_value::<NativeBehavior>(serde_json::json!({
            "type":"wheel", "direction":"left"
        }))
        .is_ok());
        let mut cursor: TriggerBehaviors = serde_json::from_value(serde_json::json!({
            "click": [{"type":"cursorMove", "direction":"up"}]
        }))
        .unwrap();
        assert_eq!(
            repeatable_click(&cursor),
            Some(RepeatableClick::CursorMove {
                direction: WheelDirection::Up,
                distance: 50,
            })
        );
        cursor.double_click.push(cursor.click[0].clone());
        assert_eq!(repeatable_click(&cursor), None);
    }

    #[test]
    fn cursor_move_injects_relative_delta_from_current_position() {
        MOUSE_MOVES.with(|events| events.borrow_mut().clear());
        execute_mouse_behavior(
            &NativeBehavior::CursorMove {
                enabled: true,
                direction: WheelDirection::Left,
                distance: 20,
            },
            0,
        );
        MOUSE_MOVES.with(|events| assert_eq!(*events.borrow(), vec![(-20, 0)]));
    }

    #[cfg(windows)]
    #[test]
    fn driver_chords_keep_shared_modifiers_and_connected_chords_on_one_backend() {
        use super::super::remote_actions::{Output, RemoteActions};
        let settings: NativeSettings =
            serde_json::from_value(serde_json::json!({"enabled":true,"behaviors":{
                "up":{"click":[{"type":"shortcut","keys":["Shift","MediaNext"]}]},
                "down":{"click":[{"type":"shortcut","keys":["Shift","B"]}]},
                "voice":{"click":[{"type":"key","key":"RAlt"}]}
            }}))
            .unwrap();
        let mut keyboard = RemoteKeyboard::default();
        let mut actions: RemoteActions = RemoteActions::default();
        let now = Instant::now();
        let mut events = Vec::new();
        for (button, down) in [
            ("up", true),
            ("down", true),
            ("up", false),
            ("down", false),
            ("voice", true),
            ("voice", false),
        ] {
            actions.edge(button, down, &settings, now);
            actions.tick(now, |output| {
                if let Output::Key(key, down) = output {
                    keyboard
                        .edge_with(
                            key,
                            down,
                            true,
                            |key, down| {
                                events.push((key, down));
                                Ok(())
                            },
                            |_, _| Ok(()),
                        )
                        .unwrap();
                }
            });
        }
        assert_eq!(
            events,
            [
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe1
                    },
                    true
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 0x0c,
                        usage: 0xb5
                    },
                    true
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0x05
                    },
                    true
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 0x0c,
                        usage: 0xb5
                    },
                    false
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0x05
                    },
                    false
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe1
                    },
                    false
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe6
                    },
                    true
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe6
                    },
                    false
                ),
            ]
        );
        assert!(keyboard.held.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn unsupported_keyboard_usage_falls_back_to_virtual_injection() {
        let mut keyboard = RemoteKeyboard::default();
        let mut driver_emitted = Vec::new();
        let mut virtual_emitted = Vec::new();
        keyboard
            .edge_with(
                super::super::remote_actions::HidKey {
                    page: 7,
                    usage: 0x04,
                },
                true,
                false,
                |key, down| {
                    driver_emitted.push((key, down));
                    Ok(())
                },
                |key, down| {
                    virtual_emitted.push((key, down));
                    Ok(())
                },
            )
            .unwrap();
        assert!(driver_emitted.is_empty());
        assert_eq!(virtual_emitted, [(0x41, true)]);
        assert_eq!(keyboard.held.len(), 1);
        keyboard
            .edge_with(
                super::super::remote_actions::HidKey {
                    page: 7,
                    usage: 0x04,
                },
                false,
                false,
                |key, down| {
                    driver_emitted.push((key, down));
                    Ok(())
                },
                |key, down| {
                    virtual_emitted.push((key, down));
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(virtual_emitted, [(0x41, true), (0x41, false)]);
        assert!(keyboard.held.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a15_confirm_falls_back_to_enter_and_releases_on_cancel() {
        let key = original_key_for_button("cmiotA15.confirm").unwrap();
        let mut keyboard = RemoteKeyboard::default();
        let mut virtual_events = Vec::new();
        for down in [true, true, false, true] {
            keyboard
                .edge_with(
                    key,
                    down,
                    false,
                    |_, _| panic!("Unsupported usage must not reach the driver"),
                    |key, down| {
                        virtual_events.push((key, down));
                        Ok(())
                    },
                )
                .unwrap();
        }
        keyboard.reset(
            |_, _| panic!("Fallback key must be released through SendInput"),
            |key, down| virtual_events.push((key, down)),
        );
        assert_eq!(
            virtual_events,
            [(0x0d, true), (0x0d, false), (0x0d, true), (0x0d, false)]
        );
        assert!(keyboard.held.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn failed_driver_key_output_falls_back_and_releases_in_the_same_backend() {
        let key = super::super::remote_actions::HidKey {
            page: 7,
            usage: 0x04,
        };
        let mut keyboard = RemoteKeyboard::default();
        let mut virtual_events = Vec::new();
        keyboard
            .edge_with(
                key,
                true,
                true,
                |_key, _down| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "closed",
                    ))
                },
                |virtual_key, down| {
                    virtual_events.push((virtual_key, down));
                    Ok(())
                },
            )
            .unwrap();
        keyboard
            .edge_with(
                key,
                false,
                true,
                |_key, _down| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "closed",
                    ))
                },
                |virtual_key, down| {
                    virtual_events.push((virtual_key, down));
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(virtual_events, [(0x41, true), (0x41, false)]);
    }

    #[cfg(windows)]
    #[test]
    fn driver_media_holds_do_not_repeat_playback() {
        let settings: NativeSettings = serde_json::from_value(serde_json::json!({"enabled":true,
            "behaviors":{"up":{"click":[{"type":"shortcut","keys":["RAlt","MediaPlayPause"]}]}}
        }))
        .unwrap();
        let chord = behavior_hid_chord(&settings.behaviors["up"].click[0]).unwrap();
        let mut keyboard = RemoteKeyboard::default();
        let mut events = Vec::new();
        for key in chord {
            keyboard
                .edge_with(
                    key,
                    true,
                    true,
                    |key, down| {
                        events.push((key, down));
                        Ok(())
                    },
                    |_, _| Ok(()),
                )
                .unwrap();
        }
        keyboard
            .edge_with(
                super::super::remote_actions::HidKey {
                    page: 0x0c,
                    usage: 0xcd,
                },
                false,
                true,
                |key, down| {
                    events.push((key, down));
                    Ok(())
                },
                |_, _| Ok(()),
            )
            .unwrap();
        keyboard
            .edge_with(
                super::super::remote_actions::HidKey {
                    page: 7,
                    usage: 0xe6,
                },
                false,
                true,
                |key, down| {
                    events.push((key, down));
                    Ok(())
                },
                |_, _| Ok(()),
            )
            .unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(
            events,
            [
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe6
                    },
                    true
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 0x0c,
                        usage: 0xcd
                    },
                    true
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 0x0c,
                        usage: 0xcd
                    },
                    false
                ),
                (
                    super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe6
                    },
                    false
                )
            ]
        );
    }

    #[test]
    fn hid_key_names_preserve_sides_function_key_ranges_and_usage_pages() {
        let keys = |name: &str| {
            behavior_hid_chord(&NativeBehavior::Key {
                enabled: true,
                key: name.into(),
            })
            .unwrap()
            .into_iter()
            .map(|key| (key.page, key.usage))
            .collect::<Vec<_>>()
        };
        assert_eq!(
            keys("Ctrl+LCtrl+RCtrl+Shift+RShift+Alt+RAlt+Win+RWin"),
            [
                (7, 0xe0),
                (7, 0xe4),
                (7, 0xe1),
                (7, 0xe5),
                (7, 0xe2),
                (7, 0xe6),
                (7, 0xe3),
                (7, 0xe7)
            ]
        );
        assert_eq!(
            keys("F1+F12+F13+F24+1+0+Z+】"),
            [
                (7, 0x3a),
                (7, 0x45),
                (7, 0x68),
                (7, 0x73),
                (7, 0x1e),
                (7, 0x27),
                (7, 0x1d),
                (7, 0x30)
            ]
        );
        assert_eq!(
            keys("VolumeUp+VolumeDown+VolumeMute+MediaPlayPause+MediaNext"),
            [
                (0x0c, 0xe9),
                (0x0c, 0xea),
                (0x0c, 0xe2),
                (0x0c, 0xcd),
                (0x0c, 0xb5)
            ]
        );
    }

    #[test]
    fn parses_bracket_and_shortcuts() {
        assert_eq!(parse_chord("]"), Some(vec![0xdd]));
        assert_eq!(parse_chord("】"), Some(vec![0xdd]));
        assert_eq!(parse_chord("Ctrl+C"), Some(vec![0x11, 0x43]));
        assert_eq!(parse_chord("MediaNext"), Some(vec![0xb0]));
        assert_eq!(parse_chord("MediaPrevious"), Some(vec![0xb1]));
        assert_eq!(parse_chord("MediaStop"), Some(vec![0xb2]));
    }

    #[test]
    fn maps_all_rc003_usages_directly_to_buttons() {
        let buttons: std::collections::HashSet<_> =
            (0..=255).filter_map(rc003_button_for_usage).collect();
        assert_eq!(buttons.len(), 13);
        assert_eq!(rc003_button_for_usage(0x28), Some("confirm"));
        assert_eq!(rc003_button_for_usage(0x52), Some("up"));
        assert_eq!(rc003_button_for_usage(0x04), None);
    }

    #[test]
    #[cfg(windows)]
    fn recording_snapshot_follows_control_and_clears_after_disconnect() {
        let shared = Shared {
            recording_requests: Mutex::new(Vec::new()),
            instance_id: None,
            settings: RwLock::new(NativeSettings::default()),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            driver_gate: Arc::new(AtomicBool::new(false)),
            driver_paused: AtomicBool::new(false),
            managed_event: None,
            managed_input: None,
            managed_remote_owned: AtomicBool::new(false),
        };
        let mut context = QuarborContext::default();
        context
            .a15_recording
            .synchronize(
                crate::devices::cmiot_a15::recording::RecordingMode::Click,
                true,
                |_| Ok::<_, ()>(()),
            )
            .unwrap();
        context
            .a15_recording
            .edge(true, |_| Ok::<_, ()>(()))
            .unwrap();
        publish_a15_recording(&shared, context.a15_recording.is_recording());
        assert!(shared.status.lock().unwrap().cmiot_a15_recording);
        context
            .a15_recording
            .edge(false, |_| Ok::<_, ()>(()))
            .unwrap();
        publish_a15_recording(&shared, context.a15_recording.is_recording());
        assert!(shared.status.lock().unwrap().cmiot_a15_recording);
        quarbor_release_inputs(&mut context, ReleaseReason::Test);
        publish_a15_recording(&shared, context.a15_recording.is_recording());
        assert!(!shared.status.lock().unwrap().cmiot_a15_recording);
    }

    #[test]
    #[cfg(windows)]
    fn a15_reports_route_to_scoped_keys_and_release_only_their_collection() {
        use super::super::windows_quarbor::{Event, Metadata};
        let mut context = QuarborContext::default();
        context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_remote\instance".into());
        context.descriptor = crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15");
        let reports = [
            vec![1, 0, 0, 0x52, 0, 0, 0, 0, 0],
            vec![3, 0x41, 0],
            vec![3, 0, 0],
            vec![1, 0, 0, 0, 0, 0, 0, 0, 0],
        ];
        for (sequence, bytes) in reports.into_iter().enumerate() {
            quarbor_accept_event(
                &mut context,
                Event::Report {
                    metadata: Metadata {
                        sequence: sequence as u64,
                        ..Default::default()
                    },
                    bytes,
                },
            );
        }
        assert_eq!(
            context
                .keys
                .iter()
                .map(|k| (k.button, k.pressed))
                .collect::<Vec<_>>(),
            vec![
                ("cmiotA15.up", true),
                ("cmiotA15.confirm", true),
                ("cmiotA15.confirm", false),
                ("cmiotA15.up", false),
            ]
        );
        assert!(context.usage_error.is_none());
        super::super::profile_switch::REQUESTS.with(|requests| requests.borrow_mut().clear());
        emit_remote_output(
            &mut context,
            super::super::remote_actions::Output::SwitchProfile(
                super::super::ProfileDirection::Next,
                true,
            ),
            "test-instance",
        )
        .unwrap();
        super::super::profile_switch::REQUESTS.with(|requests| {
            assert_eq!(
                serde_json::to_value(&requests.borrow()[0]).unwrap()["deviceId"],
                "cmiotA15"
            );
        });
        // A sequence gap must release every collection before accepting new data.
        quarbor_accept_event(
            &mut context,
            Event::Report {
                metadata: Metadata {
                    sequence: 4,
                    ..Default::default()
                },
                bytes: vec![3, 0xe9, 0],
            },
        );
        context.keys.clear();
        quarbor_accept_event(
            &mut context,
            Event::Report {
                metadata: Metadata {
                    sequence: 7,
                    ..Default::default()
                },
                bytes: vec![1, 0, 0, 0x52, 0, 0, 0, 0, 0],
            },
        );
        assert_eq!(
            context
                .keys
                .iter()
                .map(|k| (k.button, k.pressed))
                .collect::<Vec<_>>(),
            vec![("cmiotA15.volumeUp", false), ("cmiotA15.up", true),]
        );
        assert_eq!(
            original_key_for_button("cmiotA15.back"),
            Some(super::super::remote_actions::HidKey {
                page: 12,
                usage: 0x224
            })
        );
        assert_eq!(original_key_for_button("cmiotA15.tv"), None);
    }

    #[test]
    #[cfg(windows)]
    fn xm_bt_29_driver_reports_deliver_numeric_and_delete_edges() {
        use super::super::windows_quarbor::{Event, Metadata};
        let mut context = QuarborContext {
            device_id: Some(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300"
                    .into(),
            ),
            descriptor: crate::devices::descriptor_registry::descriptor_for_kind("xmBt29"),
            ..Default::default()
        };
        for (sequence, bytes) in [
            vec![1, 0, 0, 0x27],
            vec![3, 0xfc, 0],
            vec![1, 0, 0, 0],
            vec![3, 0, 0],
        ]
        .into_iter()
        .enumerate()
        {
            quarbor_accept_event(
                &mut context,
                Event::Report {
                    metadata: Metadata {
                        sequence: sequence as u64 + 1,
                        ..Default::default()
                    },
                    bytes,
                },
            );
        }
        assert_eq!(
            context
                .keys
                .iter()
                .map(|key| (key.button, key.pressed))
                .collect::<Vec<_>>(),
            [
                ("xmBt29.digit0", true),
                ("xmBt29.delete", true),
                ("xmBt29.digit0", false),
                ("xmBt29.delete", false),
            ]
        );
        assert_eq!(
            original_key_for_button("xmBt29.digit0"),
            Some(super::super::remote_actions::HidKey {
                page: 7,
                usage: 0x27
            })
        );
        assert_eq!(
            original_key_for_button("xmBt29.delete"),
            Some(super::super::remote_actions::HidKey {
                page: 12,
                usage: 0xfc
            })
        );
    }

    #[test]
    fn modifier_shortcuts_keep_both_sides() {
        let triggers: TriggerBehaviors = serde_json::from_value(serde_json::json!({
            "click": [{ "type": "shortcut", "keys": ["Win", "RWin"] }]
        }))
        .unwrap();
        assert_eq!(behavior_chord(&triggers.click[0]), Some(vec![0x5b, 0x5c]));
    }

    #[test]
    fn modifier_shortcuts_preserve_independent_sides() {
        let triggers: TriggerBehaviors = serde_json::from_value(serde_json::json!({
            "click": [{ "type": "shortcut", "keys": ["RCtrl", "Shift", "RAlt", "Win"] }]
        }))
        .unwrap();
        let keys = behavior_chord(&triggers.click[0]).unwrap();
        assert_eq!(keys, vec![0xa3, 0x10, 0xa5, 0x5b]);
        assert_eq!(
            behavior_hid_chord(&triggers.click[0])
                .unwrap()
                .into_iter()
                .map(|key| (key.page, key.usage))
                .collect::<Vec<_>>(),
            vec![(7, 0xe4), (7, 0xe1), (7, 0xe6), (7, 0xe3)]
        );
    }

    #[cfg(windows)]
    #[test]
    fn failed_driver_key_release_propagates_error_without_send_input_fallback() {
        let key = super::super::remote_actions::HidKey {
            page: 7,
            usage: 0x04,
        };
        let mut keyboard = RemoteKeyboard::default();
        let mut virtual_events = Vec::new();
        keyboard
            .edge_with(
                key,
                true,
                true,
                |_key, _down| Ok(()),
                |virtual_key, down| {
                    virtual_events.push((virtual_key, down));
                    Ok(())
                },
            )
            .unwrap();
        let result = keyboard.edge_with(
            key,
            false,
            true,
            |_key, _down| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "Quarbor command queue full",
                ))
            },
            |virtual_key, down| {
                virtual_events.push((virtual_key, down));
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        assert!(virtual_events.is_empty());
        assert!(keyboard.held.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn ble_address_parser_and_disconnect_monitor_track_falling_edges_only() {
        assert_eq!(
            ble_address_for_device_id(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39C2CF83\8&7CE84E7&0&0055"
            ),
            Some(0xc05d_39c2_cf83)
        );
        assert_eq!(
            ble_address_for_device_id(
                r"bthledevice{00001812-0000-1000-8000-00805f9b34fb}_dev_vid&050416_pid&0300_rev&0505_0cf3ce7f241e\8&11237c06&0&0025"
            ),
            Some(0x0cf3_ce7f_241e)
        );
        assert_eq!(
            ble_address_for_device_id(
                r"HID\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002045E_PID&02E0\C&1B61B8A0&0&0000"
            ),
            None
        );
        assert_eq!(
            ble_address_for_device_id(r"ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\0000"),
            None
        );

        let mut monitor = BleLinkMonitor::start(
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39C2CF83\8&7CE84E7&0&0055",
            Arc::new(AtomicBool::new(false)),
        );
        let armed = monitor.was_connected.load(Ordering::Acquire);
        record_ble_connection_status(&monitor.was_connected, &monitor.disconnects, armed, false);
        assert!(!monitor.take_disconnect());

        let armed = monitor.was_connected.load(Ordering::Acquire);
        record_ble_connection_status(&monitor.was_connected, &monitor.disconnects, armed, true);
        assert!(!monitor.take_disconnect());

        let armed = monitor.was_connected.load(Ordering::Acquire);
        record_ble_connection_status(&monitor.was_connected, &monitor.disconnects, armed, false);
        assert!(monitor.has_disconnect());
        assert!(monitor.take_disconnect());
        assert!(!monitor.take_disconnect());

        let armed = monitor.was_connected.load(Ordering::Acquire);
        record_ble_connection_status(&monitor.was_connected, &monitor.disconnects, armed, false);
        assert!(!monitor.take_disconnect());

        // Waking from sleep via a physical report before WinRT observes Connected:
        // a stale pre-wake poll (armed == false) must not clobber was_connected,
        // while a post-wake Disconnected poll (armed == true) must trigger disconnect.
        let pre_wake_armed = monitor.was_connected.load(Ordering::Acquire);
        assert!(!pre_wake_armed);
        monitor.note_connected();
        record_ble_connection_status(
            &monitor.was_connected,
            &monitor.disconnects,
            pre_wake_armed,
            false,
        );
        assert!(monitor.was_connected.load(Ordering::Acquire));
        assert!(!monitor.take_disconnect());

        let post_wake_armed = monitor.was_connected.load(Ordering::Acquire);
        assert!(post_wake_armed);
        record_ble_connection_status(
            &monitor.was_connected,
            &monitor.disconnects,
            post_wake_armed,
            false,
        );
        assert!(monitor.take_disconnect());
        assert!(!monitor.take_disconnect());
    }

    #[test]
    fn absolute_virtual_desk_maps_primary_monitor_into_negative_origin_multimonitor_space() {
        // Left secondary (-1920..0), Primary (0..2560 x 0..1440), Right secondary (2560..4480)
        // Full virtual screen: L_v = -1920, T_v = 0, W_v = 6400, H_v = 1440
        let primary = (0, 0, 2560, 1440);
        let vdesk = (-1920, 0, 6400, 1440);

        // Top-left of primary (px = 0, py = 0) -> (0 - (-1920)) / 6399 * 65535
        let (tl_x, tl_y) = normalize_primary_to_virtual_desk(0.0, 0.0, primary, vdesk);
        assert_eq!(tl_x, (65535.0 * 1920.0 / 6399.0_f64).round() as i32);
        assert_eq!(tl_y, 0);

        // Bottom-right of primary (px = 2559, py = 1439) -> (2559 - (-1920)) / 6399 * 65535
        let (br_x, br_y) = normalize_primary_to_virtual_desk(1.0, 1.0, primary, vdesk);
        assert_eq!(br_x, (65535.0 * 4479.0 / 6399.0_f64).round() as i32);
        assert_eq!(br_y, 65535);

        // Out-of-bounds u/v clamp cleanly to primary monitor edges, and NaN is rejected
        assert!(inject_absolute_virtual_desk(f64::NAN, 0.5).is_err());
        ABSOLUTE_MOUSE_MOVES.with(|events| events.borrow_mut().clear());
        inject_absolute_virtual_desk(0.5, 0.5).unwrap();
        ABSOLUTE_MOUSE_MOVES.with(|events| {
            let moves = events.borrow();
            assert_eq!(moves.len(), 1);
            assert_eq!(moves[0].2, 0x0001 | 0x8000 | 0x4000);
        });
    }

    #[test]
    fn virtual_key_edge_normalizes_left_modifiers_populates_scan_code_and_sets_extended_flags() {
        VIRTUAL_KEY_EDGES.with(|events| events.borrow_mut().clear());

        // Generic "Alt" must resolve to VK_LMENU (0xA4) with physical Left Alt scan code (0x38)
        // and non-extended flags (0 on down, KEYEVENTF_KEYUP=0x0002 on up) so WH_KEYBOARD_LL hooks (e.g. Doubao) accept it!
        inject_virtual_key_edge("Alt", true).unwrap();
        inject_virtual_key_edge("Alt", false).unwrap();

        // "RAlt" must resolve to VK_RMENU (0xA5) + KEYEVENTF_EXTENDEDKEY (0x0001) + non-zero scan code!
        inject_virtual_key_edge("RAlt", true).unwrap();
        inject_virtual_key_edge("RAlt", false).unwrap();

        // Generic "Ctrl" and "Shift" normalize to VK_LCONTROL (0xA2) and VK_LSHIFT (0xA0)
        inject_virtual_key_edge("Ctrl", true).unwrap();
        inject_virtual_key_edge("Shift", true).unwrap();

        // "RCtrl", "Win", and navigation/arrow keys set KEYEVENTF_EXTENDEDKEY (0x0001)
        inject_virtual_key_edge("RCtrl", true).unwrap();
        inject_virtual_key_edge("Win", true).unwrap();
        inject_virtual_key_edge("ArrowUp", true).unwrap();
        inject_virtual_key_edge("PageDown", false).unwrap();

        VIRTUAL_KEY_EDGES.with(|events| {
            let recorded = events.borrow();
            assert_eq!(recorded.len(), 10);

            // Alt down & up -> VK_LMENU (0xA4), scan_code == 0x38 (non-zero!), flags 0 / 2
            assert_eq!(recorded[0].0, 0xa4);
            assert_eq!(recorded[0].1, 0x38);
            assert_eq!(recorded[0].2, 0x0000);
            assert_eq!(recorded[1].0, 0xa4);
            assert_eq!(recorded[1].1, 0x38);
            assert_eq!(recorded[1].2, 0x0002);

            // RAlt down & up -> VK_RMENU (0xA5), non-zero scan_code, KEYEVENTF_EXTENDEDKEY (0x0001 / 0x0003)
            assert_eq!(recorded[2].0, 0xa5);
            assert_ne!(recorded[2].1, 0);
            assert_eq!(recorded[2].2, 0x0001);
            assert_eq!(recorded[3].0, 0xa5);
            assert_ne!(recorded[3].1, 0);
            assert_eq!(recorded[3].2, 0x0001 | 0x0002);

            // Ctrl -> VK_LCONTROL (0xA2), Shift -> VK_LSHIFT (0xA0)
            assert_eq!(recorded[4].0, 0xa2);
            assert_ne!(recorded[4].1, 0);
            assert_eq!(recorded[4].2, 0x0000);
            assert_eq!(recorded[5].0, 0xa0);
            assert_ne!(recorded[5].1, 0);
            assert_eq!(recorded[5].2, 0x0000);

            // RCtrl (0xA3), Win (0x5B), ArrowUp (0x26), PageDown up (0x22) -> KEYEVENTF_EXTENDEDKEY
            assert_eq!((recorded[6].0, recorded[6].2), (0xa3, 0x0001));
            assert_eq!((recorded[7].0, recorded[7].2), (0x5b, 0x0001));
            assert_eq!((recorded[8].0, recorded[8].2), (0x26, 0x0001));
            assert_eq!((recorded[9].0, recorded[9].2), (0x22, 0x0001 | 0x0002));
        });
    }
}
