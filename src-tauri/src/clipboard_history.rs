//! In-memory session clipboard history monitor for the clipboard quick overlay.
use serde::Serialize;

pub(crate) const MAX_ENTRIES: usize = 30;
pub(crate) const MAX_ENTRY_BYTES: usize = 64 * 1024;
#[cfg(not(test))]
const POLL_INTERVAL_MS: u64 = 400;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub text: String,
    pub copied_at_ms: u64,
}

#[derive(Default)]
pub(crate) struct HistoryStore {
    items: Vec<ClipboardEntry>,
}

impl HistoryStore {
    pub(crate) fn push(&mut self, text: String, now_ms: u64) -> bool {
        if text.trim().is_empty() || text.len() > MAX_ENTRY_BYTES {
            return false;
        }
        self.items.retain(|entry| entry.text != text);
        self.items.insert(
            0,
            ClipboardEntry {
                text,
                copied_at_ms: now_ms,
            },
        );
        self.items.truncate(MAX_ENTRIES);
        true
    }

    pub(crate) fn entries(&self) -> Vec<ClipboardEntry> {
        self.items.clone()
    }

    pub(crate) fn clear(&mut self) {
        self.items.clear();
    }
}

#[cfg(not(test))]
mod runtime {
    use super::*;
    use std::sync::{LazyLock, Mutex, Once, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct MonitorState {
        store: HistoryStore,
        last_change: Option<i64>,
    }

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static STATE: LazyLock<Mutex<MonitorState>> =
        LazyLock::new(|| Mutex::new(MonitorState::default()));
    static MONITOR_THREAD: Once = Once::new();

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    #[cfg(target_os = "macos")]
    fn current_change_count() -> Option<i64> {
        unsafe extern "C" {
            fn axonkey_macos_clipboard_change_count() -> std::os::raw::c_long;
        }
        Some(unsafe { axonkey_macos_clipboard_change_count() as i64 })
    }

    #[cfg(target_os = "macos")]
    fn read_allowed_text() -> Option<(i64, Option<String>)> {
        unsafe extern "C" {
            fn axonkey_macos_clipboard_read_text_if_allowed(
                out_change_count: *mut std::os::raw::c_long,
                max_bytes: usize,
            ) -> *mut std::os::raw::c_char;
            fn axonkey_macos_clipboard_free_string(ptr: *mut std::os::raw::c_char);
        }
        let mut count: std::os::raw::c_long = 0;
        let ptr =
            unsafe { axonkey_macos_clipboard_read_text_if_allowed(&mut count, MAX_ENTRY_BYTES) };
        if ptr.is_null() {
            return Some((count as i64, None));
        }
        let text = unsafe { std::ffi::CStr::from_ptr(ptr) }
            .to_str()
            .ok()
            .map(str::to_owned);
        unsafe { axonkey_macos_clipboard_free_string(ptr) };
        Some((count as i64, text))
    }

    #[cfg(windows)]
    fn windows_clipboard_sequence() -> u32 {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetClipboardSequenceNumber() -> u32;
        }
        unsafe { GetClipboardSequenceNumber() }
    }

    #[cfg(windows)]
    fn current_change_count() -> Option<i64> {
        Some(windows_clipboard_sequence() as i64)
    }

    #[cfg(windows)]
    fn read_allowed_text() -> Option<(i64, Option<String>)> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        const CF_UNICODETEXT: u32 = 13;
        #[link(name = "user32")]
        unsafe extern "system" {
            fn RegisterClipboardFormatW(lpsz_format: *const u16) -> u32;
            fn IsClipboardFormatAvailable(format: u32) -> i32;
        }
        static EXCLUDE_FORMAT: OnceLock<u32> = OnceLock::new();
        let seq = windows_clipboard_sequence() as i64;
        let exclude = *EXCLUDE_FORMAT.get_or_init(|| {
            let name: Vec<u16> = "ExcludeClipboardContentFromMonitorProcessing\0"
                .encode_utf16()
                .collect();
            unsafe { RegisterClipboardFormatW(name.as_ptr()) }
        });
        if exclude != 0 && unsafe { IsClipboardFormatAvailable(exclude) } != 0 {
            return Some((seq, None));
        }
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
            return Some((seq, None));
        }
        let app = APP.get()?;
        match app.clipboard().read_text() {
            Ok(text) if text.len() <= MAX_ENTRY_BYTES => Some((seq, Some(text))),
            _ => Some((seq, None)),
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn current_change_count() -> Option<i64> {
        None
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn read_allowed_text() -> Option<(i64, Option<String>)> {
        None
    }

    pub fn initialize(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
        sync_now();
        MONITOR_THREAD.call_once(|| {
            if let Err(error) = std::thread::Builder::new()
                .name("axonkey-clipboard-monitor".into())
                .spawn(|| loop {
                    std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                    sync_now();
                })
            {
                log::warn!(
                    target: "axonkey::clipboard",
                    "Cannot start clipboard history monitor: {error}"
                );
            }
        });
    }

    pub fn sync_now() {
        let Some(count) = current_change_count() else {
            return;
        };
        let unchanged = STATE
            .lock()
            .ok()
            .is_some_and(|guard| guard.last_change == Some(count));
        if unchanged {
            return;
        }
        let Some((actual_count, maybe_text)) = read_allowed_text() else {
            return;
        };
        if let Ok(mut guard) = STATE.lock() {
            guard.last_change = Some(actual_count);
            if let Some(text) = maybe_text {
                guard.store.push(text, now_ms());
            }
        }
    }

    pub fn entries() -> Vec<ClipboardEntry> {
        STATE
            .lock()
            .map(|guard| guard.store.entries())
            .unwrap_or_default()
    }

    pub fn clear() {
        let current = current_change_count();
        if let Ok(mut guard) = STATE.lock() {
            guard.store.clear();
            if let Some(count) = current {
                guard.last_change = Some(count);
            }
        }
    }
}

#[cfg(test)]
mod runtime {
    use super::*;
    use std::cell::RefCell;

    thread_local! {
        static TEST_STORE: RefCell<HistoryStore> = RefCell::new(HistoryStore::default());
    }

    #[allow(dead_code)]
    pub fn initialize(_app: &tauri::AppHandle) {}

    pub fn sync_now() {}

    pub fn entries() -> Vec<ClipboardEntry> {
        TEST_STORE.with(|store| store.borrow().entries())
    }

    pub fn clear() {
        TEST_STORE.with(|store| store.borrow_mut().clear());
    }

    pub fn set_entries_for_test(items: Vec<String>) {
        TEST_STORE.with(|store| {
            let mut store = store.borrow_mut();
            store.clear();
            let count = items.len();
            for (idx, text) in items.into_iter().rev().enumerate() {
                store.push(text, (idx + 1) as u64 * 100);
            }
            let _ = count;
        });
    }
}

#[cfg(test)]
pub use runtime::set_entries_for_test;
pub use runtime::{clear, entries, initialize, sync_now};

#[tauri::command]
pub async fn get_clipboard_history(
    window: tauri::WebviewWindow,
) -> Result<Vec<ClipboardEntry>, String> {
    if window.label() != "main" && window.label() != "quick-overlay" {
        return Err("Invalid window".into());
    }
    sync_now();
    Ok(entries())
}

#[tauri::command]
pub async fn clear_clipboard_history(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" && window.label() != "quick-overlay" {
        return Err("Invalid window".into());
    }
    clear();
    let _ = crate::quick_overlay::close_if_clipboard_mode();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_store_deduplicates_mru_rejects_blank_or_oversized_and_caps_at_30() {
        let mut store = HistoryStore::default();
        assert!(!store.push(String::new(), 1));
        assert!(!store.push("   \n\t  ".into(), 2));
        assert!(!store.push("a".repeat(MAX_ENTRY_BYTES + 1), 3));
        assert!(store.entries().is_empty());

        assert!(store.push("first".into(), 10));
        assert!(store.push("second".into(), 20));
        assert!(store.push("first".into(), 30));
        let listed = store.entries();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].text, "first");
        assert_eq!(listed[0].copied_at_ms, 30);
        assert_eq!(listed[1].text, "second");

        for i in 0..35 {
            assert!(store.push(format!("item-{i}"), 100 + i as u64));
        }
        let capped = store.entries();
        assert_eq!(capped.len(), MAX_ENTRIES);
        assert_eq!(capped[0].text, "item-34");
        assert_eq!(capped[MAX_ENTRIES - 1].text, "item-5");

        store.clear();
        assert!(store.entries().is_empty());
    }

    #[test]
    fn test_runtime_entries_preserve_newest_first_order_and_clear() {
        set_entries_for_test(vec!["latest".into(), "older".into(), "oldest".into()]);
        let items: Vec<String> = entries().into_iter().map(|entry| entry.text).collect();
        assert_eq!(items, vec!["latest", "older", "oldest"]);
        clear();
        assert!(entries().is_empty());
    }
}
