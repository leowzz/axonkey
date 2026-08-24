use super::{InputServiceStatus, NativeBehavior, NativeSettings, TriggerBehaviors};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    ffi::c_void,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::Emitter;

const EVENT_BACKEND_READY: i32 = 1;
const EVENT_DEVICE_CONNECTED: i32 = 2;
const EVENT_DEVICE_DISCONNECTED: i32 = 3;
const EVENT_INPUT_REPORT: i32 = 4;
const EVENT_BACKEND_ERROR: i32 = 5;
const EVENT_TICK: i32 = 6;
const CAPTURE_MODE_MASK: i32 = 0x03;
const CAPTURE_VOICE_RIGHT_CONTROL: i32 = 0x04;
const LONG_PRESS_MS: u64 = 600;
const DOUBLE_CLICK_MS: u64 = 350;
const REPEAT_INITIAL_MS: u64 = 500;
const REPEAT_INTERVAL_MS: u64 = 50;
const MEDIA_REPEAT_INITIAL_MS: u64 = 350;
const MEDIA_REPEAT_INTERVAL_MS: u64 = 100;
const DENIED_RETRY_MS: u64 = 2_000;
const IO_RETURN_NOT_PERMITTED: i32 = 0xe00002e2_u32 as i32;
const STALE_INPUT_MONITORING_ERROR: &str =
    "macOS Input Monitoring authorization is stale for this build; remove the old Axonkey entry and add the current Axonkey.app again";

type StopCallback = unsafe extern "C" fn(*mut c_void) -> bool;
type EventCallback = unsafe extern "C" fn(*mut c_void, i32, u32, *const u8, usize, i32);

#[repr(C)]
struct NativeCallbacks {
    context: *mut c_void,
    should_stop: StopCallback,
    on_event: EventCallback,
}

extern "C" {
    fn axonkey_macos_input_run(
        callbacks: *const NativeCallbacks,
        capture: bool,
        voice_right_control: bool,
    ) -> i32;
    fn axonkey_macos_input_monitoring_granted() -> bool;
    fn axonkey_macos_accessibility_granted() -> bool;
    fn axonkey_macos_request_input_monitoring() -> bool;
    fn axonkey_macos_request_accessibility() -> bool;
    fn axonkey_macos_post_key(code: u16, down: bool, flags: u64, autorepeat: bool) -> bool;
    fn axonkey_macos_post_system_key(kind: i32, down: bool) -> bool;
    fn axonkey_macos_post_text(text: *const u16, length: usize) -> bool;
}

struct Shared {
    settings: RwLock<NativeSettings>,
    status: Mutex<InputServiceStatus>,
    event_app: RwLock<Option<tauri::AppHandle>>,
    stop: AtomicBool,
    restart: AtomicBool,
}

pub struct InputService {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl InputService {
    pub fn start() -> Self {
        let shared = Arc::new(Shared {
            settings: RwLock::new(NativeSettings::default()),
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            restart: AtomicBool::new(false),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("Axonkey macOS HID input".into())
            .spawn(move || worker_loop(worker_shared))
            .ok();
        if worker.is_none() {
            shared.status.lock().unwrap().error = Some("Cannot start the input worker".into());
        }
        Self {
            shared,
            worker: Mutex::new(worker),
        }
    }

    pub fn update_settings(&self, settings: NativeSettings) -> Result<(), String> {
        validate_settings(&settings)?;
        let old_settings = self
            .shared
            .settings
            .read()
            .map_err(|_| "Input settings lock is unavailable")?
            .clone();
        let should_restart = old_settings.enabled != settings.enabled
            || wants_hardware_voice_right_control(&old_settings)
                != wants_hardware_voice_right_control(&settings);
        *self
            .shared
            .settings
            .write()
            .map_err(|_| "Input settings lock is unavailable")? = settings;
        if should_restart {
            self.shared.restart.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub fn status(&self) -> InputServiceStatus {
        let mut status = self
            .shared
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| InputServiceStatus {
                error: Some("Input status lock is unavailable".into()),
                ..InputServiceStatus::default()
            });
        status.input_monitoring_granted = Some(effective_input_monitoring_granted(
            Self::input_monitoring_granted(),
            &status,
        ));
        status.accessibility_granted = Some(Self::accessibility_granted());
        status
    }

    pub fn set_event_app(&self, app: tauri::AppHandle) {
        if let Ok(mut event_app) = self.shared.event_app.write() {
            *event_app = Some(app);
        }
    }

    pub fn input_monitoring_granted() -> bool {
        unsafe { axonkey_macos_input_monitoring_granted() }
    }

    pub fn accessibility_granted() -> bool {
        unsafe { axonkey_macos_accessibility_granted() }
    }

    pub fn request_permission(kind: &str) -> Result<bool, String> {
        match kind {
            "inputMonitoring" => Ok(unsafe { axonkey_macos_request_input_monitoring() }),
            "accessibility" => Ok(unsafe { axonkey_macos_request_accessibility() }),
            _ => Err("Unsupported macOS permission".into()),
        }
    }
}

impl Drop for InputService {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

fn settings_enabled(shared: &Shared) -> bool {
    shared
        .settings
        .read()
        .map(|settings| settings.enabled)
        .unwrap_or(false)
}

fn permissions_granted() -> bool {
    InputService::input_monitoring_granted() && InputService::accessibility_granted()
}

fn desired_capture(shared: &Shared) -> bool {
    settings_enabled(shared) && permissions_granted()
}

fn permission_error(shared: &Shared) -> Option<String> {
    if !settings_enabled(shared) {
        return None;
    }
    if !InputService::input_monitoring_granted() {
        return Some("macOS Input Monitoring permission is required".into());
    }
    if !InputService::accessibility_granted() {
        return Some("macOS Accessibility permission is required".into());
    }
    None
}

fn effective_input_monitoring_granted(
    preflight_granted: bool,
    status: &InputServiceStatus,
) -> bool {
    preflight_granted && !status.input_monitoring_open_denied
}

fn prepare_backend_attempt(status: &mut InputServiceStatus, permission_error: Option<String>) {
    status.backend_ready = false;
    if !status.input_monitoring_open_denied {
        status.device_connected = false;
        status.hardware_id = None;
    }
    status.capture_active = false;
    status.error = if status.input_monitoring_open_denied {
        Some(STALE_INPUT_MONITORING_ERROR.into())
    } else {
        permission_error
    };
}

fn record_backend_error(status: &mut InputServiceStatus, code: i32) {
    status.capture_active = false;
    if code == IO_RETURN_NOT_PERMITTED {
        status.input_monitoring_open_denied = true;
        status.error = Some(STALE_INPUT_MONITORING_ERROR.into());
    } else {
        status.error = Some(format!("macOS HID backend stopped with IOKit error {code}"));
    }
}

struct WorkerContext {
    shared: Arc<Shared>,
    capture: bool,
    voice_right_control_requested: bool,
    voice_right_control_active: bool,
    device_seen: bool,
    input: MacInputState,
    next_permission_check: Instant,
}

fn worker_loop(shared: Arc<Shared>) {
    while !shared.stop.load(Ordering::Acquire) {
        shared.restart.store(false, Ordering::Release);
        let capture = desired_capture(&shared);
        if let Ok(mut status) = shared.status.lock() {
            prepare_backend_attempt(&mut status, permission_error(&shared));
        }

        let mut context = WorkerContext {
            shared: Arc::clone(&shared),
            capture,
            voice_right_control_requested: capture
                && shared
                    .settings
                    .read()
                    .map(|settings| wants_hardware_voice_right_control(&settings))
                    .unwrap_or(false),
            voice_right_control_active: false,
            device_seen: false,
            input: MacInputState::default(),
            next_permission_check: Instant::now() + Duration::from_millis(250),
        };
        let callbacks = NativeCallbacks {
            context: (&mut context as *mut WorkerContext).cast(),
            should_stop: should_stop_callback,
            on_event: event_callback,
        };
        let result = unsafe {
            axonkey_macos_input_run(&callbacks, capture, context.voice_right_control_requested)
        };
        context.input.release_all();
        if let Ok(mut status) = shared.status.lock() {
            status.capture_active = false;
            if result != 0 {
                record_backend_error(&mut status, result);
                if status.input_monitoring_open_denied && !context.device_seen {
                    status.device_connected = false;
                    status.hardware_id = None;
                }
            }
        }
        if !shared.stop.load(Ordering::Acquire) && !shared.restart.load(Ordering::Acquire) {
            let retry_ms = shared
                .status
                .lock()
                .map(|status| {
                    if status.input_monitoring_open_denied {
                        DENIED_RETRY_MS
                    } else {
                        150
                    }
                })
                .unwrap_or(150);
            thread::sleep(Duration::from_millis(retry_ms));
        }
    }
}

unsafe extern "C" fn should_stop_callback(context: *mut c_void) -> bool {
    if context.is_null() {
        return true;
    }
    let context = &mut *(context.cast::<WorkerContext>());
    if context.shared.stop.load(Ordering::Acquire) || context.shared.restart.load(Ordering::Acquire)
    {
        return true;
    }
    let now = Instant::now();
    if now < context.next_permission_check {
        return false;
    }
    context.next_permission_check = now + Duration::from_millis(250);
    desired_capture(&context.shared) != context.capture
}

unsafe extern "C" fn event_callback(
    context: *mut c_void,
    event: i32,
    report_id: u32,
    bytes: *const u8,
    length: usize,
    code: i32,
) {
    if context.is_null() {
        return;
    }
    let context = &mut *(context.cast::<WorkerContext>());
    let result = catch_unwind(AssertUnwindSafe(|| match event {
        EVENT_BACKEND_READY => {
            if let Ok(mut status) = context.shared.status.lock() {
                status.backend_ready = true;
                if !status.input_monitoring_open_denied {
                    status.error = permission_error(&context.shared);
                }
            }
        }
        EVENT_DEVICE_CONNECTED => {
            let capture_mode = code & CAPTURE_MODE_MASK;
            context.device_seen = true;
            context.voice_right_control_active = code & CAPTURE_VOICE_RIGHT_CONTROL != 0;
            if let Ok(mut status) = context.shared.status.lock() {
                if context.capture && capture_mode != 0 {
                    status.input_monitoring_open_denied = false;
                }
                status.device_connected = true;
                status.hardware_id = Some("HID\\VID_2717&PID_32B8".into());
                status.capture_active = context.capture && capture_mode != 0;
                if context.capture && capture_mode == 0 {
                    status.error = Some("RC003 could not be captured or filtered on macOS".into());
                } else if context.voice_right_control_requested
                    && !context.voice_right_control_active
                {
                    status.error =
                        Some("RC003 Right Control hardware mapping could not be applied".into());
                } else if context.capture {
                    status.error = None;
                }
            }
        }
        EVENT_DEVICE_DISCONNECTED => {
            context.input.release_all();
            if let Ok(mut status) = context.shared.status.lock() {
                status.device_connected = false;
                status.hardware_id = None;
                status.capture_active = false;
            }
        }
        EVENT_INPUT_REPORT if context.capture && !bytes.is_null() => {
            let report = std::slice::from_raw_parts(bytes, length);
            if let Some(usages) = parse_hid_report(report_id, report) {
                context.input.process_report(
                    &context.shared,
                    usages,
                    context.voice_right_control_requested,
                );
            }
        }
        EVENT_BACKEND_ERROR => {
            if let Ok(mut status) = context.shared.status.lock() {
                record_backend_error(&mut status, code);
            }
        }
        EVENT_TICK if context.capture => context.input.process_timers(&context.shared),
        _ => {}
    }));
    if result.is_err() {
        if let Ok(mut status) = context.shared.status.lock() {
            status.error = Some("macOS input callback failed unexpectedly".into());
            status.capture_active = false;
        }
        context.shared.restart.store(true, Ordering::Release);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MacKey {
    Keyboard { code: u16, modifier: u64 },
    System { kind: i32 },
}

impl MacKey {
    const fn keyboard(code: u16) -> Self {
        Self::Keyboard { code, modifier: 0 }
    }

    const fn modifier(code: u16, modifier: u64) -> Self {
        Self::Keyboard { code, modifier }
    }

    const fn system(kind: i32) -> Self {
        Self::System { kind }
    }

    fn modifier_flag(self) -> u64 {
        match self {
            Self::Keyboard { modifier, .. } => modifier,
            Self::System { .. } => 0,
        }
    }
}

const FLAG_SHIFT: u64 = 1 << 17;
const FLAG_CONTROL: u64 = 1 << 18;
const FLAG_OPTION: u64 = 1 << 19;
const FLAG_COMMAND: u64 = 1 << 20;
const FLAG_DEVICE_RIGHT_CONTROL: u64 = 0x0000_2000;

#[derive(Clone, Copy)]
struct SourceKey {
    id: &'static str,
    usage: u16,
    original: MacKey,
    repeat_initial_ms: u64,
    repeat_interval_ms: u64,
}

impl SourceKey {
    const fn new(id: &'static str, usage: u16, original: MacKey) -> Self {
        Self {
            id,
            usage,
            original,
            repeat_initial_ms: REPEAT_INITIAL_MS,
            repeat_interval_ms: REPEAT_INTERVAL_MS,
        }
    }

    const fn with_repeat(
        id: &'static str,
        usage: u16,
        original: MacKey,
        repeat_initial_ms: u64,
        repeat_interval_ms: u64,
    ) -> Self {
        Self {
            id,
            usage,
            original,
            repeat_initial_ms,
            repeat_interval_ms,
        }
    }
}

const SOURCE_KEYS: [SourceKey; 13] = [
    SourceKey::new("voice", 0x3e, MacKey::keyboard(96)),
    SourceKey::new("power", 0x66, MacKey::keyboard(90)),
    SourceKey::new("home", 0x4a, MacKey::keyboard(115)),
    SourceKey::new("tv", 0x35, MacKey::keyboard(10)),
    SourceKey::new("menu", 0x65, MacKey::keyboard(110)),
    SourceKey::new("confirm", 0x28, MacKey::keyboard(36)),
    SourceKey::new("up", 0x52, MacKey::keyboard(126)),
    SourceKey::new("down", 0x51, MacKey::keyboard(125)),
    SourceKey::new("left", 0x50, MacKey::keyboard(123)),
    SourceKey::new("right", 0x4f, MacKey::keyboard(124)),
    SourceKey::with_repeat(
        "back",
        0xf1,
        MacKey::keyboard(51),
        MEDIA_REPEAT_INITIAL_MS,
        REPEAT_INTERVAL_MS,
    ),
    SourceKey::with_repeat(
        "volumeUp",
        0x80,
        MacKey::system(0),
        MEDIA_REPEAT_INITIAL_MS,
        MEDIA_REPEAT_INTERVAL_MS,
    ),
    SourceKey::with_repeat(
        "volumeDown",
        0x81,
        MacKey::system(1),
        MEDIA_REPEAT_INITIAL_MS,
        MEDIA_REPEAT_INTERVAL_MS,
    ),
];

fn source_for_usage(usage: u16) -> Option<SourceKey> {
    SOURCE_KEYS
        .iter()
        .copied()
        .find(|source| source.usage == usage)
}

struct PressedChord {
    keys: Vec<MacKey>,
}

fn press_flags(keys: &[MacKey]) -> Vec<u64> {
    let mut flags = 0;
    keys.iter()
        .map(|key| {
            flags |= key.modifier_flag();
            flags
        })
        .collect()
}

impl PressedChord {
    fn press(keys: &[MacKey]) -> Self {
        let flags = press_flags(keys);
        let mut pressed = Vec::new();
        for (key, flags) in keys.iter().zip(flags) {
            if post_key(*key, true, flags, false) {
                pressed.push(*key);
            }
        }
        Self { keys: pressed }
    }

    fn release(&mut self) {
        let mut flags = self
            .keys
            .iter()
            .fold(0, |flags, key| flags | key.modifier_flag());
        for key in self.keys.iter().copied().rev() {
            if key.modifier_flag() != 0 {
                flags &= !key.modifier_flag();
            }
            post_key(key, false, flags, false);
        }
        self.keys.clear();
    }

    fn repeat(&self) {
        let flags = self
            .keys
            .iter()
            .fold(0, |flags, key| flags | key.modifier_flag());
        if let Some(key) = self
            .keys
            .iter()
            .copied()
            .rev()
            .find(|key| key.modifier_flag() == 0)
        {
            post_key(key, true, flags, true);
        }
    }

    fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

fn post_key(key: MacKey, down: bool, flags: u64, autorepeat: bool) -> bool {
    unsafe {
        match key {
            MacKey::Keyboard { code, .. } => axonkey_macos_post_key(code, down, flags, autorepeat),
            MacKey::System { kind } => axonkey_macos_post_system_key(kind, down),
        }
    }
}

fn tap_key(key: MacKey) {
    post_key(key, true, key.modifier_flag(), false);
    post_key(key, false, 0, false);
}

struct PressState {
    started_at: Instant,
    original: MacKey,
    long_fired: bool,
    passthrough: bool,
    held_outputs: PressedChord,
    next_repeat_at: Instant,
    repeat_interval_ms: u64,
}

struct PendingClick {
    due_at: Instant,
    original: MacKey,
}

#[derive(Default)]
struct ButtonState {
    pressed: Option<PressState>,
    pending_click: Option<PendingClick>,
}

#[derive(Default)]
struct MacInputState {
    active_usages: HashSet<u16>,
    button_states: HashMap<&'static str, ButtonState>,
}

impl MacInputState {
    fn process_report(
        &mut self,
        shared: &Shared,
        usages: HashSet<u16>,
        voice_right_control_is_hardware_mapped: bool,
    ) {
        let pressed = usages
            .difference(&self.active_usages)
            .copied()
            .collect::<Vec<_>>();
        let released = self
            .active_usages
            .difference(&usages)
            .copied()
            .collect::<Vec<_>>();
        self.active_usages = usages;

        for usage in pressed {
            if let Some(source) = source_for_usage(usage) {
                emit_remote_key_event(shared, source.id, true);
                if source.id != "voice" || !voice_right_control_is_hardware_mapped {
                    self.press_source(shared, source);
                }
            }
        }
        for usage in released {
            if let Some(source) = source_for_usage(usage) {
                emit_remote_key_event(shared, source.id, false);
                if source.id != "voice" || !voice_right_control_is_hardware_mapped {
                    self.release_source(shared, source);
                }
            }
        }
    }

    fn press_source(&mut self, shared: &Shared, source: SourceKey) {
        let settings = shared
            .settings
            .read()
            .map(|settings| settings.clone())
            .unwrap_or_default();
        let triggers = settings
            .behaviors
            .get(source.id)
            .cloned()
            .unwrap_or_default();
        let state = self.button_states.entry(source.id).or_default();
        if state.pressed.is_some() {
            return;
        }
        let now = Instant::now();
        if state
            .pending_click
            .as_ref()
            .is_some_and(|pending| now >= pending.due_at)
        {
            let pending = state.pending_click.take().unwrap();
            execute_click_or_original(&triggers.click, pending.original);
        }
        if !settings.enabled || !has_custom_behavior(&triggers) {
            post_key(source.original, true, 0, false);
            state.pressed = Some(PressState {
                started_at: now,
                original: source.original,
                long_fired: false,
                passthrough: true,
                held_outputs: PressedChord { keys: Vec::new() },
                next_repeat_at: now + Duration::from_millis(source.repeat_initial_ms),
                repeat_interval_ms: source.repeat_interval_ms,
            });
            return;
        }

        let held_outputs = continuous_click_chord(&triggers)
            .map(|keys| PressedChord::press(&keys))
            .unwrap_or_else(|| PressedChord { keys: Vec::new() });
        state.pressed = Some(PressState {
            started_at: now,
            original: source.original,
            long_fired: false,
            passthrough: false,
            held_outputs,
            next_repeat_at: now + Duration::from_millis(source.repeat_initial_ms),
            repeat_interval_ms: source.repeat_interval_ms,
        });
    }

    fn release_source(&mut self, shared: &Shared, source: SourceKey) {
        let settings = shared
            .settings
            .read()
            .map(|settings| settings.clone())
            .unwrap_or_default();
        let triggers = settings
            .behaviors
            .get(source.id)
            .cloned()
            .unwrap_or_default();
        let Some(state) = self.button_states.get_mut(source.id) else {
            return;
        };
        let Some(mut press) = state.pressed.take() else {
            return;
        };
        if !press.held_outputs.is_empty() {
            press.held_outputs.release();
            return;
        }
        if press.passthrough {
            post_key(press.original, false, 0, false);
            return;
        }
        if press.long_fired {
            return;
        }
        let long_enabled = has_enabled(&triggers.long_press);
        if long_enabled && press.started_at.elapsed() >= Duration::from_millis(LONG_PRESS_MS) {
            execute_behaviors(&triggers.long_press);
            return;
        }
        if !long_enabled && press.started_at.elapsed() >= Duration::from_millis(LONG_PRESS_MS) {
            tap_key(press.original);
            return;
        }
        if has_enabled(&triggers.double_click) {
            if state.pending_click.take().is_some() {
                execute_behaviors(&triggers.double_click);
            } else {
                state.pending_click = Some(PendingClick {
                    due_at: Instant::now() + Duration::from_millis(DOUBLE_CLICK_MS),
                    original: press.original,
                });
            }
        } else {
            execute_click_or_original(&triggers.click, press.original);
        }
    }

    fn process_timers(&mut self, shared: &Shared) {
        let settings = shared
            .settings
            .read()
            .map(|settings| settings.clone())
            .unwrap_or_default();
        if !settings.enabled {
            self.release_all();
            return;
        }
        let now = Instant::now();
        for source in SOURCE_KEYS {
            let Some(state) = self.button_states.get_mut(source.id) else {
                continue;
            };
            let triggers = settings
                .behaviors
                .get(source.id)
                .cloned()
                .unwrap_or_default();
            if let Some(press) = state.pressed.as_mut() {
                let reached_long_press =
                    now.duration_since(press.started_at) >= Duration::from_millis(LONG_PRESS_MS);
                if press.held_outputs.is_empty()
                    && !press.long_fired
                    && !press.passthrough
                    && reached_long_press
                {
                    if has_enabled(&triggers.long_press) {
                        execute_behaviors(&triggers.long_press);
                        press.long_fired = true;
                    } else {
                        post_key(press.original, true, 0, false);
                        press.passthrough = true;
                        press.next_repeat_at =
                            now + Duration::from_millis(press.repeat_interval_ms);
                    }
                    state.pending_click = None;
                }
                if now >= press.next_repeat_at {
                    if !press.held_outputs.is_empty() {
                        press.held_outputs.repeat();
                    } else if press.passthrough {
                        post_key(press.original, true, 0, true);
                    }
                    press.next_repeat_at = now + Duration::from_millis(press.repeat_interval_ms);
                }
            }
            if pending_click_is_due(state, now) {
                let pending = state.pending_click.take().unwrap();
                execute_click_or_original(&triggers.click, pending.original);
            }
        }
    }

    fn release_all(&mut self) {
        for state in self.button_states.values_mut() {
            if let Some(mut press) = state.pressed.take() {
                if !press.held_outputs.is_empty() {
                    press.held_outputs.release();
                }
                if press.passthrough {
                    post_key(press.original, false, 0, false);
                }
            }
            state.pending_click = None;
        }
        self.active_usages.clear();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteKeyEvent {
    button: &'static str,
    pressed: bool,
}

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

fn pending_click_is_due(state: &ButtonState, now: Instant) -> bool {
    state.pressed.is_none()
        && state
            .pending_click
            .as_ref()
            .is_some_and(|pending| now >= pending.due_at)
}

fn parse_hid_report(report_id: u32, report: &[u8]) -> Option<HashSet<u16>> {
    if report_id != 1 {
        return None;
    }
    let bytes = if report.len() == 7 && report.first().copied() == Some(report_id as u8) {
        &report[1..]
    } else {
        report
    };
    if bytes.is_empty() || !bytes.len().is_multiple_of(2) {
        return None;
    }
    Some(
        bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .filter(|usage| *usage != 0)
            .collect(),
    )
}

fn has_enabled(behaviors: &[NativeBehavior]) -> bool {
    behaviors.iter().any(NativeBehavior::enabled)
}

fn has_custom_behavior(triggers: &TriggerBehaviors) -> bool {
    has_enabled(&triggers.click)
        || has_enabled(&triggers.double_click)
        || has_enabled(&triggers.long_press)
}

fn continuous_click_chord(triggers: &TriggerBehaviors) -> Option<Vec<MacKey>> {
    if has_enabled(&triggers.double_click) || has_enabled(&triggers.long_press) {
        return None;
    }
    let mut enabled_clicks = triggers.click.iter().filter(|behavior| behavior.enabled());
    let behavior = enabled_clicks.next()?;
    if enabled_clicks.next().is_some() {
        return None;
    }
    behavior_chord(behavior)
}

fn wants_hardware_voice_right_control(settings: &NativeSettings) -> bool {
    if !settings.enabled {
        return false;
    }
    let Some(triggers) = settings.behaviors.get("voice") else {
        return false;
    };
    continuous_click_chord(triggers)
        == Some(vec![MacKey::modifier(
            62,
            FLAG_CONTROL | FLAG_DEVICE_RIGHT_CONTROL,
        )])
}

fn execute_click_or_original(behaviors: &[NativeBehavior], original: MacKey) {
    if has_enabled(behaviors) {
        execute_behaviors(behaviors);
    } else {
        tap_key(original);
    }
}

fn execute_behaviors(behaviors: &[NativeBehavior]) {
    for behavior in behaviors.iter().filter(|behavior| behavior.enabled()) {
        match behavior {
            NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. } => {
                if let Some(keys) = behavior_chord(behavior) {
                    let mut pressed = PressedChord::press(&keys);
                    pressed.release();
                }
            }
            NativeBehavior::Paste { text, .. } => {
                let utf16 = text.encode_utf16().collect::<Vec<_>>();
                if !utf16.is_empty() {
                    unsafe {
                        axonkey_macos_post_text(utf16.as_ptr(), utf16.len());
                    }
                }
            }
            NativeBehavior::Delay { ms, .. } => {
                thread::sleep(Duration::from_millis((*ms).min(300_000)))
            }
            NativeBehavior::Disabled { .. } => {}
        }
    }
}

fn behavior_chord(behavior: &NativeBehavior) -> Option<Vec<MacKey>> {
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
        NativeBehavior::Paste { .. }
        | NativeBehavior::Delay { .. }
        | NativeBehavior::Disabled { .. } => None,
    }
}

fn parse_chord(value: &str) -> Option<Vec<MacKey>> {
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
        let key = mac_key_for_name(part.trim())?;
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    (!keys.is_empty()).then_some(keys)
}

fn mac_key_for_name(value: &str) -> Option<MacKey> {
    let upper = value.to_ascii_uppercase();
    let named = match upper.as_str() {
        "CTRL" | "CONTROL" | "LCTRL" => Some(MacKey::modifier(59, FLAG_CONTROL)),
        "RCTRL" => Some(MacKey::modifier(
            62,
            FLAG_CONTROL | FLAG_DEVICE_RIGHT_CONTROL,
        )),
        "SHIFT" | "LSHIFT" => Some(MacKey::modifier(56, FLAG_SHIFT)),
        "RSHIFT" => Some(MacKey::modifier(60, FLAG_SHIFT)),
        "ALT" | "LALT" | "OPTION" | "LOPTION" => Some(MacKey::modifier(58, FLAG_OPTION)),
        "RALT" | "ROPTION" => Some(MacKey::modifier(61, FLAG_OPTION)),
        "WIN" | "LWIN" | "CMD" | "COMMAND" => Some(MacKey::modifier(55, FLAG_COMMAND)),
        "RWIN" | "RCMD" | "RCOMMAND" => Some(MacKey::modifier(54, FLAG_COMMAND)),
        "ESC" | "ESCAPE" => Some(MacKey::keyboard(53)),
        "ENTER" | "RETURN" => Some(MacKey::keyboard(36)),
        "SPACE" => Some(MacKey::keyboard(49)),
        "TAB" => Some(MacKey::keyboard(48)),
        "BACKSPACE" => Some(MacKey::keyboard(51)),
        "DELETE" => Some(MacKey::keyboard(117)),
        "INSERT" => Some(MacKey::keyboard(114)),
        "HOME" => Some(MacKey::keyboard(115)),
        "END" => Some(MacKey::keyboard(119)),
        "PAGEUP" => Some(MacKey::keyboard(116)),
        "PAGEDOWN" => Some(MacKey::keyboard(121)),
        "UP" | "ARROWUP" => Some(MacKey::keyboard(126)),
        "DOWN" | "ARROWDOWN" => Some(MacKey::keyboard(125)),
        "LEFT" | "ARROWLEFT" => Some(MacKey::keyboard(123)),
        "RIGHT" | "ARROWRIGHT" => Some(MacKey::keyboard(124)),
        "VOLUMEMUTE" => Some(MacKey::system(7)),
        "VOLUMEDOWN" => Some(MacKey::system(1)),
        "VOLUMEUP" => Some(MacKey::system(0)),
        "MEDIAPLAYPAUSE" => Some(MacKey::system(16)),
        ";" | ":" => Some(MacKey::keyboard(41)),
        "=" | "+" => Some(MacKey::keyboard(24)),
        "," | "，" | "<" => Some(MacKey::keyboard(43)),
        "-" | "_" => Some(MacKey::keyboard(27)),
        "." | "。" | ">" => Some(MacKey::keyboard(47)),
        "/" | "?" | "？" => Some(MacKey::keyboard(44)),
        "`" | "~" => Some(MacKey::keyboard(50)),
        "[" | "{" | "【" => Some(MacKey::keyboard(33)),
        "\\" | "|" => Some(MacKey::keyboard(42)),
        "]" | "}" | "】" => Some(MacKey::keyboard(30)),
        "'" | "\"" => Some(MacKey::keyboard(39)),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    if upper.len() == 1 {
        return key_code_for_ascii(upper.as_bytes()[0]).map(MacKey::keyboard);
    }
    let function = upper
        .strip_prefix('F')
        .and_then(|number| number.parse::<u8>().ok())?;
    function_key_code(function).map(MacKey::keyboard)
}

fn key_code_for_ascii(value: u8) -> Option<u16> {
    Some(match value {
        b'A' => 0,
        b'S' => 1,
        b'D' => 2,
        b'F' => 3,
        b'H' => 4,
        b'G' => 5,
        b'Z' => 6,
        b'X' => 7,
        b'C' => 8,
        b'V' => 9,
        b'B' => 11,
        b'Q' => 12,
        b'W' => 13,
        b'E' => 14,
        b'R' => 15,
        b'Y' => 16,
        b'T' => 17,
        b'1' => 18,
        b'2' => 19,
        b'3' => 20,
        b'4' => 21,
        b'6' => 22,
        b'5' => 23,
        b'9' => 25,
        b'7' => 26,
        b'8' => 28,
        b'0' => 29,
        b'O' => 31,
        b'U' => 32,
        b'I' => 34,
        b'P' => 35,
        b'L' => 37,
        b'J' => 38,
        b'K' => 40,
        b'N' => 45,
        b'M' => 46,
        _ => return None,
    })
}

fn function_key_code(number: u8) -> Option<u16> {
    Some(match number {
        1 => 122,
        2 => 120,
        3 => 99,
        4 => 118,
        5 => 96,
        6 => 97,
        7 => 98,
        8 => 100,
        9 => 101,
        10 => 109,
        11 => 103,
        12 => 111,
        13 => 105,
        14 => 107,
        15 => 113,
        16 => 106,
        17 => 64,
        18 => 79,
        19 => 80,
        20 => 90,
        _ => return None,
    })
}

fn validate_settings(settings: &NativeSettings) -> Result<(), String> {
    for (button, triggers) in &settings.behaviors {
        for behavior in triggers
            .click
            .iter()
            .chain(&triggers.double_click)
            .chain(&triggers.long_press)
        {
            if !behavior.enabled() {
                continue;
            }
            match behavior {
                NativeBehavior::Key { key, .. } if parse_chord(key).is_none() => {
                    return Err(format!("{button}: unsupported key '{key}'"));
                }
                NativeBehavior::Shortcut { keys, .. }
                    if keys.is_empty() || keys.iter().any(|key| parse_chord(key).is_none()) =>
                {
                    return Err(format!("{button}: shortcut contains an unsupported key"));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_rc003_hid_reports() {
        assert_eq!(
            parse_hid_report(1, &[0x52, 0x00, 0x28, 0x00, 0x00, 0x00]),
            Some(HashSet::from([0x52, 0x28]))
        );
        assert_eq!(
            parse_hid_report(1, &[0x01, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00]),
            Some(HashSet::from([0x3e]))
        );
        assert_eq!(parse_hid_report(2, &[0x52, 0x00]), None);
        assert_eq!(parse_hid_report(1, &[0x52]), None);
    }

    #[test]
    fn maps_rc003_usages_to_supported_buttons() {
        assert_eq!(
            source_for_usage(0x3e).map(|source| source.id),
            Some("voice")
        );
        assert_eq!(
            source_for_usage(0x28).map(|source| source.id),
            Some("confirm")
        );
        assert_eq!(
            source_for_usage(0x4f).map(|source| source.id),
            Some("right")
        );
        assert_eq!(
            source_for_usage(0x66).map(|source| source.original),
            Some(MacKey::keyboard(90))
        );
        assert_eq!(
            source_for_usage(0xf1).map(|source| (
                source.id,
                source.original,
                source.repeat_initial_ms,
                source.repeat_interval_ms,
            )),
            Some(("back", MacKey::keyboard(51), 350, 50))
        );
        assert_eq!(
            source_for_usage(0x80).map(|source| (
                source.id,
                source.original,
                source.repeat_initial_ms,
                source.repeat_interval_ms,
            )),
            Some(("volumeUp", MacKey::system(0), 350, 100))
        );
        assert_eq!(
            source_for_usage(0x81).map(|source| (
                source.id,
                source.original,
                source.repeat_initial_ms,
                source.repeat_interval_ms,
            )),
            Some(("volumeDown", MacKey::system(1), 350, 100))
        );
    }

    #[test]
    fn parses_macos_modifiers_and_shortcuts() {
        assert_eq!(
            parse_chord("RAlt"),
            Some(vec![MacKey::modifier(61, FLAG_OPTION)])
        );
        assert_eq!(
            parse_chord("Win+C"),
            Some(vec![
                MacKey::modifier(55, FLAG_COMMAND),
                MacKey::keyboard(8)
            ])
        );
        assert_eq!(parse_chord("VolumeUp"), Some(vec![MacKey::system(0)]));
    }

    #[test]
    fn modifier_press_includes_its_state_flag() {
        assert_eq!(
            press_flags(&[MacKey::modifier(
                62,
                FLAG_CONTROL | FLAG_DEVICE_RIGHT_CONTROL,
            )]),
            vec![FLAG_CONTROL | FLAG_DEVICE_RIGHT_CONTROL]
        );
        assert_eq!(
            press_flags(&[
                MacKey::modifier(62, FLAG_CONTROL | FLAG_DEVICE_RIGHT_CONTROL),
                MacKey::keyboard(8),
            ]),
            vec![
                FLAG_CONTROL | FLAG_DEVICE_RIGHT_CONTROL,
                FLAG_CONTROL | FLAG_DEVICE_RIGHT_CONTROL,
            ]
        );
    }

    #[test]
    fn keeps_gesture_detection_for_multi_trigger_mappings() {
        let mut triggers = TriggerBehaviors::default();
        triggers.click.push(NativeBehavior::Key {
            enabled: true,
            key: "RAlt".into(),
        });
        assert_eq!(
            continuous_click_chord(&triggers),
            Some(vec![MacKey::modifier(61, FLAG_OPTION)])
        );
        triggers.long_press.push(NativeBehavior::Key {
            enabled: true,
            key: "Escape".into(),
        });
        assert_eq!(continuous_click_chord(&triggers), None);
    }

    #[test]
    fn uses_hardware_mapping_only_for_standalone_voice_right_control() {
        let mut settings = NativeSettings {
            enabled: true,
            ..NativeSettings::default()
        };
        settings.behaviors.insert(
            "voice".into(),
            TriggerBehaviors {
                click: vec![NativeBehavior::Key {
                    enabled: true,
                    key: "RCtrl".into(),
                }],
                ..TriggerBehaviors::default()
            },
        );
        assert!(wants_hardware_voice_right_control(&settings));

        settings
            .behaviors
            .get_mut("voice")
            .unwrap()
            .long_press
            .push(NativeBehavior::Key {
                enabled: true,
                key: "Space".into(),
            });
        assert!(!wants_hardware_voice_right_control(&settings));
    }

    #[test]
    fn does_not_use_hardware_mapping_for_other_voice_keys() {
        let mut settings = NativeSettings {
            enabled: true,
            ..NativeSettings::default()
        };
        settings.behaviors.insert(
            "voice".into(),
            TriggerBehaviors {
                click: vec![NativeBehavior::Key {
                    enabled: true,
                    key: "Space".into(),
                }],
                ..TriggerBehaviors::default()
            },
        );
        assert!(!wants_hardware_voice_right_control(&settings));
        settings.enabled = false;
        assert!(!wants_hardware_voice_right_control(&settings));
    }

    #[test]
    fn waits_for_an_in_progress_second_click_before_firing_single_click() {
        let now = Instant::now();
        let mut state = ButtonState {
            pending_click: Some(PendingClick {
                due_at: now,
                original: MacKey::keyboard(53),
            }),
            ..ButtonState::default()
        };
        assert!(pending_click_is_due(&state, now));

        state.pressed = Some(PressState {
            started_at: now,
            original: MacKey::keyboard(53),
            long_fired: false,
            passthrough: false,
            held_outputs: PressedChord { keys: Vec::new() },
            next_repeat_at: now,
            repeat_interval_ms: REPEAT_INTERVAL_MS,
        });
        assert!(!pending_click_is_due(&state, now));
    }

    #[test]
    fn tcc_denial_preserves_detected_device_and_invalidates_stale_preflight() {
        let mut status = InputServiceStatus {
            backend_ready: false,
            device_connected: true,
            hardware_id: Some("HID\\VID_2717&PID_32B8".into()),
            ..InputServiceStatus::default()
        };

        record_backend_error(&mut status, IO_RETURN_NOT_PERMITTED);
        prepare_backend_attempt(&mut status, None);

        assert!(status.device_connected);
        assert_eq!(
            status.hardware_id.as_deref(),
            Some("HID\\VID_2717&PID_32B8")
        );
        assert!(!effective_input_monitoring_granted(true, &status));
        assert_eq!(status.error.as_deref(), Some(STALE_INPUT_MONITORING_ERROR));
    }
}
