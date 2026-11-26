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

pub(super) fn copy_text(text: &str) {
    match write_clipboard(text) {
        Ok(()) => {
            log::info!(target: "axonkey::input", "Mapped action: type=copyText, chars={}", text.chars().count())
        }
        Err(error) => log::warn!(target: "axonkey::input", "Mapped copyText failed: {error}"),
    }
}

#[cfg(all(not(test), target_os = "macos"))]
struct AutoreleasePool(*mut std::ffi::c_void);

#[cfg(all(not(test), target_os = "macos"))]
impl AutoreleasePool {
    fn push() -> Self {
        #[link(name = "objc")]
        extern "C" {
            fn objc_autoreleasePoolPush() -> *mut std::ffi::c_void;
        }
        Self(unsafe { objc_autoreleasePoolPush() })
    }
}

#[cfg(all(not(test), target_os = "macos"))]
impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        #[link(name = "objc")]
        extern "C" {
            fn objc_autoreleasePoolPop(pool: *mut std::ffi::c_void);
        }
        unsafe { objc_autoreleasePoolPop(self.0) };
    }
}

#[cfg(not(test))]
fn write_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _pool = AutoreleasePool::push();
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
