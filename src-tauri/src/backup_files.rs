use std::path::{Path, PathBuf};

fn exported_file(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("备份文件路径为空".into());
    }
    let file = std::path::absolute(Path::new(path))
        .map_err(|error| format!("无法定位备份文件：{error}"))?;
    if !file.is_file() {
        return Err("备份文件不存在，可能已被移动或删除".into());
    }
    Ok(file)
}

pub(crate) fn open_shell_target(
    app: &tauri::AppHandle,
    target: &Path,
    reveal_file: bool,
    label: &str,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let mut command = std::process::Command::new("/usr/bin/open");
        if reveal_file && target.is_file() {
            // Reveal the file in Finder, including paths inside .app folders.
            command.arg("-R");
        }
        let output = command
            .arg(target)
            .output()
            .map_err(|error| format!("无法打开{label}：{error}"))?;
        if !output.status.success() {
            return Err(format!(
                "无法打开{label}：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        // Pass the path directly to the shell API, never through cmd.exe; names
        // containing spaces, quotes, percent signs or ampersands remain literal.
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(
                window: *mut std::ffi::c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show: i32,
            ) -> isize;
        }
        let open_target = if reveal_file && target.is_file() {
            target
                .parent()
                .ok_or_else(|| format!("无法定位{label}目录"))?
        } else {
            target
        };
        let path: Vec<u16> = open_target
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let label_owned = label.to_owned();
        // Tauri's GUI thread already has the COM apartment needed by shell
        // handlers. Async command workers need not have COM initialized.
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    operation.as_ptr(),
                    path.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                )
            };
            let _ = sender.send(if result <= 32 {
                Err(format!("无法打开{label_owned}（系统错误 {result}）"))
            } else {
                Ok(())
            });
        })
        .map_err(|error| format!("无法打开{label}：{error}"))?;
        receiver
            .recv()
            .map_err(|error| format!("无法打开{label}：{error}"))?
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, target, reveal_file);
        Err(format!("当前系统暂不支持打开{label}"))
    }
}

#[tauri::command]
pub async fn open_backup_location(
    app: tauri::AppHandle,
    path: String,
    directory: bool,
) -> Result<(), String> {
    let file = exported_file(&path)?;
    open_shell_target(&app, &file, directory, "备份")
}

#[cfg(test)]
mod tests {
    use super::exported_file;

    #[test]
    fn resolves_exported_files_without_changing_unicode_or_shell_characters() {
        let folder =
            std::env::temp_dir().join(format!("axonkey-backup-open-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("备份 100% & data.json");
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(exported_file(file.to_str().unwrap()).unwrap(), file);
        assert!(exported_file(folder.to_str().unwrap()).is_err());
        std::fs::remove_file(&file).unwrap();
        assert!(exported_file(file.to_str().unwrap()).is_err());
        std::fs::remove_dir(folder).unwrap();
    }

    #[test]
    fn rejects_empty_export_paths() {
        assert!(exported_file("").is_err());
        assert!(exported_file("  ").is_err());
    }
}
