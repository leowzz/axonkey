mod input_service;

use input_service::{InputService, NativeSettings};

#[tauri::command]
fn ping() -> &'static str {
    "ok"
}

#[cfg(target_os = "windows")]
fn find_driver_script(
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let file_name = match action {
        "install" => "install-driver.ps1",
        "uninstall" => "uninstall-driver.ps1",
        _ => return Err("Unsupported driver action".into()),
    };

    let mut roots = vec![resource_dir.to_path_buf()];
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
                return Ok(candidate);
            }
        }
    }

    Err(format!("Driver script was not found: {file_name}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverActionResult {
    log_path: String,
}

#[cfg(target_os = "windows")]
fn driver_log_path(action: &str) -> Result<std::path::PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "Cannot locate the Windows local application data directory".to_string())?;
    let directory = std::path::PathBuf::from(local_app_data)
        .join("Axonkey")
        .join("logs");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create the driver log directory: {error}"))?;
    Ok(directory.join(format!("driver-{action}.log")))
}

#[cfg(target_os = "windows")]
fn run_driver_action(
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<DriverActionResult, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let log_path = driver_log_path(action)?;
    let started = format!(
        "Axonkey driver {action} requested: {:?}\r\n",
        std::time::SystemTime::now()
    );
    std::fs::write(&log_path, started)
        .map_err(|error| format!("Cannot initialize the driver log: {error}"))?;

    let script = find_driver_script(action, resource_dir).map_err(|error| {
        let _ = std::fs::write(&log_path, format!("ERROR: {error}\r\n"));
        format!("{error}. Log: {}", log_path.display())
    })?;
    let status = std::process::Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script)
        .arg("-Confirmed")
        .arg("-LogPath")
        .arg(&log_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            let message = format!("Cannot launch the driver script: {error}");
            let _ = std::fs::write(&log_path, format!("ERROR: {message}\r\n"));
            format!("{message}. Log: {}", log_path.display())
        })?;

    if !status.success() {
        let exit_code = status
            .code()
            .map_or_else(|| "unknown".to_string(), |code| code.to_string());
        return Err(format!(
            "Driver {action} failed with exit code {exit_code}. Log: {}",
            log_path.display()
        ));
    }

    Ok(DriverActionResult {
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn launch_driver_action(
    app: tauri::AppHandle,
    driver: String,
    action: String,
) -> Result<DriverActionResult, String> {
    if driver != "input" {
        return Err("Only the Interception input driver has a bundled installer".into());
    }

    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| format!("Cannot resolve bundled resources: {error}"))?;
        tauri::async_runtime::spawn_blocking(move || run_driver_action(&action, &resource_dir))
            .await
            .map_err(|error| format!("Driver task failed unexpectedly: {error}"))?
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
    rc003_connected: bool,
    input_backend_ready: bool,
    input_backend_error: Option<String>,
    device_hardware_id: Option<String>,
}

#[cfg(target_os = "windows")]
fn powershell_output(expression: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(expression);
    command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!value.is_empty()).then_some(value)
        })
}

#[cfg(target_os = "windows")]
fn powershell_probe(expression: &str) -> bool {
    powershell_output(expression).as_deref() == Some("1")
}

fn parse_battery_level(value: &str) -> Option<u8> {
    value
        .trim()
        .parse::<u8>()
        .ok()
        .filter(|level| *level <= 100)
}

#[cfg(target_os = "windows")]
fn rc003_battery_level() -> Option<u8> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
    $target = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -match '^HID\\.*(?:VID_2717|VID&012717).*(?:PID_32B8|PID&32B8)' } |
        Select-Object -First 1

    if (-not $target) {
        $target = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
            Where-Object { $_.InstanceId -match 'BTHLEDEVICE\\\{0000180F-0000-1000-8000-00805F9B34FB\}_DEV_.*(?:VID_2717|VID&012717).*(?:PID_32B8|PID&32B8)' } |
            Select-Object -First 1
    }
    if (-not $target) { return }

    $addressMatch = [regex]::Match($target.InstanceId, '_([0-9A-F]{12})\\', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $addressMatch.Success) { return }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
    [void][Windows.Devices.Bluetooth.BluetoothCacheMode, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
    [void][Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
    [void][Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
    [void][Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadResult, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
    [void][Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType=WindowsRuntime]

    function Await-Result($operation, [Type]$resultType) {
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
            Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
            Select-Object -First 1
        $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
        $task.Wait()
        $task.Result
    }

    $address = [Convert]::ToUInt64($addressMatch.Groups[1].Value, 16)
    $device = Await-Result ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($address)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
    if (-not $device) { return }

    $services = Await-Result ($device.GetGattServicesForUuidAsync([Guid]'0000180f-0000-1000-8000-00805f9b34fb', [Windows.Devices.Bluetooth.BluetoothCacheMode]::Cached)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])
    if ($services.Status.ToString() -ne 'Success') { return }
    $service = $services.Services | Select-Object -First 1
    if (-not $service) { return }

    $characteristics = Await-Result ($service.GetCharacteristicsForUuidAsync([Guid]'00002a19-0000-1000-8000-00805f9b34fb', [Windows.Devices.Bluetooth.BluetoothCacheMode]::Cached)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])
    if ($characteristics.Status.ToString() -ne 'Success') { return }
    $characteristic = $characteristics.Characteristics | Select-Object -First 1
    if (-not $characteristic) { return }

    $read = Await-Result ($characteristic.ReadValueAsync([Windows.Devices.Bluetooth.BluetoothCacheMode]::Cached)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadResult])
    if ($read.Status.ToString() -ne 'Success' -or $read.Value.Length -lt 1) { return }

    $toArray = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'ToArray' -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
    $bytes = $toArray.Invoke($null, @($read.Value))
    if ($bytes.Count -gt 0) { [int]$bytes[0] }
    $device.Dispose()
} catch {
    return
}
"#;

    powershell_output(SCRIPT).and_then(|value| parse_battery_level(&value))
}

#[tauri::command]
async fn probe_rc003_battery_level() -> Option<u8> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(rc003_battery_level)
            .await
            .unwrap_or_default()
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
async fn probe_audio_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            powershell_probe(
                r#"if (@(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' }).Count -gt 0) { '1' } else { '0' }"#,
            )
        })
        .await
        .unwrap_or_default()
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn update_input_settings(
    settings: NativeSettings,
    input_service: tauri::State<'_, InputService>,
) -> Result<(), String> {
    input_service.update_settings(settings)
}

#[tauri::command]
async fn probe_system_state(app: tauri::AppHandle) -> Result<SystemProbe, String> {
    use tauri::Manager;

    let input_status = app.state::<InputService>().status();

    #[cfg(target_os = "windows")]
    {
        let (input_driver_installed, pnp_connected) = tauri::async_runtime::spawn_blocking(|| {
            let windows =
                std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
            let driver_installed = std::path::PathBuf::from(windows)
                .join("System32")
                .join("drivers")
                .join("keyboard.sys")
                .is_file();
            let device_connected = powershell_probe(
                r#"if (@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' -and $_.InstanceId -match 'VID(?:_|&)0*2717.*PID(?:_|&)32B8' }).Count -gt 0) { '1' } else { '0' }"#,
            );
            (driver_installed, device_connected)
        })
        .await
        .map_err(|error| format!("System probe task failed unexpectedly: {error}"))?;
        Ok(SystemProbe {
            input_driver_installed,
            rc003_connected: input_status.device_connected || pnp_connected,
            input_backend_ready: input_status.backend_ready,
            input_backend_error: input_status.error,
            device_hardware_id: input_status.hardware_id,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(SystemProbe {
            input_driver_installed: false,
            rc003_connected: false,
            input_backend_ready: input_status.backend_ready,
            input_backend_error: input_status.error,
            device_hardware_id: input_status.hardware_id,
        })
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
            probe_audio_available,
            probe_rc003_battery_level,
            update_input_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Axonkey");
}

#[cfg(test)]
mod tests {
    use super::parse_battery_level;

    #[test]
    fn parses_valid_battery_percentages_only() {
        assert_eq!(parse_battery_level("91\r\n"), Some(91));
        assert_eq!(parse_battery_level("0"), Some(0));
        assert_eq!(parse_battery_level("100"), Some(100));
        assert_eq!(parse_battery_level("101"), None);
        assert_eq!(parse_battery_level("unknown"), None);
    }
}
