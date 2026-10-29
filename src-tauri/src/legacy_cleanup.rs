use std::sync::{Mutex, Once};
use tauri::Manager;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    status: String,
    message: String,
    log_path: Option<String>,
}

pub(crate) struct CleanupState {
    snapshot: Mutex<Snapshot>,
    next_startup: Once,
}

impl Default for CleanupState {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(Snapshot {
                status: "checking".into(),
                message: "正在检查 Interception 旧驱动…".into(),
                log_path: None,
            }),
            next_startup: Once::new(),
        }
    }
}

impl CleanupState {
    fn update(&self, status: &str, message: impl Into<String>) {
        let mut snapshot = self.snapshot.lock().unwrap();
        snapshot.status = status.into();
        snapshot.message = message.into();
    }
}

#[tauri::command]
pub(crate) fn get_legacy_cleanup(app: tauri::AppHandle) -> Option<Snapshot> {
    app.try_state::<CleanupState>()
        .map(|s| s.snapshot.lock().unwrap().clone())
}

#[tauri::command]
pub(crate) async fn check_legacy_cleanup(app: tauri::AppHandle) -> Result<(), String> {
    perform(app, false).await
}

#[tauri::command]
pub(crate) async fn run_legacy_cleanup(app: tauri::AppHandle) -> Result<(), String> {
    perform(app, true).await
}

async fn perform(app: tauri::AppHandle, uninstall: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = app.state::<CleanupState>();
        {
            let mut snapshot = state.snapshot.lock().unwrap();
            if matches!(snapshot.status.as_str(), "checking" | "running") {
                return Ok(());
            }
            if uninstall && !matches!(snapshot.status.as_str(), "required" | "failed") {
                return Err("当前不需要卸载旧驱动。".into());
            }
            snapshot.status = if uninstall { "running" } else { "checking" }.into();
            snapshot.message = if uninstall {
                "正在卸载旧驱动，请允许管理员授权…"
            } else {
                "正在检查旧驱动和重启状态…"
            }
            .into();
        }
        let worker = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            if uninstall {
                windows::uninstall(&worker)
            } else {
                windows::check(&worker, true)
            }
        })
        .await
        .map_err(|e| format!("旧驱动任务异常：{e}"))
        .and_then(|r| r);
        if let Err(error) = result {
            windows::fail(&app, error);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, uninstall);
        Err("仅 Windows 支持旧驱动清理。".into())
    }
}

#[cfg(windows)]
pub(crate) fn initialize(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = windows::check(&app, false) {
            windows::fail(&app, error);
        }
    });
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::legacy_driver::{self, LegacyProbeState};
    use std::{
        os::windows::process::CommandExt,
        path::{Path, PathBuf},
    };

    #[derive(serde::Serialize, serde::Deserialize)]
    struct UninstallRecord {
        boot_id: String,
        completed: bool,
    }

    fn record_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("interception-cleanup.json"))
    }

    fn load(path: &Path) -> Result<Option<UninstallRecord>, String> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| format!("无法读取卸载记录：{e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("无法读取卸载记录：{e}")),
        }
    }

    fn save(path: &Path, record: &UninstallRecord) -> Result<(), String> {
        use std::io::Write;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(record).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(temp, path).map_err(|e| format!("无法保存卸载记录：{e}"))
    }

    fn boot_id() -> Result<String, String> {
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks.ToString()"])
            .creation_flags(0x0800_0000).output().map_err(|e| format!("无法检查 Windows 重启状态：{e}"))?;
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !output.status.success()
            || value.is_empty()
            || !value.bytes().all(|c| c.is_ascii_digit())
        {
            return Err(format!(
                "无法读取 Windows 本次启动时间：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(value)
    }

    fn is_interception_deletion(entries: &[String]) -> bool {
        entries.chunks_exact(2).any(|pair| {
            let source = pair[0].to_ascii_lowercase();
            pair[1].is_empty()
                && [
                    r"\system32\drivers\keyboard.sys",
                    r"\system32\drivers\mouse.sys",
                ]
                .iter()
                .any(|suffix| source.ends_with(suffix))
        })
    }

    fn pending_deletion() -> Result<bool, String> {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager")
            .map_err(|e| e.to_string())?;
        let value = match key.get_raw_value("PendingFileRenameOperations") {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(format!("无法检查待重启删除的驱动：{e}")),
        };
        // REG_MULTI_SZ contains source/destination pairs; an empty destination means deletion.
        let units: Vec<_> = value
            .bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let entries: Vec<_> = String::from_utf16_lossy(&units)
            .split('\0')
            .map(String::from)
            .collect();
        Ok(is_interception_deletion(&entries))
    }

    fn needs_restart(
        record: Option<&UninstallRecord>,
        current_boot: &str,
        present: bool,
        pending: bool,
    ) -> bool {
        pending || record.is_some_and(|r| r.boot_id == current_boot && (r.completed || !present))
    }

    fn inspect(app: &tauri::AppHandle, refresh: bool) -> Result<&'static str, String> {
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let components = app
            .state::<LegacyProbeState>()
            .check(refresh, || legacy_driver::probe(&resources))?;
        let present = components.interception || components.interception_fix;
        let path = record_path(app)?;
        let record = load(&path)?;
        let current_boot = if record.is_some() {
            boot_id()?
        } else {
            String::new()
        };
        let restart = needs_restart(record.as_ref(), &current_boot, present, pending_deletion()?);
        if record.as_ref().is_some_and(|r| r.boot_id != current_boot) {
            std::fs::remove_file(&path).map_err(|e| format!("无法清除旧卸载记录：{e}"))?;
        }
        Ok(if restart {
            "rebootRequired"
        } else if present {
            "required"
        } else {
            "ready"
        })
    }

    fn publish(app: &tauri::AppHandle, status: &str) {
        let state = app.state::<CleanupState>();
        state.update(
            status,
            match status {
                "required" => "检测到 Interception 或旧版修复服务，请先卸载，避免影响设备输入。",
                "rebootRequired" => {
                    "旧驱动已提交卸载，但 Windows 尚未重启。请重启电脑后再打开 Axonkey。"
                }
                _ => "未检测到 Interception 旧驱动或修复服务，可以继续。",
            },
        );
        if status == "ready" {
            state
                .next_startup
                .call_once(|| crate::driver_migration::initialize(app.clone()));
        } else {
            crate::show_main_window(app);
        }
    }

    pub(super) fn check(app: &tauri::AppHandle, refresh: bool) -> Result<(), String> {
        publish(app, inspect(app, refresh)?);
        Ok(())
    }

    pub(super) fn fail(app: &tauri::AppHandle, error: String) {
        log::error!(target: "axonkey::legacy_cleanup", "{error}");
        app.state::<CleanupState>().update("failed", error);
        crate::show_main_window(app);
    }

    pub(super) fn uninstall(app: &tauri::AppHandle) -> Result<(), String> {
        let status = inspect(app, true)?;
        if status != "required" {
            publish(app, status);
            return Ok(());
        }
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let path = record_path(app)?;
        let mut record = UninstallRecord {
            boot_id: boot_id()?,
            completed: false,
        };
        save(&path, &record)?;
        let log = crate::driver_log_path(app, "legacy", "cleanup")?;
        app.state::<CleanupState>()
            .snapshot
            .lock()
            .unwrap()
            .log_path = Some(log.to_string_lossy().into_owned());
        crate::run_driver_action(app, "legacy", "cleanup", &resources)?;
        record.completed = true;
        save(&path, &record)?;
        publish(app, "rebootRequired");
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        #[ignore = "read-only Windows CIM and registry integration check"]
        fn windows_restart_probe_is_stable() {
            let first = boot_id().unwrap();
            assert_eq!(first, boot_id().unwrap());
            pending_deletion().unwrap();
        }
        #[test]
        fn restarting_app_does_not_satisfy_windows_restart() {
            let record = UninstallRecord {
                boot_id: "boot-one".into(),
                completed: true,
            };
            assert!(needs_restart(Some(&record), "boot-one", false, false));
            assert!(needs_restart(Some(&record), "boot-one", true, false));
            assert!(!needs_restart(Some(&record), "boot-two", false, false));
        }
        #[test]
        fn interrupted_uninstall_rechecks_actual_presence() {
            let record = UninstallRecord {
                boot_id: "one".into(),
                completed: false,
            };
            assert!(!needs_restart(Some(&record), "one", true, false));
            assert!(needs_restart(Some(&record), "one", false, false));
        }
        #[test]
        fn recognizes_only_pending_interception_file_deletions() {
            let deletion = vec![
                r"\??\C:\WINDOWS\System32\drivers\keyboard.sys".into(),
                String::new(),
            ];
            assert!(is_interception_deletion(&deletion));
            assert!(needs_restart(None, "", true, true));
            assert!(!is_interception_deletion(&[
                deletion[0].clone(),
                "replacement.sys".into()
            ]));
            assert!(!is_interception_deletion(&[
                r"C:\Windows\System32\drivers\kbdclass.sys".into(),
                String::new()
            ]));
        }
        #[test]
        fn persists_restart_record_across_process_lifetimes() {
            let path = std::env::temp_dir()
                .join(format!("axonkey-cleanup-test-{}.json", std::process::id()));
            let mut record = UninstallRecord {
                boot_id: "boot".into(),
                completed: false,
            };
            save(&path, &record).unwrap();
            assert!(!load(&path).unwrap().unwrap().completed);
            record.completed = true;
            save(&path, &record).unwrap();
            assert!(needs_restart(
                load(&path).unwrap().as_ref(),
                "boot",
                false,
                false
            ));
            std::fs::remove_file(path).unwrap();
        }
    }
}
