use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RECENT_LIMIT: usize = 20;
const ICON_CACHE_LIMIT: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationIconQuery {
    pub id: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentApplication {
    pub application: Application,
    pub last_used_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub supported: bool,
    pub current: Option<Application>,
    pub recent: Vec<RecentApplication>,
    pub error: Option<String>,
    #[serde(skip)]
    pub generation: u64,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            supported: cfg!(any(target_os = "macos", windows)),
            current: None,
            recent: vec![],
            error: None,
            generation: 0,
        }
    }
}

static STATE: OnceLock<Mutex<Snapshot>> = OnceLock::new();
fn state() -> &'static Mutex<Snapshot> {
    STATE.get_or_init(|| Mutex::new(Snapshot::default()))
}

pub fn context() -> (u64, Option<String>) {
    let state = state().lock().unwrap();
    (
        state.generation,
        state.current.as_ref().map(|app| app.id.clone()),
    )
}

pub(crate) fn frontmost_application_id() -> Option<String> {
    frontmost_application().ok().flatten().map(|app| app.id)
}

#[tauri::command]
pub fn foreground_applications() -> Snapshot {
    state().lock().unwrap().clone()
}

#[tauri::command]
pub fn resolve_application_path(path: String) -> Result<Application, String> {
    application_from_path(Path::new(path.trim()))
}

#[tauri::command]
pub async fn application_icons(applications: Vec<ApplicationIconQuery>) -> HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_application_icons(&applications))
        .await
        .unwrap_or_default()
}

pub struct Monitor {
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Monitor {
    pub fn start(path: PathBuf) -> Result<Self, String> {
        let recent = if path.exists() {
            std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Vec<RecentApplication>>(&bytes).ok())
                .unwrap_or_default()
        } else {
            vec![]
        };
        state().lock().unwrap().recent = recent.into_iter().take(RECENT_LIMIT).collect();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("Axonkey foreground apps".into())
            .spawn(move || {
                while !stopped.load(Ordering::Acquire) {
                    let result = frontmost_application();
                    let recent = {
                        let mut state = state().lock().unwrap();
                        match result {
                            Ok(current) => {
                                state.error = None;
                                let changed = state.current.as_ref().map(|a| &a.id)
                                    != current.as_ref().map(|a| &a.id);
                                let recent = if changed {
                                    state.generation += 1;
                                    if let Some(app) = &current {
                                        remember(&mut state.recent, app.clone(), now());
                                        Some(state.recent.clone())
                                    } else {
                                        None
                                    }
                                } else {
                                    None
                                };
                                state.current = current;
                                recent
                            }
                            Err(error) => {
                                if state.error.as_ref() != Some(&error) {
                                    log::warn!(target: "axonkey::foreground", "Foreground application detection failed: {error}");
                                }
                                if state.current.take().is_some() {
                                    state.generation += 1;
                                }
                                state.error = Some(error);
                                None
                            }
                        }
                    };
                    if let Some(recent) = recent {
                        if let Err(error) = save_recent(&path, &recent) {
                            state().lock().unwrap().error =
                                Some(format!("最近使用的应用未能保存：{error}"));
                        }
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn remember(recent: &mut Vec<RecentApplication>, application: Application, last_used_at: u64) {
    recent.retain(|entry| entry.application.id != application.id);
    recent.insert(
        0,
        RecentApplication {
            application,
            last_used_at,
        },
    );
    recent.truncate(RECENT_LIMIT);
}

fn save_recent(path: &Path, recent: &[RecentApplication]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(recent).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn mac_application(path: Option<&Path>) -> Result<Option<Application>, String> {
    use std::ffi::{CStr, CString};
    unsafe extern "C" {
        fn axonkey_foreground_application(
            path: *const std::ffi::c_char,
            output: *mut std::ffi::c_char,
            capacity: usize,
        ) -> i32;
    }
    let path = path
        .map(|p| CString::new(p.to_string_lossy().as_bytes()))
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut output = vec![0i8; 32768];
    let result = unsafe {
        axonkey_foreground_application(
            path.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            output.as_mut_ptr(),
            output.len(),
        )
    };
    match result {
        0 => Ok(None),
        1 => serde_json::from_slice(unsafe { CStr::from_ptr(output.as_ptr()) }.to_bytes())
            .map(Some)
            .map_err(|e| e.to_string()),
        _ if path.is_some() => Err("无法读取所选应用，请选择有效的 .app 应用。".into()),
        _ => Err("暂时无法识别前台应用，自动切换将使用设备全局配置。".into()),
    }
}

#[cfg(target_os = "macos")]
fn frontmost_application() -> Result<Option<Application>, String> {
    mac_application(None)
}

#[cfg(target_os = "macos")]
fn application_from_path(path: &Path) -> Result<Application, String> {
    mac_application(Some(path))?.ok_or_else(|| "请选择有效的 .app 应用。".into())
}

#[cfg(windows)]
fn frontmost_application() -> Result<Option<Application>, String> {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };
    unsafe {
        let window = GetForegroundWindow();
        if window.0.is_null() {
            return Ok(None);
        }
        let mut pid = 0;
        if GetWindowThreadProcessId(window, Some(&mut pid)) == 0 {
            return Ok(None);
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| format!("无法识别前台应用：{e}"))?;
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        result.map_err(|e| format!("无法读取前台应用路径：{e}"))?;
        application_from_path(Path::new(&String::from_utf16_lossy(
            &buffer[..length as usize],
        )))
        .map(Some)
    }
}

#[cfg(windows)]
fn application_from_path(path: &Path) -> Result<Application, String> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if !path.is_absolute()
        || !path.is_file()
        || !["exe", "com"]
            .iter()
            .any(|e| extension.eq_ignore_ascii_case(e))
    {
        return Err("请选择应用的 .exe 或 .com 文件。".into());
    }
    let path = path.to_string_lossy().into_owned();
    let name = Path::new(&path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    Ok(Application {
        id: format!("windows:{}", path.replace('/', "\\").to_lowercase()),
        name,
        path,
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn frontmost_application() -> Result<Option<Application>, String> {
    Ok(None)
}
#[cfg(not(any(target_os = "macos", windows)))]
fn application_from_path(_path: &Path) -> Result<Application, String> {
    Err("当前系统不支持应用识别。".into())
}

static ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

fn icon_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolve_application_icons(applications: &[ApplicationIconQuery]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for query in applications {
        let id = query.id.trim();
        if id.is_empty() || result.contains_key(id) {
            continue;
        }
        let path = query.path.trim();
        let cache_key = format!("{id}\0{path}");
        if let Some(cached) = icon_cache().lock().unwrap().get(&cache_key).cloned() {
            if let Some(icon) = cached {
                result.insert(id.to_owned(), icon);
            }
            continue;
        }
        let icon = platform_application_icon(id, path);
        {
            let mut cache = icon_cache().lock().unwrap();
            if cache.len() >= ICON_CACHE_LIMIT {
                cache.clear();
            }
            cache.insert(cache_key, icon.clone());
        }
        if let Some(icon) = icon {
            result.insert(id.to_owned(), icon);
        }
    }
    result
}

#[cfg(target_os = "macos")]
fn platform_application_icon(id: &str, path: &str) -> Option<String> {
    use std::ffi::{CStr, CString};
    unsafe extern "C" {
        fn axonkey_application_icon(
            app_id: *const std::ffi::c_char,
            path: *const std::ffi::c_char,
            output: *mut std::ffi::c_char,
            capacity: usize,
        ) -> i32;
    }
    let id_cstr = CString::new(id).ok()?;
    let path_cstr = (!path.is_empty())
        .then(|| CString::new(path).ok())
        .flatten();
    let mut output = vec![0i8; 65536];
    let status = unsafe {
        axonkey_application_icon(
            id_cstr.as_ptr(),
            path_cstr.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            output.as_mut_ptr(),
            output.len(),
        )
    };
    if status != 1 {
        return None;
    }
    unsafe { CStr::from_ptr(output.as_ptr()) }
        .to_str()
        .ok()
        .filter(|value| value.starts_with("data:image/png;base64,"))
        .map(str::to_owned)
}

#[cfg(windows)]
fn platform_application_icon(id: &str, path: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::{
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, SelectObject,
            BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
    };

    #[repr(C)]
    struct ShFileInfoW {
        h_icon: HICON,
        i_icon: i32,
        dw_attributes: u32,
        sz_display_name: [u16; 260],
        sz_type_name: [u16; 80],
    }
    const SHGFI_ICON: u32 = 0x0000_0100;
    const SHGFI_LARGEICON: u32 = 0x0000_0000;
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetFileInfoW(
            psz_path: *const u16,
            dw_file_attributes: u32,
            psfi: *mut ShFileInfoW,
            cb_file_info: u32,
            u_flags: u32,
        ) -> usize;
    }

    let candidate = if !path.is_empty() {
        path
    } else {
        id.strip_prefix("windows:")?.trim()
    };
    let file_path = Path::new(candidate);
    if !file_path.is_file() {
        return None;
    }
    let wide: Vec<u16> = file_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let mut file_info: ShFileInfoW = std::mem::zeroed();
        let resolved = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut file_info,
            std::mem::size_of::<ShFileInfoW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if resolved == 0 || file_info.h_icon.0.is_null() {
            if com_initialized {
                CoUninitialize();
            }
            return None;
        }
        let hicon = file_info.h_icon;
        let render_on_bg = |bg: u8| -> Option<Vec<u8>> {
            let dc = CreateCompatibleDC(None);
            if dc.0.is_null() {
                return None;
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: 32,
                    biHeight: -32,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            {
                Ok(bitmap) if !bits.is_null() => bitmap,
                _ => {
                    let _ = DeleteDC(dc);
                    return None;
                }
            };
            let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), 32 * 32 * 4);
            pixels.fill(bg);
            let previous = SelectObject(dc, bitmap.into());
            let ok = DrawIconEx(dc, 0, 0, hicon, 32, 32, 0, None, DI_NORMAL).is_ok();
            let _ = GdiFlush();
            let captured = ok.then(|| pixels.to_vec());
            let _ = SelectObject(dc, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(dc);
            captured
        };
        let black = render_on_bg(0);
        let white = render_on_bg(255);
        let _ = DestroyIcon(hicon);
        if com_initialized {
            CoUninitialize();
        }
        let (black, white) = (black?, white?);
        let mut rgba = vec![0u8; 32 * 32 * 4];
        for ((b_px, w_px), out) in black
            .chunks_exact(4)
            .zip(white.chunks_exact(4))
            .zip(rgba.chunks_exact_mut(4))
        {
            let diff_b = w_px[0].saturating_sub(b_px[0]);
            let diff_g = w_px[1].saturating_sub(b_px[1]);
            let diff_r = w_px[2].saturating_sub(b_px[2]);
            let alpha =
                255u8.saturating_sub(((diff_r as u16 + diff_g as u16 + diff_b as u16) / 3) as u8);
            if alpha > 0 {
                let a = alpha as u32;
                out[0] = ((b_px[2] as u32 * 255 + a / 2) / a).min(255) as u8;
                out[1] = ((b_px[1] as u32 * 255 + a / 2) / a).min(255) as u8;
                out[2] = ((b_px[0] as u32 * 255 + a / 2) / a).min(255) as u8;
                out[3] = alpha;
            }
        }
        Some(rgba_to_png_data_url(32, 32, &rgba))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_application_icon(_id: &str, _path: &str) -> Option<String> {
    None
}

#[cfg(any(windows, test))]
fn rgba_to_png_data_url(width: u32, height: u32, rgba: &[u8]) -> String {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in bytes {
            crc ^= byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let checksum = crc32(&out[start..]);
        out.extend_from_slice(&checksum.to_be_bytes());
    }

    let row_bytes = (width as usize) * 4;
    let mut scanlines = Vec::with_capacity((height as usize) * (1 + row_bytes));
    for row in rgba.chunks_exact(row_bytes).take(height as usize) {
        scanlines.push(0);
        scanlines.extend_from_slice(row);
    }

    let mut zlib = Vec::with_capacity(scanlines.len() + 16);
    zlib.extend_from_slice(&[0x78, 0x01]);
    let chunks: Vec<&[u8]> = if scanlines.is_empty() {
        vec![&[]]
    } else {
        scanlines.chunks(65_535).collect()
    };
    for (index, block) in chunks.iter().enumerate() {
        let last = index + 1 == chunks.len();
        zlib.push(if last { 0x01 } else { 0x00 });
        let len = block.len() as u16;
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    let (mut s1, mut s2) = (1u32, 0u32);
    for &byte in &scanlines {
        s1 = (s1 + byte as u32) % 65_521;
        s2 = (s2 + s1) % 65_521;
    }
    zlib.extend_from_slice(&((s2 << 16) | s1).to_be_bytes());

    let mut png = Vec::with_capacity(zlib.len() + 64);
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    write_chunk(&mut png, b"IHDR", &ihdr);
    write_chunk(&mut png, b"IDAT", &zlib);
    write_chunk(&mut png, b"IEND", &[]);

    const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(22 + png.len().div_ceil(3) * 4);
    out.push_str("data:image/png;base64,");
    for triple in png.chunks(3) {
        let b0 = triple[0] as usize;
        let b1 = triple.get(1).copied().unwrap_or(0) as usize;
        let b2 = triple.get(2).copied().unwrap_or(0) as usize;
        out.push(BASE64[b0 >> 2] as char);
        out.push(BASE64[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        out.push(if triple.len() > 1 {
            BASE64[((b1 & 0x0f) << 2) | (b2 >> 6)] as char
        } else {
            '='
        });
        out.push(if triple.len() > 2 {
            BASE64[b2 & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_apps_are_deduplicated_ordered_bounded_and_persisted() {
        let mut recent = vec![];
        for i in 0..25 {
            remember(
                &mut recent,
                Application {
                    id: i.to_string(),
                    name: format!("App {i}"),
                    path: format!("/{i}.app"),
                },
                i,
            );
        }
        assert_eq!(recent.len(), 20);
        let app = recent[10].application.clone();
        remember(&mut recent, app.clone(), 30);
        assert_eq!(recent[0].application, app);
        assert_eq!(recent[0].last_used_at, 30);
        assert_eq!(
            recent.iter().filter(|e| e.application.id == app.id).count(),
            1
        );
        let path =
            std::env::temp_dir().join(format!("axonkey-recent-apps-{}.json", uuid::Uuid::new_v4()));
        save_recent(&path, &recent).unwrap();
        let loaded: Vec<RecentApplication> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded[0].application, app);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn macos_manual_app_identity_matches_the_bundle() {
        let app = application_from_path(Path::new("/System/Applications/TextEdit.app")).unwrap();
        assert_eq!(app.id, "macos:com.apple.TextEdit");
        assert!(!app.name.is_empty());
        assert!(application_from_path(Path::new("/tmp/not-an-app")).is_err());
        if let Some(frontmost) = frontmost_application().unwrap() {
            assert_eq!(
                application_from_path(Path::new(&frontmost.path))
                    .unwrap()
                    .id,
                frontmost.id
            );
            eprintln!("Identified foreground application: {}", frontmost.name);
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn monitor_records_and_persists_actual_foreground_apps_without_device_hardware() {
        if frontmost_application().unwrap().is_none() {
            return;
        }
        let path =
            std::env::temp_dir().join(format!("axonkey-app-monitor-{}.json", uuid::Uuid::new_v4()));
        let monitor = Monitor::start(path.clone()).unwrap();
        for _ in 0..40 {
            if path.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let snapshot = foreground_applications();
        let app = snapshot.current.unwrap();
        assert!(snapshot
            .recent
            .iter()
            .any(|entry| entry.application.id == app.id));
        let saved: Vec<RecentApplication> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(saved.iter().any(|entry| entry.application.id == app.id));
        drop(monitor);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn png_data_url_encodes_valid_rgba_png_header_and_iend() {
        let rgba = vec![128u8; 32 * 32 * 4];
        let url = rgba_to_png_data_url(32, 32, &rgba);
        assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"));
        assert!(url.len() > 200);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_application_icons_resolve_by_path_and_bundle_identifier() {
        let icons = resolve_application_icons(&[
            ApplicationIconQuery {
                id: "macos:com.apple.TextEdit".into(),
                path: "/System/Applications/TextEdit.app".into(),
            },
            ApplicationIconQuery {
                id: "macos:com.apple.Finder".into(),
                path: String::new(),
            },
            ApplicationIconQuery {
                id: "macos:com.axonkey.nonexistent.invalid".into(),
                path: "/tmp/does-not-exist-axonkey.app".into(),
            },
        ]);
        assert!(icons
            .get("macos:com.apple.TextEdit")
            .is_some_and(|url| url.starts_with("data:image/png;base64,iVBORw0KGgo")));
        assert!(icons
            .get("macos:com.apple.Finder")
            .is_some_and(|url| url.starts_with("data:image/png;base64,iVBORw0KGgo")));
        assert!(!icons.contains_key("macos:com.axonkey.nonexistent.invalid"));
    }
}
