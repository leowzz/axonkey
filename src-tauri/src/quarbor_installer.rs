use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const INSTALLER: &str = "QuarborHIDFilterUserDriverInstaller.exe";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub instance_id: String,
    pub present: bool,
    pub bound: bool,
    pub recovery_active: bool,
}

impl Device {
    pub fn is_rc003(&self) -> bool {
        let id = self.instance_id.to_ascii_uppercase();
        let model = id
            .strip_prefix("HID\\")
            .unwrap_or_default()
            .split('\\')
            .next()
            .unwrap_or_default();
        let tokens: Vec<_> = model.split(['&', '_']).collect();
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
        || !matches!(reply.outcome.as_str(), "success" | "reboot_required")
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
            .join("QuarborHIDFilterUserDriver")
            .join(INSTALLER);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("未找到 Quarbor 安装器：{INSTALLER}"))
}

fn invoke(exe: &Path, action: &str, id: Option<&str>, log: Option<&Path>) -> Result<Reply, String> {
    let mut command = Command::new(exe);
    command
        .creation_flags(0x0800_0000)
        .arg(format!("--{action}"));
    if let Some(id) = id {
        command.arg(id);
    }
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    let output = command
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 Quarbor 安装器：{error}"))?;
    if let Some(path) = log {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|error| format!("无法写入驱动日志：{error}"))?;
        writeln!(
            file,
            "Installer: {}\nAction: {action}, device: {id:?}\nExit: {:?}\nstdout:\n{}\nstderr:\n{}",
            exe.display(),
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .map_err(|error| format!("无法写入驱动日志：{error}"))?;
    }
    decode_reply(&output.stdout, output.status.code(), action)
}

pub(crate) fn list(resource_dir: &Path) -> Result<Vec<Device>, String> {
    let exe = find(resource_dir)?;
    Ok(invoke(&exe, "list", None, None)?.devices)
}

fn targets<'a>(devices: &'a [Device], action: &str) -> Result<Vec<&'a Device>, String> {
    match action {
        "install" => {
            let targets: Vec<_> = devices
                .iter()
                .filter(|d| d.is_rc003() && d.present)
                .collect();
            if targets.is_empty() {
                return Err("未发现在线的 RC003 HID 键盘，请连接并唤醒遥控器后重试。".into());
            }
            Ok(targets)
        }
        // Include phantom instances, but never remove another keyboard's binding.
        "uninstall" => Ok(devices.iter().filter(|d| d.needs_uninstall()).collect()),
        _ => Err("不支持的 Quarbor 驱动操作。".into()),
    }
}

pub(crate) fn run(action: &str, resource_dir: &Path, log: &Path) -> Result<bool, String> {
    let result = (|| {
        let exe = find(resource_dir)?;
        if action == "uninstall" {
            // Full removal deliberately uses the installer's offline-aware
            // command. A targeted uninstall requires the devnode to be
            // present and returns ERROR_DEVICE_NOT_CONNECTED (1167).
            let reply = invoke(&exe, "uninstall-all", None, Some(log))?;
            return Ok(reply.reboot_required || reply.exit_code == 3010);
        }
        let devices = invoke(&exe, "list", None, Some(log))?.devices;
        let mut reboot = false;
        let selected = targets(&devices, action)?;
        for device in &selected {
            let reply = invoke(&exe, action, Some(&device.instance_id), Some(log))?;
            reboot |= reply.reboot_required || reply.exit_code == 3010;
        }
        Ok(reboot)
    })();
    result.map_err(|error: String| {
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
            present,
            bound,
            recovery_active,
        }
    }

    #[test]
    fn selects_only_rc003_and_keeps_offline_recovery() {
        let devices = vec![
            device(
                r"HID\{00001812}_DEV_VID&012717_PID&32B8_REV&00A4\1",
                true,
                false,
                false,
            ),
            device(r"HID\VID_2717&PID_32B8\offline", false, true, false),
            device(r"HID\VID_2717&PID_32B8\recovery", false, false, true),
            device(r"HID\VID_2717&PID_32B8\restored", false, false, false),
            device(r"HID\VID_046D&PID_C31C\other", true, true, true),
            device(r"HID\VID_2717&PID_32B80\wrong", true, true, true),
            device(r"USB\VID_2717&PID_32B8\parent", true, true, true),
        ];
        assert_eq!(targets(&devices, "install").unwrap().len(), 1);
        let uninstall = targets(&devices, "uninstall").unwrap();
        assert_eq!(uninstall.len(), 2);
        assert!(uninstall.iter().all(|d| !d.present));
        assert!(targets(&devices[1..], "install").is_err());
        assert!(targets(&[], "uninstall").unwrap().is_empty());
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
