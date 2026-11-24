//! Non-activating topmost overlay window for single-shot quick interaction profiles.
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

#[cfg(windows)]
#[path = "quick_overlay/windows.rs"]
mod windows_escape;

const LABEL: &str = "quick-overlay";
const EVENT: &str = "axonkey-quick-overlay";
const WIDTH: f64 = 880.0;
const HEIGHT: f64 = 660.0;
const CLIPBOARD_WIDTH: f64 = 420.0;
const CLIPBOARD_HEIGHT: f64 = 460.0;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);
static ACTIVE_REVISION: AtomicU64 = AtomicU64::new(0);
static STATE: LazyLock<Mutex<SessionState>> = LazyLock::new(|| Mutex::new(SessionState::default()));

#[cfg(test)]
static TEST_ACTIVE_REVISIONS: LazyLock<Mutex<std::collections::HashSet<u64>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardOverlayState {
    pub action: crate::input_service::ClipboardOverlayAction,
    pub entries: Vec<crate::clipboard_history::ClipboardEntry>,
    pub selected_index: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOverlaySession {
    pub revision: u64,
    pub source_id: String,
    pub device_kind: String,
    pub device_name: String,
    pub profile_id: String,
    pub profile_name: String,
    pub trigger_input: String,
    pub behaviors: serde_json::Value,
    pub pressed: Vec<String>,
    pub preview: bool,
    #[serde(default)]
    pub prompt_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard: Option<ClipboardOverlayState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor_svg: Option<String>,
}

fn window_dimensions(session: &QuickOverlaySession) -> (f64, f64) {
    if session.clipboard.is_some() {
        (CLIPBOARD_WIDTH, CLIPBOARD_HEIGHT)
    } else {
        (WIDTH, HEIGHT)
    }
}

#[derive(Default)]
struct SessionState {
    current: Option<QuickOverlaySession>,
}

impl SessionState {
    fn replace(&mut self, mut session: QuickOverlaySession) -> QuickOverlaySession {
        let revision = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
        session.revision = revision;
        self.current = Some(session.clone());
        ACTIVE_REVISION.store(revision, Ordering::Release);
        #[cfg(test)]
        TEST_ACTIVE_REVISIONS.lock().unwrap().insert(revision);
        session
    }

    fn clear_if_revision(&mut self, revision: u64) -> Option<QuickOverlaySession> {
        #[cfg(test)]
        let removed_test = TEST_ACTIVE_REVISIONS.lock().unwrap().remove(&revision);
        if self
            .current
            .as_ref()
            .is_some_and(|s| s.revision == revision)
        {
            let taken = self.current.take();
            let _ =
                ACTIVE_REVISION.compare_exchange(revision, 0, Ordering::AcqRel, Ordering::Acquire);
            return taken;
        }
        #[cfg(test)]
        if removed_test {
            return None;
        }
        None
    }

    fn is_current(&self, revision: u64) -> bool {
        self.current
            .as_ref()
            .is_some_and(|s| s.revision == revision)
    }
}

pub fn initialize(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(windows)]
    windows_escape::initialize_escape_listener();
    // Pre-create the hidden overlay webview so the first trigger opens with zero cold-start delay.
    if let Err(error) = ensure_overlay_window(app) {
        log::warn!(target: "axonkey::quick_overlay", "Cannot warm up quick overlay window: {error}");
    }
}

fn ensure_overlay_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("index.html?view=quick-overlay".into()),
    )
    .title("快捷交互窗 · Axonkey")
    .inner_size(WIDTH, HEIGHT)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .accept_first_mouse(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false);
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns_win) = win.ns_window() {
                unsafe extern "C" {
                    fn axonkey_configure_quick_overlay_window(
                        window_ptr: *mut std::ffi::c_void,
                        on_escape: extern "C" fn() -> bool,
                    );
                }
                unsafe { axonkey_configure_quick_overlay_window(ns_win, dismiss_on_escape) };
            }
        });
    }
    #[cfg(windows)]
    configure_windows_noactivate(&window);
    Ok(window)
}

#[cfg(windows)]
fn configure_windows_noactivate(window: &tauri::WebviewWindow) {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_EX_TOPMOST,
        },
    };
    if let Ok(raw) = window.hwnd() {
        let hwnd = HWND(raw.0);
        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let flags = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | flags);
        }
    }
}

pub(crate) fn is_revision_active(revision: u64) -> bool {
    if revision == 0 {
        return false;
    }
    #[cfg(test)]
    {
        return TEST_ACTIVE_REVISIONS.lock().unwrap().contains(&revision);
    }
    #[cfg(not(test))]
    {
        ACTIVE_REVISION.load(Ordering::Acquire) == revision
    }
}

pub(crate) fn open(
    source_id: String,
    device_kind: String,
    device_name: String,
    profile_id: String,
    profile_name: String,
    trigger_input: String,
    behaviors: serde_json::Value,
    preview: bool,
    prompt_mode: bool,
) -> u64 {
    let descriptor_svg = crate::devices::descriptor_registry::dynamic_svg_for_kind(&device_kind);
    open_session(QuickOverlaySession {
        revision: 0,
        source_id,
        device_kind,
        device_name,
        profile_id,
        profile_name,
        trigger_input,
        behaviors,
        pressed: Vec::new(),
        preview,
        prompt_mode,
        clipboard: None,
        descriptor_svg,
    })
}

pub(crate) fn open_session(mut input: QuickOverlaySession) -> u64 {
    input.revision = 0;
    let session = {
        let mut state = STATE.lock().unwrap();
        state.replace(input)
    };
    let revision = session.revision;
    let (width, height) = window_dimensions(&session);
    log::info!(
        target: "axonkey::quick_overlay",
        "Quick overlay opened: revision={} source={:?} kind={:?} profile={:?} trigger={:?} preview={} clipboard={}",
        revision,
        session.source_id,
        session.device_kind,
        session.profile_name,
        session.trigger_input,
        session.preview,
        session.clipboard.is_some(),
    );
    if let Some(app) = APP.get() {
        let handle = app.clone();
        let payload = session;
        let _ = app.run_on_main_thread(move || {
            let current = STATE.lock().ok().is_some_and(|s| s.is_current(revision));
            if !current {
                return;
            }
            let window = match ensure_overlay_window(&handle) {
                Ok(window) => window,
                Err(error) => {
                    log::warn!(target: "axonkey::quick_overlay", "Cannot create quick overlay window: {error}");
                    return;
                }
            };
            let _ = handle.emit_to(LABEL, EVENT, Some(payload));
            // Present immediately on the cursor's screen so macOS WebKit never throttles
            // a hidden/off-Space WebView before `reveal_quick_overlay` can fire.
            present_window_on_cursor_monitor(&window, width, height, true);
        });
    }
    revision
}

pub(crate) fn set_pressed(revision: u64, pressed: Vec<String>) {
    if !is_revision_active(revision) {
        return;
    }
    let updated = {
        let mut state = STATE.lock().unwrap();
        let Some(current) = state.current.as_mut().filter(|s| s.revision == revision) else {
            return;
        };
        if current.pressed == pressed {
            return;
        }
        current.pressed = pressed;
        current.clone()
    };
    if let Some(app) = APP.get() {
        let _ = app.emit_to(LABEL, EVENT, Some(updated));
    }
}

pub(crate) fn set_clipboard_selected(revision: u64, selected_index: usize) {
    if !is_revision_active(revision) {
        return;
    }
    let updated = {
        let mut state = STATE.lock().unwrap();
        let Some(current) = state.current.as_mut().filter(|s| s.revision == revision) else {
            return;
        };
        let Some(clipboard) = current.clipboard.as_mut() else {
            return;
        };
        if clipboard.selected_index == selected_index {
            return;
        }
        clipboard.selected_index = selected_index;
        current.clone()
    };
    if let Some(app) = APP.get() {
        let _ = app.emit_to(LABEL, EVENT, Some(updated));
    }
}

pub(crate) fn close_revision(revision: u64) -> Option<QuickOverlaySession> {
    if revision == 0 {
        return None;
    }
    let removed = STATE.lock().unwrap().clear_if_revision(revision);
    if removed.is_some() {
        log::info!(target: "axonkey::quick_overlay", "Quick overlay closed: revision={revision}");
        hide_window_if_idle();
    }
    removed
}

pub(crate) fn close_if_clipboard_mode() -> bool {
    let revision = STATE
        .lock()
        .unwrap()
        .current
        .as_ref()
        .filter(|s| s.clipboard.is_some())
        .map(|s| s.revision);
    revision.is_some_and(|rev| close_revision(rev).is_some())
}

extern "C" fn dismiss_on_escape() -> bool {
    close_revision(ACTIVE_REVISION.load(Ordering::Acquire)).is_some()
}

#[allow(dead_code)]
pub(crate) fn close_source(source_id: &str) {
    let revision = STATE
        .lock()
        .unwrap()
        .current
        .as_ref()
        .filter(|s| s.source_id == source_id)
        .map(|s| s.revision);
    if let Some(revision) = revision {
        let _ = close_revision(revision);
    }
}

fn hide_window_if_idle() {
    let Some(app) = APP.get() else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if STATE.lock().ok().is_some_and(|s| s.current.is_some()) {
            return;
        }
        let _ = handle.emit_to(LABEL, EVENT, Option::<QuickOverlaySession>::None);
        let Some(window) = handle.get_webview_window(LABEL) else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            if let Ok(ns_win) = window.ns_window() {
                unsafe extern "C" {
                    fn axonkey_hide_quick_overlay_window(window_ptr: *mut std::ffi::c_void);
                }
                unsafe { axonkey_hide_quick_overlay_window(ns_win) };
                return;
            }
        }
        #[cfg(windows)]
        {
            use windows::Win32::{
                Foundation::HWND,
                UI::WindowsAndMessaging::{ShowWindow, SW_HIDE},
            };
            if let Ok(raw) = window.hwnd() {
                unsafe {
                    let _ = ShowWindow(HWND(raw.0), SW_HIDE);
                }
                return;
            }
        }
        let _ = window.hide();
    });
}

fn present_window_on_cursor_monitor(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
    force_reorder: bool,
) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns_win) = window.ns_window() {
            unsafe extern "C" {
                fn axonkey_show_quick_overlay_window(
                    window_ptr: *mut std::ffi::c_void,
                    width: f64,
                    height: f64,
                    force_reorder: bool,
                ) -> u32;
            }
            let status =
                unsafe { axonkey_show_quick_overlay_window(ns_win, width, height, force_reorder) };
            log::info!(
                target: "axonkey::quick_overlay",
                "macOS quick overlay shown: visible={} active_space={} recovered={} accessory={}",
                status & 1 != 0,
                status & 2 != 0,
                status & 4 != 0,
                status & 8 != 0,
            );
        }
    }
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::{HWND, POINT},
            Graphics::Gdi::{
                GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
            },
            UI::{
                HiDpi::GetDpiForWindow,
                WindowsAndMessaging::{
                    GetCursorPos, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE,
                    SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
                },
            },
        };
        configure_windows_noactivate(window);
        if let Ok(raw) = window.hwnd() {
            let hwnd = HWND(raw.0);
            unsafe {
                let mut cursor = POINT::default();
                let _ = GetCursorPos(&mut cursor);
                let hmonitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(hmonitor, &mut info).as_bool() {
                    let _ = SetWindowPos(
                        hwnd,
                        None,
                        info.rcWork.left,
                        info.rcWork.top,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOSIZE,
                    );
                    let dpi = GetDpiForWindow(hwnd);
                    let scale = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };
                    let work_w = (info.rcWork.right - info.rcWork.left).max(360);
                    let work_h = (info.rcWork.bottom - info.rcWork.top).max(280);
                    let w = ((width * scale).round() as i32).min(work_w - 32);
                    let h = ((height * scale).round() as i32).min(work_h - 32);
                    let x = info.rcWork.left + (work_w - w) / 2;
                    let y = info.rcWork.top + (work_h - h) / 2 - 12;
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        x,
                        y,
                        w,
                        h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        let app = window.app_handle();
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        if let Some(monitor) = monitor {
            let area = monitor.work_area();
            let scale = monitor.scale_factor();
            let _ = window.set_position(tauri::PhysicalPosition::new(
                area.position.x + ((area.size.width as f64 - width * scale) / 2.0).round() as i32,
                area.position.y + ((area.size.height as f64 - height * scale) / 2.0).round() as i32,
            ));
        }
        let _ = window.show();
    }
}

fn reveal_window_on_active_monitor(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let win = window.clone();
    window
        .app_handle()
        .run_on_main_thread(move || {
            present_window_on_cursor_monitor(&win, width, height, false);
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_quick_overlay(
    window: tauri::WebviewWindow,
) -> Result<Option<QuickOverlaySession>, String> {
    if window.label() != LABEL {
        return Err("Invalid quick overlay window".into());
    }
    Ok(STATE.lock().map_err(|e| e.to_string())?.current.clone())
}

#[tauri::command]
pub async fn reveal_quick_overlay(
    window: tauri::WebviewWindow,
    revision: u64,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Invalid quick overlay window".into());
    }
    let Some((width, height)) = STATE
        .lock()
        .map_err(|e| e.to_string())?
        .current
        .as_ref()
        .filter(|s| s.revision == revision)
        .map(window_dimensions)
    else {
        return Ok(());
    };
    reveal_window_on_active_monitor(&window, width, height)
}

#[tauri::command]
pub async fn dismiss_quick_overlay(
    window: tauri::WebviewWindow,
    revision: u64,
) -> Result<(), String> {
    if window.label() != LABEL && window.label() != "main" {
        return Err("Invalid window".into());
    }
    let _ = close_revision(revision);
    Ok(())
}

#[tauri::command]
pub async fn preview_quick_overlay(
    window: tauri::WebviewWindow,
    source_id: String,
    device_kind: String,
    device_name: String,
    profile_id: String,
    profile_name: String,
    trigger_input: String,
    behaviors: serde_json::Value,
    prompt_mode: Option<bool>,
) -> Result<u64, String> {
    if window.label() != "main" {
        return Err("Preview must be opened from the main window".into());
    }
    Ok(open(
        source_id,
        device_kind,
        device_name,
        profile_id,
        profile_name,
        trigger_input,
        behaviors,
        true,
        prompt_mode.unwrap_or(false),
    ))
}

#[tauri::command]
pub async fn preview_clipboard_overlay(
    window: tauri::WebviewWindow,
    source_id: String,
    device_kind: String,
    device_name: String,
    trigger_input: String,
    action: Option<crate::input_service::ClipboardOverlayAction>,
) -> Result<u64, String> {
    if window.label() != "main" {
        return Err("Preview must be opened from the main window".into());
    }
    crate::clipboard_history::sync_now();
    let entries = crate::clipboard_history::entries();
    Ok(open_session(QuickOverlaySession {
        revision: 0,
        source_id,
        device_kind,
        device_name,
        profile_id: "__clipboard__".into(),
        profile_name: "剪贴板".into(),
        trigger_input,
        behaviors: serde_json::json!({}),
        pressed: Vec::new(),
        preview: true,
        prompt_mode: false,
        clipboard: Some(ClipboardOverlayState {
            action: action.unwrap_or_default(),
            entries,
            selected_index: 0,
        }),
        descriptor_svg: None,
    }))
}

#[tauri::command]
pub async fn select_clipboard_overlay_item(
    window: tauri::WebviewWindow,
    revision: u64,
    index: usize,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Invalid quick overlay window".into());
    }
    let Some(session) = close_revision(revision) else {
        return Ok(());
    };
    let Some(clipboard) = session.clipboard else {
        return Ok(());
    };
    let Some(entry) = clipboard.entries.get(index) else {
        return Ok(());
    };
    let behavior = match clipboard.action {
        crate::input_service::ClipboardOverlayAction::Paste => {
            crate::input_service::NativeBehavior::Paste {
                enabled: true,
                text: entry.text.clone(),
            }
        }
        crate::input_service::ClipboardOverlayAction::CopyText => {
            crate::input_service::NativeBehavior::CopyText {
                enabled: true,
                text: entry.text.clone(),
                title: None,
            }
        }
    };
    spawn_quick_sequence(
        window.app_handle().clone(),
        session.source_id,
        vec![behavior],
    );
    Ok(())
}

#[tauri::command]
pub async fn trigger_quick_overlay_input(
    window: tauri::WebviewWindow,
    revision: u64,
    input_id: String,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Invalid quick overlay window".into());
    }
    let Some(session) = close_revision(revision) else {
        return Ok(());
    };
    if session.clipboard.is_some() || session.trigger_input == input_id {
        return Ok(());
    }
    let settings: crate::input_service::NativeSettings =
        serde_json::from_value(serde_json::json!({ "behaviors": session.behaviors }))
            .map_err(|e| format!("快捷配置行为解析失败：{e}"))?;
    let canonical =
        crate::devices::descriptor_registry::profile_key(&session.device_kind, &input_id)
            .or_else(|| {
                crate::devices::descriptor_registry::registered_kinds()
                    .iter()
                    .find_map(|kind| {
                        crate::devices::descriptor_registry::profile_key(kind, &input_id)
                    })
            })
            .unwrap_or(&input_id)
            .to_owned();
    let Some(triggers) = settings.behaviors.get(&canonical) else {
        return Ok(());
    };
    let sequence = if triggers.click.iter().any(|b| b.enabled()) {
        triggers.click.clone()
    } else if triggers.double_click.iter().any(|b| b.enabled()) {
        triggers.double_click.clone()
    } else {
        triggers.long_press.clone()
    };
    if sequence.is_empty() {
        return Ok(());
    }
    spawn_quick_sequence(window.app_handle().clone(), session.source_id, sequence);
    Ok(())
}

fn spawn_quick_sequence(
    app: tauri::AppHandle,
    source_id: String,
    sequence: Vec<crate::input_service::NativeBehavior>,
) {
    std::thread::spawn(move || {
        // Brief pause after panel dismissal ensures the foreground window receives injected input cleanly.
        std::thread::sleep(Duration::from_millis(20));
        for behavior in sequence {
            if !behavior.enabled() {
                continue;
            }
            match behavior {
                crate::input_service::NativeBehavior::Delay { ms, .. } => {
                    std::thread::sleep(Duration::from_millis(ms.min(300_000)));
                }
                crate::input_service::NativeBehavior::SwitchProfile {
                    direction, wrap, ..
                } => {
                    if let Some(manager) = app.try_state::<crate::DeviceManager>() {
                        manager.switch_instance_profile(&source_id, direction, wrap);
                    }
                    break;
                }
                crate::input_service::NativeBehavior::QuickOverlay { .. }
                | crate::input_service::NativeBehavior::ClipboardOverlay { .. }
                | crate::input_service::NativeBehavior::Disabled { .. } => {}
                _ => {
                    #[cfg(target_os = "macos")]
                    if crate::input_service::InputService::accessibility_granted() {
                        crate::input_service::execute_quick_overlay_behavior(&behavior);
                    }
                    #[cfg(windows)]
                    crate::input_service::execute_quick_overlay_behavior(&behavior);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_quick_overlay_session_supersedes_older_revision_and_closes_only_matching() {
        let mut state = SessionState::default();
        let first = state.replace(QuickOverlaySession {
            revision: 0,
            source_id: "dev-1".into(),
            device_kind: "rc003".into(),
            device_name: "客厅遥控器".into(),
            profile_id: "p1".into(),
            profile_name: "AI 提示词".into(),
            trigger_input: "menu".into(),
            behaviors: serde_json::json!({}),
            pressed: vec![],
            preview: false,
            prompt_mode: false,
            clipboard: None,
            descriptor_svg: None,
        });
        let second = state.replace(QuickOverlaySession {
            revision: 0,
            source_id: "dev-1".into(),
            device_kind: "rc003".into(),
            device_name: "客厅遥控器".into(),
            profile_id: "p2".into(),
            profile_name: "剪辑快捷".into(),
            trigger_input: "tv".into(),
            behaviors: serde_json::json!({}),
            pressed: vec![],
            preview: false,
            prompt_mode: true,
            clipboard: None,
            descriptor_svg: None,
        });
        assert!(second.revision > first.revision);
        assert!(!state.is_current(first.revision));
        assert!(state.is_current(second.revision));
        assert_eq!(ACTIVE_REVISION.load(Ordering::Acquire), second.revision);
        assert!(state.clear_if_revision(first.revision).is_none());
        assert!(state.is_current(second.revision));
        assert!(state.clear_if_revision(second.revision).is_some());
        assert!(!state.is_current(second.revision));
    }

    #[test]
    fn close_if_clipboard_mode_only_closes_clipboard_sessions() {
        static GLOBAL_LOCK: Mutex<()> = Mutex::new(());
        let _guard = GLOBAL_LOCK.lock().unwrap();

        let regular_rev = open(
            "dev-1".into(),
            "rc003".into(),
            "客厅遥控器".into(),
            "p1".into(),
            "常用".into(),
            "menu".into(),
            serde_json::json!({}),
            false,
            false,
        );
        assert!(!close_if_clipboard_mode());
        assert!(is_revision_active(regular_rev));
        assert!(close_revision(regular_rev).is_some());

        let clipboard_rev = open_session(QuickOverlaySession {
            revision: 0,
            source_id: "dev-1".into(),
            device_kind: "rc003".into(),
            device_name: "客厅遥控器".into(),
            profile_id: "__clipboard__".into(),
            profile_name: "剪贴板".into(),
            trigger_input: "menu".into(),
            behaviors: serde_json::json!({}),
            pressed: vec![],
            preview: false,
            prompt_mode: false,
            clipboard: Some(ClipboardOverlayState {
                action: crate::input_service::ClipboardOverlayAction::Paste,
                entries: vec![
                    crate::clipboard_history::ClipboardEntry {
                        text: "one".into(),
                        copied_at_ms: 1,
                    },
                    crate::clipboard_history::ClipboardEntry {
                        text: "two".into(),
                        copied_at_ms: 2,
                    },
                ],
                selected_index: 0,
            }),
            descriptor_svg: None,
        });
        assert!(is_revision_active(clipboard_rev));
        set_clipboard_selected(clipboard_rev, 1);
        assert_eq!(
            STATE
                .lock()
                .unwrap()
                .current
                .as_ref()
                .and_then(|s| s.clipboard.as_ref())
                .map(|c| c.selected_index),
            Some(1)
        );
        assert!(close_if_clipboard_mode());
        assert!(!is_revision_active(clipboard_rev));
    }
}
