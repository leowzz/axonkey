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
const DEVICE_DISCONNECT_GRACE: Duration = Duration::from_secs(8);
const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DEVICE_STABLE_DURATION: Duration = Duration::from_secs(3);
const CR_SUCCESS: u32 = 0;
const CM_GETIDLIST_FILTER_PRESENT: u32 = 0x0000_0100;

#[cfg(windows)]
struct QuarborContext {
    reader: Option<super::windows_quarbor::Client>,
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
                log::info!(target: "axonkey::input", "Quarbor v3 duplex pipe connected: {device_id}");
            }
            Err(error) => quarbor_read_error(context, format!("Quarbor v3 connect: {error}")),
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
                quarbor_read_error(context, format!("Quarbor v3 receive: {error}"));
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
            metadata, usages, ..
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
                        log::warn!(target: "axonkey::input", "Quarbor raw HID is available; keyboard usage decoding failed: 0x{status:08X}");
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

fn rc003_button_for_usage(usage: u16) -> Option<&'static str> {
    Some(match usage {
        0x003E => "voice",
        0x00F1 => "back",
        0x0028 => "confirm",
        0x0035 => "tv",
        0x004A => "home",
        0x004F => "right",
        0x0050 => "left",
        0x0051 => "down",
        0x0052 => "up",
        0x0065 => "menu",
        0x0066 => "power",
        0x0080 => "volumeUp",
        0x0081 => "volumeDown",
        _ => return None,
    })
}

pub(super) fn rc003_usage_for_button(button: &str) -> Option<u16> {
    [
        0x3e, 0xf1, 0x28, 0x35, 0x4a, 0x4f, 0x50, 0x51, 0x52, 0x65, 0x66, 0x80, 0x81,
    ]
    .into_iter()
    .find(|usage| rc003_button_for_usage(*usage) == Some(button))
}

#[cfg(windows)]
fn quarbor_output_error(context: &mut QuarborContext, error: std::io::Error) {
    // Closing the writer makes the driver clear its queue and submit neutral
    // reports, including keys whose release was rejected or only partly sent.
    context.reader = None;
    quarbor_read_error(context, format!("Quarbor v3 keyboard output: {error}"));
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
    pub fn start() -> Self {
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
            .name("Axonkey Quarbor HID input".into())
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

    pub fn update_settings(&self, settings: NativeSettings) -> Result<(), String> {
        validate_settings(&settings)?;
        let behavior_count = settings
            .behaviors
            .values()
            .map(|triggers| {
                triggers.click.len()
                    + triggers.double_click.len()
                    + triggers.long_press.len()
                    + triggers.replace.len()
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

fn worker_loop(shared: Arc<Shared>) {
    log::info!(target: "axonkey::input", "Quarbor v3 read-only backend loaded");
    shared.status.lock().unwrap().backend_ready = true;
    let mut last_target_seen_at = None;
    while !shared.stop.load(Ordering::Relaxed) {
        if !wait_for_stable_target(&shared, &mut last_target_seen_at) {
            break;
        }
        #[cfg(windows)]
        run_context(
            &mut QuarborContext::default(),
            &shared,
            &mut last_target_seen_at,
        );
    }
    shared.status.lock().unwrap().capture_active = false;
}

fn wait_for_stable_target(shared: &Shared, last_target_seen_at: &mut Option<Instant>) -> bool {
    let mut stable_since = None;
    while !shared.stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        let hardware_id = rc003_keyboard_device_id();
        let target_present = hardware_id.is_some();
        update_device_status(shared, hardware_id, last_target_seen_at, now);

        // v3 capture is independent of mappings. Keep observing even when
        // mappings are disabled; the driver connection remains read-only.
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
) {
    context.device_id = rc003_keyboard_device_id();
    let mut next_probe = Instant::now();
    let mut actions = super::remote_actions::RemoteActions::default();
    let mut state_epoch = context.state_epoch;
    while !shared.stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= next_probe {
            let device_id = rc003_keyboard_device_id();
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
        observe_target_key(shared, key);
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
    while let Some(key) = context.keys.pop_front() {
        observe_target_key(shared, key);
        actions.edge(key.button, key.pressed, &settings, now);
    }
    let mut output_error = None;
    actions.tick(now, |output| {
        if output_error.is_some() {
            return;
        }
        match output {
            super::remote_actions::Output::CursorMove(direction, distance) => {
                let (dx, dy) = cursor_delta(direction, distance);
                send_mouse_move(dx, dy);
            }
            super::remote_actions::Output::Key(key, down) => {
                if let Some(client) = context.reader.as_mut() {
                    if let Err(error) = client.send_key(key.page, key.usage, down) {
                        output_error = Some(error);
                    }
                }
            }
        }
    });
    if let Some(error) = output_error {
        quarbor_output_error(context, error);
        actions.cancel();
    }
}

fn observe_target_key(shared: &Shared, key: RemoteKeyEvent) {
    log::info!(target: "axonkey::input", "RC003 observed key: button={}, pressed={}", key.button, key.pressed);
    emit_remote_key_event(shared, key.button, key.pressed);
}

#[cfg(windows)]
fn quarbor_publish_events(context: &mut QuarborContext, shared: &Shared) {
    use super::windows_quarbor::Event;
    while let Some(event) = context.events.pop_front() {
        match event {
            Event::Hello(_) => {}
            Event::Capabilities(caps) => {
                log::info!(target: "axonkey::input", "Quarbor v3 capture ready: report_bytes={}, queue_capacity={}, flags=0x{:X}, report_ids={:02X?}", caps.input_report_bytes, caps.queue_capacity, caps.flags, caps.report_ids);
            }
            Event::Report {
                metadata, bytes, ..
            } => {
                log::info!(target: "axonkey::input", "Quarbor HID: seq={}, filetime={}, dropped={}, length={}, data={:02X?}", metadata.sequence, metadata.timestamp, metadata.dropped, bytes.len(), &bytes[..bytes.len().min(32)]);
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

#[cfg(windows)]
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

#[cfg(target_os = "windows")]
fn rc003_keyboard_device_id() -> Option<String> {
    for _ in 0..3 {
        let mut length = 0;
        if unsafe {
            cm_get_device_id_list_size(&mut length, std::ptr::null(), CM_GETIDLIST_FILTER_PRESENT)
        } != CR_SUCCESS
            || !(2..=1_000_000).contains(&length)
        {
            return None;
        }

        let mut buffer = vec![0u16; length as usize];
        if unsafe {
            cm_get_device_id_list(
                std::ptr::null(),
                buffer.as_mut_ptr(),
                length,
                CM_GETIDLIST_FILTER_PRESENT,
            )
        } == CR_SUCCESS
        {
            return rc003_keyboard_id_from_multisz(&buffer);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn rc003_keyboard_device_id() -> Option<String> {
    None
}

fn rc003_keyboard_id_from_multisz(buffer: &[u16]) -> Option<String> {
    buffer
        .split(|value| *value == 0)
        .take_while(|value| !value.is_empty())
        .map(String::from_utf16_lossy)
        .find(|value| {
            value.to_ascii_uppercase().starts_with("HID\\") && is_target_hardware_id(value)
        })
}

fn is_target_hardware_id(value: &str) -> bool {
    let uppercase = value.to_ascii_uppercase();
    let vid = uppercase.contains("VID_2717") || uppercase.contains("VID&012717");
    let pid = uppercase.contains("PID_32B8") || uppercase.contains("PID&32B8");
    vid && pid
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
                if !send_mouse_chord_with(&keys, hold_ms, send_mouse_keyboard_inputs) {
                    log::warn!(target: "axonkey::input", "Mouse keyboard injection incomplete; target may have higher privileges");
                }
            }
        }
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

fn send_mouse_keyboard_inputs(inputs: &[Input]) -> usize {
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
        | NativeBehavior::Disabled { .. } => None,
    }
}

/// Convert the existing key names into USB HID usages, never scan codes or
/// platform keyboard events. The driver resolves the descriptor/report ID.
pub(super) fn behavior_hid_chord(
    behavior: &NativeBehavior,
) -> Option<Vec<super::remote_actions::HidKey>> {
    use super::remote_actions::HidKey;
    let mut result = Vec::new();
    for key in behavior_chord(behavior)? {
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
        let key = HidKey { page, usage };
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
        for behavior in triggers
            .click
            .iter()
            .chain(&triggers.double_click)
            .chain(&triggers.long_press)
            .chain(&triggers.replace)
        {
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
        let replacements = triggers
            .replace
            .iter()
            .filter(|behavior| behavior.enabled())
            .collect::<Vec<_>>();
        if replacements.len() > 1 {
            return Err(format!("{button}: replacement accepts only one target key"));
        }
        if let Some(behavior) = replacements.first() {
            match behavior {
                NativeBehavior::Key { .. }
                    if behavior_hid_chord(behavior).is_some_and(|keys| keys.len() == 1) => {}
                NativeBehavior::Key { .. } => {
                    return Err(format!("{button}: replacement target must be one key"))
                }
                _ => return Err(format!("{button}: replacement target must be a key")),
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
                    mouse_data: mouse_data << 16,
                    flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        };
        #[cfg(not(test))]
        {
            let _ = unsafe { SendInput(1, &input, std::mem::size_of::<Input>() as i32) };
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
        sent_events += unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            )
        };
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

#[cfg(target_os = "windows")]
#[link(name = "cfgmgr32")]
extern "system" {
    #[link_name = "CM_Get_Device_ID_List_SizeW"]
    fn cm_get_device_id_list_size(length: *mut u32, filter: *const u16, flags: u32) -> u32;
    #[link_name = "CM_Get_Device_ID_ListW"]
    fn cm_get_device_id_list(
        filter: *const u16,
        buffer: *mut u16,
        buffer_length: u32,
        flags: u32,
    ) -> u32;
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
    fn hid_mapping_service_writes_driver_chords_replacement_and_gap_releases() {
        use super::super::windows_quarbor::{
            tests::{command_server, framed, key_command, next},
            Client, Event, Metadata,
        };
        let expected = vec![
            framed(vec![8, 1, 0x62, 0]),
            key_command(2, 7, 0xe6, true), // voice -> right Alt
            key_command(3, 7, 0xe1, true),
            key_command(4, 7, 4, true), // up -> Shift+A
            key_command(5, 7, 4, false),
            key_command(6, 7, 0xe1, false),
            key_command(7, 7, 0xe6, false),
        ]; // report loss releases right Alt
        let (path, worker) = command_server(expected, 0);
        let shared = Shared {
            settings: RwLock::new(
                serde_json::from_value(serde_json::json!({
                    "enabled":true, "behaviors":{
                        "voice":{"replace":[{"type":"key","key":"RAlt"}]},
                        "up":{"click":[{"type":"shortcut","keys":["Shift","A"]}]}
                    }
                }))
                .unwrap(),
            ),
            settings_revision: AtomicU64::new(1),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
        };
        MOUSE_KEY_BATCHES.with(|batches| batches.borrow_mut().clear());
        let mut context = QuarborContext {
            reader: Some(Client::connect_path(&path, r"HID\AXONKEY_V3_READ_TEST").unwrap()),
            device_id: Some(r"HID\AXONKEY_V3_READ_TEST".into()),
            ..QuarborContext::default()
        };
        for _ in 0..2 {
            let event = next(context.reader.as_mut().unwrap()).unwrap();
            quarbor_accept_event(&mut context, event);
        }
        let mut actions = super::super::remote_actions::RemoteActions::default();
        let mut epoch = 0;
        let now = Instant::now();
        for (sequence, usages) in [
            (1, vec![0x3e]),
            (2, vec![0x3e, 0x52]),
            (3, vec![0x3e]),
            (5, vec![]),
        ] {
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
        let mut accepted = 0;
        let deadline = Instant::now() + Duration::from_secs(3);
        while accepted < 7 {
            quarbor_wait_with_timeout(&mut context, 10);
            for event in context.events.drain(..) {
                if matches!(event, Event::CommandAccepted(_)) {
                    accepted += 1;
                }
            }
            assert!(context.error.is_none(), "{:?}", context.error);
            assert!(
                Instant::now() < deadline,
                "driver commands never acknowledged"
            );
        }
        assert_eq!(context.last_sequence, Some(5)); // Results are not physical reports.
        MOUSE_KEY_BATCHES.with(|batches| assert!(batches.borrow().is_empty()));
        drop(context);
        worker.join().unwrap();
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
    fn matches_real_rc003_hardware_id_variants() {
        assert!(is_target_hardware_id("HID\\VID_2717&PID_32B8"));
        assert!(is_target_hardware_id(
            "HID\\{GUID}_DEV_VID&012717_PID&32B8_REV&00A4"
        ));
        assert!(!is_target_hardware_id("USB\\VID_2717&PID_D002"));
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

    #[test]
    fn selects_only_the_rc003_keyboard_from_present_device_ids() {
        let ids = [
            "BTHLEDEVICE\\SERVICE_DEV_VID&012717_PID&32B8",
            "HID\\OTHER_DEV_VID&012717_PID&0001",
            "HID\\RC003_DEV_VID&012717_PID&32B8",
        ]
        .join("\0")
            + "\0\0";
        let buffer = ids.encode_utf16().collect::<Vec<_>>();

        assert_eq!(
            rc003_keyboard_id_from_multisz(&buffer).as_deref(),
            Some("HID\\RC003_DEV_VID&012717_PID&32B8")
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
