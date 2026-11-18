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
const HEIGHT: f64 = 620.0;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);
static ACTIVE_REVISION: AtomicU64 = AtomicU64::new(0);
static STATE: LazyLock<Mutex<SessionState>> = LazyLock::new(|| Mutex::new(SessionState::default()));

#[cfg(test)]
static TEST_ACTIVE_REVISIONS: LazyLock<Mutex<std::collections::HashSet<u64>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor_svg: Option<String>,
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
) -> u64 {
    let descriptor_svg = crate::devices::descriptor_registry::dynamic_svg_for_kind(&device_kind);
    let session = {
        let mut state = STATE.lock().unwrap();
        state.replace(QuickOverlaySession {
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
            descriptor_svg,
        })
    };
    let revision = session.revision;
    log::info!(
        target: "axonkey::quick_overlay",
        "Quick overlay opened: revision={} source={:?} kind={:?} profile={:?} trigger={:?} preview={}",
        revision,
        session.source_id,
        session.device_kind,
        session.profile_name,
        session.trigger_input,
        session.preview,
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
            present_window_on_cursor_monitor(&window);
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

fn present_window_on_cursor_monitor(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns_win) = window.ns_window() {
            unsafe extern "C" {
                fn axonkey_show_quick_overlay_window(
                    window_ptr: *mut std::ffi::c_void,
                    width: f64,
                    height: f64,
                ) -> u32;
            }
            let status = unsafe { axonkey_show_quick_overlay_window(ns_win, WIDTH, HEIGHT) };
            log::info!(
                target: "axonkey::quick_overlay",
                "macOS quick overlay shown: visible={} active_space={}",
                status & 1 != 0,
                status & 2 != 0
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
                    let w = ((WIDTH * scale).round() as i32).min(work_w - 32);
                    let h = ((HEIGHT * scale).round() as i32).min(work_h - 32);
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
                area.position.x + ((area.size.width as f64 - WIDTH * scale) / 2.0).round() as i32,
                area.position.y + ((area.size.height as f64 - HEIGHT * scale) / 2.0).round() as i32,
            ));
        }
        let _ = window.show();
    }
}

fn reveal_window_on_active_monitor(window: &tauri::WebviewWindow) -> Result<(), String> {
    let win = window.clone();
    window
        .app_handle()
        .run_on_main_thread(move || {
            present_window_on_cursor_monitor(&win);
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
    if !STATE
        .lock()
        .map_err(|e| e.to_string())?
        .is_current(revision)
    {
        return Ok(());
    }
    reveal_window_on_active_monitor(&window)
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
    ))
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
    if session.trigger_input == input_id {
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
    let app = window.app_handle().clone();
    let source_id = session.source_id;
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
    Ok(())
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
}
