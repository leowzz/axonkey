use super::{InputServiceStatus, NativeBehavior, NativeSettings, TriggerBehaviors, WheelDirection};
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::c_void,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex, OnceLock, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
#[cfg(not(test))]
use tauri::Emitter;

const MAX_KEYBOARD: i32 = 10;
const FILTER_KEY_NONE: u16 = 0x0000;
const FILTER_KEY_ALL: u16 = 0xffff;
const KEY_UP: u16 = 0x0001;
const KEY_E0: u16 = 0x0002;
const WAIT_TIMEOUT_MS: u32 = 50;
// Frida edges do not wake Interception's wait handle. Poll their queue at a
// shorter interval only while that optional capture channel is ready.
#[cfg(windows)]
const EXTRA_KEYS_WAIT_TIMEOUT_MS: u32 = 8;
const LONG_PRESS_MS: u64 = 600;
const DOUBLE_CLICK_MS: u64 = 350;
// Keep synthesized taps visible to applications that poll keyboard state.
// Physical single-click holds already last until the remote's key-up.
const OUTPUT_TAP_DURATION: Duration = Duration::from_millis(50);
const DEVICE_DISCONNECT_GRACE: Duration = Duration::from_secs(8);
const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DEVICE_STABLE_DURATION: Duration = Duration::from_secs(3);
const CR_SUCCESS: u32 = 0;
const CM_GETIDLIST_FILTER_PRESENT: u32 = 0x0000_0100;

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

#[cfg(not(test))]
type EventApp = tauri::AppHandle;
#[cfg(test)]
type EventApp = ();

struct Shared {
    settings: RwLock<NativeSettings>,
    status: Mutex<InputServiceStatus>,
    event_app: RwLock<Option<EventApp>>,
    stop: AtomicBool,
    #[cfg(windows)]
    extra_keys: Arc<super::windows_extra_keys::ExtraKeysService>,
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
            status: Mutex::new(InputServiceStatus::default()),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            #[cfg(windows)]
            extra_keys: Arc::default(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("Axonkey Interception input".into())
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
        #[cfg(windows)]
        if !settings.enabled {
            self.shared.extra_keys.stop();
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
        *self
            .shared
            .settings
            .write()
            .map_err(|_| "Input settings lock is unavailable")? = settings;
        Ok(())
    }

    #[cfg(windows)]
    pub fn extra_keys_status(&self) -> super::windows_extra_keys::ExtraKeysStatus {
        self.shared.extra_keys.status()
    }

    #[cfg(windows)]
    pub fn set_extra_keys_enabled(&self, enabled: bool, automatic: bool) -> Result<(), String> {
        if enabled {
            if !self
                .shared
                .settings
                .read()
                .map_err(|_| "设置不可用")?
                .enabled
            {
                return Err("请先开启自定义按键功能，再授权这三个按键。".into());
            }
            if automatic {
                self.shared.extra_keys.start_automatically()
            } else {
                self.shared.extra_keys.start()
            }
        } else {
            self.shared.extra_keys.stop();
            Ok(())
        }
    }

    pub fn shutdown(&self) {
        #[cfg(windows)]
        self.shared.extra_keys.stop();
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

#[derive(Clone, Copy)]
struct SourceKey {
    id: &'static str,
    scan_code: u16,
    extended: Option<bool>,
}

const SOURCE_KEYS: [SourceKey; 13] = [
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
    // Output equivalents only; these are never recognized from Interception input.
    SourceKey {
        id: "back",
        scan_code: 0x6a,
        extended: Some(true),
    },
    SourceKey {
        id: "volumeUp",
        scan_code: 0x30,
        extended: Some(true),
    },
    SourceKey {
        id: "volumeDown",
        scan_code: 0x2e,
        extended: Some(true),
    },
];

fn source_for(stroke: KeyStroke) -> Option<SourceKey> {
    let extended = stroke.state & KEY_E0 != 0;
    SOURCE_KEYS[..10].iter().copied().find(|source| {
        source.scan_code == stroke.code
            && source.extended.is_none_or(|expected| expected == extended)
    })
}

struct PressState {
    wheel_repeat: Option<(i32, bool, Instant)>,
    started_at: Instant,
    last_repeat_log: Instant,
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
            log::error!(target: "axonkey::input", "Failed to load Interception backend: {error}");
            shared.status.lock().unwrap().error = Some(error);
            return;
        }
    };
    log::info!(target: "axonkey::input", "Interception backend loaded");
    {
        let mut status = shared.status.lock().unwrap();
        status.backend_ready = true;
        status.error = None;
    }

    let mut last_target_seen_at = None;
    while !shared.stop.load(Ordering::Relaxed) {
        if !wait_for_stable_target(&shared, &mut last_target_seen_at) {
            break;
        }

        let context = unsafe { (api.create_context)() };
        if context.is_null() {
            log::warn!(target: "axonkey::input", "Interception could not create an input context; retrying");
            let mut status = shared.status.lock().unwrap();
            status.backend_ready = false;
            status.error = Some("Interception could not create an input context".into());
            drop(status);
            thread::sleep(DEVICE_POLL_INTERVAL);
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
    }
}

fn wait_for_stable_target(shared: &Shared, last_target_seen_at: &mut Option<Instant>) -> bool {
    let mut stable_since = None;
    while !shared.stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        let hardware_id = rc003_keyboard_device_id();
        let target_present = hardware_id.is_some();
        update_device_status(shared, hardware_id, last_target_seen_at, now);

        let mapping_enabled = shared
            .settings
            .read()
            .map(|settings| settings.enabled)
            .unwrap_or(false);
        if target_present && mapping_enabled {
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

fn run_context(
    api: &InterceptionApi,
    context: Context,
    shared: &Shared,
    last_target_seen_at: &mut Option<Instant>,
) {
    let mut target_device = 0;
    let mut next_probe = Instant::now();
    let mut button_states: HashMap<&'static str, ButtonState> = HashMap::new();
    #[cfg(windows)]
    let mut extra_generation = shared.extra_keys.drain().0;
    while !shared.stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= next_probe {
            let mapping_enabled = shared
                .settings
                .read()
                .map(|settings| settings.enabled)
                .unwrap_or(false);
            let hardware_id = rc003_keyboard_device_id();
            update_device_status(shared, hardware_id.clone(), last_target_seen_at, now);
            if !mapping_enabled || hardware_id.is_none() {
                break;
            }
            let next_target = probe_devices(
                api,
                context,
                target_device,
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
                break;
            }
            target_device = next_target;
            next_probe = now + Duration::from_secs(1);
        }
        if target_device != 0 {
            #[cfg(windows)]
            {
                let (generation, events) = shared.extra_keys.drain();
                if generation != extra_generation {
                    release_extra_outputs(api, context, target_device, shared, &mut button_states);
                    extra_generation = generation;
                }
                for (usage, pressed) in events {
                    if usage == 0 {
                        release_extra_outputs(
                            api,
                            context,
                            target_device,
                            shared,
                            &mut button_states,
                        );
                    } else if let Some(index) = super::extra_keys_protocol::EXTRA_KEYS
                        .iter()
                        .position(|k| k.0 == usage)
                    {
                        let source = SOURCE_KEYS[10 + index];
                        let stroke = KeyStroke {
                            code: source.scan_code,
                            state: KEY_E0 | if pressed { 0 } else { KEY_UP },
                            information: 0,
                        };
                        process_source_stroke(
                            api,
                            context,
                            target_device,
                            shared,
                            &mut button_states,
                            stroke,
                            source,
                        );
                    }
                }
            }
            process_timers(api, context, target_device, shared, &mut button_states, now);
        }

        #[cfg(not(windows))]
        let wait_timeout_ms = WAIT_TIMEOUT_MS;
        #[cfg(windows)]
        let wait_timeout_ms = if shared.extra_keys.is_ready() {
            EXTRA_KEYS_WAIT_TIMEOUT_MS
        } else {
            WAIT_TIMEOUT_MS
        };
        let device = unsafe { (api.wait_with_timeout)(context, wait_timeout_ms) };
        if device <= 0 {
            continue;
        }
        let mut stroke = KeyStroke::default();
        if unsafe { (api.receive)(context, device, &mut stroke, 1) } != 1 {
            continue;
        }
        if device != target_device {
            unsafe { (api.send)(context, device, &stroke, 1) };
            continue;
        }
        process_target_stroke(api, context, device, shared, &mut button_states, stroke);
    }

    if target_device != 0 {
        release_all_held_outputs(api, context, target_device, &mut button_states);
    }
}

fn probe_devices(
    api: &InterceptionApi,
    context: Context,
    old_target: i32,
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
        if found != 0 {
            set_device_filter(api, context, found, FILTER_KEY_ALL);
        }
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
        log::info!(target: "axonkey::input", "RC003 unrecognized key passthrough: device={device}, scan=0x{:04X}, state=0x{:04X}", stroke.code, stroke.state);
        send_stroke(api, context, device, stroke);
        return;
    };
    process_source_stroke(api, context, device, shared, states, stroke, source);
}

fn process_source_stroke(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    shared: &Shared,
    states: &mut HashMap<&'static str, ButtonState>,
    stroke: KeyStroke,
    source: SourceKey,
) {
    let key_up = stroke.state & KEY_UP != 0;
    let (tracked_press, held_ms, should_log) = if let Some(press) = states
        .get_mut(source.id)
        .and_then(|state| state.pressed.as_mut())
    {
        let held_ms = press.started_at.elapsed().as_millis();
        let should_log = key_up || press.last_repeat_log.elapsed() >= Duration::from_secs(1);
        if should_log {
            press.last_repeat_log = Instant::now();
        }
        (true, held_ms, should_log)
    } else {
        (false, 0, true)
    };
    if should_log {
        log::info!(target: "axonkey::input", "RC003 key: device={device}, button={}, phase={}, scan=0x{:04X}, state=0x{:04X}, tracked_press={}, held_ms={}",
            source.id, if key_up { "up" } else if tracked_press { "repeat" } else { "down" },
            stroke.code, stroke.state, tracked_press, held_ms);
    }
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
        log::info!(target: "axonkey::input", "RC003 passthrough: button={}, mapping_enabled={}, custom_behavior={}", source.id, settings.enabled, has_custom_behavior(&triggers));
        if let Some(state) = states.get_mut(source.id) {
            if let Some(press) = state.pressed.take() {
                release_chord(api, context, device, &press.held_outputs);
            }
            state.pending_click = None;
        }
        // Raw extra keys have no Windows key-up fallback if the helper disconnects.
        // Track their synthesized default down so shutdown can always release it.
        if SOURCE_KEYS[10..].iter().any(|key| key.id == source.id) && settings.enabled && !key_up {
            states.entry(source.id).or_default().pressed = Some(PressState {
                wheel_repeat: None,
                started_at: Instant::now(),
                last_repeat_log: Instant::now(),
                original: stroke,
                long_fired: false,
                passthrough_long: true,
                held_outputs: vec![],
            });
        }
        send_stroke(api, context, device, stroke);
        return;
    }

    let state = states.entry(source.id).or_default();
    if !key_up {
        if let Some(press) = state.pressed.as_mut() {
            // The timer owns wheel repeats, including remotes without repeat reports.
            if press.wheel_repeat.is_some() {
                return;
            }
            if press.last_repeat_log.elapsed() >= Duration::from_secs(1) {
                log::info!(target: "axonkey::input", "RC003 repeat handling: button={}, held_outputs={}, passthrough_long={}, long_fired={}", source.id, press.held_outputs.len(), press.passthrough_long, press.long_fired);
                press.last_repeat_log = Instant::now();
            }
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
            let wheel_repeat = continuous_click_wheel(&triggers).map(|(delta, horizontal)| {
                send_wheel_with_axis(delta, horizontal);
                (
                    delta,
                    horizontal,
                    Instant::now() + Duration::from_millis(400),
                )
            });
            let held_outputs = continuous_click_chord(&triggers)
                .map(|keys| {
                    for behavior in triggers.click.iter().filter(|behavior| behavior.enabled()) {
                        match behavior {
                            NativeBehavior::Key { key, .. } => log::info!(target: "axonkey::input", "Mapped hold: button={}, key={key:?}", source.id),
                            NativeBehavior::Shortcut { keys, .. } => log::info!(target: "axonkey::input", "Mapped hold: button={}, keys={keys:?}", source.id),
                            _ => {}
                        }
                    }
                    press_chord(api, context, device, &keys)
                })
                .unwrap_or_default();
            state.pressed = Some(PressState {
                wheel_repeat,
                started_at: Instant::now(),
                last_repeat_log: Instant::now(),
                original: stroke,
                long_fired: false,
                passthrough_long: false,
                held_outputs,
            });
        }
        return;
    }

    let Some(press) = state.pressed.take() else {
        log::warn!(target: "axonkey::input", "RC003 unmatched key-up ignored: button={}", source.id);
        return;
    };
    if press.wheel_repeat.is_some() {
        return;
    }
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
        log::info!(target: "axonkey::input", "RC003 gesture: button={}, trigger=long_press, origin=key_up", source.id);
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
            log::info!(target: "axonkey::input", "RC003 gesture: button={}, trigger=double_click", source.id);
            execute_behaviors(api, context, device, &triggers.double_click);
        } else {
            log::info!(target: "axonkey::input", "RC003 click pending: button={}", source.id);
            state.pending_click = Some(PendingClick {
                due_at: Instant::now() + Duration::from_millis(DOUBLE_CLICK_MS),
                original: press.original,
            });
        }
    } else {
        log::info!(target: "axonkey::input", "RC003 gesture: button={}, trigger=click", source.id);
        execute_click_or_original(api, context, device, &triggers.click, press.original);
    }
}

#[derive(Clone, Serialize)]
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
            if let Some((delta, horizontal, due)) = press.wheel_repeat.as_mut() {
                if continuous_click_wheel(&triggers) == Some((*delta, *horizontal)) && now >= *due {
                    send_wheel_with_axis(*delta, *horizontal);
                    *due = now + Duration::from_millis(80);
                } else if continuous_click_wheel(&triggers) != Some((*delta, *horizontal)) {
                    // A mapping change while the key is held must cancel the
                    // old wheel gesture rather than leaving stale repeat state.
                    press.wheel_repeat = None;
                }
                if press.wheel_repeat.is_some() {
                    continue;
                }
            }
            let reached_long_press =
                now.duration_since(press.started_at) >= Duration::from_millis(LONG_PRESS_MS);
            if press.held_outputs.is_empty()
                && !press.long_fired
                && !press.passthrough_long
                && reached_long_press
            {
                if has_enabled(&triggers.long_press) {
                    log::info!(target: "axonkey::input", "RC003 gesture: button={}, trigger=long_press, origin=timer", source.id);
                    execute_behaviors(api, context, device, &triggers.long_press);
                    press.long_fired = true;
                } else {
                    log::info!(target: "axonkey::input", "RC003 long-press passthrough: button={}", source.id);
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
            log::info!(target: "axonkey::input", "RC003 gesture: button={}, trigger=click, origin=timer", source.id);
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

fn wheel_delta(direction: WheelDirection) -> i32 {
    match direction {
        WheelDirection::Up => 120,
        WheelDirection::Down => -120,
        WheelDirection::Left => -120,
        WheelDirection::Right => 120,
    }
}

fn continuous_click_wheel(triggers: &TriggerBehaviors) -> Option<(i32, bool)> {
    if has_enabled(&triggers.double_click) || has_enabled(&triggers.long_press) {
        return None;
    }
    let mut enabled = triggers.click.iter().filter(|behavior| behavior.enabled());
    let first = enabled.next()?;
    if enabled.next().is_some() {
        return None;
    }
    match first {
        NativeBehavior::Wheel { direction, .. } => {
            Some((wheel_delta(*direction), wheel_horizontal(*direction)))
        }
        _ => None,
    }
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
        if send_stroke(api, context, device, down) {
            thread::sleep(OUTPUT_TAP_DURATION);
            down.state |= KEY_UP;
            send_stroke(api, context, device, down);
        }
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
            NativeBehavior::Wheel { direction, .. } => {
                log::info!(target: "axonkey::input", "Mapped wheel: delta={}", wheel_delta(*direction))
            }
            NativeBehavior::Key { key, .. } => {
                log::info!(target: "axonkey::input", "Mapped action: type=key, key={key:?}")
            }
            NativeBehavior::Shortcut { keys, .. } => {
                log::info!(target: "axonkey::input", "Mapped action: type=shortcut, keys={keys:?}")
            }
            NativeBehavior::Paste { text, .. } => {
                log::info!(target: "axonkey::input", "Mapped action: type=paste, chars={}", text.chars().count())
            }
            NativeBehavior::Delay { ms, .. } => {
                log::info!(target: "axonkey::input", "Mapped action: type=delay, effective_ms={}", (*ms).min(300_000))
            }
            NativeBehavior::Disabled { .. } => {
                log::info!(target: "axonkey::input", "Mapped action: type=disabled")
            }
        }
        match behavior {
            NativeBehavior::Wheel { direction, .. } => {
                send_wheel_with_axis(wheel_delta(*direction), wheel_horizontal(*direction))
            }
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
        NativeBehavior::Wheel { .. }
        | NativeBehavior::Paste { .. }
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
    log::info!(target: "axonkey::input", "Mapped chord press: device={device}, virtual_keys={keys:X?}");
    for key in keys {
        if let Some(stroke) = output_stroke(*key, false) {
            if send_stroke(api, context, device, stroke) {
                pressed.push(stroke);
            }
        } else {
            log::warn!(target: "axonkey::input", "Mapped key conversion failed: virtual_key=0x{key:04X}");
        }
    }
    pressed
}

fn release_chord(api: &InterceptionApi, context: Context, device: i32, pressed: &[KeyStroke]) {
    if !pressed.is_empty() {
        log::info!(target: "axonkey::input", "Mapped chord release: device={device}, keys={}", pressed.len());
    }
    for mut stroke in pressed.iter().copied().rev() {
        stroke.state |= KEY_UP;
        send_stroke(api, context, device, stroke);
    }
}

fn tap_chord(api: &InterceptionApi, context: Context, device: i32, keys: &[u16]) {
    let pressed = press_chord(api, context, device, keys);
    if !pressed.is_empty() {
        log::info!(target: "axonkey::input", "Mapped tap: device={device}, hold_ms={}", OUTPUT_TAP_DURATION.as_millis());
        thread::sleep(OUTPUT_TAP_DURATION);
    }
    release_chord(api, context, device, &pressed);
}

fn release_all_held_outputs(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    states: &mut HashMap<&'static str, ButtonState>,
) {
    for (button, state) in states.iter_mut() {
        // A forced reset must never allow a delayed click from the old
        // configuration to fire after disable/disconnect/reconnect.
        state.pending_click = None;
        if let Some(press) = state.pressed.as_mut() {
            if !press.held_outputs.is_empty() {
                log::info!(target: "axonkey::input", "Mapped forced release: button={button}, keys={}, held_ms={}", press.held_outputs.len(), press.started_at.elapsed().as_millis());
            }
            release_chord(api, context, device, &press.held_outputs);
            press.held_outputs.clear();
            if press.passthrough_long {
                let mut up = press.original;
                up.state |= KEY_UP;
                send_stroke(api, context, device, up);
                press.passthrough_long = false;
            }
        }
    }
}

#[cfg(test)]
fn emit_remote_key_event(_shared: &Shared, _button: &'static str, _pressed: bool) {}

#[cfg(windows)]
fn release_extra_outputs(
    api: &InterceptionApi,
    context: Context,
    device: i32,
    shared: &Shared,
    states: &mut HashMap<&'static str, ButtonState>,
) {
    let mut extra = HashMap::new();
    for source in &SOURCE_KEYS[10..] {
        if let Some(state) = states.remove(source.id) {
            emit_remote_key_event(shared, source.id, false);
            extra.insert(source.id, state);
        }
    }
    release_all_held_outputs(api, context, device, &mut extra);
}

fn send_stroke(api: &InterceptionApi, context: Context, device: i32, stroke: KeyStroke) -> bool {
    let sent = unsafe { (api.send)(context, device, &stroke, 1) };
    let is_up = stroke.state & KEY_UP != 0;
    static OUTPUT_LOGS: OnceLock<Mutex<HashMap<(i32, u16, u16), Instant>>> = OnceLock::new();
    let now = Instant::now();
    let key = (device, stroke.code, stroke.state & KEY_E0);
    let should_log = is_up
        || OUTPUT_LOGS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map(|mut logs| {
                let previous = logs.insert(key, now);
                previous.is_none_or(|time| now.duration_since(time) >= Duration::from_secs(1))
            })
            .unwrap_or(true);
    if should_log {
        log::info!(target: "axonkey::input", "RC003 output: device={device}, phase={}, scan=0x{:04X}, state=0x{:04X}, sent={sent}",
            if is_up { "up" } else { "down" }, stroke.code, stroke.state);
    }
    if sent != 1 {
        log::warn!(target: "axonkey::input", "RC003 output injection failed: device={device}, scan=0x{:04X}, state=0x{:04X}, sent={sent}", stroke.code, stroke.state);
    }
    sent == 1
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
    static WHEEL_EVENTS: std::cell::RefCell<Vec<i32>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn send_wheel(delta: i32) {
    send_wheel_with_axis(delta, false)
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
        assert_eq!(continuous_click_wheel(&triggers), Some((-120, false)));
        assert!(continuous_click_chord(&triggers).is_none());
        let wheel = triggers.click[0].clone();
        triggers.double_click.push(wheel.clone());
        assert_eq!(continuous_click_wheel(&triggers), None);
        triggers.double_click.clear();
        triggers.long_press.push(wheel.clone());
        assert_eq!(continuous_click_wheel(&triggers), None);
        triggers.long_press.clear();
        triggers.click.push(wheel);
        assert_eq!(continuous_click_wheel(&triggers), None);
        assert!(serde_json::from_value::<NativeBehavior>(serde_json::json!({
            "type":"wheel", "direction":"left"
        }))
        .is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn extra_keys_use_gestures_and_release_outputs_without_firing_pending_clicks() {
        static SENT: Mutex<Vec<KeyStroke>> = Mutex::new(Vec::new());
        static SENT_AT: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
        unsafe extern "C" fn create() -> Context {
            std::ptr::null_mut()
        }
        unsafe extern "C" fn destroy(_: Context) {}
        unsafe extern "C" fn filter(_: Context, _: DevicePredicate, _: u16) {}
        unsafe extern "C" fn wait(_: Context, _: u32) -> i32 {
            0
        }
        unsafe extern "C" fn receive(_: Context, _: i32, _: *mut KeyStroke, _: u32) -> i32 {
            0
        }
        unsafe extern "C" fn send(_: Context, _: i32, stroke: *const KeyStroke, _: u32) -> i32 {
            SENT.lock().unwrap().push(*stroke);
            SENT_AT.lock().unwrap().push(Instant::now());
            1
        }
        unsafe extern "C" fn hardware(_: Context, _: i32, _: *mut u8, _: u32) -> u32 {
            0
        }
        // No input APIs are called: only output conversion and recording send stubs.
        let api = InterceptionApi {
            _library: unsafe { libloading::Library::new("kernel32.dll").unwrap() },
            create_context: create,
            destroy_context: destroy,
            set_filter: filter,
            wait_with_timeout: wait,
            receive,
            send,
            get_hardware_id: hardware,
        };
        let shared = Shared {
            settings: RwLock::new(NativeSettings {
                enabled: true,
                ..Default::default()
            }),
            status: Mutex::default(),
            event_app: RwLock::new(None),
            stop: AtomicBool::new(false),
            extra_keys: Arc::default(),
        };
        let source = SOURCE_KEYS[10];
        let down = KeyStroke {
            code: source.scan_code,
            state: KEY_E0,
            information: 0,
        };
        let up = KeyStroke {
            state: KEY_E0 | KEY_UP,
            ..down
        };
        assert!(
            source_for(down).is_none(),
            "extra key output codes must not become a second input source"
        );
        let mut states = HashMap::new();
        let ctx = std::ptr::null_mut();
        // Wheel holds emit immediately, repeat only from the timer, and never
        // leak the original arrow down/up or emit an extra wheel on release.
        for (button, direction, delta) in [("up", "up", 120), ("down", "down", -120)] {
            let source = *SOURCE_KEYS
                .iter()
                .find(|source| source.id == button)
                .unwrap();
            *shared.settings.write().unwrap() = serde_json::from_value(serde_json::json!({
                "enabled": true, "behaviors": { (button): {
                    "click": [{"type":"wheel", "direction":direction}]
                }}
            }))
            .unwrap();
            assert!(validate_settings(&shared.settings.read().unwrap()).is_ok());
            SENT.lock().unwrap().clear();
            states.clear();
            WHEEL_EVENTS.with(|events| events.borrow_mut().clear());
            process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
            WHEEL_EVENTS.with(|events| assert_eq!(*events.borrow(), vec![delta]));
            process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
            WHEEL_EVENTS.with(|events| assert_eq!(events.borrow().len(), 1));
            let start = states[button].pressed.as_ref().unwrap().started_at;
            process_timers(
                &api,
                ctx,
                5,
                &shared,
                &mut states,
                start + Duration::from_millis(700),
            );
            WHEEL_EVENTS.with(|events| assert_eq!(*events.borrow(), vec![delta, delta]));
            process_source_stroke(&api, ctx, 5, &shared, &mut states, up, source);
            process_timers(
                &api,
                ctx,
                5,
                &shared,
                &mut states,
                start + Duration::from_secs(2),
            );
            WHEEL_EVENTS.with(|events| assert_eq!(events.borrow().len(), 2));
            assert!(
                SENT.lock().unwrap().is_empty(),
                "wheel must not leak keyboard input"
            );

            // Disabling mappings cancels a held wheel even without a release report.
            process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
            shared.settings.write().unwrap().enabled = false;
            process_timers(
                &api,
                ctx,
                5,
                &shared,
                &mut states,
                start + Duration::from_secs(3),
            );
            assert!(states.is_empty());
            WHEEL_EVENTS.with(|events| assert_eq!(events.borrow().len(), 3));
        }
        shared.settings.write().unwrap().enabled = true;
        // Single-click-only mappings must send key-down before a release or
        // timer tick, including when other gesture rows exist but are disabled.
        for source in &SOURCE_KEYS[10..] {
            for shortcut in [false, true] {
                let click = if shortcut {
                    serde_json::json!({"type":"shortcut", "keys":["Ctrl", "C"]})
                } else {
                    serde_json::json!({"type":"key", "key":"Enter"})
                };
                *shared.settings.write().unwrap() = serde_json::from_value(serde_json::json!({
                    "enabled": true, "behaviors": { (source.id): {
                        "click": [click],
                        "doubleClick": [{"type":"key", "key":"F2", "enabled":false}],
                        "longPress": [{"type":"key", "key":"F3", "enabled":false}]
                    }}
                }))
                .unwrap();
                SENT.lock().unwrap().clear();
                states.clear();
                let down = KeyStroke {
                    code: source.scan_code,
                    state: KEY_E0,
                    information: 0,
                };
                process_source_stroke(&api, ctx, 5, &shared, &mut states, down, *source);
                let expected = if shortcut { 2 } else { 1 };
                assert_eq!(
                    SENT.lock().unwrap().len(),
                    expected,
                    "{} must execute on down",
                    source.id
                );
                assert!(SENT
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|key| key.state & KEY_UP == 0));
                assert!(states[source.id].pending_click.is_none());
                process_source_stroke(
                    &api,
                    ctx,
                    5,
                    &shared,
                    &mut states,
                    KeyStroke {
                        state: KEY_E0 | KEY_UP,
                        ..down
                    },
                    *source,
                );
                assert_eq!(SENT.lock().unwrap().len(), expected * 2);
            }
        }
        states.clear();
        SENT.lock().unwrap().clear();
        // A held replacement modifier is always released on disconnect.
        shared.settings.write().unwrap().behaviors.insert(
            "back".into(),
            TriggerBehaviors {
                click: vec![NativeBehavior::Key {
                    enabled: true,
                    key: "RAlt".into(),
                }],
                ..Default::default()
            },
        );
        process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
        assert_eq!(SENT.lock().unwrap().len(), 1);
        release_extra_outputs(&api, ctx, 5, &shared, &mut states);
        assert_eq!(SENT.lock().unwrap().last().unwrap().state & KEY_UP, KEY_UP);

        assert!(states.is_empty());
        SENT.lock().unwrap().clear();
        // A pending click is cancelled on disconnect; it must not become a user action.
        shared.settings.write().unwrap().behaviors.insert(
            "back".into(),
            TriggerBehaviors {
                double_click: vec![NativeBehavior::Key {
                    enabled: true,
                    key: "F2".into(),
                }],
                ..Default::default()
            },
        );
        process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
        process_source_stroke(&api, ctx, 5, &shared, &mut states, up, source);
        assert!(states["back"].pending_click.is_some());
        release_extra_outputs(&api, ctx, 5, &shared, &mut states);
        assert!(SENT.lock().unwrap().is_empty());
        // Two taps fire the configured double click exactly once.
        for _ in 0..2 {
            process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
            process_source_stroke(&api, ctx, 5, &shared, &mut states, up, source);
        }
        assert_eq!(SENT.lock().unwrap().len(), 2);
        SENT.lock().unwrap().clear();
        states.clear();
        // Long press is driven by timers even when HID sends no repeat reports.
        shared.settings.write().unwrap().behaviors.insert(
            "back".into(),
            TriggerBehaviors {
                long_press: vec![NativeBehavior::Key {
                    enabled: true,
                    key: "F3".into(),
                }],
                ..Default::default()
            },
        );
        process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
        states
            .get_mut("back")
            .unwrap()
            .pressed
            .as_mut()
            .unwrap()
            .started_at -= Duration::from_millis(650);
        process_timers(&api, ctx, 5, &shared, &mut states, Instant::now());
        process_source_stroke(&api, ctx, 5, &shared, &mut states, up, source);
        assert_eq!(SENT.lock().unwrap().len(), 2);
        SENT.lock().unwrap().clear();
        states.clear();
        // Default synthesized inputs are released too.
        shared.settings.write().unwrap().behaviors.clear();
        process_source_stroke(&api, ctx, 5, &shared, &mut states, down, source);
        release_extra_outputs(&api, ctx, 5, &shared, &mut states);
        assert_eq!(SENT.lock().unwrap().len(), 2);
        assert_eq!(SENT.lock().unwrap().last().unwrap().state & KEY_UP, KEY_UP);
        // Reproduce the user's mappings through JSON and the real gesture
        // handlers for all three extra keys. A frame-polled consumer must have
        // an opportunity to observe Esc down, not just two adjacent events.
        for source in &SOURCE_KEYS[10..] {
            let settings = serde_json::json!({
                "enabled": true,
                "behaviors": { (source.id): {
                    "click": [{"type":"key", "key":"Space"}],
                    "doubleClick": [{"type":"key", "key":"Esc"}],
                    "longPress": [{"type":"key", "key":"Esc"}]
                }}
            });
            *shared.settings.write().unwrap() = serde_json::from_value(settings).unwrap();
            for long_press in [false, true] {
                states.clear();
                SENT.lock().unwrap().clear();
                SENT_AT.lock().unwrap().clear();
                let down = KeyStroke {
                    code: source.scan_code,
                    state: KEY_E0,
                    information: 0,
                };
                let up = KeyStroke {
                    state: KEY_E0 | KEY_UP,
                    ..down
                };
                if long_press {
                    process_source_stroke(&api, ctx, 5, &shared, &mut states, down, *source);
                    states
                        .get_mut(source.id)
                        .unwrap()
                        .pressed
                        .as_mut()
                        .unwrap()
                        .started_at -= Duration::from_millis(650);
                    process_timers(&api, ctx, 5, &shared, &mut states, Instant::now());
                    process_source_stroke(&api, ctx, 5, &shared, &mut states, up, *source);
                } else {
                    for _ in 0..2 {
                        process_source_stroke(&api, ctx, 5, &shared, &mut states, down, *source);
                        process_source_stroke(&api, ctx, 5, &shared, &mut states, up, *source);
                    }
                }
                let sent = SENT.lock().unwrap();
                assert_eq!(
                    sent.len(),
                    2,
                    "one Esc tap, without a Space click or duplicate"
                );
                assert_eq!(sent[0].code, 1);
                assert_eq!(sent[0].state, 0);
                assert_eq!(sent[1].state, KEY_UP);
                let at = SENT_AT.lock().unwrap();
                assert!(
                    at[1].duration_since(at[0]) >= Duration::from_millis(16),
                    "{} long_press={long_press}: Esc down/up collapse within one polling frame",
                    source.id
                );
            }
        }
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
