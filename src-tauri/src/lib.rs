mod input_service;

use input_service::{InputService, NativeSettings};

#[tauri::command]
fn ping() -> &'static str {
    "ok"
}

#[cfg(target_os = "windows")]
fn find_driver_script(action: &str) -> Result<std::path::PathBuf, String> {
    let file_name = match action {
        "install" => "install-driver.cmd",
        "uninstall" => "uninstall-driver.cmd",
        _ => return Err("Unsupported driver action".into()),
    };

    let mut roots = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        roots.push(current.clone());
        if let Some(parent) = current.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            roots.push(directory.to_path_buf());
        }
    }

    for root in roots {
        for candidate in [root.join(file_name), root.join("scripts").join(file_name)] {
            if candidate.is_file() {
                return candidate
                    .canonicalize()
                    .map_err(|error| format!("Cannot resolve driver script: {error}"));
            }
        }
    }

    Err(format!("Driver script was not found: {file_name}"))
}

#[tauri::command]
fn launch_driver_action(driver: String, action: String) -> Result<(), String> {
    if driver != "input" {
        return Err("Only the Interception input driver has a bundled installer".into());
    }

    #[cfg(target_os = "windows")]
    {
        let script = find_driver_script(&action)?;
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(script)
            .spawn()
            .map_err(|error| format!("Cannot launch driver script: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = action;
        Err("Driver installation is only supported on Windows".into())
    }
}

#[tauri::command]
fn open_windows_settings(page: String) -> Result<(), String> {
    let uri = match page.as_str() {
        "bluetooth" => "ms-settings:bluetooth",
        "sound" => "ms-settings:sound",
        _ => return Err("Unsupported settings page".into()),
    };

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(uri)
            .spawn()
            .map_err(|error| format!("Cannot open Windows settings: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = uri;
        Err("Windows settings are only available on Windows".into())
    }
}

#[derive(serde::Serialize)]
struct SystemProbe {
    input_driver_installed: bool,
    audio_available: bool,
    rc003_connected: bool,
    input_backend_ready: bool,
    input_backend_error: Option<String>,
    device_hardware_id: Option<String>,
}

#[cfg(target_os = "windows")]
fn powershell_probe(expression: &str) -> bool {
    std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(expression)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "1")
        .unwrap_or(false)
}

#[tauri::command]
fn update_input_settings(
    settings: NativeSettings,
    input_service: tauri::State<'_, InputService>,
) -> Result<(), String> {
    input_service.update_settings(settings)
}

#[tauri::command]
fn probe_system_state(input_service: tauri::State<'_, InputService>) -> SystemProbe {
    #[cfg(target_os = "windows")]
    {
        let input_status = input_service.status();
        let windows = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
        let input_driver_installed = std::path::PathBuf::from(windows)
            .join("System32")
            .join("drivers")
            .join("keyboard.sys")
            .is_file();
        let audio_available = powershell_probe(
            r#"if (@(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' }).Count -gt 0) { '1' } else { '0' }"#,
        );
        let pnp_connected = powershell_probe(
            r#"if (@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' -and $_.InstanceId -match 'VID(?:_|&)0*2717.*PID(?:_|&)32B8' }).Count -gt 0) { '1' } else { '0' }"#,
        );
        SystemProbe {
            input_driver_installed,
            audio_available,
            rc003_connected: input_status.device_connected || pnp_connected,
            input_backend_ready: input_status.backend_ready,
            input_backend_error: input_status.error,
            device_hardware_id: input_status.hardware_id,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let input_status = input_service.status();
        SystemProbe {
            input_driver_installed: false,
            audio_available: false,
            rc003_connected: false,
            input_backend_ready: input_status.backend_ready,
            input_backend_error: input_status.error,
            device_hardware_id: input_status.hardware_id,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(InputService::start())
        .invoke_handler(tauri::generate_handler![
            ping,
            launch_driver_action,
            open_windows_settings,
            probe_system_state,
            update_input_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Axonkey");
}
