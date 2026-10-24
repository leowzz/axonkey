use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const INSTALLER: &str = "QuarborUniversalKeyboardDriverInstaller.exe";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub instance_id: String,
    #[serde(default)]
    pub hardware_id: String,
    pub present: bool,
    pub bound: bool,
    pub recovery_active: bool,
}

impl Device {
    pub fn is_rc003(&self) -> bool {
        let id = self.instance_id.to_ascii_uppercase();
        let hardware = self.hardware_id.to_ascii_uppercase();
        if !id.starts_with("BTHLEDEVICE\\") {
            return false;
        }
        let text = format!("{id} {hardware}");
        let tokens: Vec<_> = text.split(['&', '_', '\\', ' ']).collect();
        tokens
            .windows(2)
            .any(|pair| pair[0] == "VID" && matches!(pair[1], "2717" | "012717"))
            && tokens
                .windows(2)
                .any(|pair| pair[0] == "PID" && pair[1] == "32B8")
    }

    pub fn needs_uninstall(&self) -> bool {
        self.is_rc003() && (self.bound || self.recovery_active)
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    version: u32,
    action: String,
    outcome: String,
    exit_code: i32,
    reboot_required: bool,
    message: String,
    #[serde(default)]
    devices: Vec<Device>,
}

fn decode_reply(bytes: &[u8], code: Option<i32>, action: &str) -> Result<Reply, String> {
    if code == Some(1223) {
        return Err("已取消管理员授权，驱动操作未完成。".into());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("Quarbor 安装器返回了无效 UTF-8：{error}"))?;
    let reply: Reply = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Quarbor 安装器返回了无效 JSON（退出码 {code:?}）：{error}"))?;
    if reply.version != 1 || reply.action != action || Some(reply.exit_code) != code {
        return Err("Quarbor 安装器返回的版本、动作或退出码不一致。".into());
    }
    if !matches!(code, Some(0 | 3010))
        || !matches!(
            reply.outcome.as_str(),
            "success" | "success_with_warnings" | "reboot_required"
        )
    {
        return Err(format!(
            "Quarbor 操作失败（{}）：{}",
            reply.exit_code, reply.message
        ));
    }
    Ok(reply)
}

pub(crate) fn find(resource_dir: &Path) -> Result<PathBuf, String> {
    let mut roots = vec![resource_dir.to_path_buf()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    // Source checkout fallback is only used by development builds.
    if cfg!(debug_assertions) {
        roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
    }
    for root in roots {
        let candidate = root
            .join("vendor")
            .join("QuarborUniversalKeyboardDriverInstaller")
            .join(INSTALLER);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("未找到 Quarbor 安装器：{INSTALLER}"))
}

fn invoke(exe: &Path, action: &str, id: Option<&str>, log: Option<&Path>) -> Result<Reply, String> {
    let output_path = std::env::temp_dir().join(format!(
        "axonkey-quarbor-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("无法生成 Quarbor 输出文件名：{error}"))?
            .as_nanos()
    ));
    let mut command = Command::new(exe);
    command
        .creation_flags(0x0800_0000)
        .arg(format!("--{action}"));
    if let Some(id) = id {
        command.arg(id);
    }
    command.arg("--output").arg(&output_path);
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    let output = command
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 Quarbor 安装器：{error}"))?;
    // The installer is a GUI-subsystem executable. Its command-line worker can
    // finish writing --output after the parent process has returned, so wait
    // briefly for the documented JSON file instead of relying on stdout.
    let mut reply_bytes = None;
    for _ in 0..100 {
        if output_path.is_file() {
            match std::fs::read(&output_path) {
                Ok(bytes) if !bytes.is_empty() => {
                    reply_bytes = Some(bytes);
                    break;
                }
                Ok(_) | Err(_) => {}
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let log_result = if let Some(path) = log {
        let response = String::from_utf8_lossy(reply_bytes.as_deref().unwrap_or_default());
        match std::fs::OpenOptions::new().append(true).open(path) {
            Ok(mut file) => writeln!(
                file,
                "Installer: {}\nAction: {action}, device: {id:?}\nExit: {:?}\noutput:\n{}\nstderr:\n{}",
                exe.display(),
                output.status.code(),
                response,
                String::from_utf8_lossy(&output.stderr)
            )
            .map_err(|error| format!("无法写入驱动日志：{error}")),
            Err(error) => Err(format!("无法写入驱动日志：{error}")),
        }
    } else {
        Ok(())
    };
    let result = decode_reply(
        reply_bytes.as_deref().unwrap_or_default(),
        output.status.code(),
        action,
    );
    let _ = std::fs::remove_file(&output_path);
    log_result?;
    result
}

pub(crate) fn list(resource_dir: &Path) -> Result<Vec<Device>, String> {
    let exe = find(resource_dir)?;
    Ok(invoke(&exe, "list", None, None)?.devices)
}

fn install_targets(devices: &[Device]) -> Result<Vec<&Device>, String> {
    let targets: Vec<_> = devices
        .iter()
        .filter(|d| d.is_rc003() && d.present)
        .collect();
    if targets.is_empty() {
        return Err("未发现在线的 RC003 输入源，请连接并唤醒遥控器后重试。".into());
    }
    Ok(targets)
}

pub(crate) fn select_bound_target(devices: &[Device]) -> Option<String> {
    devices
        .iter()
        .filter(|device| device.present && device.bound && device.is_rc003())
        .min_by(|left, right| left.instance_id.cmp(&right.instance_id))
        .map(|device| device.instance_id.clone())
}

fn run_installer(action: &str, resource_dir: &Path, log: &Path) -> Result<bool, String> {
    if !matches!(action, "install" | "uninstall") {
        return Err("不支持的 Quarbor 驱动操作。".into());
    }
    let exe = find(resource_dir)?;
    if action == "uninstall" {
        // Only uninstall-all supports offline devnodes and recovery records.
        let reply = invoke(&exe, "uninstall-all", None, Some(log))?;
        return Ok(reply.reboot_required || reply.exit_code == 3010);
    }
    let devices = invoke(&exe, "list", None, Some(log))?.devices;
    let mut reboot = false;
    for device in install_targets(&devices)? {
        let reply = invoke(&exe, action, Some(&device.instance_id), Some(log))?;
        reboot |= reply.reboot_required || reply.exit_code == 3010;
    }
    Ok(reboot)
}

pub(crate) fn run(action: &str, resource_dir: &Path, log: &Path) -> Result<bool, String> {
    run_installer(action, resource_dir, log).map_err(|error| {
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(log) {
            let _ = writeln!(file, "ERROR: {error}");
        }
        format!("{error} 日志：{}", log.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Read-only integration check requiring the bundled installer and Windows PnP"]
    fn bundled_installer_lists_devices() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let devices = list(root).expect("bundled --list must return valid device JSON");
        assert!(devices.iter().all(|d| !d.instance_id.is_empty()));
    }

    fn device(id: &str, present: bool, bound: bool, recovery_active: bool) -> Device {
        Device {
            instance_id: id.into(),
            hardware_id: String::new(),
            present,
            bound,
            recovery_active,
        }
    }

    #[test]
    fn selects_only_rc003_and_keeps_offline_recovery() {
        let devices = vec![
            device(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39C2CF83\8&7CE84E7&0&0055",
                true,
                false,
                false,
            ),
            device(r"BTHLEDEVICE\VID_2717&PID_32B8\offline", false, true, false),
            device(
                r"BTHLEDEVICE\VID_2717&PID_32B8\recovery",
                false,
                false,
                true,
            ),
            device(
                r"BTHLEDEVICE\VID_2717&PID_32B8\restored",
                false,
                false,
                false,
            ),
            device(r"BTHLEDEVICE\VID_046D&PID_C31C\other", true, true, true),
            device(r"BTHLEDEVICE\VID_2717&PID_32B80\wrong", true, true, true),
            device(r"USB\VID_2717&PID_32B8\parent", true, true, true),
        ];
        assert_eq!(install_targets(&devices).unwrap().len(), 1);
        let uninstall: Vec<_> = devices.iter().filter(|d| d.needs_uninstall()).collect();
        assert_eq!(uninstall.len(), 2);
        assert!(uninstall.iter().all(|d| !d.present));
        assert!(install_targets(&devices[1..]).is_err());
    }

    #[test]
    fn accepts_only_the_bound_ble_parent() {
        let devices = vec![
            device(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39C2CF83\8&7CE84E7&0&0055",
                true,
                true,
                false,
            ),
            device(r"HID\VID_2717&PID_32B8\other", true, true, false),
        ];
        assert_eq!(
            select_bound_target(&devices),
            Some(devices[0].instance_id.clone())
        );
        assert_eq!(
            install_targets(&devices)
                .unwrap()
                .into_iter()
                .map(|device| device.instance_id.clone())
                .collect::<Vec<_>>(),
            vec![devices[0].instance_id.clone()]
        );
        assert_eq!(
            select_bound_target(&devices[..1]),
            Some(devices[0].instance_id.clone())
        );
        assert_eq!(select_bound_target(&devices[1..]), None);
    }

    #[test]
    fn handles_reboot_cancellation_and_invalid_results() {
        let reply = br#"{"version":1,"action":"install","outcome":"reboot_required","exitCode":3010,"rebootRequired":true,"message":"done","devices":[]}"#;
        assert!(
            decode_reply(reply, Some(3010), "install")
                .unwrap()
                .reboot_required
        );
        assert!(decode_reply(reply, Some(0), "install").is_err());
        assert!(decode_reply(reply, Some(3010), "list").is_err());
        assert!(decode_reply(b"", Some(1223), "install")
            .unwrap_err()
            .contains("取消"));
        assert!(decode_reply(b"not json", Some(0), "list").is_err());
        assert!(decode_reply(br#"{"version":1,"action":"install","outcome":"failed","exitCode":1,"rebootRequired":false,"message":"failure","devices":[]}"#, Some(1), "install").is_err());
        let offline_failure = br#"{"version":1,"action":"uninstall","outcome":"failed","exitCode":1167,"rebootRequired":false,"message":"device offline"}"#;
        assert!(decode_reply(offline_failure, Some(1167), "uninstall")
            .unwrap_err()
            .contains("device offline"));
        let list = br#"{"version":1,"action":"list","outcome":"success","exitCode":0,"rebootRequired":false,"message":"ok","devices":[]}"#;
        assert!(decode_reply(list, Some(0), "list")
            .unwrap()
            .devices
            .is_empty());
    }
}
