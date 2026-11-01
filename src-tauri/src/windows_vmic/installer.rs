use std::{
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

const DIRECTORY: &str = "QuarborVirtualMicrophoneDriverInstaller";
const INSTALLER: &str = "QuarborVirtualMicrophoneDriverInstaller.exe";

#[derive(Debug, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum InstallationState {
    Absent,
    DevicePresent,
    Unknown,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    version: u32,
    action: String,
    outcome: String,
    exit_code: i32,
    reboot_required: bool,
    state_known: bool,
    installation_state: InstallationState,
    message: String,
    warning: String,
    state_error: String,
}

impl Reply {
    fn installed(&self) -> Option<bool> {
        match self.installation_state {
            InstallationState::Absent => Some(false),
            InstallationState::DevicePresent => Some(true),
            InstallationState::Unknown => None,
        }
    }

    fn warning(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.warning.is_empty() {
            parts.push(self.warning.clone());
        }
        if !self.state_known {
            parts.push(if self.state_error.is_empty() {
                "无法确认驱动状态，请重新检测。".into()
            } else {
                format!("无法确认驱动状态：{}", self.state_error)
            });
        }
        (!parts.is_empty()).then(|| parts.join("；"))
    }
}

pub(crate) fn probe(resource_dir: &Path) -> Result<bool, String> {
    let reply = invoke(&find(resource_dir)?, "status", None)?;
    reply.installed().ok_or_else(|| {
        reply
            .warning()
            .unwrap_or_else(|| "无法确认 Quarbor 虚拟麦克风驱动状态。".into())
    })
}

pub(crate) fn run(
    resource_dir: &Path,
    action: &str,
    log_path: &Path,
) -> Result<crate::DriverActionResult, String> {
    let result = (|| {
        std::fs::write(log_path, format!("Quarbor virtual microphone: {action}\n"))
            .map_err(|error| format!("无法初始化驱动操作日志：{error}"))?;
        let reply = invoke(&find(resource_dir)?, action, Some(log_path))?;
        Ok(crate::DriverActionResult {
            log_path: log_path.to_string_lossy().into_owned(),
            reboot_required: reply.reboot_required || reply.exit_code == 3010,
            installation_state: None,
            driver_installed: reply.installed(),
            warning: reply.warning(),
        })
    })();
    result.map_err(|error: String| format!("{error} 日志：{}", log_path.display()))
}

fn find(resource_dir: &Path) -> Result<PathBuf, String> {
    let mut roots = vec![resource_dir.to_path_buf()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if cfg!(debug_assertions) {
        roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
    }
    roots
        .into_iter()
        .map(|root| root.join("vendor").join(DIRECTORY).join(INSTALLER))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| format!("未找到 Quarbor 虚拟麦克风安装器：{INSTALLER}"))
}

fn invoke(exe: &Path, action: &str, log_path: Option<&Path>) -> Result<Reply, String> {
    let output_path = std::env::temp_dir().join(format!(
        "axonkey-vmic-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("无法创建驱动结果文件名：{error}"))?
            .as_nanos()
    ));
    let output = Command::new(exe)
        .current_dir(exe.parent().unwrap())
        .creation_flags(0x0800_0000)
        .arg(format!("--{action}"))
        .arg("--output")
        .arg(&output_path)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 Quarbor 虚拟麦克风安装器：{error}"))?;
    let bytes = std::fs::read(&output_path);
    let _ = std::fs::remove_file(&output_path);
    if let Some(path) = log_path {
        std::fs::write(
            path,
            format!(
                "Installer: {}\nAction: {action}\nExit: {:?}\nResult:\n{}\nstdout:\n{}\nstderr:\n{}",
                exe.display(),
                output.status.code(),
                String::from_utf8_lossy(bytes.as_deref().unwrap_or_default()),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            ),
        )
        .map_err(|error| format!("无法写入驱动操作日志：{error}"))?;
    }
    if output.status.code() == Some(1223) {
        return Err("已取消管理员授权，驱动操作未完成，请重新尝试。".into());
    }
    let bytes = bytes.map_err(|error| {
        format!(
            "无法读取驱动操作结果（退出码 {:?}）：{error}。请重新检测驱动状态。",
            output.status.code()
        )
    })?;
    decode_reply(&bytes, output.status.code(), action)
}

fn decode_reply(bytes: &[u8], code: Option<i32>, action: &str) -> Result<Reply, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("Quarbor 虚拟麦克风安装器返回了无效 UTF-8：{error}"))?;
    let reply: Reply = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Quarbor 虚拟麦克风安装器返回了无效 JSON：{error}"))?;
    if reply.version != 1 || reply.action != action || Some(reply.exit_code) != code {
        return Err("Quarbor 虚拟麦克风安装器返回的版本、动作或退出码不一致。".into());
    }
    if reply.state_known == (reply.installation_state == InstallationState::Unknown) {
        return Err("Quarbor 虚拟麦克风安装器返回的设备状态不一致。".into());
    }
    if !matches!(code, Some(0 | 3010))
        || !matches!(reply.outcome.as_str(), "success" | "reboot_required")
    {
        return Err(format!(
            "Quarbor 虚拟麦克风操作失败（{}）：{} {}",
            reply.exit_code,
            reply.message,
            reply.warning().unwrap_or_default(),
        ));
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(action: &str, code: i32, outcome: &str, state: &str) -> serde_json::Value {
        serde_json::json!({
            "version": 1, "action": action, "outcome": outcome, "exitCode": code,
            "rebootRequired": code == 3010, "stateKnown": state != "unknown",
            "installationState": state, "message": "操作结果", "warning": "",
            "stateError": "", "log": "安装器日志"
        })
    }

    #[test]
    fn status_and_actions_use_reported_state_including_pending_removal() {
        for (action, code, outcome, state, installed) in [
            ("status", 0, "success", "absent", Some(false)),
            ("status", 0, "success", "device_present", Some(true)),
            ("install", 0, "success", "device_present", Some(true)),
            ("uninstall", 0, "success", "absent", Some(false)),
            (
                "uninstall",
                3010,
                "reboot_required",
                "device_present",
                Some(true),
            ),
            ("install", 0, "success", "unknown", None),
        ] {
            let decoded = decode_reply(
                &serde_json::to_vec(&reply(action, code, outcome, state)).unwrap(),
                Some(code),
                action,
            )
            .unwrap();
            assert_eq!(decoded.installed(), installed);
            assert_eq!(decoded.reboot_required, code == 3010);
        }
    }

    #[test]
    fn partial_failure_keeps_warning_and_unknown_state_keeps_success() {
        let mut value = reply("uninstall", 299, "incomplete", "device_present");
        value["warning"] = "驱动包尚未移除".into();
        let error =
            decode_reply(&serde_json::to_vec(&value).unwrap(), Some(299), "uninstall").unwrap_err();
        assert!(error.contains("299") && error.contains("驱动包尚未移除"));
        let mut value = reply("install", 0, "success", "unknown");
        value["stateError"] = "设备枚举失败".into();
        let decoded =
            decode_reply(&serde_json::to_vec(&value).unwrap(), Some(0), "install").unwrap();
        assert_eq!(decoded.installed(), None);
        assert!(decoded.warning().unwrap().contains("设备枚举失败"));
    }

    #[test]
    fn rejects_invalid_protocol_and_preserves_bom_support() {
        let value = reply("status", 0, "success", "absent");
        let bom = format!("\u{feff}{value}");
        assert!(decode_reply(bom.as_bytes(), Some(0), "status").is_ok());
        assert!(decode_reply(b"not json", Some(0), "status").is_err());
        assert!(decode_reply(&[0xff], Some(0), "status").is_err());
        for (field, replacement) in [
            ("version", serde_json::json!(2)),
            ("action", serde_json::json!("install")),
            ("exitCode", serde_json::json!(3010)),
            ("outcome", serde_json::json!("failed")),
            ("stateKnown", serde_json::json!(false)),
        ] {
            let mut invalid = value.clone();
            invalid[field] = replacement;
            assert!(
                decode_reply(&serde_json::to_vec(&invalid).unwrap(), Some(0), "status").is_err()
            );
        }
    }

    #[test]
    fn bundled_status_command_returns_a_known_state_without_elevation() {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        assert!(probe(&resources).is_ok());
    }
}
