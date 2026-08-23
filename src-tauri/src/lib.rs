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
fn probe_rc003_battery_level() -> Option<u8> {
    #[cfg(target_os = "windows")]
    {
        rc003_battery_level()
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
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
