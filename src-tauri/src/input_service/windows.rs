use super::{cursor_delta, InputServiceStatus, NativeBehavior, NativeSettings, WheelDirection};
#[cfg(test)]
use super::{repeatable_click, RepeatableClick, TriggerBehaviors};
use serde::Serialize;
use std::{
    path::PathBuf,
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
const DEVICE_DISCONNECT_GRACE: Duration = Duration::from_secs(8);
const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DEVICE_STABLE_DURATION: Duration = Duration::from_secs(3);

#[cfg(windows)]
struct QuarborContext {
    reader: Option<super::windows_quarbor::Client>,
    keyboard: RemoteKeyboard,
    events: std::collections::VecDeque<super::windows_quarbor::Event>,
    keys: std::collections::VecDeque<RemoteKeyEvent>,
    active_usages: std::collections::HashSet<u16>,
    device_id: Option<String>,
    a15_reports: crate::devices::cmiot_a15::ReportState,
    a15_voice: crate::devices::cmiot_a15_fc::VoiceStream,
    a15_pcm: std::collections::VecDeque<crate::devices::cmiot_a15_fc::PcmFrame>,
    a15_voice_errors: u64,
    a15_recording: crate::devices::cmiot_a15_recording::RecordingControl,
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
            keyboard: RemoteKeyboard::default(),
            events: std::collections::VecDeque::new(),
            keys: std::collections::VecDeque::new(),
            active_usages: std::collections::HashSet::new(),
            device_id: None,
            a15_reports: Default::default(),
            a15_voice: Default::default(),
            a15_pcm: Default::default(),
            a15_voice_errors: 0,
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
                match self.held[index].1 {
                    KeyBackend::Driver(driver_key) => {
                        if let Err(error) = emit_driver(driver_key, false) {
                            log::warn!(
                                target: "axonkey::input",
                                "Universal driver key release failed; trying SendInput fallback: {error}"
                            );
                            let virtual_key = virtual_key_for_hid(driver_key).ok_or(error)?;
                            emit_virtual(virtual_key, false)?;
                        }
                    }
                    KeyBackend::Virtual(virtual_key) => emit_virtual(virtual_key, false)?,
                }
                self.held.remove(index);
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
fn quarbor_wait_with_timeout(context: &mut QuarborContext, timeout_ms: u32) {
    if !context.keys.is_empty() {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
    let Some(device_id) = context.device_id.as_deref() else {
        return;
    };
    if context.reader.is_none() && context.last_pipe_attempt.elapsed() >= DEVICE_POLL_INTERVAL {
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
                quarbor_accept_event(context, event);
                if !context.keys.is_empty() {
                    return;
                }
            }
            Ok(None) => {
                if !context.events.is_empty() || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(
                    Duration::from_millis(2)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(error) => {
                quarbor_read_error(context, format!("Quarbor Universal receive: {error}"));
                context.reader = None;
                quarbor_release_active_usages(context);
                break;
            }
        }
    }
    if context.reader.is_none() {
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
        Event::Report {
            metadata,
            bytes,
            usages,
        } => {
            if context
                .last_sequence
                .is_some_and(|last| last.checked_add(1) != Some(metadata.sequence))
                || metadata.dropped > context.dropped
            {
                log::warn!(target: "axonkey::input", "Quarbor HID report gap: previous={:?}, current={}, dropped={}", context.last_sequence, metadata.sequence, metadata.dropped);
                quarbor_release_active_usages(context);
            }
            context.last_sequence = Some(metadata.sequence);
            context.dropped = metadata.dropped;
            if context
                .device_id
                .as_deref()
                .is_some_and(crate::devices::cmiot_a15::matches_instance)
            {
                context.usage_error = None;
                if bytes.first() == Some(&0xfc) {
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
                }
                for (button, pressed) in context.a15_reports.accept(bytes) {
                    context.keys.push_back(RemoteKeyEvent { button, pressed });
                }
            } else {
                match usages {
                    Ok(usages) => {
                        context.usage_error = None;
                        quarbor_decode_usages(context, usages.iter().copied());
                    }
                    Err(status) => {
                        // Preserve observed UI state, but never keep moving from
                        // stale state when the next release cannot be decoded.
                        context.state_epoch = context.state_epoch.wrapping_add(1);
                        if context.usage_error != Some(*status) {
                            let preview = bytes
                                .iter()
                                .take(16)
                                .map(|byte| format!("{byte:02X}"))
                                .collect::<Vec<_>>()
                                .join(" ");
                            log::warn!(target: "axonkey::input", "Quarbor RC003 report decode failed: status=0x{status:08X}, bytes={}, preview={preview}", bytes.len());
                            context.usage_error = Some(*status);
                        }
                    }
                }
            }
        }
        Event::Status(metadata) => {
            if metadata.dropped > context.dropped {
                quarbor_release_active_usages(context);
            }
            context.dropped = metadata.dropped;
            if metadata.status != 0 {
                quarbor_release_active_usages(context);
                quarbor_read_error(
                    context,
                    format!("Quarbor HID read NTSTATUS=0x{:08X}", metadata.status),
                );
            } else {
                context.error = None;
            }
        }
        Event::Capabilities(_) => {
            // A previous connection may have been lost after a successful start.
            // Neutralize the physical device before accepting a new recording.
            if context
                .device_id
                .as_deref()
                .is_some_and(crate::devices::cmiot_a15::matches_instance)
            {
                context.a15_recording.reset();
                context.a15_voice.reset();
                context.a15_pcm.clear();
                if context
                    .reader
                    .as_ref()
                    .is_some_and(|client| client.supports_physical_write())
                {
                    if let Err(error) = send_a15_recording_report(&mut context.reader, [0xfb, 0]) {
                        quarbor_output_error(context, error);
                    }
                }
            }
            // Each connection starts with a neutral output state.
            if let Some(client) = context.reader.as_mut() {
                if let Err(error) = client.reset_input() {
                    quarbor_output_error(context, error);
                }
            }
        }
        Event::CommandAccepted(id) => {
            log::debug!(target: "axonkey::input", "Quarbor command accepted: request_id={id}");
        }
    }
    context.events.push_back(event);
}

#[cfg(windows)]
fn quarbor_release_active_usages(context: &mut QuarborContext) {
    // Never replay a queued start after a gap/disconnect has reset recording.
    context.keys.retain(|key| key.button != "cmiotA15.voice");
    if let Err(error) = context
        .a15_recording
        .stop(|report| send_a15_recording_report(&mut context.reader, report))
    {
        quarbor_read_error(context, format!("A15 recording stop: {error}"));
    }
    context.a15_recording.reset();
    context.a15_voice.reset();
    context.a15_pcm.clear();
    context.keyboard.reset(
        |key, down| {
            if let Some(client) = context.reader.as_mut() {
                let _ = client.send_key(key.page, key.usage, down);
            }
        },
        |key, down| {
            let _ = send_remote_virtual_key(key, down);
        },
    );
    context.state_epoch = context.state_epoch.wrapping_add(1);
    for (button, pressed) in context.a15_reports.release_all() {
        context.keys.push_back(RemoteKeyEvent { button, pressed });
    }
    let active = std::mem::take(&mut context.active_usages);
    for usage in active {
        if let Some(button) = rc003_button_for_usage(usage) {
            context.keys.push_back(RemoteKeyEvent {
                button,
                pressed: false,
            });
        }
    }
}

#[cfg(windows)]
fn quarbor_decode_usages(context: &mut QuarborContext, usages: impl IntoIterator<Item = u16>) {
    let current: std::collections::HashSet<_> = usages
        .into_iter()
        .filter(|usage| rc003_button_for_usage(*usage).is_some())
        .collect();
    for usage in context.active_usages.difference(&current).copied() {
        if let Some(button) = rc003_button_for_usage(usage) {
            context.keys.push_back(RemoteKeyEvent {
                button,
                pressed: false,
            });
        }
    }
    for usage in current.difference(&context.active_usages).copied() {
        if let Some(button) = rc003_button_for_usage(usage) {
            context.keys.push_back(RemoteKeyEvent {
                button,
                pressed: true,
            });
        }
    }
    context.active_usages = current;
}

const RC003_BUTTON_USAGES: [(&str, u16); 13] = [
    ("voice", 0x003e),
    ("back", 0x00f1),
    ("confirm", 0x0028),
    ("tv", 0x0035),
    ("home", 0x004a),
    ("right", 0x004f),
    ("left", 0x0050),
    ("down", 0x0051),
    ("up", 0x0052),
    ("menu", 0x0065),
    ("power", 0x0066),
    ("volumeUp", 0x0080),
    ("volumeDown", 0x0081),
];

fn rc003_button_for_usage(usage: u16) -> Option<&'static str> {
    RC003_BUTTON_USAGES
        .iter()
        .find_map(|&(button, value)| (value == usage).then_some(button))
}

pub(super) fn original_key_for_button(button: &str) -> Option<super::remote_actions::HidKey> {
    if button.starts_with("cmiotA15.") {
        crate::devices::cmiot_a15::original_usage(button)
            .map(|(page, usage)| super::remote_actions::HidKey { page, usage })
    } else {
        rc003_usage_for_button(button).map(|usage| super::remote_actions::HidKey { page: 7, usage })
    }
}

pub(super) fn rc003_usage_for_button(button: &str) -> Option<u16> {
    RC003_BUTTON_USAGES
        .iter()
        .find_map(|&(name, usage)| (name == button).then_some(usage))
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
    quarbor_release_active_usages(context);
}

#[cfg(not(test))]
type EventApp = tauri::AppHandle;
#[cfg(test)]
type EventApp = ();

struct Shared {
    settings: RwLock<NativeSettings>,
    settings_revision: AtomicU64,
    status: Mutex<InputServiceStatus>,
    event_app: RwLock<Option<EventApp>>,
    stop: AtomicBool,
    driver_gate: Arc<AtomicBool>,
    driver_paused: AtomicBool,
}

pub struct InputService {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl InputService {
    pub fn start(resource_dir: Option<PathBuf>, driver_gate: Arc<AtomicBool>) -> Self {
        log::info!(target: "axonkey::input", "Starting Windows input service");
        let shared = Arc::new(Shared {
            settings: RwLock::new(NativeSettings::default()),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            driver_gate,
            driver_paused: AtomicBool::new(false),
        });
        let worker_shared = Arc::clone(&shared);
        #[cfg(windows)]
        let worker = thread::Builder::new()
            .name("Axonkey Quarbor Universal input".into())
            .spawn(move || worker_loop(worker_shared, resource_dir))
            .ok();
        #[cfg(not(windows))]
        let worker = thread::Builder::new()
            .name("Axonkey Quarbor Universal input".into())
            .spawn(move || worker_loop(worker_shared, resource_dir))
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

    pub fn update_settings(&self, settings: NativeSettings) -> Result<(), String> {
        validate_settings(&settings)?;
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
}

impl Drop for InputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct QuarborTargetSelector {
    resource_dir: Option<PathBuf>,
    last_probe: Instant,
    target: Option<String>,
    installer_failure_logged: bool,
}

impl QuarborTargetSelector {
    fn new(resource_dir: Option<PathBuf>) -> Self {
        Self {
            resource_dir,
            last_probe: Instant::now() - Duration::from_secs(1),
            target: None,
            installer_failure_logged: false,
        }
    }

    fn current(&mut self) -> Option<String> {
        #[cfg(windows)]
        if self.last_probe.elapsed() >= Duration::from_secs(1) {
            self.last_probe = Instant::now();
            self.target = self.probe();
        }
        self.target.clone()
    }

    #[cfg(windows)]
    fn probe(&mut self) -> Option<String> {
        let Some(resource_dir) = self.resource_dir.as_deref() else {
            if !self.installer_failure_logged {
                log::warn!(
                    target: "axonkey::input",
                    "Quarbor installer resource directory unavailable; waiting for a valid bound BTHLEDEVICE target"
                );
                self.installer_failure_logged = true;
            }
            return None;
        };
        match crate::quarbor_installer::list(resource_dir) {
            Ok(devices) => crate::quarbor_installer::select_bound_target(&devices),
            Err(error) => {
                if !self.installer_failure_logged {
                    log::warn!(
                        target: "axonkey::input",
                        "Quarbor installer device list unavailable; waiting for a valid bound BTHLEDEVICE target: {error}"
                    );
                    self.installer_failure_logged = true;
                }
                None
            }
        }
    }
}

#[cfg(windows)]
fn worker_loop(shared: Arc<Shared>, resource_dir: Option<PathBuf>) {
    log::info!(target: "axonkey::input", "Quarbor Universal duplex backend loaded");
    shared.status.lock().unwrap().backend_ready = true;
    let mut last_target_seen_at = None;
    let mut target_selector = QuarborTargetSelector::new(resource_dir.clone());
    while !shared.stop.load(Ordering::Relaxed) {
        if shared.driver_gate.load(Ordering::Acquire) {
            // run_context has returned and dropped its pipe before acknowledging
            // this pause. Support both startup migration and manual rechecks.
            shared.status.lock().unwrap().backend_ready = false;
            shared.driver_paused.store(true, Ordering::Release);
            while shared.driver_gate.load(Ordering::Acquire) && !shared.stop.load(Ordering::Relaxed)
            {
                thread::sleep(Duration::from_millis(25));
            }
            shared.driver_paused.store(false, Ordering::Release);
            target_selector = QuarborTargetSelector::new(resource_dir.clone());
            if shared.stop.load(Ordering::Relaxed) {
                break;
            }
            shared.status.lock().unwrap().backend_ready = true;
        }
        if !wait_for_stable_target(&shared, &mut last_target_seen_at, &mut target_selector) {
            continue;
        }
        run_context(
            &mut QuarborContext::default(),
            &shared,
            &mut last_target_seen_at,
            &mut target_selector,
        );
    }
    shared.status.lock().unwrap().capture_active = false;
}

#[cfg(not(windows))]
fn worker_loop(shared: Arc<Shared>, resource_dir: Option<PathBuf>) {
    let _ = resource_dir;
    log::info!(target: "axonkey::input", "Windows input service is unavailable on this platform");
    shared.status.lock().unwrap().backend_ready = false;
    while !shared.stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_stable_target(
    shared: &Shared,
    last_target_seen_at: &mut Option<Instant>,
    target_selector: &mut QuarborTargetSelector,
) -> bool {
    let mut stable_since = None;
    while !shared.stop.load(Ordering::Relaxed) {
        if shared.driver_gate.load(Ordering::Acquire) {
            return false;
        }
        let now = Instant::now();
        let hardware_id = target_selector.current();
        let target_present = hardware_id.is_some();
        update_device_status(shared, hardware_id, last_target_seen_at, now);

        // Universal capture is independent of mappings. Keep observing even when
        // mappings are disabled; forward original keys through the driver.
        if target_present {
            let first_stable = *stable_since.get_or_insert(now);
            if now.saturating_duration_since(first_stable) >= DEVICE_STABLE_DURATION {
                return true;
            }
        } else {
            stable_since = None;
        }

        thread::sleep(DEVICE_POLL_INTERVAL);
    }
    false
}

#[cfg(windows)]
fn run_context(
    context: &mut QuarborContext,
    shared: &Shared,
    last_target_seen_at: &mut Option<Instant>,
    target_selector: &mut QuarborTargetSelector,
) {
    context.device_id = target_selector.current();
    let mut next_probe = Instant::now();
    let mut actions = super::remote_actions::RemoteActions::default();
    let mut state_epoch = context.state_epoch;
    while !shared.stop.load(Ordering::Relaxed) {
        if shared.driver_gate.load(Ordering::Acquire) {
            break;
        }
        let now = Instant::now();
        if now >= next_probe {
            let device_id = target_selector.current();
            update_device_status(shared, device_id.clone(), last_target_seen_at, now);
            if device_id.as_deref() != context.device_id.as_deref() {
                break;
            }
            next_probe = now + Duration::from_secs(1);
        }
        quarbor_wait_with_timeout(context, WAIT_TIMEOUT_MS);
        quarbor_publish_events(context, shared);
        process_remote_actions(
            context,
            shared,
            &mut actions,
            &mut state_epoch,
            Instant::now(),
        );
    }
    quarbor_release_active_usages(context);
    publish_a15_recording(shared, false);
    if context
        .device_id
        .as_deref()
        .is_some_and(crate::devices::cmiot_a15::matches_instance)
    {
        if let Some(client) = context.reader.as_mut() {
            if let Err(error) = client.finish_pending(Duration::from_millis(300)) {
                quarbor_read_error(context, format!("A15 shutdown stop not confirmed: {error}"));
            }
        }
    }
    context.reader = None; // Driver disconnect cleanup releases delivered keys.
    while let Some(key) = context.keys.pop_front() {
        emit_remote_key_event(shared, key.button, key.pressed);
    }
    shared.status.lock().unwrap().capture_active = false;
}

#[cfg(windows)]
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

#[cfg(windows)]
fn publish_a15_recording(shared: &Shared, recording: bool) {
    #[cfg(not(test))]
    if let Some(app) = shared.event_app.read().ok().and_then(|app| app.clone()) {
        use tauri::Manager;
        if let Some(audio) = app.try_state::<crate::audio_service::AudioService>() {
            audio.set_a15_recording(recording);
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
                let _ = app.emit("axonkey-cmiot-a15-recording", recording);
            }
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
    while let Some(frame) = context.a15_pcm.pop_front() {
        emit_a15_pcm(shared, frame);
    }
    process_remote_actions_inner(context, shared, actions, state_epoch, now);
    context
        .a15_voice
        .synchronize(context.a15_recording.is_recording());
    publish_a15_recording(shared, context.a15_recording.is_recording());
}

#[cfg(windows)]
fn process_remote_actions_inner(
    context: &mut QuarborContext,
    shared: &Shared,
    actions: &mut super::remote_actions::RemoteActions,
    state_epoch: &mut u64,
    now: Instant,
) {
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
        |report| send_a15_recording_report(&mut context.reader, report),
    ) {
        quarbor_output_error(context, error);
        actions.cancel();
        return;
    }
    context
        .a15_voice
        .synchronize(context.a15_recording.is_recording());
    while let Some(key) = context.keys.pop_front() {
        emit_remote_key_event(shared, key.button, key.pressed);
        if key.button == "cmiotA15.voice" {
            if let Err(error) = context.a15_recording.edge(key.pressed, |report| {
                send_a15_recording_report(&mut context.reader, report)
            }) {
                quarbor_output_error(context, error);
                actions.cancel();
                return;
            }
            publish_a15_recording(shared, context.a15_recording.is_recording());
            context
                .a15_voice
                .synchronize(context.a15_recording.is_recording());
            continue;
        }
        actions.edge(key.button, key.pressed, &settings, now);
    }
    let mut output_error = None;
    actions.tick(now, |output| {
        if output_error.is_some() {
            return;
        }
        output_error = emit_remote_output(context, output).err();
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
) -> std::io::Result<()> {
    use super::remote_actions::Output;
    match output {
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
            let driver_supported = mouse_button_usage(button).is_some()
                && context.reader.as_ref().is_some_and(|client| {
                    mouse_button_usage(button).is_some_and(|usage| client.supports_key(0x09, usage))
                });
            let mut sent_by_driver = false;
            if driver_supported {
                let usage = mouse_button_usage(button).expect("driver mouse button usage");
                if let Some(client) = context.reader.as_mut() {
                    match client
                        .send_key(0x09, usage, true)
                        .and_then(|_| client.send_key(0x09, usage, false))
                    {
                        Ok(_) => sent_by_driver = true,
                        Err(error) => log::warn!(
                            target: "axonkey::input",
                            "Universal driver mouse button failed; trying SendInput fallback: {error}"
                        ),
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
            let device = if context
                .device_id
                .as_deref()
                .is_some_and(crate::devices::cmiot_a15::matches_instance)
            {
                super::profile_switch::DeviceId::CmiotA15
            } else {
                super::profile_switch::DeviceId::Rc003
            };
            super::profile_switch::execute(device, direction, wrap)
        }
        // The Universal protocol has no Unicode/text command. Keep paste as a
        // text injection operation; keyboard, media and mouse outputs above
        // remain source-aware.
        Output::Paste(text) => send_unicode_text(&text),
        Output::OpenApp(path) => super::launch::execute(&NativeBehavior::OpenApp {
            enabled: true,
            path,
        }),
        Output::OpenWebsite(url) => {
            super::launch::execute(&NativeBehavior::OpenWebsite { enabled: true, url })
        }
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
                && context
                    .device_id
                    .as_deref()
                    .is_some_and(crate::devices::cmiot_a15::matches_instance)
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
            Event::Report {
                metadata, bytes, ..
            } => {
                emit_raw_hid_event(
                    shared,
                    context.device_id.as_deref().unwrap_or_default(),
                    metadata,
                    bytes,
                );
            }
            Event::Status(_) | Event::CommandAccepted(_) => {}
        }
    }
    let mut status = shared.status.lock().unwrap();
    status.capture_active = context.reader.as_ref().is_some_and(|reader| reader.ready());
    status.error = context.error.clone();
}

#[cfg(all(windows, not(test)))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawHidEvent {
    instance_id: String,
    report_sequence: String,
    timestamp_filetime: String,
    dropped: String,
    ntstatus: u32,
    bytes: Vec<u8>,
}

#[cfg(all(windows, not(test)))]
fn emit_raw_hid_event(
    shared: &Shared,
    instance_id: &str,
    metadata: super::windows_quarbor::Metadata,
    bytes: Vec<u8>,
) {
    let app = shared.event_app.read().ok().and_then(|app| app.clone());
    if let Some(app) = app {
        let _ = app.emit(
            "axonkey-raw-hid",
            RawHidEvent {
                instance_id: instance_id.into(),
                report_sequence: metadata.sequence.to_string(),
                timestamp_filetime: metadata.timestamp.to_string(),
                dropped: metadata.dropped.to_string(),
                ntstatus: metadata.status,
                bytes,
            },
        );
    }
}

#[cfg(all(windows, test))]
fn emit_raw_hid_event(
    _shared: &Shared,
    _instance_id: &str,
    _metadata: super::windows_quarbor::Metadata,
    _bytes: Vec<u8>,
) {
}

fn device_connection_visible(found: bool, last_seen_at: Option<Instant>, now: Instant) -> bool {
    found
        || last_seen_at.is_some_and(|last_seen| {
            now.saturating_duration_since(last_seen) < DEVICE_DISCONNECT_GRACE
        })
}

fn update_device_status(
    shared: &Shared,
    hardware_id: Option<String>,
    last_target_seen_at: &mut Option<Instant>,
    now: Instant,
) {
    let found = hardware_id.is_some();
    if found {
        *last_target_seen_at = Some(now);
    }
    let connected = device_connection_visible(found, *last_target_seen_at, now);
    let mut status = shared.status.lock().unwrap();
    let previous_connected = status.device_connected;
    status.backend_ready = true;
    status.device_connected = connected;
    if found || !connected {
        status.hardware_id = hardware_id;
    }
    status.error = None;
    if previous_connected != connected {
        log::info!(target: "axonkey::input", "RC003 connection changed: connected={connected}");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteKeyEvent {
    button: &'static str,
    pressed: bool,
}

#[cfg(not(test))]
fn emit_remote_key_event(shared: &Shared, button: &'static str, pressed: bool) {
    let app = shared
        .event_app
        .read()
        .ok()
        .and_then(|event_app| event_app.clone());
    if let Some(app) = app {
        let _ = app.emit("axonkey-remote-key", RemoteKeyEvent { button, pressed });
    }
}

// Feed the existing native audio channel directly; the event remains diagnostic.
#[cfg(not(test))]
fn emit_a15_pcm(shared: &Shared, frame: crate::devices::cmiot_a15_fc::PcmFrame) {
    if let Some(app) = shared.event_app.read().ok().and_then(|app| app.clone()) {
        use tauri::Manager;
        if let Some(audio) = app.try_state::<crate::audio_service::AudioService>() {
            audio.push_a15_pcm(&frame.samples);
        }
        let _ = app.emit("axonkey-cmiot-a15-pcm", frame);
    }
}

#[cfg(test)]
fn emit_a15_pcm(_shared: &Shared, _frame: crate::devices::cmiot_a15_fc::PcmFrame) {}

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
        NativeBehavior::Paste { text, .. } => send_unicode_text(text),
        NativeBehavior::OpenApp { .. } | NativeBehavior::OpenWebsite { .. } => {
            super::launch::execute(behavior)
        }
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
        NativeBehavior::Delay { .. } | NativeBehavior::Disabled { .. } => {}
    }
}

fn virtual_key_input(key: u16) -> Input {
    let extended = unsafe { MapVirtualKeyW(key as u32, 4) } >> 8 == 0xe0;
    Input {
        kind: 1,
        value: InputValue {
            keyboard: KeyboardInput {
                virtual_key: key,
                scan_code: 0,
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
        | NativeBehavior::Paste { .. }
        | NativeBehavior::OpenApp { .. }
        | NativeBehavior::OpenWebsite { .. }
        | NativeBehavior::Delay { .. }
        | NativeBehavior::SwitchProfile { .. }
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

#[cfg(windows)]
fn virtual_key_for_hid(key: super::remote_actions::HidKey) -> Option<u16> {
    (1..=255)
        .filter(|virtual_key| !matches!(virtual_key, 0x10..=0x12))
        .find(|virtual_key| hid_key_for_virtual_key(*virtual_key) == Some(key))
        .or_else(|| (key.page == 7 && key.usage == 0xf1).then_some(0x08))
}

#[cfg(windows)]
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
        "LALT" => 0xa4,
        "RALT" => 0xa5,
        "WIN" | "LWIN" => 0x5b,
        "RWIN" => 0x5c,
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

fn validate_settings(settings: &NativeSettings) -> Result<(), String> {
    for (button, triggers) in &settings.behaviors {
        for behavior in triggers.iter() {
            if !behavior.enabled() {
                continue;
            }
            match behavior {
                NativeBehavior::Key { key, .. } if behavior_hid_chord(behavior).is_none() => {
                    return Err(format!("{button}: unsupported key '{key}'"));
                }
                NativeBehavior::Shortcut { keys, .. }
                    if keys.is_empty()
                        || keys.iter().any(|key| parse_chord(key).is_none())
                        || behavior_hid_chord(behavior).is_none() =>
                {
                    return Err(format!("{button}: shortcut contains an unsupported key"));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

#[repr(C)]
#[allow(dead_code)]
struct WinPoint {
    x: i32,
    y: i32,
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
    static MOUSE_KEY_BATCHES: std::cell::RefCell<Vec<Vec<(u16, u32)>>> = const { std::cell::RefCell::new(Vec::new()) };
    static WHEEL_EVENTS: std::cell::RefCell<Vec<i32>> = const { std::cell::RefCell::new(Vec::new()) };
    static MOUSE_MOVES: std::cell::RefCell<Vec<(i32, i32)>> = const { std::cell::RefCell::new(Vec::new()) };
    static MOUSE_BUTTON_EVENTS: std::cell::RefCell<Vec<(u32, u32)>> = const { std::cell::RefCell::new(Vec::new()) };
    static UNICODE_EVENTS: std::cell::RefCell<Vec<(u16, u32)>> = const { std::cell::RefCell::new(Vec::new()) };
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
    log::info!(target: "axonkey::input", "Mapped paste output: expected_events={expected_events}, sent_events={sent_events}");
    if sent_events != expected_events {
        log::warn!(target: "axonkey::input", "Mapped paste injection incomplete: expected_events={expected_events}, sent_events={sent_events}");
    }
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn MapVirtualKeyW(code: u32, map_type: u32) -> u32;
    fn SendInput(input_count: u32, inputs: *const Input, input_size: i32) -> u32;
    fn GetCursorPos(point: *mut WinPoint) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
}

#[cfg(not(target_os = "windows"))]
#[allow(non_snake_case)]
unsafe fn MapVirtualKeyW(_code: u32, _map_type: u32) -> u32 {
    0
}

#[cfg(not(target_os = "windows"))]
#[allow(non_snake_case)]
unsafe fn SendInput(_input_count: u32, _inputs: *const Input, _input_size: i32) -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

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
                    settings: RwLock::new(settings.clone()),
                    settings_revision: AtomicU64::new(1),
                    status: Mutex::new(InputServiceStatus::default()),
                    event_app: RwLock::new(None),
                    stop: AtomicBool::new(false),
                    driver_gate: Arc::new(AtomicBool::new(false)),
                    driver_paused: AtomicBool::new(false),
                }),
                worker: Mutex::new(None),
            };
            let now = Instant::now();
            let mut actions = RemoteActions::default();
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
        // No resource directory means this worker cannot select or open hardware.
        let service = InputService::start(None, gate.clone());
        service.wait_for_driver_pause().unwrap();
        assert!(!service.status().backend_ready);
        gate.store(false, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(2);
        while service.shared.driver_paused.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "worker must resume");
            thread::sleep(Duration::from_millis(5));
        }
        gate.store(true, Ordering::Release);
        service.wait_for_driver_pause().unwrap();
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
                vec![vec![(0x11, 0), (0x43, 0), (0x43, 2), (0x11, 2)]]
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

        emit_remote_output(&mut context, Output::Wheel(WheelDirection::Up)).unwrap();
        emit_remote_output(&mut context, Output::CursorMove(WheelDirection::Right, 37)).unwrap();
        emit_remote_output(
            &mut context,
            Output::MouseClick(super::super::MouseButton::Left),
        )
        .unwrap();
        emit_remote_output(
            &mut context,
            Output::MouseClick(super::super::MouseButton::Middle),
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
        emit_remote_output(&mut context, Output::CursorMove(WheelDirection::Right, 37)).unwrap();
        MOUSE_MOVES.with(|moves| assert_eq!(*moves.borrow(), [(37, 0)]));
    }

    #[cfg(windows)]
    #[test]
    fn report_gaps_and_read_errors_release_observed_keys() {
        use super::super::windows_quarbor::{Event, Metadata};
        let metadata = |sequence, dropped, status| Metadata {
            sequence,
            timestamp: 0,
            dropped,
            status,
        };
        let mut context = QuarborContext::default();
        for sequence in [1, 3] {
            quarbor_accept_event(
                &mut context,
                Event::Report {
                    metadata: metadata(sequence, 0, 0),
                    bytes: vec![1, 0x3e],
                    usages: Ok(vec![0x3e]),
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
        assert!(context.active_usages.is_empty());
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
                    timestamp: u64::MAX,
                    dropped: 0,
                    status: 0,
                },
                bytes: bytes.clone(),
                usages: Err(5),
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
        quarbor_release_active_usages(&mut context);
        assert!(!context.keys.pop_front().unwrap().pressed);
        quarbor_release_active_usages(&mut context);
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

    #[test]
    fn keeps_short_ble_hid_disconnects_out_of_the_visible_status() {
        let now = Instant::now();
        assert!(device_connection_visible(true, None, now));
        assert!(device_connection_visible(
            false,
            now.checked_sub(Duration::from_secs(7)),
            now
        ));
        assert!(!device_connection_visible(
            false,
            now.checked_sub(Duration::from_secs(8)),
            now
        ));
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
        let mut actions = RemoteActions::default();
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
            settings: RwLock::new(NativeSettings::default()),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            driver_gate: Arc::new(AtomicBool::new(false)),
            driver_paused: AtomicBool::new(false),
        };
        let mut context = QuarborContext::default();
        context
            .a15_recording
            .synchronize(
                crate::devices::cmiot_a15_recording::RecordingMode::Click,
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
        quarbor_release_active_usages(&mut context);
        publish_a15_recording(&shared, context.a15_recording.is_recording());
        assert!(!shared.status.lock().unwrap().cmiot_a15_recording);
    }

    #[test]
    #[cfg(windows)]
    fn a15_reports_route_to_scoped_keys_and_release_only_their_collection() {
        use super::super::windows_quarbor::{Event, Metadata};
        let mut context = QuarborContext::default();
        context.device_id = Some(r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_remote\instance".into());
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
                    usages: Err(50), // The RC003 decoder cannot decode A15 consumer packets.
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
                usages: Err(50),
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
                usages: Err(50),
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
}
