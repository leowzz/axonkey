use serde::Serialize;
use std::sync::Mutex;
#[cfg(not(any(target_os = "macos", windows)))]
use tauri::Emitter;
use tauri::Manager;

#[cfg(windows)]
mod windows;

const LABEL: &str = "profile-switch-overlay";
#[cfg(not(any(target_os = "macos", windows)))]
const EVENT: &str = "axonkey-profile-switch-overlay";
const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 100.0;

#[cfg(not(any(target_os = "macos", windows)))]
fn create_overlay_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("index.html?view=profile-switch-overlay".into()),
    )
    .title("配置切换 · Axonkey")
    .inner_size(WIDTH, HEIGHT)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false);
    #[cfg(target_os = "windows")]
    let builder = builder.effects(
        tauri::window::EffectsBuilder::new()
            .effect(tauri::window::Effect::Acrylic)
            .color(tauri::window::Color(28, 32, 39, 105))
            .build(),
    );
    let window = builder.build().map_err(|e| e.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    create_overlay_window(app)
}

#[derive(Clone, Serialize)]
pub struct Notification {
    revision: u64,
    device: String,
    from: String,
    to: String,
}

#[derive(Default)]
struct NotificationState {
    revision: u64,
    current: Option<Notification>,
}

impl NotificationState {
    fn replace(&mut self, device: String, from: String, to: String) -> Notification {
        self.revision += 1;
        let notification = Notification {
            revision: self.revision,
            device,
            from,
            to,
        };
        self.current = Some(notification.clone());
        notification
    }

    fn is_current(&self, revision: u64) -> bool {
        self.current
            .as_ref()
            .is_some_and(|item| item.revision == revision)
    }
}

#[derive(Default)]
pub struct OverlayState(Mutex<NotificationState>);

// Keep WebView creation off synchronous IPC handlers.
#[tauri::command]
pub async fn show_profile_switch_overlay(
    app: tauri::AppHandle,
    device: String,
    from: String,
    to: String,
) -> Result<(), String> {
    show(&app, device, from, to)
}

pub(crate) fn show(
    app: &tauri::AppHandle,
    device: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let state = app.state::<OverlayState>();
    let notification = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .replace(device, from, to);
    log::info!(
        target: "axonkey::profile_overlay",
        "Profile notification requested: revision={} device={:?} from={:?} to={:?}",
        notification.revision,
        notification.device,
        notification.from,
        notification.to,
    );
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let state = handle.state::<OverlayState>();
            let Ok(state) = state.0.lock() else { return };
            if !state.is_current(notification.revision) { return; }
            // Imported names may contain NUL; keep them displayable in AppKit.
            let device = std::ffi::CString::new(notification.device.replace('\0', "�")).unwrap();
            let from = std::ffi::CString::new(notification.from.replace('\0', "�")).unwrap();
            let to = std::ffi::CString::new(notification.to.replace('\0', "�")).unwrap();
            unsafe extern "C" {
                fn axonkey_show_profile_switch_overlay(device: *const std::ffi::c_char, from: *const std::ffi::c_char, to: *const std::ffi::c_char) -> u32;
            }
            let status = unsafe { axonkey_show_profile_switch_overlay(device.as_ptr(), from.as_ptr(), to.as_ptr()) };
            log::info!(target: "axonkey::profile_overlay", "Native profile notification: revision={} visible={} active_space={}", notification.revision, status & 1 != 0, status & 2 != 0);
        }).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        let revision = notification.revision;
        let device = notification.device;
        let from = notification.from;
        let to = notification.to;
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let state = handle.state::<OverlayState>();
            let Ok(state) = state.0.lock() else { return };
            if !state.is_current(revision) { return; }
            if let Err(error) = windows::show_profile_switch_overlay(&device, &from, &to, revision) {
                log::warn!(target: "axonkey::profile_overlay", "Cannot show native profile notification: {error}");
            } else {
                log::info!(target: "axonkey::profile_overlay", "Native Windows profile notification shown: revision={revision}");
            }
        }).map_err(|e| e.to_string())?;
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let state_handle = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let state = state_handle.state::<OverlayState>();
                let Ok(mut state) = state.0.lock() else {
                    return;
                };
                if state.is_current(revision) {
                    windows::hide_profile_switch_overlay(revision);
                    state.current = None;
                }
            });
        });
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        // Serialize first creation on platforms that render this in a WebView.
        let state = state.0.lock().map_err(|e| e.to_string())?;
        if !state.is_current(notification.revision) {
            return Ok(());
        }
        create_overlay_window(&app)?;
        // The first webview load recovers this payload through the snapshot command.
        app.emit_to(LABEL, EVENT, notification)
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_profile_switch_overlay(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OverlayState>,
) -> Result<Option<Notification>, String> {
    if window.label() != LABEL {
        return Err("Invalid overlay window".into());
    }
    Ok(state.0.lock().map_err(|e| e.to_string())?.current.clone())
}

#[tauri::command]
pub async fn reveal_profile_switch_overlay(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OverlayState>,
    revision: u64,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Invalid overlay window".into());
    }
    let state = state.0.lock().map_err(|e| e.to_string())?;
    if !state.is_current(revision) {
        return Ok(());
    }
    let app = window.app_handle();
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        window
            .set_position(tauri::PhysicalPosition::new(
                area.position.x + ((area.size.width as f64 - WIDTH * scale) / 2.0).round() as i32,
                area.position.y
                    + (area.size.height as f64 * 0.75 - HEIGHT * scale / 2.0).round() as i32,
            ))
            .map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hide_profile_switch_overlay(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OverlayState>,
    revision: u64,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Invalid overlay window".into());
    }
    let mut state = state.0.lock().map_err(|e| e.to_string())?;
    if state.is_current(revision) {
        window.hide().map_err(|e| e.to_string())?;
        state.current = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::NotificationState;

    #[test]
    fn older_notifications_cannot_reveal_or_hide_a_new_switch() {
        let mut state = NotificationState::default();
        let first = state.replace("客厅遥控器".into(), "工作".into(), "游戏".into());
        let second = state.replace("客厅遥控器".into(), "游戏".into(), "阅读".into());
        assert!(!state.is_current(first.revision));
        assert!(state.is_current(second.revision));
        assert_eq!(state.current.as_ref().unwrap().device, "客厅遥控器");
        assert_eq!(state.current.as_ref().unwrap().from, "游戏");
        assert_eq!(state.current.as_ref().unwrap().to, "阅读");
        state.current = None;
        assert!(!state.is_current(second.revision));
        let third = state.replace("客厅遥控器".into(), "阅读".into(), "工作".into());
        assert!(third.revision > second.revision);
    }
}
