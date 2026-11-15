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
    let mut uncached = Vec::new();
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
        if !uncached
            .iter()
            .any(|(seen_id, _, _): &(String, String, String)| seen_id == id)
        {
            uncached.push((id.to_owned(), path.to_owned(), cache_key));
        }
    }
    if uncached.is_empty() {
        return result;
    }
    let extracted = with_icon_extractor_context(|| {
        uncached
            .iter()
            .map(|(id, path, _)| platform_application_icon(id, path))
            .collect::<Vec<_>>()
    });
    for ((id, _, cache_key), icon) in uncached.into_iter().zip(extracted) {
        {
            let mut cache = icon_cache().lock().unwrap();
            if cache.len() >= ICON_CACHE_LIMIT {
                cache.clear();
            }
            cache.insert(cache_key, icon.clone());
        }
        if let Some(icon) = icon {
            result.insert(id, icon);
        }
    }
    result
}

#[cfg(windows)]
fn with_icon_extractor_context<T: Send>(work: impl FnOnce() -> T + Send) -> T {
    use windows::{
        core::HRESULT,
        Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
    };
    const RPC_E_CHANGED_MODE: HRESULT = HRESULT(0x80010106u32 as i32);

    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    // SHGetFileInfoW requires an STA apartment; Tokio blocking threads that ran
    // WinRT/Bluetooth queries are already bound to MTA (RPC_E_CHANGED_MODE).
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr == RPC_E_CHANGED_MODE {
        return thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _com =
                        ComGuard(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok());
                    work()
                })
                .join()
                .expect("Windows icon STA thread panicked")
        });
    }
    let _com = ComGuard(hr.is_ok());
    work()
}

#[cfg(not(windows))]
fn with_icon_extractor_context<T>(work: impl FnOnce() -> T) -> T {
    work()
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
#[repr(C)]
struct ShFileInfoW {
    h_icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    i_icon: i32,
    dw_attributes: u32,
    sz_display_name: [u16; 260],
    sz_type_name: [u16; 80],
}

#[cfg(windows)]
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

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn PrivateExtractIconsW(
        lpsz_file: *const u16,
        n_icon_index: i32,
        cx_icon: i32,
        cy_icon: i32,
        phicon: *mut windows::Win32::UI::WindowsAndMessaging::HICON,
        piconid: *mut u32,
        n_icons: u32,
        flags: u32,
    ) -> u32;
}

#[cfg(windows)]
fn default_windows_exe_icon_index() -> Option<i32> {
    static DEFAULT_EXE_ICON_INDEX: OnceLock<Option<i32>> = OnceLock::new();
    *DEFAULT_EXE_ICON_INDEX.get_or_init(|| {
        const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
        const SHGFI_USEFILEATTRIBUTES: u32 = 0x0000_0010;
        const SHGFI_SYSICONINDEX: u32 = 0x0000_4000;
        let ext: [u16; 5] = [b'.' as u16, b'e' as u16, b'x' as u16, b'e' as u16, 0];
        let mut info: ShFileInfoW = unsafe { std::mem::zeroed() };
        let resolved = unsafe {
            SHGetFileInfoW(
                ext.as_ptr(),
                FILE_ATTRIBUTE_NORMAL,
                &mut info,
                std::mem::size_of::<ShFileInfoW>() as u32,
                SHGFI_USEFILEATTRIBUTES | SHGFI_SYSICONINDEX,
            )
        };
        (resolved != 0).then_some(info.i_icon)
    })
}

#[cfg(windows)]
fn platform_application_icon(id: &str, path: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::{
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, SelectObject,
            BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        },
        UI::WindowsAndMessaging::{
            DestroyIcon, DrawIconEx, GetSystemMetrics, DI_NORMAL, SM_CXICON,
        },
    };

    const SHGFI_ICON: u32 = 0x0000_0100;
    const SHGFI_LARGEICON: u32 = 0x0000_0000;
    const SHGFI_SYSICONINDEX: u32 = 0x0000_4000;

    let from_path = (!path.is_empty())
        .then(|| Path::new(path))
        .filter(|candidate| candidate.is_file());
    let from_id = id
        .strip_prefix("windows:")
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(Path::new)
        .filter(|candidate| candidate.is_file());
    let file_path = from_path.or(from_id)?;
    let wide: Vec<u16> = file_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut file_info: ShFileInfoW = std::mem::zeroed();
        let resolved = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut file_info,
            std::mem::size_of::<ShFileInfoW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_SYSICONINDEX,
        );
        if resolved == 0 || file_info.h_icon.0.is_null() {
            return windows_packaged_app_icon(file_path);
        }
        let embedded_icons = PrivateExtractIconsW(
            wide.as_ptr(),
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            0,
        );
        if Some(file_info.i_icon) == default_windows_exe_icon_index()
            && (embedded_icons == 0 || embedded_icons == u32::MAX)
        {
            let _ = DestroyIcon(file_info.h_icon);
            return windows_packaged_app_icon(file_path);
        }

        let hicon = file_info.h_icon;
        let size = GetSystemMetrics(SM_CXICON).clamp(32, 64) as u32;
        let pixel_bytes = (size as usize) * (size as usize) * 4;
        let render_on_bg = |bg: u8| -> Option<Vec<u8>> {
            let dc = CreateCompatibleDC(None);
            if dc.0.is_null() {
                return None;
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size as i32,
                    biHeight: -(size as i32),
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
            let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), pixel_bytes);
            pixels.fill(bg);
            let previous = SelectObject(dc, bitmap.into());
            let ok = DrawIconEx(
                dc,
                0,
                0,
                hicon,
                size as i32,
                size as i32,
                0,
                None,
                DI_NORMAL,
            )
            .is_ok();
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
        let (black, white) = (black?, white?);
        let mut rgba = vec![0u8; pixel_bytes];
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
        Some(rgba_to_png_data_url(size, size, &rgba))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_application_icon(_id: &str, _path: &str) -> Option<String> {
    None
}

#[cfg(any(windows, test))]
fn windows_packaged_app_icon(exe_path: &Path) -> Option<String> {
    use quick_xml::{events::Event, Reader, XmlVersion};

    let exe_name = exe_path.file_name()?.to_str()?;
    let mut ancestor = exe_path.parent();
    let mut found_manifest = None;
    for _ in 0..3 {
        let dir = ancestor?;
        let candidate = dir.join("AppxManifest.xml");
        if candidate.is_file() {
            found_manifest = Some((dir, candidate));
            break;
        }
        ancestor = dir.parent();
    }
    let (package_dir, manifest_path) = found_manifest?;
    let xml = std::fs::read_to_string(manifest_path).ok()?;

    let mut reader = Reader::from_str(&xml);
    let mut in_properties = false;
    let mut in_properties_logo = false;
    let mut in_matching_app = false;
    let mut properties_logo: Option<String> = None;
    let mut first_visual_logo: Option<String> = None;
    let mut matched_visual_logo: Option<String> = None;

    let extract_attr =
        |element: &quick_xml::events::BytesStart<'_>, target: &str| -> Option<String> {
            for attr in element.attributes().with_checks(false).flatten() {
                let key = attr.key.as_ref();
                let local = key.rsplit(|b| *b == b':').next().unwrap_or(key);
                if local.eq_ignore_ascii_case(target.as_bytes()) {
                    if let Ok(val) = attr.normalized_value(XmlVersion::default()) {
                        let trimmed = val.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_owned());
                        }
                    }
                }
            }
            None
        };

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref element)) => {
                let raw = element.name();
                let local = raw
                    .as_ref()
                    .rsplit(|b| *b == b':')
                    .next()
                    .unwrap_or(raw.as_ref());
                if local.eq_ignore_ascii_case(b"Properties") {
                    in_properties = true;
                } else if in_properties && local.eq_ignore_ascii_case(b"Logo") {
                    in_properties_logo = true;
                } else if local.eq_ignore_ascii_case(b"Application") {
                    in_matching_app = extract_attr(element, "Executable")
                        .and_then(|value| {
                            Path::new(&value.replace('\\', "/"))
                                .file_name()
                                .and_then(|n| n.to_str())
                                .map(|n| n.eq_ignore_ascii_case(exe_name))
                        })
                        .unwrap_or(false);
                } else if local.eq_ignore_ascii_case(b"VisualElements") {
                    let logo = extract_attr(element, "Square44x44Logo")
                        .or_else(|| extract_attr(element, "Square150x150Logo"));
                    if let Some(logo) = logo {
                        if in_matching_app && matched_visual_logo.is_none() {
                            matched_visual_logo = Some(logo.clone());
                        }
                        if first_visual_logo.is_none() {
                            first_visual_logo = Some(logo);
                        }
                    }
                }
            }
            Ok(Event::Empty(ref element)) => {
                let raw = element.name();
                let local = raw
                    .as_ref()
                    .rsplit(|b| *b == b':')
                    .next()
                    .unwrap_or(raw.as_ref());
                if local.eq_ignore_ascii_case(b"VisualElements") {
                    let logo = extract_attr(element, "Square44x44Logo")
                        .or_else(|| extract_attr(element, "Square150x150Logo"));
                    if let Some(logo) = logo {
                        if in_matching_app && matched_visual_logo.is_none() {
                            matched_visual_logo = Some(logo.clone());
                        }
                        if first_visual_logo.is_none() {
                            first_visual_logo = Some(logo);
                        }
                    }
                }
            }
            Ok(Event::Text(text)) if in_properties_logo && properties_logo.is_none() => {
                if let Ok(decoded) = text.xml_content(XmlVersion::default()) {
                    let trimmed = decoded.trim();
                    if !trimmed.is_empty() {
                        properties_logo = Some(trimmed.to_owned());
                    }
                }
            }
            Ok(Event::End(ref element)) => {
                let raw = element.name();
                let local = raw
                    .as_ref()
                    .rsplit(|b| *b == b':')
                    .next()
                    .unwrap_or(raw.as_ref());
                if local.eq_ignore_ascii_case(b"Properties") {
                    in_properties = false;
                    in_properties_logo = false;
                } else if local.eq_ignore_ascii_case(b"Logo") {
                    in_properties_logo = false;
                } else if local.eq_ignore_ascii_case(b"Application") {
                    in_matching_app = false;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    for rel in [matched_visual_logo, first_visual_logo, properties_logo]
        .into_iter()
        .flatten()
    {
        if let Some(bytes) = resolve_appx_logo_bytes(package_dir, &rel) {
            return Some(png_bytes_to_data_url(&bytes));
        }
    }
    None
}

#[cfg(any(windows, test))]
fn resolve_appx_logo_bytes(package_dir: &Path, relative_logo: &str) -> Option<Vec<u8>> {
    let normalized = relative_logo.replace('\\', "/");
    let full = package_dir.join(&normalized);
    let parent = full.parent()?;
    let stem = full.file_stem()?.to_str()?;
    let ext = full.extension()?.to_str()?;
    const QUALIFIERS: &[&str] = &[
        "targetsize-48_altform-lightunplated",
        "targetsize-48_altform-unplated",
        "targetsize-48",
        "targetsize-32_altform-lightunplated",
        "targetsize-32_altform-unplated",
        "targetsize-32",
        "scale-200",
        "scale-150",
        "scale-125",
        "scale-100",
    ];
    let candidates: Vec<PathBuf> = QUALIFIERS
        .iter()
        .map(|qualifier| parent.join(format!("{stem}.{qualifier}.{ext}")))
        .chain(std::iter::once(full.clone()))
        .collect();
    for candidate in candidates {
        if let Ok(bytes) = std::fs::read(&candidate) {
            if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Some(bytes);
            }
        }
    }
    None
}

#[cfg(any(windows, test))]
fn png_bytes_to_data_url(png: &[u8]) -> String {
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

    png_bytes_to_data_url(&png)
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
    fn appx_manifest_logo_resolves_qualified_png_for_packaged_apps() {
        let package_dir =
            std::env::temp_dir().join(format!("axonkey-appx-icon-test-{}", uuid::Uuid::new_v4()));
        let app_dir = package_dir.join("app");
        let assets_dir = package_dir.join("Assets");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::create_dir_all(&assets_dir).unwrap();
        let exe_path = app_dir.join("SampleApp.exe");
        std::fs::write(&exe_path, b"not-a-real-pe-with-icons").unwrap();
        std::fs::write(
            package_dir.join("AppxManifest.xml"),
            r#"<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10">
  <Properties>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Applications>
    <Application Id="App" Executable="app\SampleApp.exe">
      <uap:VisualElements DisplayName="Sample" Square44x44Logo="Assets\AppList.png" Square150x150Logo="Assets\MedTile.png" />
    </Application>
  </Applications>
</Package>"#,
        )
        .unwrap();
        let sample_png = [137u8, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4];
        let sample_url = png_bytes_to_data_url(&sample_png);
        std::fs::write(
            assets_dir.join("AppList.targetsize-32_altform-lightunplated.png"),
            &sample_png,
        )
        .unwrap();

        let resolved = windows_packaged_app_icon(&exe_path);
        assert_eq!(resolved.as_deref(), Some(sample_url.as_str()));

        #[cfg(windows)]
        {
            let icons = resolve_application_icons(&[ApplicationIconQuery {
                id: format!("windows:{}", exe_path.to_string_lossy().to_lowercase()),
                path: exe_path.to_string_lossy().into_owned(),
            }]);
            assert_eq!(icons.values().next(), Some(&sample_url));
        }

        let _ = std::fs::remove_dir_all(package_dir);
    }

    #[test]
    #[cfg(windows)]
    fn windows_application_icons_resolve_by_path_id_and_under_mta() {
        let icons = resolve_application_icons(&[
            ApplicationIconQuery {
                id: "windows:explorer-by-path".into(),
                path: r"C:\Windows\explorer.exe".into(),
            },
            ApplicationIconQuery {
                id: r"windows:c:\windows\explorer.exe".into(),
                path: String::new(),
            },
            ApplicationIconQuery {
                id: r"windows:c:\windows\explorer.exe".into(),
                path: r"C:\Windows\nonexistent-moved-explorer.exe".into(),
            },
            ApplicationIconQuery {
                id: r"windows:c:\nonexistent\missing.exe".into(),
                path: r"C:\nonexistent\missing.exe".into(),
            },
        ]);
        assert!(icons
            .get("windows:explorer-by-path")
            .is_some_and(|url| url.starts_with("data:image/png;base64,iVBORw0KGgo")));
        assert!(icons
            .get(r"windows:c:\windows\explorer.exe")
            .is_some_and(|url| url.starts_with("data:image/png;base64,iVBORw0KGgo")));
        assert!(!icons.contains_key(r"windows:c:\nonexistent\missing.exe"));

        if Path::new(r"C:\Windows\System32\ApplicationFrameHost.exe").is_file() {
            let host_icons = resolve_application_icons(&[ApplicationIconQuery {
                id: r"windows:c:\windows\system32\applicationframehost.exe".into(),
                path: r"C:\Windows\System32\ApplicationFrameHost.exe".into(),
            }]);
            assert!(
                !host_icons.contains_key(r"windows:c:\windows\system32\applicationframehost.exe"),
                "iconless frame host should fall back cleanly instead of returning stock .exe placeholder"
            );
        }

        let _mta = crate::windows_runtime::initialize_mta().unwrap();
        let mta_icons = resolve_application_icons(&[ApplicationIconQuery {
            id: "windows:explorer-from-mta-thread".into(),
            path: r"C:\Windows\explorer.exe".into(),
        }]);
        assert!(mta_icons
            .get("windows:explorer-from-mta-thread")
            .is_some_and(|url| url.starts_with("data:image/png;base64,iVBORw0KGgo")));
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
