use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::c_void,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::Emitter;

const MAX_KEYBOARD: i32 = 10;
const FILTER_KEY_NONE: u16 = 0x0000;
const FILTER_KEY_ALL: u16 = 0xffff;
const KEY_UP: u16 = 0x0001;
const KEY_E0: u16 = 0x0002;
const WAIT_TIMEOUT_MS: u32 = 50;
const LONG_PRESS_MS: u64 = 600;
const DOUBLE_CLICK_MS: u64 = 350;
const DEVICE_DISCONNECT_GRACE: Duration = Duration::from_secs(8);
const CONTEXT_RETRY_DELAY: Duration = Duration::from_millis(250);

type Context = *mut c_void;
type DevicePredicate = unsafe extern "C" fn(i32) -> i32;
type CreateContext = unsafe extern "C" fn() -> Context;
type DestroyContext = unsafe extern "C" fn(Context);
type SetFilter = unsafe extern "C" fn(Context, DevicePredicate, u16);
type WaitWithTimeout = unsafe extern "C" fn(Context, u32) -> i32;
type Receive = unsafe extern "C" fn(Context, i32, *mut KeyStroke, u32) -> i32;
type Send = unsafe extern "C" fn(Context, i32, *const KeyStroke, u32) -> i32;
type GetHardwareId = unsafe extern "C" fn(Context, i32, *mut u8, u32) -> u32;

static FILTER_TARGET: AtomicI32 = AtomicI32::new(0);

unsafe extern "C" fn selected_device(device: i32) -> i32 {
    i32::from(device == FILTER_TARGET.load(Ordering::Relaxed))
}

unsafe extern "C" fn keyboard_device(device: i32) -> i32 {
    i32::from((1..=MAX_KEYBOARD).contains(&device))
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct KeyStroke {
    code: u16,
    state: u16,
    information: u32,
}

struct InterceptionApi {
    _library: libloading::Library,
    create_context: CreateContext,
    destroy_context: DestroyContext,
    set_filter: SetFilter,
    wait_with_timeout: WaitWithTimeout,
    receive: Receive,
    send: Send,
    get_hardware_id: GetHardwareId,
}

impl InterceptionApi {
    fn load() -> Result<Self, String> {
        let mut failures = Vec::new();
        for path in interception_dll_candidates() {
            if !path.is_file() {
                continue;
            }
            let library = match unsafe { libloading::Library::new(&path) } {
                Ok(library) => library,
                Err(error) => {
                    failures.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            let result = unsafe {
                Ok(Self {
                    create_context: load_symbol(&library, b"interception_create_context\0")?,
                    destroy_context: load_symbol(&library, b"interception_destroy_context\0")?,
                    set_filter: load_symbol(&library, b"interception_set_filter\0")?,
                    wait_with_timeout: load_symbol(&library, b"interception_wait_with_timeout\0")?,
                    receive: load_symbol(&library, b"interception_receive\0")?,
                    send: load_symbol(&library, b"interception_send\0")?,
                    get_hardware_id: load_symbol(&library, b"interception_get_hardware_id\0")?,
                    _library: library,
                })
            };
            return result.map_err(|error: String| format!("{}: {error}", path.display()));
        }

        let detail = if failures.is_empty() {
            "interception.dll was not found".to_string()
        } else {
            failures.join("; ")
        };
        Err(detail)
    }
}

unsafe fn load_symbol<T: Copy>(library: &libloading::Library, name: &[u8]) -> Result<T, String> {
    library
        .get::<T>(name)
        .map(|symbol| *symbol)
        .map_err(|error| error.to_string())
}

fn interception_dll_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        roots.push(current.clone());
        if let Some(parent) = current.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.push(parent.to_path_buf());
            if let Some(grandparent) = parent.parent() {
                roots.push(grandparent.to_path_buf());
            }
        }
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));

    let mut candidates = Vec::new();
    for root in roots {
        candidates.push(root.join("interception.dll"));
        candidates.push(
            root.join("vendor")
                .join("interception")
                .join("interception.dll"),
        );
        candidates.push(root.join("resources").join("interception.dll"));
    }
    candidates
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct InputServiceStatus {
    pub backend_ready: bool,
    pub device_connected: bool,
    pub hardware_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
pub struct NativeSettings {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    behaviors: HashMap<String, TriggerBehaviors>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriggerBehaviors {
    #[serde(default)]
    click: Vec<NativeBehavior>,
    #[serde(default)]
    double_click: Vec<NativeBehavior>,
    #[serde(default)]
    long_press: Vec<NativeBehavior>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum NativeBehavior {
    Key {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        key: String,
    },
    Shortcut {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        keys: Vec<String>,
    },
    Paste {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        text: String,
    },
    Delay {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        ms: u64,
    },
    Disabled {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
}

fn enabled_by_default() -> bool {
    true
}

impl NativeBehavior {
    fn enabled(&self) -> bool {
        match self {
            Self::Key { enabled, .. }
            | Self::Shortcut { enabled, .. }
            | Self::Paste { enabled, .. }
            | Self::Delay { enabled, .. }
            | Self::Disabled { enabled } => *enabled,
        }
    }
}

struct Shared {
    settings: RwLock<NativeSettings>,
    status: Mutex<InputServiceStatus>,
    event_app: RwLock<Option<tauri::AppHandle>>,
    stop: AtomicBool,
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
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("Axonkey Interception input".into())
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
        *self
            .shared
            .settings
            .write()
            .map_err(|_| "Input settings lock is unavailable")? = settings;
        Ok(())
    }

    pub fn set_event_app(&self, app: tauri::AppHandle) {
        if let Ok(mut event_app) = self.shared.event_app.write() {
            *event_app = Some(app);
        }
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
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

#[derive(Clone, Copy)]
struct SourceKey {
    id: &'static str,
    scan_code: u16,
    extended: Option<bool>,
}

const SOURCE_KEYS: [SourceKey; 10] = [
    SourceKey {
        id: "voice",
        scan_code: 0x3f,
        extended: Some(false),
    },
    SourceKey {
        id: "power",
        scan_code: 0x5e,
        extended: Some(true),
    },
    SourceKey {
        id: "home",
        scan_code: 0x47,
        extended: None,
    },
    SourceKey {
        id: "tv",
        scan_code: 0x29,
        extended: None,
    },
    SourceKey {
        id: "menu",
        scan_code: 0x5d,
        extended: None,
    },
    SourceKey {
        id: "confirm",
        scan_code: 0x1c,
        extended: None,
    },
    SourceKey {
        id: "up",
        scan_code: 0x48,
        extended: None,
    },
    SourceKey {
        id: "down",
        scan_code: 0x50,
        extended: None,
    },
    SourceKey {
        id: "left",
        scan_code: 0x4b,
        extended: None,
    },
    SourceKey {
        id: "right",
        scan_code: 0x4d,
        extended: None,
    },
];

fn source_for(stroke: KeyStroke) -> Option<SourceKey> {
    let extended = stroke.state & KEY_E0 != 0;
    SOURCE_KEYS.iter().copied().find(|source| {
        source.scan_code == stroke.code
            && source.extended.is_none_or(|expected| expected == extended)
    })
}

struct PressState {
    started_at: Instant,
    original: KeyStroke,
    long_fired: bool,
    passthrough_long: bool,
    held_outputs: Vec<KeyStroke>,
}

struct PendingClick {
    due_at: Instant,
    original: KeyStroke,
}

#[derive(Default)]
struct ButtonState {
    pressed: Option<PressState>,
    pending_click: Option<PendingClick>,
}

fn worker_loop(shared: Arc<Shared>) {
    let api = match InterceptionApi::load() {
        Ok(api) => api,
        Err(error) => {
            shared.status.lock().unwrap().error = Some(error);
            return;
        }
    };
    let mut last_target_seen_at = None;
    while !shared.stop.load(Ordering::Relaxed) {
        let context = unsafe { (api.create_context)() };
        if context.is_null() {
            let mut status = shared.status.lock().unwrap();
            status.backend_ready = false;
            status.error = Some("Interception could not create an input context".into());
            drop(status);
            thread::sleep(CONTEXT_RETRY_DELAY);
            continue;
        }

        {
            let mut status = shared.status.lock().unwrap();
            status.backend_ready = true;
            status.error = None;
        }

        run_context(&api, context, &shared, &mut last_target_seen_at);
        clear_keyboard_filters(&api, context);
        unsafe { (api.destroy_context)(context) };

        if !shared.stop.load(Ordering::Relaxed) {
            thread::sleep(CONTEXT_RETRY_DELAY);
        }
    }
}

fn run_context(
    api: &InterceptionApi,
    context: Context,
    shared: &Shared,
    last_target_seen_at: &mut Option<Instant>,
) {
    let mut target_device = 0;
    let mut target_filtered = false;
    let mut next_probe = Instant::now();
    let mut button_states: HashMap<&'static str, ButtonState> = HashMap::new();
    while !shared.stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= next_probe {
            let filter_target = shared
                .settings
                .read()
                .map(|settings| settings.enabled)
                .unwrap_or(false);
            let next_target = probe_devices(
                api,
                context,
                target_device,
                target_filtered,
                filter_target,
                *last_target_seen_at,
                now,
                shared,
            );
            if next_target != 0 {
                *last_target_seen_at = Some(now);
            }
            if next_target != target_device {
                if target_device != 0 {
                    release_all_held_outputs(api, context, target_device, &mut button_states);
                }
                button_states.clear();
            }
            if next_target == 0 {
                // Contexts keep fixed device handles; rebuild after hot removal or re-pairing.
                return;
            }
            target_device = next_target;
            target_filtered = filter_target;
            next_probe = now + Duration::from_secs(1);
        }
        if target_device != 0 && target_filtered {
            process_timers(api, context, target_device, shared, &mut button_states, now);
        }

        let device = unsafe { (api.wait_with_timeout)(context, WAIT_TIMEOUT_MS) };
        if device <= 0 {
            continue;
        }
        let mut stroke = KeyStroke::default();
        if unsafe { (api.receive)(context, device, &mut stroke, 1) } != 1 {
            continue;
        }
        if device != target_device {
            send_stroke(api, context, device, stroke);
            continue;
        }
        if target_filtered {
            process_target_stroke(api, context, device, shared, &mut button_states, stroke);
        } else {
            send_stroke(api, context, device, stroke);
        }
    }

    if target_device != 0 {
        release_all_held_outputs(api, context, target_device, &mut button_states);
    }
}

fn probe_devices(
    api: &InterceptionApi,
    context: Context,
    old_target: i32,
    old_target_filtered: bool,
    filter_target: bool,
    last_target_seen_at: Option<Instant>,
    now: Instant,
    shared: &Shared,
) -> i32 {
    let mut found = 0;
    let mut found_id = None;
    for device in 1..=MAX_KEYBOARD {
        let ids = hardware_ids(api, context, device);
        if is_target_hardware_id(&ids) {
            found = device;
            found_id = ids
                .split('\0')
                .find(|value| !value.trim().is_empty())
                .map(str::trim)
                .map(str::to_string);
            break;
        }
    }

    if old_target != found {
        if old_target != 0 {
            set_device_filter(api, context, old_target, FILTER_KEY_NONE);
        }
        if found != 0 && filter_target {
            set_device_filter(api, context, found, FILTER_KEY_ALL);
        }
    } else if found != 0 && old_target_filtered != filter_target {
        set_device_filter(
            api,
            context,
            found,
            if filter_target {
                FILTER_KEY_ALL
            } else {
                FILTER_KEY_NONE
            },
        );
    }
    let mut status = shared.status.lock().unwrap();
    status.backend_ready = true;
    status.device_connected = device_connection_visible(found != 0, last_target_seen_at, now);
    if found_id.is_some() || !status.device_connected {
        status.hardware_id = found_id;
    }
    status.error = None;
    found
}

fn device_connection_visible(found: bool, last_seen_at: Option<Instant>, now: Instant) -> bool {
    found
        || last_seen_at.is_some_and(|last_seen| {
            now.saturating_duration_since(last_seen) < DEVICE_DISCONNECT_GRACE
        })
}

fn set_device_filter(api: &InterceptionApi, context: Context, device: i32, filter: u16) {
    FILTER_TARGET.store(device, Ordering::Relaxed);
    unsafe { (api.set_filter)(context, selected_device, filter) };
}

fn clear_keyboard_filters(api: &InterceptionApi, context: Context) {
    FILTER_TARGET.store(0, Ordering::Relaxed);
    unsafe { (api.set_filter)(context, keyboard_device, FILTER_KEY_NONE) };
}

fn hardware_ids(api: &InterceptionApi, context: Context, device: i32) -> String {
    let mut buffer = [0u8; 2048];
    let length =
        unsafe { (api.get_hardware_id)(context, device, buffer.as_mut_ptr(), buffer.len() as u32) }
            as usize;
    if length < 2 || length > buffer.len() {
        return String::new();
    }
    let words = buffer[..length]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&words)
}

fn is_target_hardware_id(value: &str) -> bool {
    let uppercase = value.to_ascii_uppercase();
    let vid = uppercase.contains("VID_2717") || uppercase.contains("VID&012717");
    let pid = uppercase.contains("PID_32B8") || uppercase.contains("PID&32B8");
    vid && pid
}

fn process_target_stroke(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    shared: &Shared,
    states: &mut HashMap<&'static str, ButtonState>,
    stroke: KeyStroke,
) {
    let Some(source) = source_for(stroke) else {
        send_stroke(api, context, device, stroke);
        return;
    };
    let key_up = stroke.state & KEY_UP != 0;
    emit_remote_key_event(shared, source.id, !key_up);
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
    if !settings.enabled || !has_custom_behavior(&triggers) {
        if let Some(state) = states.get_mut(source.id) {
            if let Some(press) = state.pressed.take() {
                release_chord(api, context, device, &press.held_outputs);
            }
            state.pending_click = None;
        }
        send_stroke(api, context, device, stroke);
        return;
    }

    let state = states.entry(source.id).or_default();
    if !key_up {
        if let Some(press) = state.pressed.as_mut() {
            if let Some(repeat) = press.held_outputs.last().copied() {
                send_stroke(api, context, device, repeat);
            } else if press.passthrough_long {
                send_stroke(api, context, device, stroke);
            } else if !has_enabled(&triggers.long_press)
                && press.started_at.elapsed() >= Duration::from_millis(LONG_PRESS_MS)
            {
                send_original_down(api, context, device, press.original);
                press.passthrough_long = true;
                send_stroke(api, context, device, stroke);
            }
        } else {
            let held_outputs = continuous_click_chord(&triggers)
                .map(|keys| press_chord(api, context, device, &keys))
                .unwrap_or_default();
            state.pressed = Some(PressState {
                started_at: Instant::now(),
                original: stroke,
                long_fired: false,
                passthrough_long: false,
                held_outputs,
            });
        }
        return;
    }

    let Some(press) = state.pressed.take() else {
        return;
    };
    if !press.held_outputs.is_empty() {
        release_chord(api, context, device, &press.held_outputs);
        return;
    }
    if press.passthrough_long {
        send_stroke(api, context, device, stroke);
        return;
    }
    if press.long_fired {
        return;
    }
    let long_enabled = has_enabled(&triggers.long_press);
    if long_enabled && press.started_at.elapsed() >= Duration::from_millis(LONG_PRESS_MS) {
        execute_behaviors(api, context, device, &triggers.long_press);
        return;
    }
    if !long_enabled && press.started_at.elapsed() >= Duration::from_millis(LONG_PRESS_MS) {
        send_original_down(api, context, device, press.original);
        send_stroke(api, context, device, stroke);
        return;
    }
    if has_enabled(&triggers.double_click) {
        if state.pending_click.take().is_some() {
            execute_behaviors(api, context, device, &triggers.double_click);
        } else {
            state.pending_click = Some(PendingClick {
                due_at: Instant::now() + Duration::from_millis(DOUBLE_CLICK_MS),
                original: press.original,
            });
        }
    } else {
        execute_click_or_original(api, context, device, &triggers.click, press.original);
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

fn process_timers(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    shared: &Shared,
    states: &mut HashMap<&'static str, ButtonState>,
    now: Instant,
) {
    let settings = shared
        .settings
        .read()
        .map(|settings| settings.clone())
        .unwrap_or_default();
    if !settings.enabled {
        release_all_held_outputs(api, context, device, states);
        states.clear();
        return;
    }
    for source in SOURCE_KEYS {
        let Some(state) = states.get_mut(source.id) else {
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
                && !press.passthrough_long
                && reached_long_press
            {
                if has_enabled(&triggers.long_press) {
                    execute_behaviors(api, context, device, &triggers.long_press);
                    press.long_fired = true;
                } else {
                    send_original_down(api, context, device, press.original);
                    press.passthrough_long = true;
                }
                state.pending_click = None;
            }
        }
        if state
            .pending_click
            .as_ref()
            .is_some_and(|pending| now >= pending.due_at)
        {
            let pending = state.pending_click.take().unwrap();
            execute_click_or_original(api, context, device, &triggers.click, pending.original);
        }
    }
}

fn has_enabled(behaviors: &[NativeBehavior]) -> bool {
    behaviors.iter().any(NativeBehavior::enabled)
}

fn has_custom_behavior(triggers: &TriggerBehaviors) -> bool {
    has_enabled(&triggers.click)
        || has_enabled(&triggers.double_click)
        || has_enabled(&triggers.long_press)
}

fn continuous_click_chord(triggers: &TriggerBehaviors) -> Option<Vec<u16>> {
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

fn execute_click_or_original(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    behaviors: &[NativeBehavior],
    original: KeyStroke,
) {
    if has_enabled(behaviors) {
        execute_behaviors(api, context, device, behaviors);
    } else {
        let mut down = original;
        down.state &= !KEY_UP;
        send_stroke(api, context, device, down);
        down.state |= KEY_UP;
        send_stroke(api, context, device, down);
    }
}

fn send_original_down(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    mut original: KeyStroke,
) {
    original.state &= !KEY_UP;
    send_stroke(api, context, device, original);
}

fn execute_behaviors(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    behaviors: &[NativeBehavior],
) {
    for behavior in behaviors.iter().filter(|behavior| behavior.enabled()) {
        match behavior {
            NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. } => {
                if let Some(chord) = behavior_chord(behavior) {
                    tap_chord(api, context, device, &chord);
                }
            }
            NativeBehavior::Paste { text, .. } => send_unicode_text(text),
            NativeBehavior::Delay { ms, .. } => {
                thread::sleep(Duration::from_millis((*ms).min(300_000)))
            }
            NativeBehavior::Disabled { .. } => {}
        }
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
        NativeBehavior::Paste { .. }
        | NativeBehavior::Delay { .. }
        | NativeBehavior::Disabled { .. } => None,
    }
}

fn press_chord(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    keys: &[u16],
) -> Vec<KeyStroke> {
    let mut pressed = Vec::new();
    for key in keys {
        if let Some(stroke) = output_stroke(*key, false) {
            if send_stroke(api, context, device, stroke) {
                pressed.push(stroke);
            }
        }
    }
    pressed
}

fn release_chord(api: &InterceptionApi, context: Context, device: i32, pressed: &[KeyStroke]) {
    for mut stroke in pressed.iter().copied().rev() {
        stroke.state |= KEY_UP;
        send_stroke(api, context, device, stroke);
    }
}

fn tap_chord(api: &InterceptionApi, context: Context, device: i32, keys: &[u16]) {
    let pressed = press_chord(api, context, device, keys);
    release_chord(api, context, device, &pressed);
}

fn release_all_held_outputs(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    states: &mut HashMap<&'static str, ButtonState>,
) {
    for state in states.values_mut() {
        if let Some(press) = state.pressed.as_mut() {
            release_chord(api, context, device, &press.held_outputs);
            press.held_outputs.clear();
        }
    }
}

fn send_stroke(api: &InterceptionApi, context: Context, device: i32, stroke: KeyStroke) -> bool {
    unsafe { (api.send)(context, device, &stroke, 1) == 1 }
}

fn output_stroke(virtual_key: u16, key_up: bool) -> Option<KeyStroke> {
    let mut scan = unsafe { MapVirtualKeyW(virtual_key as u32, 4) };
    if scan == 0 {
        scan = match virtual_key {
            0xad => 0xe020,
            0xae => 0xe02e,
            0xaf => 0xe030,
            0xb3 => 0xe022,
            _ => 0,
        };
    }
    let code = (scan & 0xff) as u16;
    if code == 0 {
        return None;
    }
    let extended = scan & 0xff00 == 0xe000 || is_extended_key(virtual_key);
    Some(KeyStroke {
        code,
        state: (u16::from(extended) * KEY_E0) | (u16::from(key_up) * KEY_UP),
        information: 0,
    })
}

fn is_extended_key(key: u16) -> bool {
    matches!(key,
        0xa3 | 0xa5 | 0x5b | 0x5c | 0x21..=0x28 | 0x2d | 0x2e | 0x5d | 0xad..=0xaf | 0xb3
    )
}

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

fn send_unicode_text(text: &str) {
    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const KEYEVENTF_UNICODE: u32 = 0x0004;
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
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            )
        };
    }
}

#[link(name = "user32")]
extern "system" {
    fn MapVirtualKeyW(code: u32, map_type: u32) -> u32;
    fn SendInput(input_count: u32, inputs: *const Input, input_size: i32) -> u32;
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_bracket_and_shortcuts() {
        assert_eq!(parse_chord("]"), Some(vec![0xdd]));
        assert_eq!(parse_chord("】"), Some(vec![0xdd]));
        assert_eq!(parse_chord("Ctrl+C"), Some(vec![0x11, 0x43]));
    }

    #[test]
    fn finds_confirm_scan_code() {
        let source = source_for(KeyStroke {
            code: 0x1c,
            state: 0,
            information: 0,
        })
        .unwrap();
        assert_eq!(source.id, "confirm");
    }

    #[test]
    fn holds_a_single_click_key_when_no_other_gesture_is_configured() {
        let mut triggers = TriggerBehaviors::default();
        triggers.click.push(NativeBehavior::Key {
            enabled: true,
            key: "RAlt".into(),
        });

        assert_eq!(continuous_click_chord(&triggers), Some(vec![0xa5]));

        triggers.long_press.push(NativeBehavior::Key {
            enabled: true,
            key: "Escape".into(),
        });
        assert_eq!(continuous_click_chord(&triggers), None);
    }

    #[test]
    fn keeps_gesture_detection_for_double_clicks_and_action_sequences() {
        let key = NativeBehavior::Key {
            enabled: true,
            key: "RAlt".into(),
        };
        let mut with_double_click = TriggerBehaviors {
            click: vec![key.clone()],
            ..TriggerBehaviors::default()
        };
        with_double_click.double_click.push(NativeBehavior::Key {
            enabled: true,
            key: "Escape".into(),
        });
        assert_eq!(continuous_click_chord(&with_double_click), None);

        let action_sequence = TriggerBehaviors {
            click: vec![
                key,
                NativeBehavior::Delay {
                    enabled: true,
                    ms: 10,
                },
            ],
            ..TriggerBehaviors::default()
        };
        assert_eq!(continuous_click_chord(&action_sequence), None);
    }

    #[test]
    fn disabled_behavior_suppresses_passthrough_without_holding_a_key() {
        let triggers = TriggerBehaviors {
            click: vec![NativeBehavior::Disabled { enabled: true }],
            ..TriggerBehaviors::default()
        };

        assert!(has_custom_behavior(&triggers));
        assert_eq!(continuous_click_chord(&triggers), None);
    }
}
