use super::{InputServiceStatus, NativeBehavior, NativeSettings, TriggerBehaviors};
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::Emitter;

const MAX_KEYBOARD: i32 = 20;
const FILTER_KEY_NONE: u16 = 0x0000;
const FILTER_KEY_ALL: u16 = 0xffff;
const KEY_UP: u16 = 0x0001;
const KEY_E0: u16 = 0x0002;
const WAIT_TIMEOUT_MS: u32 = 50;
const LONG_PRESS_MS: u64 = 600;
const DOUBLE_CLICK_MS: u64 = 350;
const DEVICE_DISCONNECT_GRACE: Duration = Duration::from_secs(8);
const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DEVICE_STABLE_DURATION: Duration = Duration::from_secs(3);
const CR_SUCCESS: u32 = 0;
const CM_GETIDLIST_FILTER_PRESENT: u32 = 0x0000_0100;
const OIB_DRIVER_IDENTITY_SIGNATURE: u32 = 0x3142_494f;
const OIB_IOCTL_SET_FILTER: u32 = oib_ioctl(0x804);
const OIB_IOCTL_SET_EVENT: u32 = oib_ioctl(0x810);
const OIB_IOCTL_WRITE: u32 = oib_ioctl(0x820);
const OIB_IOCTL_READ: u32 = oib_ioctl(0x840);
const OIB_IOCTL_GET_HARDWARE_ID: u32 = oib_ioctl(0x880);
const OIB_IOCTL_GET_KEYBOARD_SLOT_COUNT: u32 = oib_ioctl(0x900);
const OIB_IOCTL_GET_DRIVER_IDENTITY: u32 = oib_ioctl(0xa00);
const WAIT_OBJECT_0: u32 = 0;
const WAIT_FAILED: u32 = u32::MAX;
const WINDOWS_WAIT_TIMEOUT: u32 = 0x0000_0102;

const fn oib_ioctl(function: u32) -> u32 {
    (0x22 << 16) | (function << 2)
}

type NativeHandle = *mut c_void;
type Context = *mut OibContext;
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

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct OibKeyboardInputData {
    unit_id: u16,
    make_code: u16,
    flags: u16,
    reserved: u16,
    extra_information: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct OibDriverIdentity {
    signature: u32,
    version_major: u32,
    version_minor: u32,
    is_keyboard: u8,
    padding: [u8; 3],
}

fn validate_oib_identity(identity: &OibDriverIdentity) -> Result<(), String> {
    if identity.signature != OIB_DRIVER_IDENTITY_SIGNATURE {
        return Err("The installed input driver is not OpenInputBridge".into());
    }
    if identity.is_keyboard != 1 {
        return Err("OpenInputBridge returned a non-keyboard control slot".into());
    }
    if identity.version_major < 1 {
        return Err(format!(
            "OpenInputBridge {}.{} is unsupported",
            identity.version_major, identity.version_minor
        ));
    }
    Ok(())
}

fn validate_keyboard_slot_count(count: u32) -> Result<u32, String> {
    if (1..=MAX_KEYBOARD as u32).contains(&count) {
        Ok(count)
    } else {
        Err(format!(
            "OpenInputBridge reported an invalid keyboard slot count: {count}"
        ))
    }
}

fn oib_device_path(slot_index: u32) -> String {
    format!(r"\\.\interception{slot_index:02}")
}

struct OibSlot {
    device: NativeHandle,
    event: NativeHandle,
}

impl OibSlot {
    #[cfg(target_os = "windows")]
    fn open(slot_index: u32) -> Result<Self, String> {
        const GENERIC_READ: u32 = 0x8000_0000;
        const OPEN_EXISTING: u32 = 3;
        let path = oib_device_path(slot_index)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let device = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if device == invalid_handle_value() {
            return Err(format!(
                "Cannot open OpenInputBridge slot {slot_index:02}: {}",
                std::io::Error::last_os_error()
            ));
        }

        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            unsafe {
                CloseHandle(device);
            }
            return Err(format!(
                "Cannot create OpenInputBridge event: {}",
                std::io::Error::last_os_error()
            ));
        }

        let slot = Self { device, event };
        let handles = [event, std::ptr::null_mut()];
        slot.ioctl(
            OIB_IOCTL_SET_EVENT,
            handles.as_ptr().cast_mut().cast(),
            std::mem::size_of_val(&handles) as u32,
            std::ptr::null_mut(),
            0,
        )?;
        Ok(slot)
    }

    #[cfg(not(target_os = "windows"))]
    fn open(_slot_index: u32) -> Result<Self, String> {
        Err("OpenInputBridge is only available on Windows".into())
    }

    #[cfg(target_os = "windows")]
    fn ioctl(
        &self,
        code: u32,
        input: *mut c_void,
        input_size: u32,
        output: *mut c_void,
        output_size: u32,
    ) -> Result<u32, String> {
        let mut bytes_returned = 0;
        let succeeded = unsafe {
            DeviceIoControl(
                self.device,
                code,
                input,
                input_size,
                output,
                output_size,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };
        if succeeded == 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(bytes_returned)
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn ioctl(
        &self,
        _code: u32,
        _input: *mut c_void,
        _input_size: u32,
        _output: *mut c_void,
        _output_size: u32,
    ) -> Result<u32, String> {
        Err("OpenInputBridge is only available on Windows".into())
    }

    fn identity(&self) -> Result<OibDriverIdentity, String> {
        let mut identity = OibDriverIdentity {
            signature: 0,
            version_major: 0,
            version_minor: 0,
            is_keyboard: 0,
            padding: [0; 3],
        };
        let bytes = self.ioctl(
            OIB_IOCTL_GET_DRIVER_IDENTITY,
            std::ptr::null_mut(),
            0,
            (&mut identity as *mut OibDriverIdentity).cast(),
            std::mem::size_of::<OibDriverIdentity>() as u32,
        )?;
        if bytes as usize != std::mem::size_of::<OibDriverIdentity>() {
            return Err("OpenInputBridge returned an invalid identity response".into());
        }
        Ok(identity)
    }

    fn keyboard_slot_count(&self) -> Result<u32, String> {
        let mut count = 0u32;
        let bytes = self.ioctl(
            OIB_IOCTL_GET_KEYBOARD_SLOT_COUNT,
            std::ptr::null_mut(),
            0,
            (&mut count as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )?;
        if bytes as usize != std::mem::size_of::<u32>() {
            return Err("OpenInputBridge returned an invalid slot-count response".into());
        }
        validate_keyboard_slot_count(count)
    }
}

impl Drop for OibSlot {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        unsafe {
            if self.device != invalid_handle_value() {
                CloseHandle(self.device);
            }
            if !self.event.is_null() {
                CloseHandle(self.event);
            }
        }
    }
}

struct OibContext {
    slots: Vec<OibSlot>,
}

impl OibContext {
    fn open() -> Result<Self, String> {
        let first = OibSlot::open(0)?;
        validate_oib_identity(&first.identity()?)?;
        let slot_count = first.keyboard_slot_count()?;
        let mut slots = Vec::with_capacity(slot_count as usize);
        slots.push(first);
        for slot_index in 1..slot_count {
            let slot = OibSlot::open(slot_index)?;
            validate_oib_identity(&slot.identity()?)?;
            slots.push(slot);
        }
        Ok(Self { slots })
    }

    fn slot(&self, device: i32) -> Option<&OibSlot> {
        usize::try_from(device.checked_sub(1)?)
            .ok()
            .and_then(|index| self.slots.get(index))
    }

    fn set_filter(&self, device: i32, filter: u16) -> Result<(), String> {
        let slot = self
            .slot(device)
            .ok_or_else(|| format!("Invalid OpenInputBridge keyboard device: {device}"))?;
        let mut filter = filter;
        slot.ioctl(
            OIB_IOCTL_SET_FILTER,
            (&mut filter as *mut u16).cast(),
            std::mem::size_of::<u16>() as u32,
            std::ptr::null_mut(),
            0,
        )?;
        Ok(())
    }

    fn read(&self, device: i32) -> Result<Option<KeyStroke>, String> {
        let slot = self
            .slot(device)
            .ok_or_else(|| format!("Invalid OpenInputBridge keyboard device: {device}"))?;
        let mut input = OibKeyboardInputData::default();
        let bytes = slot.ioctl(
            OIB_IOCTL_READ,
            std::ptr::null_mut(),
            0,
            (&mut input as *mut OibKeyboardInputData).cast(),
            std::mem::size_of::<OibKeyboardInputData>() as u32,
        )?;
        if bytes == 0 {
            return Ok(None);
        }
        if bytes as usize != std::mem::size_of::<OibKeyboardInputData>() {
            return Err("OpenInputBridge returned a partial keyboard record".into());
        }
        Ok(Some(KeyStroke {
            code: input.make_code,
            state: input.flags,
            information: input.extra_information,
        }))
    }

    fn write(&self, device: i32, strokes: &[KeyStroke]) -> Result<(), String> {
        let slot = self
            .slot(device)
            .ok_or_else(|| format!("Invalid OpenInputBridge keyboard device: {device}"))?;
        let mut inputs = strokes
            .iter()
            .map(|stroke| OibKeyboardInputData {
                unit_id: 0,
                make_code: stroke.code,
                flags: stroke.state,
                reserved: 0,
                extra_information: stroke.information,
            })
            .collect::<Vec<_>>();
        slot.ioctl(
            OIB_IOCTL_WRITE,
            inputs.as_mut_ptr().cast(),
            std::mem::size_of_val(inputs.as_slice()) as u32,
            std::ptr::null_mut(),
            0,
        )?;
        Ok(())
    }

    fn hardware_id(&self, device: i32, buffer: &mut [u8]) -> Result<u32, String> {
        let slot = self
            .slot(device)
            .ok_or_else(|| format!("Invalid OpenInputBridge keyboard device: {device}"))?;
        slot.ioctl(
            OIB_IOCTL_GET_HARDWARE_ID,
            std::ptr::null_mut(),
            0,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    }

    #[cfg(target_os = "windows")]
    fn wait_with_timeout(&self, timeout_ms: u32) -> Result<Option<i32>, String> {
        let events = self.slots.iter().map(|slot| slot.event).collect::<Vec<_>>();
        let result =
            unsafe { WaitForMultipleObjects(events.len() as u32, events.as_ptr(), 0, timeout_ms) };
        if result == WINDOWS_WAIT_TIMEOUT {
            return Ok(None);
        }
        if result == WAIT_FAILED {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let index = result.saturating_sub(WAIT_OBJECT_0) as usize;
        if index >= events.len() {
            return Err(format!(
                "OpenInputBridge returned an invalid wait index: {result}"
            ));
        }
        Ok(Some(index as i32 + 1))
    }

    #[cfg(not(target_os = "windows"))]
    fn wait_with_timeout(&self, _timeout_ms: u32) -> Result<Option<i32>, String> {
        Err("OpenInputBridge is only available on Windows".into())
    }
}

unsafe extern "C" fn oib_create_context() -> Context {
    OibContext::open()
        .map(Box::new)
        .map(Box::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

unsafe extern "C" fn oib_destroy_context(context: Context) {
    if !context.is_null() {
        drop(Box::from_raw(context));
    }
}

unsafe extern "C" fn oib_set_filter(context: Context, predicate: DevicePredicate, filter: u16) {
    let Some(context) = context.as_ref() else {
        return;
    };
    for device in 1..=context.slots.len() as i32 {
        if predicate(device) != 0 {
            let _ = context.set_filter(device, filter);
        }
    }
}

unsafe extern "C" fn oib_wait_with_timeout(context: Context, timeout_ms: u32) -> i32 {
    let Some(context) = context.as_ref() else {
        return -1;
    };
    match context.wait_with_timeout(timeout_ms) {
        Ok(Some(device)) => device,
        Ok(None) => 0,
        Err(_) => -1,
    }
}

unsafe extern "C" fn oib_receive(
    context: Context,
    device: i32,
    stroke: *mut KeyStroke,
    count: u32,
) -> i32 {
    if stroke.is_null() || count == 0 {
        return 0;
    }
    let Some(context) = context.as_ref() else {
        return 0;
    };
    match context.read(device) {
        Ok(Some(value)) => {
            *stroke = value;
            1
        }
        Ok(None) => 0,
        Err(_) => -1,
    }
}

unsafe extern "C" fn oib_send(
    context: Context,
    device: i32,
    strokes: *const KeyStroke,
    count: u32,
) -> i32 {
    if strokes.is_null() || count == 0 {
        return 0;
    }
    let Some(context) = context.as_ref() else {
        return 0;
    };
    let strokes = std::slice::from_raw_parts(strokes, count as usize);
    i32::from(context.write(device, strokes).is_ok()) * count as i32
}

unsafe extern "C" fn oib_get_hardware_id(
    context: Context,
    device: i32,
    buffer: *mut u8,
    buffer_size: u32,
) -> u32 {
    if buffer.is_null() || buffer_size == 0 {
        return 0;
    }
    let Some(context) = context.as_ref() else {
        return 0;
    };
    let buffer = std::slice::from_raw_parts_mut(buffer, buffer_size as usize);
    context.hardware_id(device, buffer).unwrap_or(0)
}

struct OpenInputBridgeApi {
    create_context: CreateContext,
    destroy_context: DestroyContext,
    set_filter: SetFilter,
    wait_with_timeout: WaitWithTimeout,
    receive: Receive,
    send: Send,
    get_hardware_id: GetHardwareId,
}

#[cfg(target_os = "windows")]
fn require_oib_services() -> Result<(), String> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let services = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SYSTEM\\CurrentControlSet\\Services")
        .map_err(|error| format!("Cannot inspect Windows input drivers: {error}"))?;
    for service in ["OpenInputBridgeKeyboard", "OpenInputBridgeMouse"] {
        if let Err(error) = services.open_subkey(service) {
            if error.kind() == std::io::ErrorKind::NotFound {
                return Err(format!(
                    "OpenInputBridge is not installed completely (missing {service})"
                ));
            }
            return Err(format!("Cannot inspect {service}: {error}"));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn require_oib_services() -> Result<(), String> {
    Err("OpenInputBridge is only available on Windows".into())
}

impl OpenInputBridgeApi {
    fn load() -> Result<Self, String> {
        require_oib_services()?;
        drop(OibContext::open()?);
        Ok(Self {
            create_context: oib_create_context,
            destroy_context: oib_destroy_context,
            set_filter: oib_set_filter,
            wait_with_timeout: oib_wait_with_timeout,
            receive: oib_receive,
            send: oib_send,
            get_hardware_id: oib_get_hardware_id,
        })
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
            .name("Axonkey OpenInputBridge input".into())
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
    let api = match OpenInputBridgeApi::load() {
        Ok(api) => api,
        Err(error) => {
            shared.status.lock().unwrap().error = Some(error);
            return;
        }
    };
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
            let mut status = shared.status.lock().unwrap();
            status.backend_ready = false;
            status.error = Some("OpenInputBridge could not create an input context".into());
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
    api: &OpenInputBridgeApi,
    context: Context,
    shared: &Shared,
    last_target_seen_at: &mut Option<Instant>,
) {
    let mut target_device = 0;
    let mut next_probe = Instant::now();
    let mut button_states: HashMap<&'static str, ButtonState> = HashMap::new();
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
                return;
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
                return;
            }
            target_device = next_target;
            next_probe = now + Duration::from_secs(1);
        }
        if target_device != 0 {
            process_timers(api, context, target_device, shared, &mut button_states, now);
        }

        let device = unsafe { (api.wait_with_timeout)(context, WAIT_TIMEOUT_MS) };
        if device < 0 {
            set_context_error(
                shared,
                "OpenInputBridge wait failed; rebuilding the input context",
            );
            return;
        }
        if device == 0 {
            continue;
        }
        let mut stroke = KeyStroke::default();
        let received = unsafe { (api.receive)(context, device, &mut stroke, 1) };
        if received < 0 {
            set_context_error(
                shared,
                "OpenInputBridge read failed; rebuilding the input context",
            );
            return;
        }
        if received != 1 {
            continue;
        }
        if device != target_device {
            send_stroke(api, context, device, stroke);
            continue;
        }
        process_target_stroke(api, context, device, shared, &mut button_states, stroke);
    }

    if target_device != 0 {
        release_all_held_outputs(api, context, target_device, &mut button_states);
    }
}

fn set_context_error(shared: &Shared, message: &str) {
    let mut status = shared.status.lock().unwrap();
    status.backend_ready = false;
    status.error = Some(message.into());
}

fn probe_devices(
    api: &OpenInputBridgeApi,
    context: Context,
    old_target: i32,
    last_target_seen_at: Option<Instant>,
    now: Instant,
    shared: &Shared,
) -> i32 {
    let ids_by_device = (1..=MAX_KEYBOARD)
        .map(|device| hardware_ids(api, context, device))
        .collect::<Vec<_>>();
    let found = select_target_device(&ids_by_device);
    let found_id = usize::try_from(found.saturating_sub(1))
        .ok()
        .and_then(|index| ids_by_device.get(index))
        .and_then(|ids| {
            ids.split('\0')
                .find(|value| !value.trim().is_empty())
                .map(str::trim)
                .map(str::to_string)
        });

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

fn select_target_device(ids_by_device: &[String]) -> i32 {
    ids_by_device
        .iter()
        .position(|ids| is_target_hardware_id(ids))
        .map_or(0, |index| index as i32 + 1)
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
    status.backend_ready = true;
    status.device_connected = connected;
    if found || !connected {
        status.hardware_id = hardware_id;
    }
    status.error = None;
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

fn set_device_filter(api: &OpenInputBridgeApi, context: Context, device: i32, filter: u16) {
    FILTER_TARGET.store(device, Ordering::Relaxed);
    unsafe { (api.set_filter)(context, selected_device, filter) };
}

fn clear_keyboard_filters(api: &OpenInputBridgeApi, context: Context) {
    FILTER_TARGET.store(0, Ordering::Relaxed);
    unsafe { (api.set_filter)(context, keyboard_device, FILTER_KEY_NONE) };
}

fn hardware_ids(api: &OpenInputBridgeApi, context: Context, device: i32) -> String {
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
    api: &OpenInputBridgeApi,
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
    api: &OpenInputBridgeApi,
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
    api: &OpenInputBridgeApi,
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
    api: &OpenInputBridgeApi,
    context: Context,
    device: i32,
    mut original: KeyStroke,
) {
    original.state &= !KEY_UP;
    send_stroke(api, context, device, original);
}

fn execute_behaviors(
    api: &OpenInputBridgeApi,
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
    api: &OpenInputBridgeApi,
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

fn release_chord(api: &OpenInputBridgeApi, context: Context, device: i32, pressed: &[KeyStroke]) {
    for mut stroke in pressed.iter().copied().rev() {
        stroke.state |= KEY_UP;
        send_stroke(api, context, device, stroke);
    }
}

fn tap_chord(api: &OpenInputBridgeApi, context: Context, device: i32, keys: &[u16]) {
    let pressed = press_chord(api, context, device, keys);
    release_chord(api, context, device, &pressed);
}

fn release_all_held_outputs(
    api: &OpenInputBridgeApi,
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

fn send_stroke(api: &OpenInputBridgeApi, context: Context, device: i32, stroke: KeyStroke) -> bool {
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

#[cfg(target_os = "windows")]
fn invalid_handle_value() -> NativeHandle {
    -1isize as NativeHandle
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *const c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: NativeHandle,
    ) -> NativeHandle;
    fn CreateEventW(
        event_attributes: *const c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
    ) -> NativeHandle;
    fn DeviceIoControl(
        device: NativeHandle,
        control_code: u32,
        input: *mut c_void,
        input_size: u32,
        output: *mut c_void,
        output_size: u32,
        bytes_returned: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn WaitForMultipleObjects(
        count: u32,
        handles: *const NativeHandle,
        wait_all: i32,
        milliseconds: u32,
    ) -> u32;
    fn CloseHandle(handle: NativeHandle) -> i32;
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

    #[test]
    fn requires_openinputbridge_keyboard_identity() {
        let keyboard = OibDriverIdentity {
            signature: OIB_DRIVER_IDENTITY_SIGNATURE,
            version_major: 1,
            version_minor: 0,
            is_keyboard: 1,
            padding: [0; 3],
        };
        assert!(validate_oib_identity(&keyboard).is_ok());

        let mut legacy_or_unknown = keyboard;
        legacy_or_unknown.signature = 0;
        assert!(validate_oib_identity(&legacy_or_unknown).is_err());

        let mut mouse = keyboard;
        mouse.is_keyboard = 0;
        assert!(validate_oib_identity(&mouse).is_err());
    }

    #[test]
    fn matches_openinputbridge_wire_contract() {
        assert_eq!(std::mem::size_of::<OibKeyboardInputData>(), 12);
        assert_eq!(std::mem::size_of::<OibDriverIdentity>(), 16);
        assert_eq!(OIB_IOCTL_SET_FILTER, 0x0022_2010);
        assert_eq!(OIB_IOCTL_SET_EVENT, 0x0022_2040);
        assert_eq!(OIB_IOCTL_READ, 0x0022_2100);
        assert_eq!(OIB_IOCTL_GET_DRIVER_IDENTITY, 0x0022_2800);
        assert_eq!(oib_device_path(0), r"\\.\interception00");
        assert_eq!(oib_device_path(19), r"\\.\interception19");
    }

    #[test]
    fn reselects_rc003_after_oib_assigns_a_different_slot() {
        let initial = vec![
            "HID\\VID_0001&PID_0001".to_string(),
            "HID\\VID_2717&PID_32B8".to_string(),
            String::new(),
        ];
        let reconnected = vec![
            "HID\\VID_0001&PID_0001".to_string(),
            String::new(),
            "HID\\VID_2717&PID_32B8".to_string(),
        ];

        assert_eq!(select_target_device(&initial), 2);
        assert_eq!(select_target_device(&reconnected), 3);
    }

    #[test]
    fn rejects_invalid_oib_keyboard_slot_counts() {
        assert_eq!(validate_keyboard_slot_count(10), Ok(10));
        assert!(validate_keyboard_slot_count(0).is_err());
        assert!(validate_keyboard_slot_count(21).is_err());
    }
}
