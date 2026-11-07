#[cfg(not(test))]
use tauri_plugin_clipboard_manager::ClipboardExt;

static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub(crate) fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

pub(super) fn paste_with(text: &str, send_shortcut: impl FnOnce()) {
    match write_clipboard(text) {
        Ok(()) => send_shortcut(),
        Err(error) => log::warn!(target: "axonkey::input", "Mapped paste failed: {error}"),
    }
}

#[cfg(not(test))]
fn write_clipboard(text: &str) -> Result<(), String> {
    APP.get()
        .ok_or("Clipboard service is not ready")?
        .clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
thread_local! {
    pub(super) static CLIPBOARD: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

#[cfg(test)]
fn write_clipboard(text: &str) -> Result<(), String> {
    CLIPBOARD.with(|value| *value.borrow_mut() = text.into());
    Ok(())
}
