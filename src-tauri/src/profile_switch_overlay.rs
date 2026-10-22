use serde::Serialize;
use std::sync::Mutex;
#[cfg(not(target_os = "macos"))]
use tauri::Emitter;
use tauri::Manager;

const LABEL: &str = "profile-switch-overlay";
#[cfg(not(target_os = "macos"))]
const EVENT: &str = "axonkey-profile-switch-overlay";
const WIDTH: f64 = 420.0;
const HEIGHT: f64 = 100.0;

#[derive(Clone, Serialize)]
pub struct Notification {
    revision: u64,
    from: String,
    to: String,
}

#[derive(Default)]
struct NotificationState {
    revision: u64,
    current: Option<Notification>,
}

impl NotificationState {
    fn replace(&mut self, from: String, to: String) -> Notification {
        self.revision += 1;
        let notification = Notification {
            revision: self.revision,
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

// This command is async because creating a webview from a synchronous command
// can deadlock the Windows event loop. The lock also serializes first creation.
#[tauri::command]
pub async fn show_profile_switch_overlay(
    app: tauri::AppHandle,
    state: tauri::State<'_, OverlayState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let notification = state.0.lock().map_err(|e| e.to_string())?.replace(from, to);
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let state = handle.state::<OverlayState>();
            let Ok(state) = state.0.lock() else { return };
            if !state.is_current(notification.revision) { return; }
            // Imported names may contain NUL; keep them displayable in AppKit.
            let from = std::ffi::CString::new(notification.from.replace('\0', "�")).unwrap();
            let to = std::ffi::CString::new(notification.to.replace('\0', "�")).unwrap();
            unsafe extern "C" {
                fn axonkey_show_profile_switch_overlay(from: *const std::ffi::c_char, to: *const std::ffi::c_char) -> u32;
            }
            let status = unsafe { axonkey_show_profile_switch_overlay(from.as_ptr(), to.as_ptr()) };
            log::info!(target: "axonkey::profile_overlay", "Native profile notification: revision={} visible={} active_space={}", notification.revision, status & 1 != 0, status & 2 != 0);
        }).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Serialize first creation on platforms that render this in a WebView.
        let state = state.0.lock().map_err(|e| e.to_string())?;
        if !state.is_current(notification.revision) {
            return Ok(());
        }
        if app.get_webview_window(LABEL).is_none() {
            let builder = tauri::WebviewWindowBuilder::new(
                &app,
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
                .map_err(|e| e.to_string())?;
        }
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
        let first = state.replace("工作".into(), "游戏".into());
        let second = state.replace("游戏".into(), "阅读".into());
        assert!(!state.is_current(first.revision));
        assert!(state.is_current(second.revision));
        assert_eq!(state.current.as_ref().unwrap().from, "游戏");
        assert_eq!(state.current.as_ref().unwrap().to, "阅读");
        state.current = None;
        assert!(!state.is_current(second.revision));
        let third = state.replace("阅读".into(), "工作".into());
        assert!(third.revision > second.revision);
    }
}
