use super::{
    cursor_delta, repeatable_click, InputServiceStatus, NativeBehavior, NativeSettings,
    RepeatableClick, TriggerBehaviors, WheelDirection,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::c_void,
    io::{ErrorKind, Read, Write},
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
const LONG_PRESS_MS: u64 = 600;
const LONG_PRESS_REPEAT_INITIAL_MS: u64 = 350;
const LONG_PRESS_REPEAT_INTERVAL_MS: u64 = 100;
const DOUBLE_CLICK_MS: u64 = 350;
const REPEAT_INITIAL_MS: u64 = 500;
const REPEAT_INTERVAL_MS: u64 = 50;
const MEDIA_REPEAT_INITIAL_MS: u64 = 350;
const MEDIA_REPEAT_INTERVAL_MS: u64 = 100;
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

struct InputApi {
    create_context: CreateContext,
    destroy_context: DestroyContext,
    set_filter: SetFilter,
    wait_with_timeout: WaitWithTimeout,
    receive: Receive,
    send: Send,
    get_hardware_id: GetHardwareId,
}

impl InputApi {
    fn load() -> Result<Self, String> {
        Ok(Self {
            create_context: quarbor_create_context,
            destroy_context: quarbor_destroy_context,
            set_filter: quarbor_set_filter,
            wait_with_timeout: quarbor_wait_with_timeout,
            receive: quarbor_receive,
            send: quarbor_send,
            get_hardware_id: quarbor_get_hardware_id,
        })
    }
}

#[cfg(windows)]
struct QuarborContext {
    pipe: Option<super::windows_pipe::PipeStream>,
    bytes: Vec<u8>,
    reports: std::collections::VecDeque<KeyStroke>,
    active_usages: std::collections::HashSet<u16>,
    device_id: Option<String>,
    session_id: Option<u64>,
    handshaken: bool,
    last_pipe_attempt: Instant,
}

#[cfg(windows)]
impl Default for QuarborContext {
    fn default() -> Self {
        Self {
            pipe: None,
            bytes: Vec::new(),
            reports: std::collections::VecDeque::new(),
            active_usages: std::collections::HashSet::new(),
            device_id: None,
            session_id: None,
            handshaken: false,
            last_pipe_attempt: Instant::now() - Duration::from_secs(2),
        }
    }
}

#[cfg(windows)]
unsafe extern "C" fn quarbor_create_context() -> Context {
    Box::into_raw(Box::new(QuarborContext::default())).cast()
}

#[cfg(windows)]
unsafe extern "C" fn quarbor_destroy_context(context: Context) {
    if !context.is_null() {
        drop(Box::from_raw(context.cast::<QuarborContext>()));
    }
}

#[cfg(windows)]
unsafe extern "C" fn quarbor_set_filter(
    _context: Context,
    _predicate: DevicePredicate,
    _filter: u16,
) {
}

#[cfg(windows)]
unsafe extern "C" fn quarbor_wait_with_timeout(context: Context, timeout_ms: u32) -> i32 {
    let context = &mut *context.cast::<QuarborContext>();
    if !context.reports.is_empty() {
        return 1;
    }
    let Some(device_id) = rc003_keyboard_device_id() else {
        context.pipe = None;
        quarbor_release_active_usages(context);
        context.bytes.clear();
        context.device_id = None;
        context.session_id = None;
        context.handshaken = false;
        thread::sleep(Duration::from_millis(timeout_ms as u64));
        return 0;
    };
    let device_changed = context
        .device_id
        .as_deref()
        .is_none_or(|current| !current.eq_ignore_ascii_case(&device_id));
    if device_changed {
        context.pipe = None;
        quarbor_release_active_usages(context);
        context.bytes.clear();
        context.device_id = Some(device_id.clone());
        context.session_id = None;
        context.handshaken = false;
    }
    if context.pipe.is_none() && context.last_pipe_attempt.elapsed() >= Duration::from_millis(250) {
        context.last_pipe_attempt = Instant::now();
        context.pipe = super::windows_pipe::PipeStream::connect(
            &quarbor_pipe_name(&device_id),
            Duration::from_millis(1),
        )
        .ok();
    }
    let Some(mut pipe) = context.pipe.take() else {
        thread::sleep(Duration::from_millis(timeout_ms as u64));
        return 0;
    };
    let mut buffer = [0u8; 8192];
    let result = match pipe.read(&mut buffer) {
        Ok(size) => {
            if size == 0 {
                quarbor_release_active_usages(context);
                Err(ErrorKind::UnexpectedEof.into())
            } else {
                context.bytes.extend_from_slice(&buffer[..size]);
                quarbor_parse_frames(context, &mut pipe)
                    .map(|()| i32::from(!context.reports.is_empty()))
            }
        }
        Err(error) if error.kind() == ErrorKind::TimedOut => Ok(0),
        Err(error) => {
            quarbor_release_active_usages(context);
            Err(error)
        }
    };
    if result.is_ok() {
        context.pipe = Some(pipe);
    } else {
        context.bytes.clear();
        context.session_id = None;
        context.handshaken = false;
    }
    result.unwrap_or(0)
}

#[cfg(windows)]
fn quarbor_release_active_usages(context: &mut QuarborContext) {
    let active = std::mem::take(&mut context.active_usages);
    for usage in active {
        if let Some(stroke) = rc003_usage_stroke(usage, true) {
            context.reports.push_back(stroke);
        }
    }
}

#[cfg(windows)]
unsafe extern "C" fn quarbor_receive(
    context: Context,
    _device: i32,
    stroke: *mut KeyStroke,
    _count: u32,
) -> i32 {
    let context = &mut *context.cast::<QuarborContext>();
    match context.reports.pop_front() {
        Some(value) => {
            *stroke = value;
            1
        }
        None => 0,
    }
}

#[cfg(windows)]
unsafe extern "C" fn quarbor_send(
    _context: Context,
    _device: i32,
    stroke: *const KeyStroke,
    count: u32,
) -> i32 {
    if stroke.is_null() || count == 0 {
        return 0;
    }
    let stroke = *stroke;
    let mut input = Input {
        kind: 1,
        value: InputValue {
            keyboard: KeyboardInput {
                virtual_key: 0,
                scan_code: stroke.code,
                flags: 0x0008
                    | if stroke.state & KEY_E0 != 0 {
                        0x0001
                    } else {
                        0
                    }
                    | if stroke.state & KEY_UP != 0 {
                        0x0002
                    } else {
                        0
                    },
                time: 0,
                extra_info: 0,
            },
        },
    };
    SendInput(1, &mut input, std::mem::size_of::<Input>() as i32) as i32
}

#[cfg(windows)]
unsafe extern "C" fn quarbor_get_hardware_id(
    context: Context,
    _device: i32,
    buffer: *mut u8,
    length: u32,
) -> u32 {
    let context = &*context.cast::<QuarborContext>();
    let Some(id) = context.device_id.as_deref() else {
        return 0;
    };
    let encoded: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    let bytes = encoded.len() * 2;
    if buffer.is_null() || length < bytes as u32 {
        return bytes as u32;
    }
    std::ptr::copy_nonoverlapping(encoded.as_ptr().cast::<u8>(), buffer, bytes);
    bytes as u32
}

#[cfg(windows)]
fn quarbor_pipe_name(instance_id: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for unit in instance_id.to_ascii_uppercase().encode_utf16() {
        for byte in unit.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!(r"\\.\pipe\Quarbor.HidUserFilter.v2.{hash:016X}")
}

#[cfg(windows)]
fn quarbor_parse_frames(
    context: &mut QuarborContext,
    pipe: &mut super::windows_pipe::PipeStream,
) -> std::io::Result<()> {
    const HEADER: usize = 64;
    const MAGIC: u32 = 0x3246_4851;
    const VERSION: u16 = 2;
    while context.bytes.len() >= HEADER {
        let frame_header = &context.bytes[..HEADER];
        let magic = u32::from_le_bytes(frame_header[0..4].try_into().unwrap());
        let version = u16::from_le_bytes(frame_header[4..6].try_into().unwrap());
        let kind = u16::from_le_bytes(frame_header[6..8].try_into().unwrap());
        let header_bytes = u32::from_le_bytes(frame_header[8..12].try_into().unwrap());
        let payload = u32::from_le_bytes(frame_header[12..16].try_into().unwrap()) as usize;
        let session_id = u64::from_le_bytes(frame_header[16..24].try_into().unwrap());
        let sequence = u64::from_le_bytes(frame_header[24..32].try_into().unwrap());
        let timeout_ms = u32::from_le_bytes(frame_header[40..44].try_into().unwrap());
        let deadline_ms = u32::from_le_bytes(frame_header[44..48].try_into().unwrap());
        let reserved = u32::from_le_bytes(frame_header[56..60].try_into().unwrap());
        let reserved2 = u32::from_le_bytes(frame_header[60..64].try_into().unwrap());
        let valid_payload = match kind {
            1 => payload >= 2 && payload % 2 == 0,
            2 | 5 => payload == 16,
            3 | 4 => (1..=4096).contains(&payload),
            6 => payload == 48,
            _ => false,
        };
        if magic != MAGIC
            || version != VERSION
            || header_bytes != HEADER as u32
            || !(1..=6).contains(&kind)
            || !valid_payload
            || reserved != 0
            || reserved2 != 0
        {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "invalid Quarbor v2 frame header",
            ));
        }
        let frame = HEADER + payload;
        if context.bytes.len() < frame {
            break;
        }
        let data = context.bytes[HEADER..frame].to_vec();
        context.bytes.drain(..frame);
        match kind {
            1 => {
                if data[data.len() - 2..] != [0, 0] {
                    return Err(std::io::Error::new(
                        ErrorKind::InvalidData,
                        "invalid Quarbor Hello",
                    ));
                }
                let units = data[..data.len() - 2]
                    .chunks_exact(2)
                    .map(|part| u16::from_le_bytes([part[0], part[1]]))
                    .collect::<Vec<_>>();
                let hello_id = String::from_utf16(&units).map_err(|_| {
                    std::io::Error::new(ErrorKind::InvalidData, "invalid Quarbor Hello UTF-16")
                })?;
                if let Some(expected) = context.device_id.as_deref() {
                    if !expected.eq_ignore_ascii_case(&hello_id) {
                        return Err(std::io::Error::new(
                            ErrorKind::InvalidData,
                            "Quarbor Hello device mismatch",
                        ));
                    }
                }
                context.device_id = Some(hello_id);
                context.session_id = Some(session_id);
                context.handshaken = false;
                quarbor_send_client_hello(pipe, session_id)?;
                context.handshaken = true;
            }
            3 => {
                if payload == 0 || !context.handshaken || context.session_id != Some(session_id) {
                    return Err(std::io::Error::new(
                        ErrorKind::InvalidData,
                        "invalid Quarbor ReportRequest",
                    ));
                }
                quarbor_send_report_reply(
                    pipe,
                    session_id,
                    sequence,
                    timeout_ms,
                    deadline_ms,
                    &data,
                )?;
                quarbor_decode_report(context, &data);
            }
            2 | 4 | 5 | 6 => {}
            _ => unreachable!(),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn quarbor_frame_header(
    kind: u16,
    payload: usize,
    session_id: u64,
    sequence: u64,
    timeout_ms: u32,
    deadline_ms: u32,
) -> [u8; 64] {
    let mut header = [0u8; 64];
    header[0..4].copy_from_slice(&0x3246_4851u32.to_le_bytes());
    header[4..6].copy_from_slice(&2u16.to_le_bytes());
    header[6..8].copy_from_slice(&kind.to_le_bytes());
    header[8..12].copy_from_slice(&64u32.to_le_bytes());
    header[12..16].copy_from_slice(&(payload as u32).to_le_bytes());
    header[16..24].copy_from_slice(&session_id.to_le_bytes());
    header[24..32].copy_from_slice(&sequence.to_le_bytes());
    header[40..44].copy_from_slice(&timeout_ms.to_le_bytes());
    header[44..48].copy_from_slice(&deadline_ms.to_le_bytes());
    header
}

#[cfg(windows)]
fn quarbor_write_frame(
    pipe: &mut super::windows_pipe::PipeStream,
    header: [u8; 64],
    payload: &[u8],
) -> std::io::Result<()> {
    pipe.write_all(&header)?;
    pipe.write_all(payload)
}

#[cfg(windows)]
fn quarbor_send_client_hello(
    pipe: &mut super::windows_pipe::PipeStream,
    session_id: u64,
) -> std::io::Result<()> {
    let mut payload = [0u8; 16];
    payload[0..2].copy_from_slice(&2u16.to_le_bytes());
    payload[2..4].copy_from_slice(&64u16.to_le_bytes());
    payload[4..8].copy_from_slice(&1u32.to_le_bytes());
    payload[8..12].copy_from_slice(&4096u32.to_le_bytes());
    quarbor_write_frame(
        pipe,
        quarbor_frame_header(2, payload.len(), session_id, 0, 0, 0),
        &payload,
    )
}

#[cfg(windows)]
fn quarbor_send_report_reply(
    pipe: &mut super::windows_pipe::PipeStream,
    session_id: u64,
    sequence: u64,
    timeout_ms: u32,
    deadline_ms: u32,
    payload: &[u8],
) -> std::io::Result<()> {
    quarbor_write_frame(
        pipe,
        quarbor_frame_header(
            4,
            payload.len(),
            session_id,
            sequence,
            timeout_ms,
            deadline_ms,
        ),
        payload,
    )
}

#[cfg(windows)]
fn quarbor_decode_report(context: &mut QuarborContext, payload: &[u8]) {
    let mut current = std::collections::HashSet::new();
    for offset in 0..=1.min(payload.len()) {
        if (payload.len() - offset) % 2 != 0 {
            continue;
        }
        for pair in payload[offset..].chunks_exact(2) {
            let usage = u16::from_le_bytes([pair[0], pair[1]]);
            if known_rc003_usage(usage) {
                current.insert(usage);
            }
        }
        if !current.is_empty() {
            break;
        }
    }
    for usage in current.difference(&context.active_usages).copied() {
        if let Some(stroke) = rc003_usage_stroke(usage, false) {
            context.reports.push_back(stroke);
        }
    }
    for usage in context.active_usages.difference(&current).copied() {
        if let Some(stroke) = rc003_usage_stroke(usage, true) {
            context.reports.push_back(stroke);
        }
    }
    context.active_usages = current;
}

#[cfg(windows)]
fn known_rc003_usage(usage: u16) -> bool {
    matches!(
        usage,
        0x003E
            | 0x00F1
            | 0x0028
            | 0x0035
            | 0x004A
            | 0x004F
            | 0x0050
            | 0x0051
            | 0x0052
            | 0x0065
            | 0x0066
            | 0x0080
            | 0x0081
    )
}

#[cfg(windows)]
fn rc003_usage_stroke(usage: u16, key_up: bool) -> Option<KeyStroke> {
    let (code, extended) = match usage {
        0x003E => (0x3F, false),
        0x00F1 => (0x6A, true),
        0x0028 => (0x1C, false),
        0x0035 => (0x29, false),
        0x004A => (0x47, true),
        0x004F => (0x4D, true),
        0x0050 => (0x4B, true),
        0x0051 => (0x50, true),
        0x0052 => (0x48, true),
        0x0065 => (0x5D, true),
        0x0066 => (0x5E, true),
        0x0080 => (0x30, true),
        0x0081 => (0x2E, true),
        _ => return None,
    };
    Some(KeyStroke {
        code,
        state: (u16::from(extended) * KEY_E0) | (u16::from(key_up) * KEY_UP),
        information: 0,
    })
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

#[derive(Clone, Copy)]
struct SourceKey {
    id: &'static str,
    scan_code: u16,
    extended: Option<bool>,
    repeat_initial_ms: u64,
    repeat_interval_ms: u64,
}

impl SourceKey {
    const fn new(id: &'static str, scan_code: u16, extended: Option<bool>) -> Self {
        Self {
            id,
            scan_code,
            extended,
            repeat_initial_ms: REPEAT_INITIAL_MS,
            repeat_interval_ms: REPEAT_INTERVAL_MS,
        }
    }

    const fn with_repeat(
        id: &'static str,
        scan_code: u16,
        extended: Option<bool>,
        repeat_initial_ms: u64,
        repeat_interval_ms: u64,
    ) -> Self {
        Self {
            id,
            scan_code,
            extended,
            repeat_initial_ms,
            repeat_interval_ms,
        }
    }
}

const SOURCE_KEYS: [SourceKey; 13] = [
    SourceKey::new("voice", 0x3f, Some(false)),
    SourceKey::new("power", 0x5e, Some(true)),
    SourceKey::new("home", 0x47, None),
    SourceKey::new("tv", 0x29, None),
    SourceKey::new("menu", 0x5d, None),
    SourceKey::new("confirm", 0x1c, None),
    SourceKey::new("up", 0x48, None),
    SourceKey::new("down", 0x50, None),
    SourceKey::new("left", 0x4b, None),
    SourceKey::new("right", 0x4d, None),
    // Quarbor HID reports include these consumer usages directly.
    SourceKey::with_repeat(
        "back",
        0x6a,
        Some(true),
        MEDIA_REPEAT_INITIAL_MS,
        MEDIA_REPEAT_INTERVAL_MS,
    ),
    SourceKey::with_repeat(
        "volumeUp",
        0x30,
        Some(true),
        MEDIA_REPEAT_INITIAL_MS,
        MEDIA_REPEAT_INTERVAL_MS,
    ),
    SourceKey::with_repeat(
        "volumeDown",
        0x2e,
        Some(true),
        MEDIA_REPEAT_INITIAL_MS,
        MEDIA_REPEAT_INTERVAL_MS,
    ),
];

fn source_for(stroke: KeyStroke) -> Option<SourceKey> {
    let extended = stroke.state & KEY_E0 != 0;
    SOURCE_KEYS.iter().copied().find(|source| {
        source.scan_code == stroke.code
            && source.extended.is_none_or(|expected| expected == extended)
    })
}

struct PressState {
    click_repeat: Option<(RepeatableClick, Instant)>,
    started_at: Instant,
    last_repeat_log: Instant,
    next_repeat_at: Instant,
    repeat_interval_ms: u64,
    original: KeyStroke,
    long_fired: bool,
    long_repeat_due_at: Option<Instant>,
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
    let api = match InputApi::load() {
        Ok(api) => api,
        Err(error) => {
            log::error!(target: "axonkey::input", "Failed to load Quarbor HID backend: {error}");
            shared.status.lock().unwrap().error = Some(error);
            return;
        }
    };
    log::info!(target: "axonkey::input", "Quarbor HID backend loaded");
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
            log::warn!(target: "axonkey::input", "Quarbor HID could not create an input context; retrying");
            let mut status = shared.status.lock().unwrap();
            status.backend_ready = false;
            status.error = Some("Quarbor HID could not create an input context".into());
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

        // The Quarbor filter blocks the HID read even when mappings are
        // disabled, so keep the pipe connected and forward original strokes
        // in that mode as well.
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

fn run_context(
    api: &InputApi,
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
            let hardware_id = rc003_keyboard_device_id();
            update_device_status(shared, hardware_id.clone(), last_target_seen_at, now);
            if hardware_id.is_none() {
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
            process_timers(api, context, target_device, shared, &mut button_states, now);
        }

        let wait_timeout_ms = WAIT_TIMEOUT_MS;
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
    api: &InputApi,
    context: Context,
    old_target: i32,
    last_target_seen_at: Option<Instant>,
    now: Instant,
    shared: &Shared,
) -> i32 {
    let mut found = 0;
    let mut found_id = None;
    #[cfg(not(test))]
    if let Some(device_id) = rc003_keyboard_device_id() {
        // Quarbor owns the per-device pipe rather than exposing native device
        // handles. Keep the existing state machine's logical target
        // slot while the backend connects to this exact instance ID.
        found = 1;
        found_id = Some(device_id);
    }
    #[cfg(test)]
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

fn set_device_filter(api: &InputApi, context: Context, device: i32, filter: u16) {
    FILTER_TARGET.store(device, Ordering::Relaxed);
    unsafe { (api.set_filter)(context, selected_device, filter) };
}

fn clear_keyboard_filters(api: &InputApi, context: Context) {
    FILTER_TARGET.store(0, Ordering::Relaxed);
    unsafe { (api.set_filter)(context, keyboard_device, FILTER_KEY_NONE) };
}

fn hardware_ids(api: &InputApi, context: Context, device: i32) -> String {
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
    api: &InputApi,
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
    api: &InputApi,
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
        send_stroke(api, context, device, stroke);
        return;
    }

    let state = states.entry(source.id).or_default();
    if !key_up {
        if let Some(press) = state.pressed.as_mut() {
            // The timer owns wheel repeats, including remotes without repeat reports.
            if press.click_repeat.is_some() {
                return;
            }
            if press.last_repeat_log.elapsed() >= Duration::from_secs(1) {
                log::info!(target: "axonkey::input", "RC003 repeat handling: button={}, held_outputs={}, passthrough_long={}, long_fired={}", source.id, press.held_outputs.len(), press.passthrough_long, press.long_fired);
                press.last_repeat_log = Instant::now();
            }
            if !press.held_outputs.is_empty() {
                // Repetition is driven by the timer below so report-polled and
                // edge-only sources share the same cadence.
                return;
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
            let click_repeat = repeatable_click(&triggers).map(|action| {
                execute_repeatable_click(action);
                (action, Instant::now() + Duration::from_millis(400))
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
                click_repeat,
                started_at: Instant::now(),
                last_repeat_log: Instant::now(),
                next_repeat_at: Instant::now() + Duration::from_millis(source.repeat_initial_ms),
                repeat_interval_ms: source.repeat_interval_ms,
                original: stroke,
                long_fired: false,
                long_repeat_due_at: None,
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
    if press.click_repeat.is_some() {
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
    api: &InputApi,
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
            if let Some((action, due)) = press.click_repeat.as_mut() {
                if repeatable_click(&triggers) == Some(*action) && now >= *due {
                    execute_repeatable_click(*action);
                    *due = now + Duration::from_millis(80);
                } else if repeatable_click(&triggers) != Some(*action) {
                    // A mapping change while the key is held must cancel the
                    // old repeatable click rather than leaving stale repeat state.
                    press.click_repeat = None;
                }
                if press.click_repeat.is_some() {
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
                    press.long_repeat_due_at =
                        Some(now + Duration::from_millis(LONG_PRESS_REPEAT_INITIAL_MS));
                } else {
                    log::info!(target: "axonkey::input", "RC003 long-press passthrough: button={}", source.id);
                    send_original_down(api, context, device, press.original);
                    press.passthrough_long = true;
                }
                state.pending_click = None;
            }
            if let Some(due_at) = press.long_repeat_due_at {
                if !has_enabled(&triggers.long_press) {
                    press.long_repeat_due_at = None;
                } else if now >= due_at {
                    log::info!(target: "axonkey::input", "RC003 repeat: button={}, trigger=long_press, origin=timer, held_ms={}", source.id, now.duration_since(press.started_at).as_millis());
                    execute_behaviors(api, context, device, &triggers.long_press);
                    press.long_repeat_due_at =
                        Some(now + Duration::from_millis(LONG_PRESS_REPEAT_INTERVAL_MS));
                }
            }
            if !press.held_outputs.is_empty() && now >= press.next_repeat_at {
                log::info!(target: "axonkey::input", "RC003 repeat: button={}, origin=timer, held_ms={}, passthrough={}", source.id, now.duration_since(press.started_at).as_millis(), press.passthrough_long);
                if let Some(repeat) = press.held_outputs.last().copied() {
                    send_stroke(api, context, device, repeat);
                }
                press.next_repeat_at = now + Duration::from_millis(press.repeat_interval_ms);
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
    match repeatable_click(triggers) {
        Some(RepeatableClick::Wheel(direction)) => {
            Some((wheel_delta(direction), wheel_horizontal(direction)))
        }
        _ => None,
    }
}

fn execute_repeatable_click(action: RepeatableClick) {
    match action {
        RepeatableClick::Wheel(direction) => {
            send_wheel_with_axis(wheel_delta(direction), wheel_horizontal(direction))
        }
        RepeatableClick::CursorMove {
            direction,
            distance,
        } => {
            let (dx, dy) = cursor_delta(direction, distance);
            send_mouse_move(dx, dy);
        }
    }
}

fn execute_click_or_original(
    api: &InputApi,
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

fn send_original_down(api: &InputApi, context: Context, device: i32, mut original: KeyStroke) {
    original.state &= !KEY_UP;
    send_stroke(api, context, device, original);
}

fn execute_behaviors(api: &InputApi, context: Context, device: i32, behaviors: &[NativeBehavior]) {
    for behavior in behaviors.iter().filter(|behavior| behavior.enabled()) {
        match behavior {
            NativeBehavior::Wheel { direction, .. } => {
                log::info!(target: "axonkey::input", "Mapped wheel: delta={}", wheel_delta(*direction))
            }
            NativeBehavior::CursorMove {
                direction,
                distance,
                ..
            } => {
                log::info!(target: "axonkey::input", "Mapped cursor move: {direction:?}, distance={distance}")
            }
            NativeBehavior::Mouse { button, .. } => {
                log::info!(target: "axonkey::input", "Mapped mouse button: {button:?}")
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
            NativeBehavior::OpenApp { .. } | NativeBehavior::OpenWebsite { .. } => {}
        }
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
            NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. } => {
                if let Some(chord) = behavior_chord(behavior) {
                    tap_chord(api, context, device, &chord);
                }
            }
            NativeBehavior::Paste { text, .. } => send_unicode_text(text),
            NativeBehavior::OpenApp { .. } | NativeBehavior::OpenWebsite { .. } => super::launch::execute(behavior),
            NativeBehavior::Delay { ms, .. } => {
                thread::sleep(Duration::from_millis((*ms).min(300_000)))
            }
            NativeBehavior::Disabled { .. } => {}
        }
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
        NativeBehavior::OpenApp { .. } | NativeBehavior::OpenWebsite { .. } => super::launch::execute(behavior),
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

fn press_chord(api: &InputApi, context: Context, device: i32, keys: &[u16]) -> Vec<KeyStroke> {
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

fn release_chord(api: &InputApi, context: Context, device: i32, pressed: &[KeyStroke]) {
    if !pressed.is_empty() {
        log::info!(target: "axonkey::input", "Mapped chord release: device={device}, keys={}", pressed.len());
    }
    for mut stroke in pressed.iter().copied().rev() {
        stroke.state |= KEY_UP;
        send_stroke(api, context, device, stroke);
    }
}

fn tap_chord(api: &InputApi, context: Context, device: i32, keys: &[u16]) {
    let pressed = press_chord(api, context, device, keys);
    if !pressed.is_empty() {
        log::info!(target: "axonkey::input", "Mapped tap: device={device}, hold_ms={}", OUTPUT_TAP_DURATION.as_millis());
        thread::sleep(OUTPUT_TAP_DURATION);
    }
    release_chord(api, context, device, &pressed);
}

fn release_all_held_outputs(
    api: &InputApi,
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

fn send_stroke(api: &InputApi, context: Context, device: i32, stroke: KeyStroke) -> bool {
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
            0xb0 => 0xe019,
            0xb1 => 0xe010,
            0xb2 => 0xe024,
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
        0xa3 | 0xa5 | 0x5b | 0x5c | 0x21..=0x28 | 0x2d | 0x2e | 0x5d | 0xad..=0xaf | 0xb0..=0xb3
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

    #[test]
    fn accepts_case_only_changes_in_quarbor_hello_device_id() {
        let setup_api = "HID\\{00001812}_DEV_VID&012717_PID&32B8";
        let hello = "HID\\{00001812}_Dev_VID&012717_PID&32b8";
        assert!(setup_api.eq_ignore_ascii_case(hello));
    }

    #[test]
    fn uses_v2_pipe_names_and_wire_headers() {
        let path = quarbor_pipe_name("HID\\{00001812}_DEV_VID&012717_PID&32B8");
        assert!(path.contains("Quarbor.HidUserFilter.v2."));
        assert!(!path.contains(".v1."));

        let header = quarbor_frame_header(4, 9, 0x1122_3344_5566_7788, 7, 100, 1234);
        assert_eq!(
            u32::from_le_bytes(header[0..4].try_into().unwrap()),
            0x3246_4851
        );
        assert_eq!(u16::from_le_bytes(header[4..6].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(header[6..8].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(header[8..12].try_into().unwrap()), 64);
        assert_eq!(u32::from_le_bytes(header[12..16].try_into().unwrap()), 9);
        assert_eq!(
            u64::from_le_bytes(header[16..24].try_into().unwrap()),
            0x1122_3344_5566_7788
        );
        assert_eq!(u64::from_le_bytes(header[24..32].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 100);
        assert_eq!(u32::from_le_bytes(header[44..48].try_into().unwrap()), 1234);
    }

    #[test]
    fn decodes_report_id_before_rc003_usage() {
        let mut context = QuarborContext::default();
        quarbor_decode_report(&mut context, &[1, 0, 0, 0x28, 0, 0, 0, 0, 0]);
        let stroke = context.reports.pop_front().expect("usage report");
        assert_eq!(stroke.code, 0x1c);
        assert_eq!(stroke.state, 0);
        assert!(context.active_usages.contains(&0x28));
    }

    #[test]
    fn decodes_special_usages_into_regular_sources() {
        for (usage, scan_code) in [(0x00f1, 0x6a), (0x0080, 0x30), (0x0081, 0x2e)] {
            let mut context = QuarborContext::default();
            quarbor_decode_report(&mut context, &[1, 0, usage as u8, (usage >> 8) as u8]);
            let stroke = context.reports.pop_front().expect("special usage report");
            assert_eq!(stroke.code, scan_code);
            assert!(source_for(stroke).is_some());
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
    fn parses_bracket_and_shortcuts() {
        assert_eq!(parse_chord("]"), Some(vec![0xdd]));
        assert_eq!(parse_chord("】"), Some(vec![0xdd]));
        assert_eq!(parse_chord("Ctrl+C"), Some(vec![0x11, 0x43]));
        assert_eq!(parse_chord("MediaNext"), Some(vec![0xb0]));
        assert_eq!(parse_chord("MediaPrevious"), Some(vec![0xb1]));
        assert_eq!(parse_chord("MediaStop"), Some(vec![0xb2]));
        for (key, scan) in [(0xb0, 0x19), (0xb1, 0x10), (0xb2, 0x24)] {
            let stroke = output_stroke(key, false).unwrap();
            assert_eq!((stroke.code, stroke.state & KEY_E0), (scan, KEY_E0));
        }
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
    fn modifier_shortcuts_keep_both_sides() {
        let triggers: TriggerBehaviors = serde_json::from_value(serde_json::json!({
            "click": [{ "type": "shortcut", "keys": ["Win", "RWin"] }]
        }))
        .unwrap();
        assert_eq!(continuous_click_chord(&triggers), Some(vec![0x5b, 0x5c]));
    }

    #[test]
    fn modifier_shortcuts_preserve_independent_sides() {
        let triggers: TriggerBehaviors = serde_json::from_value(serde_json::json!({
            "click": [{ "type": "shortcut", "keys": ["RCtrl", "Shift", "RAlt", "Win"] }]
        }))
        .unwrap();
        let keys = continuous_click_chord(&triggers).unwrap();
        assert_eq!(keys, vec![0xa3, 0x10, 0xa5, 0x5b]);
        // Scan codes require the real Windows MapVirtualKeyW implementation.
        #[cfg(target_os = "windows")]
        {
            let strokes: Vec<_> = keys
                .into_iter()
                .map(|key| {
                    let stroke = output_stroke(key, false).unwrap();
                    (stroke.code, stroke.state & KEY_E0)
                })
                .collect();
            assert_eq!(
                strokes,
                vec![(0x1d, KEY_E0), (0x2a, 0), (0x38, KEY_E0), (0x5b, KEY_E0)]
            );
        }
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
