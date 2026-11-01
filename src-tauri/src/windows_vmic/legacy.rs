use std::{
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    installed: Option<bool>,
    reboot_required: bool,
    error: Option<String>,
}

pub(crate) fn probe(resources: &Path) -> Result<bool, String> {
    let reply = invoke(resources, "status", None)?;
    if let Some(error) = reply.error {
        return Err(error);
    }
    reply
        .installed
        .ok_or_else(|| "无法确认 VB-CABLE 设备状态。".into())
}

pub(crate) fn uninstall(
    resources: &Path,
    log_path: &Path,
) -> Result<crate::LegacyAudioRemovalResult, String> {
    let reply = invoke(resources, "uninstall", Some(log_path))
        .map_err(|error| format!("{error} 日志：{}", log_path.display()))?;
    Ok(crate::LegacyAudioRemovalResult {
        log_path: log_path.to_string_lossy().into_owned(),
        reboot_required: reply.reboot_required,
        error: reply.error,
    })
}

fn invoke(resources: &Path, action: &str, log_path: Option<&Path>) -> Result<Reply, String> {
    let relative = Path::new("scripts/legacy-audio-cleanup.ps1");
    let bundled = resources.join(relative);
    let script = if bundled.is_file() {
        bundled
    } else if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(relative)
    } else {
        return Err("缺少旧版虚拟声卡清理脚本，请重新安装 Axonkey。".into());
    };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let output = std::env::temp_dir().join(format!(
        "axonkey-legacy-audio-{}-{nonce}.json",
        std::process::id()
    ));
    let system_root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录。")?;
    let mut command = Command::new(
        Path::new(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    );
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(["-Action", action, "-OutputPath"])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    if let Some(log_path) = log_path {
        command.arg("-LogPath").arg(log_path);
    }
    let result = (|| {
        let status = command
            .status()
            .map_err(|error| format!("无法运行旧版虚拟声卡检查：{error}"))?;
        let json = std::fs::read_to_string(&output)
            .map_err(|error| format!("无法读取旧版虚拟声卡处理结果（{status}）：{error}"))?;
        let reply: Reply = serde_json::from_str(json.trim_start_matches('\u{feff}'))
            .map_err(|error| format!("旧版虚拟声卡处理结果无效：{error}"))?;
        if !status.success() && status.code() != Some(3010) && reply.error.is_none() {
            return Err(format!("旧版虚拟声卡处理失败：{status}"));
        }
        Ok(reply)
    })();
    let _ = std::fs::remove_file(output);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_status_does_not_change_drivers() {
        probe(&Path::new(env!("CARGO_MANIFEST_DIR")).join("..")).unwrap();
    }
}
