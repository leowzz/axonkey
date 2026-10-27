mod audio_service;
mod backup_files;
mod devices;
mod driver_migration;
mod input_service;
mod legacy_cleanup;
mod legacy_driver;
mod profile_switch_overlay;
#[cfg(target_os = "windows")]
mod quarbor_installer;
mod release_update;
#[cfg(target_os = "windows")]
mod windows_driver_devices;

use audio_service::{AudioServiceManager, AudioServiceStatus, AudioTarget};
use input_service::managed::{
    DeviceManager, Instance as DeviceInstance, Snapshot as DeviceSnapshot,
};
use input_service::mouse::MouseService;
use input_service::{InputService, NativeSettings};
use tauri::{Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";
const AUTOSTART_ARG: &str = "--autostart";
const LEGACY_AUTOSTART_MARKER: &str = "autostart-initialized";
const BACKGROUND_AUTOSTART_MARKER: &str = "autostart-background-initialized";
const PERMISSION_HELPER_WIDTH: f64 = 430.0;
const PERMISSION_HELPER_HEIGHT: f64 = 560.0;
const RUNTIME_LOG_FILE_BASENAME: &str = "axonkey";
const RUNTIME_LOG_MAX_BYTES: u128 = 5_000_000;
const RUNTIME_LOG_KEEP_FILES: usize = 5;

#[derive(Clone, Copy)]
struct WindowGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    resizable: bool,
    always_on_top: bool,
}

#[derive(Default)]
struct PermissionHelperWindowState(std::sync::Mutex<Option<WindowGeometry>>);

fn initialize_autostart(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_autostart::ManagerExt;

    let directory = app.path().app_config_dir()?;
    let marker = directory.join(BACKGROUND_AUTOSTART_MARKER);
    // Apply the default once and migrate legacy entries, preserving user changes.
    if marker.try_exists()? {
        return Ok(());
    }
    std::fs::create_dir_all(&directory)?;
    let autostart = app.autolaunch();
    let was_enabled = autostart.is_enabled()?;
    let legacy_marker = directory.join(LEGACY_AUTOSTART_MARKER);
    let had_legacy_initialization = legacy_marker.try_exists()?;
    let should_be_enabled = !had_legacy_initialization || was_enabled;
    if should_be_enabled {
        autostart.enable()?;
    }
    if should_be_enabled && !autostart.is_enabled()? {
        return Err("Autostart did not become enabled".into());
    }
    std::fs::write(marker, b"initialized\n")?;
    Ok(())
}

fn args_request_autostart<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == AUTOSTART_ARG)
}

fn launched_from_autostart() -> bool {
    args_request_autostart(std::env::args())
}

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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogInfo {
    directory: String,
    current_file: String,
}

fn runtime_log_info(app: &tauri::AppHandle) -> Result<LogInfo, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Cannot resolve the Axonkey log directory: {error}"))?;
    let current_file = directory.join(format!("{RUNTIME_LOG_FILE_BASENAME}.log"));
    Ok(LogInfo {
        directory: directory.to_string_lossy().into_owned(),
        current_file: current_file.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn get_log_info(app: tauri::AppHandle) -> Result<LogInfo, String> {
    runtime_log_info(&app)
}

#[tauri::command]
fn open_log_directory(app: tauri::AppHandle) -> Result<LogInfo, String> {
    let info = runtime_log_info(&app)?;
    let directory = std::path::Path::new(&info.directory);
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Cannot create the Axonkey log directory: {error}"))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(directory)
            .spawn()
            .map_err(|error| format!("Cannot open the Axonkey log directory: {error}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        // The bundle identifier makes the log directory end in `.app`.
        // Opening it launches it as an application; reveal a log inside instead.
        let current_file = std::path::Path::new(&info.current_file);
        let reveal_target = if current_file.is_file() {
            current_file
        } else {
            directory
        };
        let output = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(reveal_target)
            .output()
            .map_err(|error| format!("Cannot open the Axonkey log directory: {error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Cannot open the Axonkey log directory ({}): {}",
                output.status,
                detail.trim(),
            ));
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = directory;
        return Err("Opening the Axonkey log directory is not supported on this platform".into());
    }

    Ok(info)
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
fn find_driver_helper(
    driver: &str,
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let file_name = match (driver, action) {
        ("audio", "install" | "uninstall") => "vbcable-driver.ps1",
        ("legacy", "cleanup" | "status") => "uninstall-old-driver.exe",
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

    Err(format!("Driver helper was not found: {file_name}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverActionResult {
    log_path: String,
    reboot_required: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedDriverUninstallFailure {
    instance_id: String,
    error: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedDriverUninstallResult {
    device_count: usize,
    uninstalled_count: usize,
    unbound_count: usize,
    reboot_required: bool,
    failures: Vec<ManagedDriverUninstallFailure>,
}

#[cfg(target_os = "windows")]
fn driver_log_path(
    app: &tauri::AppHandle,
    driver: &str,
    action: &str,
) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create the driver log directory: {error}"))?;
    let file_name = if driver == "audio" {
        format!("vbcable-{action}.log")
    } else if driver == "legacy" {
        "old-driver-uninstall.log".to_string()
    } else {
        format!("quarbor-{action}.log")
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
        reboot_required: false,
    })
}

#[cfg(target_os = "windows")]
fn run_driver_action(
    app: &tauri::AppHandle,
    driver: &str,
    action: &str,
    resource_dir: &std::path::Path,
) -> Result<DriverActionResult, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let log_path = driver_log_path(app, driver, action)?;
    let started = format!(
        "Axonkey {driver} driver {action} requested: {:?}\r\n",
        std::time::SystemTime::now()
    );
    std::fs::write(&log_path, started)
        .map_err(|error| format!("Cannot initialize the driver log: {error}"))?;

    let helper = find_driver_helper(driver, action, resource_dir).map_err(|error| {
        let _ = std::fs::write(&log_path, format!("ERROR: {error}\r\n"));
        format!("{error}. Log: {}", log_path.display())
    })?;
    let _ = std::fs::OpenOptions::new()
        .append(true)
        .open(&log_path)
        .and_then(|mut file| {
            use std::io::Write;
            writeln!(file, "Helper: {}", helper.display())
        });
    let mut command = if driver == "legacy" {
        let mut command = std::process::Command::new(&helper);
        command
            .arg("--confirmed")
            .arg("--headless")
            .arg("--log-path")
            .arg(&log_path);
        command
    } else {
        let mut command = std::process::Command::new("powershell.exe");
        command
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-WindowStyle")
            .arg("Hidden")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&helper)
            .arg("-Action")
            .arg(action)
            .arg("-LogPath")
            .arg(&log_path);
        command
    };
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            let message = format!("Cannot launch the driver helper: {error}");
            let _ = std::fs::write(&log_path, format!("ERROR: {message}\r\n"));
            format!("{message}. Log: {}", log_path.display())
        })?;

    if let Ok(mut log) = std::fs::OpenOptions::new().append(true).open(&log_path) {
        use std::io::Write;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stdout.trim().is_empty() {
            let _ = writeln!(log, "stdout:\r\n{stdout}");
        }
        if !stderr.trim().is_empty() {
            let _ = writeln!(log, "stderr:\r\n{stderr}");
        }
    }

    if !output.status.success() {
        let exit_code = output
            .status
            .code()
            .map_or_else(|| "unknown".to_string(), |code| code.to_string());
        let detail = std::fs::read_to_string(&log_path)
            .ok()
            .and_then(|contents| {
                let lines = contents
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>();
                if lines.is_empty() {
                    None
                } else {
                    let mut text = lines.into_iter().rev().collect::<Vec<_>>().join(" | ");
                    if text.len() > 800 {
                        text = text.chars().take(800).collect();
                        text.push('…');
                    }
                    Some(text)
                }
            });
        let detail_suffix = detail
            .map(|text| format!(" 详情: {text}."))
            .unwrap_or_default();
        return Err(format!(
            "Driver {action} failed with exit code {exit_code}.{detail_suffix} Log: {}",
            log_path.display(),
        ));
    }

    Ok(DriverActionResult {
        log_path: log_path.to_string_lossy().into_owned(),
        reboot_required: true,
    })
}

#[tauri::command]
async fn launch_driver_action(
    _app: tauri::AppHandle,
    driver: String,
    action: String,
) -> Result<DriverActionResult, String> {
    if driver != "audio" {
        return Err("Unsupported driver kind".into());
    }
    if !matches!(action.as_str(), "install" | "uninstall") {
        return Err("Unsupported driver action".into());
    }
    log::info!(target: "axonkey::runtime", "Driver action requested: {driver}/{action}");

    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        let resource_dir = _app
            .path()
            .resource_dir()
            .map_err(|error| format!("Cannot resolve bundled resources: {error}"))?;
        tauri::async_runtime::spawn_blocking(move || {
            run_driver_action(&_app, &driver, &action, &resource_dir)
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
        _app.state::<AudioServiceManager>().pause(None);
        let task_result = tauri::async_runtime::spawn_blocking(move || {
            run_macos_driver_action(&action_for_task, &resource_dir)
        })
        .await;
        _app.state::<AudioServiceManager>().resume(None);
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

#[cfg(target_os = "windows")]
fn run_device_driver_action(
    app: &tauri::AppHandle,
    action: &str,
    resource_dir: &std::path::Path,
    target: &str,
) -> Result<DriverActionResult, String> {
    let log_path = driver_log_path(app, "input", action)?;
    std::fs::write(
        &log_path,
        format!(
            "Axonkey device driver {action} requested for {target:?}: {:?}\r\n",
            std::time::SystemTime::now()
        ),
    )
    .map_err(|error| format!("Cannot initialize the driver log: {error}"))?;
    let reboot_required =
        quarbor_installer::run_for_device(action, resource_dir, target, &log_path)?;
    Ok(DriverActionResult {
        log_path: log_path.to_string_lossy().into_owned(),
        reboot_required,
    })
}

#[cfg(target_os = "windows")]
fn run_uninstall_all_driver_action(
    app: &tauri::AppHandle,
    resource_dir: &std::path::Path,
) -> Result<DriverActionResult, String> {
    let log_path = driver_log_path(app, "input", "uninstall-all")?;
    std::fs::write(
        &log_path,
        format!(
            "Axonkey device driver uninstall-all requested: {:?}\r\n",
            std::time::SystemTime::now()
        ),
    )
    .map_err(|error| format!("Cannot initialize the driver log: {error}"))?;
    let exe = quarbor_installer::find(resource_dir)?;
    let reply = quarbor_installer::invoke(&exe, "uninstall-all", None, Some(&log_path))?;
    Ok(DriverActionResult {
        log_path: log_path.to_string_lossy().into_owned(),
        reboot_required: reply.reboot_required || reply.exit_code == 3010,
    })
}

#[tauri::command]
async fn install_device_driver(
    _app: tauri::AppHandle,
    instance_id: String,
) -> Result<DriverActionResult, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        let target = resolve_quarbor_target(&_app, &instance_id)?;
        let resource_dir = _app
            .path()
            .resource_dir()
            .map_err(|error| format!("Cannot resolve bundled resources: {error}"))?;
        let target_for_store = target.clone();
        let app_for_task = _app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_device_driver_action(&app_for_task, "install", &resource_dir, &target)
        })
        .await
        .map_err(|error| format!("Driver task failed unexpectedly: {error}"))??;
        _app.state::<DeviceManager>()
            .remember_quarbor_target(&instance_id, &target_for_store)?;
        Ok(result)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (_app, instance_id);
        Err("设备驱动安装仅支持 Windows".into())
    }
}

#[tauri::command]
async fn unbind_device_instance(
    app: tauri::AppHandle,
    instance_id: String,
) -> Result<DeviceSnapshot, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        if let Some(target) = resolve_installed_quarbor_target(&app, &instance_id)? {
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|error| format!("Cannot resolve bundled resources: {error}"))?;
            let app_for_task = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                run_device_driver_action(&app_for_task, "uninstall", &resource_dir, &target)
            })
            .await
            .map_err(|error| format!("Driver task failed unexpectedly: {error}"))??;
        }

        let manager = app.state::<DeviceManager>();
        let snapshot = manager.unbind(&instance_id)?;
        app.state::<AudioServiceManager>()
            .sync_instances(&audio_targets(&snapshot));
        return Ok(snapshot);
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri::Manager;
        let manager = app.state::<DeviceManager>();
        let snapshot = manager.unbind(&instance_id)?;
        app.state::<AudioServiceManager>()
            .sync_instances(&audio_targets(&snapshot));
        Ok(snapshot)
    }
}

#[tauri::command]
async fn uninstall_bound_device_drivers(
    app: tauri::AppHandle,
) -> Result<ManagedDriverUninstallResult, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        let instance_ids = app
            .state::<DeviceManager>()
            .snapshot()
            .store
            .instances
            .iter()
            .filter(|instance| {
                matches!(instance.kind.as_str(), "rc003" | "cmiotA15") && instance.binding.is_some()
            })
            .map(|instance| instance.id.clone())
            .collect::<Vec<_>>();
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| format!("Cannot resolve bundled resources: {error}"))?;
        let manager = app.state::<DeviceManager>();
        let mut result = ManagedDriverUninstallResult {
            device_count: 0,
            uninstalled_count: 0,
            unbound_count: 0,
            reboot_required: false,
            failures: Vec::new(),
        };
        result.device_count = instance_ids.len();
        if instance_ids.is_empty() {
            return Ok(result);
        }

        // The global action must release every per-device pipe before the
        // installer removes all bindings in one transaction.
        manager.pause_for_driver_migration();
        let app_for_task = app.clone();
        let action_result = tauri::async_runtime::spawn_blocking(move || {
            run_uninstall_all_driver_action(&app_for_task, &resource_dir)
        })
        .await;
        manager.resume_after_driver_migration();
        let action =
            action_result.map_err(|error| format!("Driver task failed unexpectedly: {error}"))?;

        match action {
            Ok(action) => {
                result.uninstalled_count = result.device_count;
                result.reboot_required = action.reboot_required;
                for instance_id in instance_ids {
                    match manager.unbind(&instance_id) {
                        Ok(_) => result.unbound_count += 1,
                        Err(error) => result
                            .failures
                            .push(ManagedDriverUninstallFailure { instance_id, error }),
                    }
                }
            }
            Err(error) => {
                result.failures = instance_ids
                    .into_iter()
                    .map(|instance_id| ManagedDriverUninstallFailure {
                        instance_id,
                        error: error.clone(),
                    })
                    .collect();
            }
        }
        if result.unbound_count > 0 {
            let snapshot = manager.snapshot();
            app.state::<AudioServiceManager>()
                .sync_instances(&audio_targets(&snapshot));
        }
        return Ok(result);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("设备驱动卸载仅支持 Windows".into())
    }
}

#[tauri::command]
fn open_windows_settings(page: String) -> Result<(), String> {
    let target = match page.as_str() {
        "bluetooth" => "ms-settings:bluetooth",
        "sound" => "ms-settings:sound",
        "services" => "services.msc",
        _ => return Err("Unsupported settings page".into()),
    };
    log::info!(target: "axonkey::runtime", "Opening Windows settings page: {page}");

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(target)
            .spawn()
            .map_err(|error| format!("Cannot open Windows settings: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("Windows settings are only available on Windows".into())
    }
}

#[tauri::command]
fn open_system_settings(page: String) -> Result<(), String> {
    log::info!(target: "axonkey::runtime", "Opening system settings page: {page}");
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
        let result = InputService::request_permission(&kind);
        match &result {
            Ok(granted) => {
                log::info!(target: "axonkey::runtime", "macOS permission request completed: kind={kind}, granted={granted}")
            }
            Err(error) => {
                log::warn!(target: "axonkey::runtime", "macOS permission request failed: kind={kind}, error={error}")
            }
        }
        result
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
        "github" => "https://github.com/leowzz/axonkey",
        "releases" => "https://github.com/leowzz/axonkey/releases",
        _ => return Err("Unsupported external page".into()),
    };
    log::info!(target: "axonkey::runtime", "Opening external page: {page}");

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

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|error| format!("Cannot open the external page: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("Cannot open the external page in the default browser".into())
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = url;
        Err("External pages are only supported on macOS and Windows".into())
    }
}

#[derive(serde::Serialize)]
struct SystemProbe {
    platform: &'static str,
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
fn resolve_quarbor_target(app: &tauri::AppHandle, instance_id: &str) -> Result<String, String> {
    use tauri::Manager;

    let snapshot = app.state::<DeviceManager>().snapshot();
    let instance = snapshot
        .store
        .instances
        .iter()
        .find(|instance| {
            instance.id == instance_id && matches!(instance.kind.as_str(), "rc003" | "cmiotA15")
        })
        .ok_or_else(|| "未找到要安装驱动的设备实例。".to_string())?;
    if instance.binding.is_none() {
        return Err("请先绑定物理设备。".into());
    }
    let devices = windows_driver_devices::list()?;
    input_service::managed::driver_target(
        instance,
        &snapshot.store.instances,
        &snapshot.discovered,
        &devices,
    )
    .map(|(target, _)| target)
    .ok_or_else(|| "未找到该设备对应的 Quarbor 设备节点，请先连接并唤醒设备。".into())
}

#[cfg(target_os = "windows")]
fn resolve_installed_quarbor_target(
    app: &tauri::AppHandle,
    instance_id: &str,
) -> Result<Option<String>, String> {
    use tauri::Manager;

    let snapshot = app.state::<DeviceManager>().snapshot();
    let instance = snapshot
        .store
        .instances
        .iter()
        .find(|instance| instance.id == instance_id)
        .ok_or_else(|| "未找到要解除绑定的设备实例。".to_string())?;
    if !matches!(instance.kind.as_str(), "rc003" | "cmiotA15") || instance.binding.is_none() {
        return Ok(None);
    }
    let devices = windows_driver_devices::list()?;
    Ok(input_service::managed::driver_target(
        instance,
        &snapshot.store.instances,
        &snapshot.discovered,
        &devices,
    )
    .filter(|(_, installed)| *installed)
    .map(|(target, _)| target))
}

#[tauri::command]
fn probe_audio_available(
    instance_id: Option<String>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        audio_service.refresh(instance_id.as_deref());
        Ok(audio_service
            .status(instance_id.as_deref())
            .driver_installed)
    }

    #[cfg(target_os = "macos")]
    {
        Ok(audio_service
            .status(instance_id.as_deref())
            .driver_installed)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = audio_service;
        Ok(false)
    }
}

#[tauri::command]
fn probe_cable_driver() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        // Match the service checked by vbcable-driver.ps1, independently of
        // remote connections and the user's selected playback endpoint.
        match RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SYSTEM\CurrentControlSet\Services\VBAudioVACMME")
        {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("无法读取 CABLE 驱动状态：{error}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    Err("CABLE 驱动管理仅支持 Windows".into())
}

#[tauri::command]
fn probe_audio_state(
    instance_id: Option<String>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> AudioServiceStatus {
    audio_service.refresh(instance_id.as_deref());
    audio_service.status(instance_id.as_deref())
}

fn default_voice_output_device() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let devices: Vec<String> = host
            .output_devices()
            .map(|devices| {
                devices
                    .filter_map(|device| {
                        device
                            .description()
                            .ok()
                            .map(|description| description.name().to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        let preferred = devices.iter().find(|name| {
            let normalized = name.trim().to_ascii_lowercase();
            normalized.starts_with("cable input") && !normalized.contains("16ch")
        });
        return preferred
            .cloned()
            .or_else(|| {
                host.default_output_device()
                    .and_then(|device| device.description().ok())
                    .map(|description| description.name().to_string())
            })
            .or_else(|| devices.first().cloned());
    }
    #[cfg(target_os = "macos")]
    {
        return Some("MiRemoteV 2ch".to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    None
}

fn audio_targets(snapshot: &DeviceSnapshot) -> Vec<AudioTarget> {
    snapshot
        .store
        .instances
        .iter()
        .filter(|instance| {
            instance.kind == "rc003"
                || (cfg!(any(windows, target_os = "macos")) && instance.kind == "cmiotA15")
        })
        .map(|instance| {
            let voice_target = instance.voice_target.clone().or_else(|| {
                instance.binding.as_ref().and_then(|binding| {
                    snapshot
                        .discovered
                        .iter()
                        .find(|device| &device.id == binding)
                        .and_then(|device| device.bluetooth_address.clone())
                })
            });
            AudioTarget {
                instance_id: instance.id.clone(),
                kind: instance.kind.clone(),
                voice_target,
                output_device: instance
                    .voice_output_device
                    .clone()
                    .map(|device| device.trim().to_string())
                    .filter(|device| !device.is_empty()),
                gain_db: instance.audio_gain_db,
                enabled: instance.enabled && instance.binding.is_some(),
            }
        })
        .collect()
}

#[tauri::command]
async fn list_voice_output_devices() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            use cpal::traits::{DeviceTrait, HostTrait};
            let host = cpal::default_host();
            let devices = host
                .output_devices()
                .map_err(|error| format!("无法获取音频输出设备：{error}"))?;
            devices
                .map(|device| {
                    device
                        .description()
                        .map(|description| description.name().to_string())
                        .map_err(|error| format!("无法读取音频输出设备名称：{error}"))
                })
                .collect()
        }
        #[cfg(target_os = "macos")]
        {
            Ok(vec!["MiRemoteV 2ch".to_string()])
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Err("当前系统暂不支持语音输出设备列表".to_string())
        }
    })
    .await
    .map_err(|error| format!("获取音频输出设备失败：{error}"))?
}

#[tauri::command]
async fn restart_audio_service(
    app: tauri::AppHandle,
    instance_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<AudioServiceManager>()
                .restart(instance_id.as_deref())
        })
        .await
        .map_err(|error| format!("音频重启失败：{error}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("手动重启虚拟麦克风仅支持 macOS".into())
    }
}

#[tauri::command]
async fn open_signal_monitor(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_webview_window("signal-monitor") {
            window.unminimize().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            return window.set_focus().map_err(|e| e.to_string());
        }
        tauri::WebviewWindowBuilder::new(
            &app,
            "signal-monitor",
            tauri::WebviewUrl::App("bluetooth-signal.html".into()),
        )
        .title("语音链路监测 · Axonkey")
        .inner_size(1080.0, 760.0)
        .min_inner_size(680.0, 540.0)
        .build()
        .map_err(|e| format!("无法打开语音链路监测：{e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("语音链路监测目前仅支持 macOS".into())
    }
}

#[tauri::command]
async fn get_signal_monitor_state(
    app: tauri::AppHandle,
    instance_id: Option<String>,
    after: Option<u64>,
    clear: Option<bool>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<AudioServiceManager>().signal_snapshot(
                instance_id.as_deref(),
                after,
                clear.unwrap_or(false),
            )
        })
        .await
        .map_err(|e| format!("无法读取监测数据：{e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, after, clear);
        Err("语音链路监测目前仅支持 macOS".into())
    }
}

#[tauri::command]
async fn export_signal_monitor(
    window: tauri::WebviewWindow,
    content: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if content.len() > 4_000_000 {
        return Err("导出数据过大，请缩短采集时间后重试".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name("语音链路监测读数.csv")
            .add_filter("CSV", &["csv"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path
            .into_path()
            .map_err(|e| format!("无法使用所选位置：{e}"))?;
        std::fs::write(path, content).map_err(|e| format!("无法保存读数：{e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("导出失败：{e}"))?
}

#[tauri::command]
fn get_audio_test_state(
    instance_id: Option<String>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> (AudioServiceStatus, audio_service::AudioLevel) {
    (
        audio_service.status(instance_id.as_deref()),
        audio_service.level(instance_id.as_deref()),
    )
}

#[tauri::command]
fn set_audio_stretch_compensation(
    enabled: bool,
    instance_id: Option<String>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        audio_service.set_stretch_compensation(instance_id.as_deref(), enabled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (enabled, audio_service);
        Err("拉伸补偿实验仅支持 macOS".into())
    }
}

#[tauri::command]
fn set_audio_gain(
    gain: i16,
    instance_id: Option<String>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> Result<(), String> {
    audio_service.set_gain_db(instance_id.as_deref(), gain)
}

#[tauri::command]
fn refresh_device_information(
    binding: String,
    manager: tauri::State<'_, DeviceManager>,
) -> Result<DeviceSnapshot, String> {
    manager.refresh_information(&binding)
}

#[tauri::command]
fn device_snapshot(
    manager: tauri::State<'_, DeviceManager>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> DeviceSnapshot {
    let mut snapshot = manager.snapshot();
    audio_service.sync_instances(&audio_targets(&snapshot));
    for instance in &snapshot.store.instances {
        if instance.kind == "rc003" {
            if let Some(status) = snapshot.runtime.get_mut(&instance.id) {
                status.recording = audio_service.status(Some(&instance.id)).forwarding;
            }
        }
    }
    snapshot
}

#[tauri::command]
fn put_device_instance(
    revision: u64,
    mut instance: DeviceInstance,
    manager: tauri::State<'_, DeviceManager>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> Result<DeviceSnapshot, String> {
    if instance.id.is_empty() && instance.voice_output_device.is_none() {
        instance.voice_output_device = default_voice_output_device();
    }
    let snapshot = manager.put(revision, instance)?;
    audio_service.sync_instances(&audio_targets(&snapshot));
    Ok(snapshot)
}

#[tauri::command]
fn remove_device_instance(
    revision: u64,
    id: String,
    manager: tauri::State<'_, DeviceManager>,
    audio_service: tauri::State<'_, AudioServiceManager>,
) -> Result<DeviceSnapshot, String> {
    let snapshot = manager.remove(revision, &id)?;
    audio_service.sync_instances(&audio_targets(&snapshot));
    Ok(snapshot)
}

#[tauri::command]
fn update_input_settings(
    settings: NativeSettings,
    input_service: tauri::State<'_, InputService>,
    mouse_service: tauri::State<'_, MouseService>,
    manager: tauri::State<'_, DeviceManager>,
) -> Result<(), String> {
    log::debug!(target: "axonkey::runtime", "Applying input settings from frontend");
    manager.set_enabled(settings.enabled);
    input_service.update_settings(settings.clone())?;
    mouse_service.update_settings(&settings)
}

#[tauri::command]
fn write_mapping_file(path: String, content: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Mapping file path is empty".into());
    }
    let result = std::fs::write(&path, content)
        .map_err(|error| format!("Cannot save mapping file: {error}"));
    match &result {
        Ok(()) => log::info!(target: "axonkey::runtime", "Mapping file exported successfully"),
        Err(error) => log::warn!(target: "axonkey::runtime", "Mapping file export failed: {error}"),
    }
    result
}

#[tauri::command]
async fn probe_system_state(app: tauri::AppHandle) -> Result<SystemProbe, String> {
    use tauri::Manager;

    let input_status = app.state::<InputService>().status();
    log::debug!(target: "axonkey::runtime", "Running system state probe");

    #[cfg(target_os = "windows")]
    {
        Ok(SystemProbe {
            platform: "windows",
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
        let audio_service = app.state::<AudioServiceManager>();
        audio_service.refresh(None);
        let audio_status = audio_service.status(None);
        Ok(SystemProbe {
            platform: "macos",
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

fn start_device_services(app: &tauri::AppHandle) -> Result<(), String> {
    let device_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("device-instances.json");
    app.manage(AudioServiceManager::start());
    #[cfg(target_os = "windows")]
    let input_service = InputService::start(std::sync::Arc::new(
        std::sync::atomic::AtomicBool::new(false),
    ));
    #[cfg(not(target_os = "windows"))]
    let input_service = InputService::start();
    app.manage(input_service);
    app.manage(MouseService::start());
    let device_manager = DeviceManager::start(app.clone(), device_path);
    let initial_snapshot = device_manager.snapshot();
    app.manage(device_manager);
    app.state::<AudioServiceManager>()
        .sync_instances(&audio_targets(&initial_snapshot));
    app.state::<InputService>().set_event_app(app.clone());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some(RUNTIME_LOG_FILE_BASENAME.into()),
                    }),
                ])
                .max_file_size(RUNTIME_LOG_MAX_BYTES)
                .rotation_strategy(RotationStrategy::KeepSome(RUNTIME_LOG_KEEP_FILES))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args_request_autostart(args) {
                log::info!(target: "axonkey::runtime", "Existing instance received an autostart launch");
                return;
            }
            log::info!(target: "axonkey::runtime", "Existing instance requested focus");
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(|current, release| {
                    release_update::is_newer_release(&current, &release.version)
                })
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .setup(|app| {
            use tauri::Manager;

            let default_panic_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |panic| {
                log::error!(target: "axonkey::panic", "Unhandled Rust panic: {panic}");
                default_panic_hook(panic);
            }));
            log::info!(
                target: "axonkey::runtime",
                "Axonkey {} starting on {} ({})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
            );
            match runtime_log_info(app.handle()) {
                Ok(info) => log::info!(
                    target: "axonkey::runtime",
                    "Runtime log file: {} (max {} bytes, {} rotated files kept)",
                    info.current_file,
                    RUNTIME_LOG_MAX_BYTES,
                    RUNTIME_LOG_KEEP_FILES,
                ),
                Err(error) => log::warn!(target: "axonkey::runtime", "Cannot resolve runtime log path: {error}"),
            }
            if let Err(error) = initialize_autostart(app.handle()) {
                log::warn!(target: "axonkey::runtime", "Cannot initialize autostart: {error}");
            }
            #[cfg(target_os = "windows")]
            app.manage(driver_migration::MigrationState::default());
            #[cfg(target_os = "windows")]
            app.manage(legacy_cleanup::CleanupState::default());
            #[cfg(not(target_os = "windows"))]
            start_device_services(app.handle()).map_err(std::io::Error::other)?;
            app.manage(PermissionHelperWindowState::default());
            app.manage(profile_switch_overlay::OverlayState::default());
            app.manage(legacy_driver::LegacyProbeState::default());
            if let Err(error) = install_tray(app) {
                log::error!(target: "axonkey::runtime", "Failed to install the system tray: {error}");
                return Err(error.into());
            }
            if launched_from_autostart() {
                #[cfg(target_os = "macos")]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                log::info!(target: "axonkey::runtime", "Autostart launch will remain in the background");
            } else {
                show_main_window(app.handle());
            }
            #[cfg(target_os = "windows")]
            legacy_cleanup::initialize(app.handle().clone());
            log::info!(target: "axonkey::runtime", "Axonkey startup completed");
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "signal-monitor" && matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<AudioServiceManager>()
                    .stop_signal_monitor(None);
            }
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.try_state::<driver_migration::MigrationState>().is_some_and(|s| s.blocks_close())
                    || window.try_state::<legacy_cleanup::CleanupState>().is_some_and(|s| s.blocks_close()) {
                    return;
                }
                let _ = window.hide();
                log::debug!(target: "axonkey::runtime", "Main window hidden after close request");

                #[cfg(target_os = "macos")]
                let _ = window
                    .app_handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        })
        .invoke_handler(tauri::generate_handler![
            legacy_cleanup::get_legacy_cleanup,
            legacy_cleanup::check_legacy_cleanup,
            legacy_cleanup::run_legacy_cleanup,
            driver_migration::get_driver_migration,
            driver_migration::check_driver_migration,
            driver_migration::run_driver_migration,
            release_update::check_release_update,
            profile_switch_overlay::show_profile_switch_overlay,
            profile_switch_overlay::get_profile_switch_overlay,
            profile_switch_overlay::reveal_profile_switch_overlay,
            profile_switch_overlay::hide_profile_switch_overlay,
            ping,
            get_platform,
            get_log_info,
            open_log_directory,
            launch_driver_action,
            install_device_driver,
            unbind_device_instance,
            uninstall_bound_device_drivers,
            open_windows_settings,
            open_system_settings,
            set_permission_helper_mode,
            reveal_current_app,
            open_external_page,
            request_macos_permission,
            probe_system_state,
            probe_audio_available,
            probe_audio_state,
            probe_cable_driver,
            list_voice_output_devices,
            restart_audio_service,
            get_audio_test_state,
            set_audio_gain,
            set_audio_stretch_compensation,
            open_signal_monitor,
            get_signal_monitor_state,
            export_signal_monitor,
            update_input_settings,
            device_snapshot,
            refresh_device_information,
            put_device_instance,
            remove_device_instance,
            write_mapping_file,
            backup_files::open_backup_location,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Axonkey")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            }
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(service) = app.try_state::<DeviceManager>() { service.shutdown(); }
                if let Some(service) = app.try_state::<MouseService>() { service.shutdown(); }
            }
            #[cfg(windows)]
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(service) = app.try_state::<InputService>() { service.shutdown(); }
            }
            #[cfg(not(windows))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::{app_bundle_for_executable, args_request_autostart, rc003_connected};

    #[test]
    fn recognizes_only_the_autostart_launch_argument() {
        assert!(args_request_autostart(["axonkey", "--autostart"]));
        assert!(args_request_autostart([
            "axonkey",
            "--other",
            "--autostart",
        ]));
        assert!(!args_request_autostart(["axonkey"]));
        assert!(!args_request_autostart(["axonkey", "--autostarted"]));
    }

    #[test]
    fn macos_connection_uses_bluetooth_when_hid_is_not_visible() {
        assert!(rc003_connected(false, true));
        assert!(rc003_connected(true, false));
        assert!(!rc003_connected(false, false));
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
