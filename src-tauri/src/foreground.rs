use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RECENT_LIMIT: usize = 20;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub id: String,
    pub name: String,
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
}
