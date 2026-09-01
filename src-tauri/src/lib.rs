mod audio_service;
mod input_service;

use audio_service::{AudioService, AudioServiceStatus};
use input_service::{InputService, NativeSettings};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";
const PERMISSION_HELPER_WIDTH: f64 = 430.0;
const PERMISSION_HELPER_HEIGHT: f64 = 560.0;

#[derive(Clone, Copy)]
struct WindowGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    resizable: bool,
    always_on_top: bool,
}

#[derive(Default)]
struct PermissionHelperWindowState(std::sync::Mutex<Option<WindowGeometry>>);

fn app_bundle_for_executable(executable: &std::path::Path) -> Option<std::path::PathBuf> {
    executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(std::path::Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn apply_permission_helper_mode(
    window: &tauri::WebviewWindow,
    state: &PermissionHelperWindowState,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        let geometry = WindowGeometry {
            position: window
                .outer_position()
                .map_err(|error| format!("Cannot read window position: {error}"))?,
            size: window
                .outer_size()
                .map_err(|error| format!("Cannot read window size: {error}"))?,
            resizable: window
                .is_resizable()
                .map_err(|error| format!("Cannot read resizable state: {error}"))?,
            always_on_top: window
                .is_always_on_top()
                .map_err(|error| format!("Cannot read always-on-top state: {error}"))?,
        };
        let mut saved = state
            .0
            .lock()
            .map_err(|_| "Permission helper window state is unavailable".to_string())?;
        if saved.is_none() {
            *saved = Some(geometry);
        }
        drop(saved);

        let helper_size =
            tauri::LogicalSize::new(PERMISSION_HELPER_WIDTH, PERMISSION_HELPER_HEIGHT);
        window
            .set_min_size(Some(helper_size))
            .map_err(|error| format!("Cannot set helper minimum size: {error}"))?;
        window
            .set_resizable(false)
            .map_err(|error| format!("Cannot lock helper size: {error}"))?;
        window
            .set_size(helper_size)
            .map_err(|error| format!("Cannot resize permission helper: {error}"))?;
        window
            .set_always_on_top(true)
            .map_err(|error| format!("Cannot keep permission helper visible: {error}"))?;

        if let Some(monitor) = window
            .current_monitor()
            .map_err(|error| format!("Cannot read current monitor: {error}"))?
        {
            let scale = monitor.scale_factor();
            let work_area = monitor.work_area();
            let width = (PERMISSION_HELPER_WIDTH * scale).round() as i32;
            let margin = (20.0 * scale).round() as i32;
            let x = work_area.position.x + work_area.size.width as i32 - width - margin;
            let y = work_area.position.y + margin;
            window
                .set_position(PhysicalPosition::new(x, y))
                .map_err(|error| format!("Cannot position permission helper: {error}"))?;
        }
        window
            .set_focus()
            .map_err(|error| format!("Cannot focus permission helper: {error}"))?;
        return Ok(());
    }

    let geometry = state
        .0
        .lock()
        .map_err(|_| "Permission helper window state is unavailable".to_string())?
        .take();
    if let Some(geometry) = geometry {
        window
            .set_min_size(Some(tauri::LogicalSize::new(980.0, 680.0)))
            .map_err(|error| format!("Cannot restore minimum window size: {error}"))?;
        window
            .set_size(geometry.size)
            .map_err(|error| format!("Cannot restore window size: {error}"))?;
        window
            .set_position(geometry.position)
            .map_err(|error| format!("Cannot restore window position: {error}"))?;
        window
            .set_resizable(geometry.resizable)
            .map_err(|error| format!("Cannot restore resizable state: {error}"))?;
        window
            .set_always_on_top(geometry.always_on_top)
            .map_err(|error| format!("Cannot restore always-on-top state: {error}"))?;
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };

    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "显示 Axonkey", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "退出 Axonkey", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let tray = TrayIconBuilder::with_id("axonkey-tray")
        .icon(tauri::include_image!("./icons/32x32.png"))
        .tooltip("Axonkey")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id() == TRAY_SHOW_ID {
                show_main_window(app);
            } else if event.id() == TRAY_QUIT_ID {
                app.exit(0);
            }
        });

    #[cfg(target_os = "windows")]
    let tray = {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

        tray.show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    show_main_window(tray.app_handle());
                }
            })
    };

    tray.build(app)?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn install_tray(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
fn ping() -> &'static str {
    "ok"
}

#[tauri::command]
fn get_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return "unsupported";
}

#[cfg(target_os = "windows")]
fn find_driver_script(
    driver: &str,
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let file_name = match (driver, action) {
        ("input", "install") => "install-driver.ps1",
        ("input", "uninstall") => "uninstall-driver.ps1",
        ("audio", "install" | "uninstall") => "vbcable-driver.ps1",
        ("input" | "audio", _) => return Err("Unsupported driver action".into()),
        _ => return Err("Unsupported driver kind".into()),
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
fn driver_log_path(driver: &str, action: &str) -> Result<std::path::PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "Cannot locate the Windows local application data directory".to_string())?;
    let directory = std::path::PathBuf::from(local_app_data)
        .join("Axonkey")
        .join("logs");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create the driver log directory: {error}"))?;
    let file_name = if driver == "audio" {
        format!("vbcable-{action}.log")
    } else {
        format!("driver-{action}.log")
    };
    Ok(directory.join(file_name))
}

#[cfg(target_os = "macos")]
fn macos_driver_log_path(action: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "Cannot locate the macOS home directory".to_string())?;
    let directory = std::path::PathBuf::from(home)
        .join("Library")
        .join("Logs")
        .join("Axonkey");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create the driver log directory: {error}"))?;
    Ok(directory.join(format!("miremotev-{action}.log")))
}

#[cfg(target_os = "macos")]
fn find_macos_driver_package(
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let file_name = match action {
        "install" => "MiRemoteV2ch-Install.pkg",
        "uninstall" => "MiRemoteV2ch-Uninstall.pkg",
        _ => return Err("Unsupported driver action".into()),
    };
    let mut roots = vec![resource_dir.to_path_buf()];
    if let Ok(current) = std::env::current_dir() {
        roots.push(current.clone());
        roots.push(current.join("src-tauri"));
        if let Some(parent) = current.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    for root in roots {
        for candidate in [
            root.join(file_name),
            root.join("macos").join(file_name),
            root.join("resources").join("macos").join(file_name),
            root.join("src-tauri")
                .join("resources")
                .join("macos")
                .join(file_name),
        ] {
            if candidate.is_file() {
                return candidate
                    .canonicalize()
                    .map_err(|error| format!("Cannot resolve the driver package: {error}"));
            }
        }
    }
    Err(format!(
        "{file_name} was not found. Run `make build-macos-audio` before testing installation."
    ))
}

#[cfg(target_os = "macos")]
fn run_macos_driver_action(
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<DriverActionResult, String> {
    let package = find_macos_driver_package(action, resource_dir)?;
    let log_path = macos_driver_log_path(action)?;
    let script = r#"on run argv
set packagePath to item 1 of argv
return do shell script "/usr/sbin/installer -pkg " & quoted form of packagePath & " -target /" with administrator privileges
end run"#;
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .arg(&package)
        .output()
        .map_err(|error| format!("Cannot launch the macOS driver installer: {error}"))?;
    let mut log = format!(
        "Axonkey MiRemoteV 2ch {action}\nPackage: {}\n",
        package.display()
    );
    log.push_str(&String::from_utf8_lossy(&output.stdout));
    log.push_str(&String::from_utf8_lossy(&output.stderr));
    std::fs::write(&log_path, log)
        .map_err(|error| format!("Cannot write the driver log: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "MiRemoteV 2ch {action} was cancelled or failed. Log: {}",
            log_path.display()
        ));
    }
    Ok(DriverActionResult {
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

#[cfg(target_os = "windows")]
fn run_driver_action(
    driver: &str,
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<DriverActionResult, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let log_path = driver_log_path(driver, action)?;
    let started = format!(
        "Axonkey {driver} driver {action} requested: {:?}\r\n",
        std::time::SystemTime::now()
    );
    std::fs::write(&log_path, started)
        .map_err(|error| format!("Cannot initialize the driver log: {error}"))?;

    let script = find_driver_script(driver, action, resource_dir).map_err(|error| {
        let _ = std::fs::write(&log_path, format!("ERROR: {error}\r\n"));
        format!("{error}. Log: {}", log_path.display())
    })?;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script);
    if driver == "audio" {
        command.arg("-Action").arg(action);
    }
    let status = command
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
    _app: tauri::AppHandle,
    driver: String,
    action: String,
) -> Result<DriverActionResult, String> {
    if !matches!(driver.as_str(), "input" | "audio") {
        return Err("Unsupported driver kind".into());
    }
    if !matches!(action.as_str(), "install" | "uninstall") {
        return Err("Unsupported driver action".into());
    }

    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        let resource_dir = _app
            .path()
            .resource_dir()
            .map_err(|error| format!("Cannot resolve bundled resources: {error}"))?;
        tauri::async_runtime::spawn_blocking(move || {
            run_driver_action(&driver, &action, &resource_dir)
        })
        .await
        .map_err(|error| format!("Driver task failed unexpectedly: {error}"))?
    }

    #[cfg(target_os = "macos")]
    {
        if driver != "audio" {
            return Err("macOS uses system permissions instead of an input driver".into());
        }
        let resource_dir = _app
            .path()
            .resource_dir()
            .map_err(|error| format!("Cannot resolve bundled resources: {error}"))?;
        let action_for_task = action.clone();
        _app.state::<AudioService>().pause();
        let task_result = tauri::async_runtime::spawn_blocking(move || {
            run_macos_driver_action(&action_for_task, &resource_dir)
        })
        .await;
        _app.state::<AudioService>().resume();
        let result =
            task_result.map_err(|error| format!("Driver task failed unexpectedly: {error}"))??;
        Ok(result)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = _app;
        let _ = driver;
        let _ = action;
        Err("Driver installation is only supported on Windows and macOS".into())
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

#[tauri::command]
fn open_system_settings(page: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return open_windows_settings(page);
    }

    #[cfg(target_os = "macos")]
    {
        let uri = match page.as_str() {
            "bluetooth" => "x-apple.systempreferences:com.apple.BluetoothSettings",
            "sound" => "x-apple.systempreferences:com.apple.Sound-Settings.extension",
            "inputMonitoring" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            _ => return Err("Unsupported settings page".into()),
        };
        std::process::Command::new("open")
            .arg(uri)
            .spawn()
            .map_err(|error| format!("Cannot open macOS System Settings: {error}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = page;
        Err("System settings are not supported on this platform".into())
    }
}

#[tauri::command]
fn set_permission_helper_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, PermissionHelperWindowState>,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| "Main window is unavailable".to_string())?;
        apply_permission_helper_mode(&window, &state, enabled)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = state;
        let _ = enabled;
        Err("Permission helper mode is only available on macOS".into())
    }
}

#[tauri::command]
fn reveal_current_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the current executable: {error}"))?;
        let app_bundle = app_bundle_for_executable(&executable).ok_or_else(|| {
            "Axonkey.app was not found. Install or open the packaged app first.".to_string()
        })?;
        std::process::Command::new("open")
            .arg("-R")
            .arg(app_bundle)
            .spawn()
            .map_err(|error| format!("Cannot reveal Axonkey.app in Finder: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    Err("Revealing the current app is only available on macOS".into())
}

#[tauri::command]
fn request_macos_permission(kind: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        InputService::request_permission(&kind)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("macOS permissions are only available on macOS".into())
    }
}

#[tauri::command]
fn open_external_page(page: String) -> Result<(), String> {
    let url = match page.as_str() {
        "vbcable" => "https://vb-audio.com/Cable/",
        _ => return Err("Unsupported external page".into()),
    };

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Cannot open the external page: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Err("External pages are only supported on Windows".into())
    }
}

#[derive(serde::Serialize)]
struct SystemProbe {
    platform: &'static str,
    input_driver_installed: bool,
    rc003_connected: bool,
    input_backend_ready: bool,
    input_backend_error: Option<String>,
    device_hardware_id: Option<String>,
    input_monitoring_granted: Option<bool>,
    input_authorization_stale: Option<bool>,
    accessibility_granted: Option<bool>,
    capture_active: bool,
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

#[cfg(any(target_os = "windows", test))]
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
async fn probe_rc003_battery_level(app: tauri::AppHandle) -> Option<u8> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(rc003_battery_level)
            .await
            .unwrap_or_default()
    }

    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        app.state::<AudioService>().status().battery_level
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = app;
        None
    }
}

#[cfg(target_os = "windows")]
fn vbcable_service_installed() -> Result<bool, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    match hklm.open_subkey("SYSTEM\\CurrentControlSet\\Services\\VBAudioVACMME") {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Cannot read the VB-CABLE driver registry key: {error}"
        )),
    }
}

#[tauri::command]
fn probe_audio_available(audio_service: tauri::State<'_, AudioService>) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        vbcable_service_installed()
    }

    #[cfg(target_os = "macos")]
    {
        Ok(audio_service.status().driver_installed)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = audio_service;
        Ok(false)
    }
}

#[tauri::command]
fn probe_audio_state(audio_service: tauri::State<'_, AudioService>) -> AudioServiceStatus {
    audio_service.refresh();
    audio_service.status()
}

#[tauri::command]
fn set_audio_gain(gain: i16, audio_service: tauri::State<'_, AudioService>) -> Result<(), String> {
    audio_service.set_gain_db(gain)
}

#[tauri::command]
async fn probe_rc003_connected(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;

    if app.state::<InputService>().status().device_connected {
        return Ok(true);
    }

    #[cfg(target_os = "macos")]
    {
        let audio_service = app.state::<AudioService>();
        audio_service.refresh();
        return Ok(rc003_connected(
            false,
            audio_service.status().bluetooth_connected,
        ));
    }

    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            powershell_probe(
                r#"if (@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' -and $_.InstanceId -match '(?:VID_2717|VID&012717).*(?:PID_32B8|PID&32B8)' }).Count -gt 0) { '1' } else { '0' }"#,
            )
        })
        .await
        .map_err(|error| format!("Device probe task failed unexpectedly: {error}"))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(false)
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
        let windows = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
        let input_driver_installed = std::path::PathBuf::from(windows)
            .join("System32")
            .join("drivers")
            .join("keyboard.sys")
            .is_file();
        Ok(SystemProbe {
            platform: "windows",
            input_driver_installed,
            rc003_connected: input_status.device_connected,
            input_backend_ready: input_status.backend_ready,
            input_backend_error: input_status.error,
            device_hardware_id: input_status.hardware_id,
            input_monitoring_granted: None,
            input_authorization_stale: None,
            accessibility_granted: None,
            capture_active: input_status.capture_active,
        })
    }

    #[cfg(target_os = "macos")]
    {
        let audio_service = app.state::<AudioService>();
        audio_service.refresh();
        let audio_status = audio_service.status();
        Ok(SystemProbe {
            platform: "macos",
            input_driver_installed: true,
            rc003_connected: rc003_connected(
                input_status.device_connected,
                audio_status.bluetooth_connected,
            ),
            input_backend_ready: input_status.backend_ready,
            input_backend_error: input_status.error,
            device_hardware_id: input_status.hardware_id,
            input_monitoring_granted: input_status.input_monitoring_granted,
            input_authorization_stale: Some(input_status.input_monitoring_open_denied),
            accessibility_granted: input_status.accessibility_granted,
            capture_active: input_status.capture_active,
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(SystemProbe {
            platform: "unsupported",
            input_driver_installed: false,
            rc003_connected: false,
            input_backend_ready: input_status.backend_ready,
            input_backend_error: input_status.error,
            device_hardware_id: input_status.hardware_id,
            input_monitoring_granted: None,
            input_authorization_stale: None,
            accessibility_granted: None,
            capture_active: false,
        })
    }
}

fn rc003_connected(input_connected: bool, bluetooth_connected: bool) -> bool {
    input_connected || bluetooth_connected
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(AudioService::start())
        .manage(InputService::start())
        .manage(PermissionHelperWindowState::default())
        .setup(|app| {
            use tauri::Manager;

            app.state::<InputService>()
                .set_event_app(app.handle().clone());
            install_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();

                #[cfg(target_os = "macos")]
                let _ = window
                    .app_handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            get_platform,
            launch_driver_action,
            open_windows_settings,
            open_system_settings,
            set_permission_helper_mode,
            reveal_current_app,
            open_external_page,
            request_macos_permission,
            probe_system_state,
            probe_audio_available,
            probe_audio_state,
            set_audio_gain,
            probe_rc003_connected,
            probe_rc003_battery_level,
            update_input_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Axonkey");
}

#[cfg(test)]
mod tests {
    use super::{app_bundle_for_executable, parse_battery_level, rc003_connected};

    #[test]
    fn macos_connection_uses_bluetooth_when_hid_is_not_visible() {
        assert!(rc003_connected(false, true));
        assert!(rc003_connected(true, false));
        assert!(!rc003_connected(false, false));
    }

    #[test]
    fn parses_valid_battery_percentages_only() {
        assert_eq!(parse_battery_level("91\r\n"), Some(91));
        assert_eq!(parse_battery_level("0"), Some(0));
        assert_eq!(parse_battery_level("100"), Some(100));
        assert_eq!(parse_battery_level("101"), None);
        assert_eq!(parse_battery_level("unknown"), None);
    }

    #[test]
    fn finds_the_packaged_app_bundle_from_its_executable() {
        let executable = std::path::Path::new("/Applications/Axonkey.app/Contents/MacOS/axonkey");
        assert_eq!(
            app_bundle_for_executable(executable),
            Some(std::path::PathBuf::from("/Applications/Axonkey.app"))
        );
        assert_eq!(
            app_bundle_for_executable(std::path::Path::new("/tmp/axonkey")),
            None
        );
    }
}
