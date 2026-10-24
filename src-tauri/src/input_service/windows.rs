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
    // Remember the backend selected on key down; key up must use the same one,
    // even after disconnect or a descriptor/capability change.
    held: Vec<(super::remote_actions::HidKey, KeyBackend)>,
    virtual_keys: std::collections::HashSet<super::remote_actions::HidKey>,
    repeats: std::collections::HashMap<super::remote_actions::HidKey, Instant>,
}

#[cfg(windows)]
impl RemoteKeyboard {
    fn prepare(
        &mut self,
        settings: &NativeSettings,
        supports: impl Fn(super::remote_actions::HidKey) -> bool,
    ) {
        if !settings.enabled {
            self.virtual_keys.clear();
            return;
        }
        let chords: Vec<_> = settings
            .behaviors
            .values()
            .flat_map(super::TriggerBehaviors::iter)
            .filter(|action| action.enabled())
            .filter_map(behavior_hid_chord)
            .collect();
        self.virtual_keys = chords
            .iter()
            .flatten()
            .copied()
            .filter(|key| is_virtual_media_key(*key) || !supports(*key))
            .collect();
        // A chord cannot mix asynchronous driver writes and immediate SendInput
        // events. Shared keys also need one backend for the scheduler's refcounts.
        loop {
            let previous = self.virtual_keys.len();
            for chord in &chords {
                if chord.iter().any(|key| self.virtual_keys.contains(key)) {
                    self.virtual_keys.extend(chord.iter().copied());
                }
            }
            if self.virtual_keys.len() == previous {
                break;
            }
        }
    }

    fn edge_with(
        &mut self,
        key: super::remote_actions::HidKey,
        down: bool,
        supported: bool,
        now: Instant,
        mut emit: impl FnMut(KeyBackend, bool) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        let held = self.held.iter().position(|(held, _)| *held == key);
        if !down {
            if let Some(index) = held {
                emit(self.held[index].1, false)?;
                self.held.remove(index);
                self.repeats.remove(&key);
            }
            return Ok(());
        }
        if held.is_some() {
            return Ok(());
        }
        // Media/volume keys use virtual control even if the keyboard
        // descriptor advertises the corresponding non-typing usages.
        let backend = if is_virtual_media_key(key) || !supported || self.virtual_keys.contains(&key)
        {
            KeyBackend::Virtual(virtual_key_for_hid(key).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    format!(
                        "No virtual key for HID {:#06X}/{:#06X}",
                        key.page, key.usage
                    ),
                )
            })?)
        } else {
            KeyBackend::Driver(key)
        };
        emit(backend, true)?;
        self.held.push((key, backend));
        if let KeyBackend::Virtual(vk) = backend {
            log::info!(target: "axonkey::input", "Mapped virtual keyboard output: HID={:#06X}/{:#06X}, VK={vk:#04X}", key.page, key.usage);
            if matches!(vk, 0xae | 0xaf) || !matches!(vk, 0xa0..=0xa5 | 0x5b..=0x5c | 0xad..=0xb3) {
                self.repeats.insert(key, now + Duration::from_millis(400));
            }
        }
        Ok(())
    }

    fn reset(&mut self) {
        self.repeats.clear();
        for index in (0..self.held.len()).rev() {
            let KeyBackend::Virtual(key) = self.held[index].1 else {
                continue;
            };
            // Retry a failed release once; keep it for the next cleanup attempt.
            if send_remote_virtual_key(key, false)
                .or_else(|_| send_remote_virtual_key(key, false))
                .is_ok()
            {
                self.held.remove(index);
            }
        }
    }

    fn repeat(&mut self, now: Instant) -> std::io::Result<()> {
        for (key, backend) in &self.held {
            let Some(due) = self.repeats.get_mut(key) else {
                continue;
            };
            if now < *due {
                continue;
            }
            if let KeyBackend::Virtual(vk) = backend {
                send_remote_virtual_key(*vk, true)?;
            }
            *due = now + Duration::from_millis(80);
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for RemoteKeyboard {
    fn drop(&mut self) {
        self.reset();
    }
}

fn is_virtual_media_key(key: super::remote_actions::HidKey) -> bool {
    key.page == 0x0c || (key.page == 7 && matches!(key.usage, 0x7f..=0x81))
}

fn virtual_key_for_hid(key: super::remote_actions::HidKey) -> Option<u16> {
    // The same conversion table serves both directions. Choose explicit left
    // modifier VKs so left/right identity is preserved by SendInput.
    (1..=255)
        .filter(|vk| !matches!(vk, 0x10..=0x12))
        .find(|vk| hid_key_for_virtual_key(*vk) == Some(key))
        .or_else(|| (key.page == 7 && key.usage == 0xf1).then_some(0x08))
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
    context.keyboard.reset();
    context.state_epoch = context.state_epoch.wrapping_add(1);
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
}

pub struct InputService {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl InputService {
    pub fn start(resource_dir: Option<PathBuf>) -> Self {
        log::info!(target: "axonkey::input", "Starting Windows input service");
        let shared = Arc::new(Shared {
            settings: RwLock::new(NativeSettings::default()),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
        });
        let worker_shared = Arc::clone(&shared);
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
        *current = settings;
        self.shared
            .settings_revision
            .fetch_add(1, Ordering::Relaxed);
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

fn worker_loop(shared: Arc<Shared>, resource_dir: Option<PathBuf>) {
    log::info!(target: "axonkey::input", "Quarbor Universal duplex backend loaded");
    shared.status.lock().unwrap().backend_ready = true;
    let mut last_target_seen_at = None;
    let mut target_selector = QuarborTargetSelector::new(resource_dir);
    while !shared.stop.load(Ordering::Relaxed) {
        if !wait_for_stable_target(&shared, &mut last_target_seen_at, &mut target_selector) {
            break;
        }
        #[cfg(windows)]
        run_context(
            &mut QuarborContext::default(),
            &shared,
            &mut last_target_seen_at,
            &mut target_selector,
        );
    }
    shared.status.lock().unwrap().capture_active = false;
}

fn wait_for_stable_target(
    shared: &Shared,
    last_target_seen_at: &mut Option<Instant>,
    target_selector: &mut QuarborTargetSelector,
) -> bool {
    let mut stable_since = None;
    while !shared.stop.load(Ordering::Relaxed) {
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
    context.reader = None; // Driver disconnect cleanup releases delivered keys.
    while let Some(key) = context.keys.pop_front() {
        emit_remote_key_event(shared, key.button, key.pressed);
    }
    shared.status.lock().unwrap().capture_active = false;
}

#[cfg(windows)]
fn process_remote_actions(
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
    context.keyboard.prepare(&settings, |key| {
        context
            .reader
            .as_ref()
            .is_some_and(|client| client.supports_key(key.page, key.usage))
    });
    while let Some(key) = context.keys.pop_front() {
        emit_remote_key_event(shared, key.button, key.pressed);
        actions.edge(key.button, key.pressed, &settings, now);
    }
    let mut output_error = None;
    actions.tick(now, |output| {
        if output_error.is_some() {
            return;
        }
        output_error = emit_remote_output(context, output, now).err();
    });
    if output_error.is_none() {
        output_error = context.keyboard.repeat(now).err();
    }
    if let Some(error) = output_error {
        quarbor_output_error(context, error);
        actions.cancel();
    }
}

#[cfg(windows)]
fn emit_remote_output(
    context: &mut QuarborContext,
    output: super::remote_actions::Output,
    now: Instant,
) -> std::io::Result<()> {
    use super::remote_actions::Output;
    match output {
        Output::CursorMove(direction, distance) => {
            let (dx, dy) = cursor_delta(direction, distance);
            send_mouse_move(dx, dy);
        }
        Output::MouseClick(button) => send_mouse_click(button),
        Output::Wheel(direction) => {
            send_wheel_with_axis(wheel_delta(direction), wheel_horizontal(direction));
        }
        Output::SwitchProfile(direction, wrap) => super::profile_switch::execute(direction, wrap),
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
            context.keyboard.edge_with(
                key,
                down,
                supported,
                now,
                |backend, down| match backend {
                    KeyBackend::Virtual(key) => send_remote_virtual_key(key, down),
                    KeyBackend::Driver(key) => {
                        if let Some(client) = context.reader.as_mut() {
                            client.send_key(key.page, key.usage, down)?;
                        }
                        Ok(())
                    }
                },
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

fn wheel_delta(direction: WheelDirection) -> i32 {
    match direction {
        WheelDirection::Up => 120,
        WheelDirection::Down => -120,
        WheelDirection::Left => -120,
        WheelDirection::Right => 120,
    }
}

/// System mouse mappings use SendInput, independently of any RC003 keyboard.
pub(super) fn execute_mouse_behavior(behavior: &NativeBehavior, hold_ms: u64) {
    match behavior {
        NativeBehavior::Wheel { direction, .. } => {
            send_wheel_with_axis(wheel_delta(*direction), wheel_horizontal(*direction))
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
                    log::warn!(target: "axonkey::input", "Mouse keyboard injection incomplete; target may have higher privileges");
                }
            }
        }
        NativeBehavior::SwitchProfile {
            direction, wrap, ..
        } => super::profile_switch::execute(*direction, *wrap),
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
    if hold_ms > 0 {
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
        if released < ups.len() {
            send(&ups[released..]);
        }
        return pressed == downs.len() && released == ups.len();
    }
    let mut inputs = Vec::with_capacity(downs.len() * 2);
    inputs.extend_from_slice(&downs);
    inputs.extend(downs.iter().copied().rev().map(release));
    let sent = send(&inputs).min(inputs.len());
    if sent == inputs.len() {
        return true;
    }
    // A partial batch may have inserted downs without their matching ups.
    // Release only those keys, in reverse order, without replaying the action.
    let held = sent.min(downs.len()) - sent.saturating_sub(downs.len());
    if held > 0 {
        let cleanup: Vec<Input> = downs[..held].iter().copied().rev().map(release).collect();
        send(&cleanup);
    }
    false
}

fn send_keyboard_inputs(inputs: &[Input]) -> usize {
    #[cfg(not(test))]
    {
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            ) as usize
        }
    }
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
        0xad => (7, 0x7f),
        0xaf => (7, 0x80),
        0xae => (7, 0x81),
        0xb0 => (0x0c, 0xb5),
        0xb1 => (0x0c, 0xb6),
        0xb2 => (0x0c, 0xb7),
        0xb3 => (0x0c, 0xcd),
        _ => return None,
    };
    Some(super::remote_actions::HidKey { page, usage })
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

    #[cfg(windows)]
    #[test]
    fn hid_reports_dispatch_wheel_unicode_and_validated_launches() {
        use super::super::windows_quarbor::{Event, Metadata};
        let application = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let shared = Shared {
            settings: RwLock::new(
                serde_json::from_value(serde_json::json!({
                    "enabled":true, "behaviors":{"confirm":{"click":[
                        {"type":"wheel","direction":"up"},
                        {"type":"wheel","direction":"down"},
                        {"type":"wheel","direction":"left"},
                        {"type":"wheel","direction":"right"},
                        {"type":"paste","text":"中文🙂"},
                        {"type":"delay","ms":100},
                        {"type":"openApp","path":application},
                        {"type":"openWebsite","url":"https://example.com/"},
                        {"type":"openWebsite","url":"file:///C:/Example.exe"}
                    ]}}
                }))
                .unwrap(),
            ),
            settings_revision: AtomicU64::new(1),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
        };
        WHEEL_EVENTS.with(|events| events.borrow_mut().clear());
        UNICODE_EVENTS.with(|events| events.borrow_mut().clear());
        super::super::launch::OPENED_TARGETS.with(|targets| targets.borrow_mut().clear());
        let mut context = QuarborContext::default();
        let mut actions = super::super::remote_actions::RemoteActions::default();
        let mut epoch = 0;
        let now = Instant::now();
        for (sequence, usages) in [(1, vec![0x28]), (2, vec![])] {
            quarbor_accept_event(
                &mut context,
                Event::Report {
                    metadata: Metadata {
                        sequence,
                        timestamp: 0,
                        dropped: 0,
                        status: 0,
                    },
                    bytes: vec![1; 121],
                    usages: Ok(usages),
                },
            );
            process_remote_actions(&mut context, &shared, &mut actions, &mut epoch, now);
        }
        WHEEL_EVENTS.with(|events| assert_eq!(*events.borrow(), [120, -120, -120, 120]));
        let expected: Vec<_> = "中文🙂"
            .encode_utf16()
            .flat_map(|unit| [(unit, 4), (unit, 6)])
            .collect();
        UNICODE_EVENTS.with(|events| assert_eq!(*events.borrow(), expected));
        for elapsed in [99, 100] {
            process_remote_actions(
                &mut context,
                &shared,
                &mut actions,
                &mut epoch,
                now + Duration::from_millis(elapsed),
            );
            super::super::launch::OPENED_TARGETS.with(|targets| {
                if elapsed == 99 {
                    assert!(targets.borrow().is_empty());
                } else {
                    assert_eq!(
                        *targets.borrow(),
                        [
                            (application.clone(), true),
                            ("https://example.com/".into(), false)
                        ]
                    );
                }
            });
        }
        // A queued launch must not survive a capture discontinuity.
        for (sequence, usages) in [(3, vec![0x28]), (4, vec![])] {
            quarbor_accept_event(
                &mut context,
                Event::Report {
                    metadata: Metadata {
                        sequence,
                        timestamp: 0,
                        dropped: 0,
                        status: 0,
                    },
                    bytes: vec![1; 121],
                    usages: Ok(usages),
                },
            );
        }
        process_remote_actions(
            &mut context,
            &shared,
            &mut actions,
            &mut epoch,
            now + Duration::from_secs(1),
        );
        context.state_epoch += 1;
        process_remote_actions(
            &mut context,
            &shared,
            &mut actions,
            &mut epoch,
            now + Duration::from_secs(2),
        );
        super::super::launch::OPENED_TARGETS.with(|targets| assert_eq!(targets.borrow().len(), 2));
    }

    #[cfg(windows)]
    #[test]
    fn hid_reports_execute_mouse_clicks_in_sequences_and_cancel_pending_clicks() {
        use super::super::windows_quarbor::{Event, Metadata};
        let shared = Shared {
            settings: RwLock::new(
                serde_json::from_value(serde_json::json!({
                    "enabled":true, "behaviors":{"confirm":{"click":[
                        {"type":"cursorMove","direction":"right","distance":37},
                        {"type":"mouse","button":"left"},
                        {"type":"delay","ms":100},
                        {"type":"mouse","button":"right"}
                    ]}}
                }))
                .unwrap(),
            ),
            settings_revision: AtomicU64::new(1),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
        };
        let report = |sequence, usages| Event::Report {
            metadata: Metadata {
                sequence,
                timestamp: 0,
                dropped: 0,
                status: 0,
            },
            bytes: vec![1; 121],
            usages: Ok(usages),
        };
        MOUSE_BUTTON_EVENTS.with(|events| events.borrow_mut().clear());
        MOUSE_MOVES.with(|events| events.borrow_mut().clear());
        let mut context = QuarborContext::default();
        let mut actions = super::super::remote_actions::RemoteActions::default();
        let mut epoch = 0;
        let now = Instant::now();
        quarbor_accept_event(&mut context, report(1, vec![0x28]));
        process_remote_actions(&mut context, &shared, &mut actions, &mut epoch, now);
        MOUSE_BUTTON_EVENTS.with(|events| assert!(events.borrow().is_empty()));
        quarbor_accept_event(&mut context, report(2, vec![]));
        process_remote_actions(&mut context, &shared, &mut actions, &mut epoch, now);
        MOUSE_BUTTON_EVENTS.with(|events| assert_eq!(*events.borrow(), [(2, 0), (4, 0)]));
        MOUSE_MOVES.with(|events| assert_eq!(*events.borrow(), [(37, 0)]));
        process_remote_actions(
            &mut context,
            &shared,
            &mut actions,
            &mut epoch,
            now + Duration::from_millis(99),
        );
        MOUSE_BUTTON_EVENTS.with(|events| assert_eq!(events.borrow().len(), 2));
        process_remote_actions(
            &mut context,
            &shared,
            &mut actions,
            &mut epoch,
            now + Duration::from_millis(100),
        );
        MOUSE_BUTTON_EVENTS
            .with(|events| assert_eq!(*events.borrow(), [(2, 0), (4, 0), (8, 0), (16, 0)]));
        // A repeated/empty report must not click again. Disabling mappings
        // after the next click cancels the right click still waiting on delay.
        quarbor_accept_event(&mut context, report(3, vec![]));
        process_remote_actions(
            &mut context,
            &shared,
            &mut actions,
            &mut epoch,
            now + Duration::from_secs(1),
        );
        MOUSE_BUTTON_EVENTS.with(|events| assert_eq!(events.borrow().len(), 4));
        quarbor_accept_event(&mut context, report(4, vec![0x28]));
        quarbor_accept_event(&mut context, report(5, vec![]));
        process_remote_actions(
            &mut context,
            &shared,
            &mut actions,
            &mut epoch,
            now + Duration::from_secs(2),
        );
        MOUSE_BUTTON_EVENTS.with(|events| assert_eq!(events.borrow().len(), 6));
        shared.settings.write().unwrap().enabled = false;
        shared.settings_revision.fetch_add(1, Ordering::Relaxed);
        process_remote_actions(
            &mut context,
            &shared,
            &mut actions,
            &mut epoch,
            now + Duration::from_secs(3),
        );
        MOUSE_BUTTON_EVENTS.with(|events| assert_eq!(events.borrow().len(), 6));
    }

    #[cfg(windows)]
    #[test]
    fn hid_reports_execute_cursor_mapping_and_failures_cancel_repeats() {
        use super::super::windows_quarbor::{Event, Metadata};
        let shared = Shared {
            settings: RwLock::new(
                serde_json::from_value(serde_json::json!({
                    "enabled":true, "behaviors":{"up":{"click":[
                        {"type":"cursorMove", "direction":"right", "distance":37}
                    ]}}
                }))
                .unwrap(),
            ),
            settings_revision: AtomicU64::new(0),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
        };
        let report = |seq, usages| Event::Report {
            metadata: Metadata {
                sequence: seq,
                timestamp: 0,
                dropped: 0,
                status: 0,
            },
            bytes: vec![1; 121],
            usages,
        };
        for failure in 0..4 {
            MOUSE_MOVES.with(|moves| moves.borrow_mut().clear());
            let mut context = QuarborContext::default();
            let mut cursor = super::super::remote_actions::RemoteActions::default();
            let mut epoch = 0;
            let now = Instant::now();
            quarbor_accept_event(&mut context, report(1, Ok(vec![0x52])));
            process_remote_actions(&mut context, &shared, &mut cursor, &mut epoch, now);
            MOUSE_MOVES.with(|moves| assert_eq!(*moves.borrow(), [(37, 0)]));
            process_remote_actions(
                &mut context,
                &shared,
                &mut cursor,
                &mut epoch,
                now + Duration::from_millis(400),
            );
            MOUSE_MOVES.with(|moves| assert_eq!(moves.borrow().len(), 2));
            match failure {
                0 => quarbor_accept_event(&mut context, report(2, Ok(vec![]))),
                1 => quarbor_release_active_usages(&mut context), // disconnect/gap
                2 => quarbor_accept_event(&mut context, report(2, Err(5))),
                _ => quarbor_accept_event(
                    &mut context,
                    Event::Status(Metadata {
                        sequence: 1,
                        timestamp: 0,
                        dropped: 0,
                        status: 0xc0000001,
                    }),
                ),
            }
            process_remote_actions(
                &mut context,
                &shared,
                &mut cursor,
                &mut epoch,
                now + Duration::from_millis(410),
            );
            process_remote_actions(
                &mut context,
                &shared,
                &mut cursor,
                &mut epoch,
                now + Duration::from_secs(1),
            );
            MOUSE_MOVES.with(|moves| assert_eq!(moves.borrow().len(), 2, "failure={failure}"));
        }
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
    fn mouse_shortcut_burst_has_no_per_event_hold_delay() {
        MOUSE_KEY_BATCHES.with(|batches| batches.borrow_mut().clear());
        let started = Instant::now();
        for index in 0..40 {
            execute_mouse_behavior(
                &NativeBehavior::Shortcut {
                    enabled: true,
                    keys: if index % 2 == 0 {
                        vec!["Ctrl".into(), "Shift".into(), "Tab".into()]
                    } else {
                        vec!["Ctrl".into(), "Tab".into()]
                    },
                },
                0,
            );
        }
        let elapsed = started.elapsed();
        println!("40 alternating mouse shortcut outputs (mock injection): {elapsed:?}");
        MOUSE_KEY_BATCHES.with(|batches| {
            let batches = batches.borrow();
            assert_eq!(batches.len(), 40);
            for (index, batch) in batches.iter().enumerate() {
                let expected = if index % 2 == 0 {
                    vec![
                        (0x11, 0),
                        (0x10, 0),
                        (0x09, 0),
                        (0x09, 2),
                        (0x10, 2),
                        (0x11, 2),
                    ]
                } else {
                    vec![(0x11, 0), (0x09, 0), (0x09, 2), (0x11, 2)]
                };
                assert_eq!(
                    *batch, expected,
                    "every notch must preserve order and release its modifiers"
                );
            }
        });
        // Generous headroom for CI scheduling; the former fixed 50 ms hold
        // necessarily took at least two seconds, even without OS injection.
        assert!(
            elapsed < Duration::from_secs(1),
            "mouse output is serialized behind a per-event hold: {elapsed:?}"
        );
    }

    #[test]
    fn configured_mouse_hold_separates_down_and_up() {
        let started = Instant::now();
        let mut batches = Vec::new();
        assert!(send_mouse_chord_with(&[0x11, 0x09], 20, |inputs| {
            batches.push((
                started.elapsed(),
                inputs
                    .iter()
                    .map(|input| unsafe {
                        (input.value.keyboard.virtual_key, input.value.keyboard.flags)
                    })
                    .collect::<Vec<_>>(),
            ));
            inputs.len()
        }));
        assert_eq!(batches.len(), 2);
        assert!(batches[1].0 - batches[0].0 >= Duration::from_millis(20));
        assert_eq!(batches[0].1, vec![(0x11, 0), (0x09, 0)]);
        assert_eq!(batches[1].1, vec![(0x09, 2), (0x11, 2)]);
    }

    #[test]
    fn configured_mouse_hold_cleans_up_partial_injection() {
        for partial_release in [false, true] {
            let mut calls = 0;
            let mut held = Vec::new();
            assert!(!send_mouse_chord_with(&[0x11, 0x09], 1, |inputs| {
                calls += 1;
                let sent = if (partial_release && calls == 2) || (!partial_release && calls == 1) {
                    1
                } else {
                    inputs.len()
                };
                for input in &inputs[..sent] {
                    let key = unsafe { input.value.keyboard };
                    if key.flags & 2 == 0 {
                        held.push(key.virtual_key);
                    } else {
                        assert_eq!(held.pop(), Some(key.virtual_key));
                    }
                }
                sent
            }));
            assert!(held.is_empty());
        }
    }

    #[test]
    fn partial_mouse_chord_injection_releases_only_unmatched_downs() {
        let keys = [0x11, 0x10, 0x09];
        for accepted in 0..=6 {
            let mut calls = 0;
            let mut held = Vec::new();
            let complete = send_mouse_chord_with(&keys, 0, |inputs| {
                calls += 1;
                let sent = if calls == 1 { accepted } else { inputs.len() };
                for input in &inputs[..sent] {
                    assert_eq!(input.kind, 1);
                    let key = unsafe { input.value.keyboard };
                    if key.flags & 2 == 0 {
                        held.push(key.virtual_key);
                    } else {
                        assert_eq!(held.pop(), Some(key.virtual_key));
                    }
                }
                sent
            });
            assert_eq!(complete, accepted == 6);
            assert!(
                held.is_empty(),
                "partial injection must not leave Ctrl/Shift held"
            );
            assert_eq!(calls, if accepted == 0 || accepted == 6 { 1 } else { 2 });
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
    fn virtual_keys_preserve_mapping_sides_and_release_backend_after_capability_change() {
        use super::super::remote_actions::HidKey;
        for vk in 1..=255 {
            if let Some(hid) = hid_key_for_virtual_key(vk) {
                assert_eq!(
                    hid_key_for_virtual_key(virtual_key_for_hid(hid).unwrap()),
                    Some(hid)
                );
            }
        }
        assert_eq!(
            virtual_key_for_hid(HidKey {
                page: 7,
                usage: 0xe2
            }),
            Some(0xa4)
        );
        assert_eq!(
            virtual_key_for_hid(HidKey {
                page: 7,
                usage: 0xe6
            }),
            Some(0xa5)
        );
        let key = HidKey {
            page: 7,
            usage: 0xe6,
        };
        let now = Instant::now();
        let mut keyboard = RemoteKeyboard::default();
        let mut events = Vec::new();
        keyboard
            .edge_with(key, true, false, now, |backend, down| {
                events.push((backend, down));
                Ok(())
            })
            .unwrap();
        keyboard
            .edge_with(key, true, true, now, |backend, down| {
                events.push((backend, down));
                Ok(())
            })
            .unwrap();
        keyboard
            .edge_with(key, false, true, now, |backend, down| {
                events.push((backend, down));
                Ok(())
            })
            .unwrap();
        assert_eq!(
            events,
            [
                (KeyBackend::Virtual(0xa5), true),
                (KeyBackend::Virtual(0xa5), false)
            ]
        );
        assert!(keyboard.held.is_empty());
        // A rejected down must never be remembered as a held key.
        assert!(keyboard
            .edge_with(key, true, false, now, |_, _| Err(std::io::Error::other(
                "injection failed"
            )))
            .is_err());
        assert!(keyboard.held.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn virtual_chords_keep_shared_modifiers_and_connected_chords_on_one_backend() {
        use super::super::remote_actions::{Output, RemoteActions};
        let settings: NativeSettings =
            serde_json::from_value(serde_json::json!({"enabled":true,"behaviors":{
                "up":{"click":[{"type":"shortcut","keys":["Shift","MediaNext"]}]},
                "down":{"click":[{"type":"shortcut","keys":["Shift","B"]}]},
                "voice":{"click":[{"type":"key","key":"RAlt"}]}
            }}))
            .unwrap();
        let mut keyboard = RemoteKeyboard::default();
        keyboard.prepare(&settings, |_| true);
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
                        .edge_with(key, down, true, now, |backend, down| {
                            events.push((backend, down));
                            Ok(())
                        })
                        .unwrap();
                }
            });
        }
        use KeyBackend::{Driver, Virtual};
        assert_eq!(
            events,
            [
                (Virtual(0xa0), true),
                (Virtual(0xb0), true),
                (Virtual(0x42), true),
                (Virtual(0xb0), false),
                (Virtual(0x42), false),
                (Virtual(0xa0), false),
                (
                    Driver(super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe6
                    }),
                    true
                ),
                (
                    Driver(super::super::remote_actions::HidKey {
                        page: 7,
                        usage: 0xe6
                    }),
                    false
                ),
            ]
        );
        assert!(keyboard.held.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn virtual_media_holds_do_not_repeat_playback_and_cleanup_releases_in_reverse_order() {
        let settings: NativeSettings = serde_json::from_value(serde_json::json!({"enabled":true,
            "behaviors":{"up":{"click":[{"type":"shortcut","keys":["RAlt","MediaPlayPause"]}]}}
        }))
        .unwrap();
        let chord = behavior_hid_chord(&settings.behaviors["up"].click[0]).unwrap();
        let mut keyboard = RemoteKeyboard::default();
        keyboard.prepare(&settings, |_| true);
        let now = Instant::now();
        MOUSE_KEY_BATCHES.with(|events| events.borrow_mut().clear());
        for key in chord {
            keyboard
                .edge_with(key, true, true, now, |backend, down| {
                    let KeyBackend::Virtual(vk) = backend else {
                        panic!("mixed backend chord");
                    };
                    send_remote_virtual_key(vk, down)
                })
                .unwrap();
        }
        keyboard.repeat(now + Duration::from_secs(10)).unwrap();
        drop(keyboard);
        MOUSE_KEY_BATCHES.with(|events| {
            let events: Vec<_> = events
                .borrow()
                .iter()
                .flatten()
                .map(|(vk, flags)| (*vk, flags & 2 == 0))
                .collect();
            assert_eq!(
                events,
                [(0xa5, true), (0xb3, true), (0xb3, false), (0xa5, false)]
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn virtual_volume_repeats_and_releases_on_configuration_input_failure_and_shutdown() {
        use super::super::windows_quarbor::{Event, Metadata};
        for failure in 0..6 {
            let shared = Shared {
                settings: RwLock::new(
                    serde_json::from_value(serde_json::json!({"enabled":true,
                        "behaviors":{"confirm":{"click":[{"type":"key","key":"VolumeUp"}]}}
                    }))
                    .unwrap(),
                ),
                settings_revision: AtomicU64::new(1),
                status: Mutex::new(InputServiceStatus::default()),
                event_app: RwLock::new(None),
                stop: AtomicBool::new(false),
            };
            let report = |sequence, usages| Event::Report {
                metadata: Metadata {
                    sequence,
                    timestamp: 0,
                    dropped: 0,
                    status: 0,
                },
                bytes: vec![1; 121],
                usages,
            };
            MOUSE_KEY_BATCHES.with(|events| events.borrow_mut().clear());
            let mut context = QuarborContext::default();
            let mut actions = super::super::remote_actions::RemoteActions::default();
            let mut epoch = 0;
            let now = Instant::now();
            quarbor_accept_event(&mut context, report(1, Ok(vec![0x28])));
            process_remote_actions(&mut context, &shared, &mut actions, &mut epoch, now);
            quarbor_accept_event(&mut context, report(2, Ok(vec![0x28])));
            process_remote_actions(
                &mut context,
                &shared,
                &mut actions,
                &mut epoch,
                now + Duration::from_millis(399),
            );
            MOUSE_KEY_BATCHES.with(|events| assert_eq!(events.borrow().len(), 1));
            process_remote_actions(
                &mut context,
                &shared,
                &mut actions,
                &mut epoch,
                now + Duration::from_millis(400),
            );
            MOUSE_KEY_BATCHES.with(|events| assert_eq!(events.borrow().len(), 2));
            if failure == 5 {
                drop(context);
            } else {
                match failure {
                    0 => quarbor_accept_event(&mut context, report(3, Ok(vec![]))),
                    1 => {
                        shared.settings_revision.fetch_add(1, Ordering::Relaxed);
                    }
                    2 => quarbor_accept_event(&mut context, report(4, Ok(vec![]))),
                    3 => quarbor_accept_event(&mut context, report(3, Err(13))),
                    4 => quarbor_accept_event(
                        &mut context,
                        Event::Status(Metadata {
                            sequence: 2,
                            timestamp: 0,
                            dropped: 0,
                            status: 0xc0000001,
                        }),
                    ),
                    _ => unreachable!(),
                }
                process_remote_actions(
                    &mut context,
                    &shared,
                    &mut actions,
                    &mut epoch,
                    now + Duration::from_millis(410),
                );
                process_remote_actions(
                    &mut context,
                    &shared,
                    &mut actions,
                    &mut epoch,
                    now + Duration::from_secs(2),
                );
                drop(context);
            }
            MOUSE_KEY_BATCHES.with(|events| {
                let events: Vec<_> = events
                    .borrow()
                    .iter()
                    .flatten()
                    .map(|(vk, flags)| (*vk, flags & 2 == 0))
                    .collect();
                assert_eq!(
                    events,
                    [(0xaf, true), (0xaf, true), (0xaf, false)],
                    "failure={failure}"
                );
            });
        }
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
            [(7, 0x80), (7, 0x81), (7, 0x7f), (0x0c, 0xcd), (0x0c, 0xb5)]
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
        // Verify the actual mouse keyboard output keeps left/right modifiers distinct.
        #[cfg(target_os = "windows")]
        {
            let strokes: Vec<_> = keys
                .into_iter()
                .map(|key| {
                    let input = virtual_key_input(key);
                    let keyboard = unsafe { input.value.keyboard };
                    (keyboard.virtual_key, keyboard.flags)
                })
                .collect();
            assert_eq!(strokes, vec![(0xa3, 1), (0x10, 0), (0xa5, 1), (0x5b, 1)]);
        }
    }
}
