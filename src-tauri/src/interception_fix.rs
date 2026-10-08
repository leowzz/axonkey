#[tauri::command]
pub async fn interception_fix_action(
    _app: tauri::AppHandle,
    action: String,
) -> Result<serde_json::Value, String> {
    if !matches!(action.as_str(), "status" | "install" | "uninstall") {
        return Err("Unsupported reconnect-fix action".into());
    }
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let resources = _app.path().resource_dir().map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || run(&resources, &action))
            .await
            .map_err(|e| format!("Reconnect-fix task failed: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    Err("Reconnect fix is available only on Windows".into())
}

#[cfg(target_os = "windows")]
fn run(resources: &std::path::Path, action: &str) -> Result<serde_json::Value, String> {
    use std::{os::windows::process::CommandExt, process::Command};
    // Never search cwd: an elevated service-management script must be a bundled
    // resource or the fixed development checkout, not an arbitrary local file.
    let script = resources.join("scripts/interception-fix.ps1");
    #[cfg(debug_assertions)]
    let script = if script.is_file() {
        script
    } else {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/interception-fix.ps1")
    };
    if !script.is_file() {
        return Err("Reconnect-fix management script is missing. Reinstall Axonkey.".into());
    }
    let system_root = std::env::var_os("SystemRoot").ok_or("Cannot locate Windows")?;
    let powershell = std::path::PathBuf::from(system_root)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = Command::new(powershell)
        .creation_flags(0x0800_0000)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-Action", action, "-Confirmed"])
        .output()
        .map_err(|e| format!("Cannot launch reconnect-fix management: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "操作已取消或失败（{}）。{} 检查 %LOCALAPPDATA%\\Axonkey\\logs 和 %ProgramData%\\Axonkey Interception Fix\\logs。",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if action == "status" {
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Cannot read service status: {e}"))
    } else {
        Ok(serde_json::json!({ "restartRequired": true }))
    }
}
