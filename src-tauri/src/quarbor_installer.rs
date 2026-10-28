use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const INSTALLER: &str = "QuarborUniversalKeyboardDriverInstaller.exe";

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub instance_id: String,
    #[serde(default)]
    pub hardware_id: String,
    #[serde(default)]
    pub bluetooth_address: Option<String>,
    pub present: bool,
    pub bound: bool,
    pub recovery_active: bool,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub inf: String,
    #[serde(default)]
    pub section: String,
}

impl Device {
    pub fn is_rc003(&self) -> bool {
        let id = self.instance_id.to_ascii_uppercase();
        (id.starts_with("BTHLEDEVICE\\") || id.starts_with("HID\\")) && self.is_rc003_hardware()
    }

    pub fn matches_kind(&self, kind: &str) -> bool {
        match kind {
            "xboxBluetooth" => crate::devices::xbox::matches_instance(&self.instance_id),
            "rc003" => self.is_rc003(),
            "cmiotA15" => crate::devices::cmiot_a15::matches_instance(&self.instance_id),
            _ => false,
        }
    }

    pub fn bluetooth_address(&self) -> Option<String> {
        if let Some(address) = &self.bluetooth_address {
            return Some(address.clone());
        }
        let id = self.instance_id.to_ascii_uppercase();
        if !id.starts_with("BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_") {
            return None;
        }
        let segment = id.split('\\').nth(1)?;
        let address = segment.rsplit('_').next()?;
        (address.len() == 12 && address.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| address.to_string())
    }

    pub fn is_rc003_hardware(&self) -> bool {
        let id = self.instance_id.to_ascii_uppercase();
        let hardware = self.hardware_id.to_ascii_uppercase();
        let text = format!("{id} {hardware}");
        let tokens: Vec<_> = text.split(['&', '_', '\\', ' ']).collect();
        tokens
            .windows(2)
            .any(|pair| pair[0] == "VID" && matches!(pair[1], "2717" | "012717"))
            && tokens
                .windows(2)
                .any(|pair| pair[0] == "PID" && pair[1] == "32B8")
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    version: u32,
    action: String,
    outcome: String,
    pub exit_code: i32,
    pub reboot_required: bool,
    pub installation_state: Option<crate::DriverInstallationState>,
    message: String,
    #[serde(default)]
    pub devices: Vec<Device>,
}

fn decode_reply(bytes: &[u8], code: Option<i32>, action: &str) -> Result<Reply, String> {
    if code == Some(1223) {
        return Err("已取消管理员授权，驱动操作未完成，请重新尝试。".into());
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

pub(crate) fn invoke(
    exe: &Path,
    action: &str,
    id: Option<&str>,
    log: Option<&Path>,
) -> Result<Reply, String> {
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

fn compact_address(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .flat_map(|ch| ch.to_uppercase())
        .collect()
}

fn reversed_address(value: &str) -> String {
    value
        .as_bytes()
        .chunks(2)
        .rev()
        .flat_map(|chunk| chunk.iter().copied())
        .map(char::from)
        .collect()
}

pub(crate) fn target_for_bluetooth_address(
    devices: &[Device],
    address: &str,
    kind: &str,
) -> Option<(String, bool)> {
    let compact = compact_address(address);
    if compact.len() < 12 {
        return None;
    }
    devices
        .iter()
        .filter(|device| {
            let instance = compact_address(&device.instance_id);
            let hardware = compact_address(&device.hardware_id);
            let reversed = reversed_address(&compact);
            device.matches_kind(kind)
                && (device
                    .bluetooth_address()
                    .is_some_and(|address| compact_address(&address) == compact)
                    || device.instance_id.to_ascii_uppercase().contains(&compact)
                    || instance.contains(&compact)
                    || hardware.contains(&compact)
                    || device.instance_id.to_ascii_uppercase().contains(&reversed)
                    || instance.contains(&reversed)
                    || hardware.contains(&reversed))
        })
        .min_by_key(|device| {
            (
                !device.instance_id.starts_with("BTHLEDEVICE\\"),
                !device.present,
            )
        })
        .map(|device| {
            (
                device.instance_id.clone(),
                device.bound || device.recovery_active,
            )
        })
}

pub(crate) fn unique_installed_rc003_target(devices: &[Device]) -> Option<(String, bool)> {
    let mut matches = devices
        .iter()
        .filter(|device| device.is_rc003() && (device.bound || device.recovery_active));
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some((first.instance_id.clone(), true))
}

pub(crate) fn run_for_device(
    action: &str,
    resource_dir: &Path,
    target: &str,
    log: &Path,
) -> Result<Reply, String> {
    if !matches!(action, "install" | "uninstall") {
        return Err("不支持的 Quarbor 驱动操作。".into());
    }
    if target.trim().is_empty() {
        return Err("未找到该设备对应的 Quarbor 设备节点。".into());
    }
    let exe = find(resource_dir)?;
    invoke(&exe, action, Some(target), Some(log))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, present: bool, bound: bool, recovery_active: bool) -> Device {
        Device {
            instance_id: id.into(),
            hardware_id: String::new(),
            bluetooth_address: None,
            present,
            bound,
            recovery_active,
            name: String::new(),
            inf: String::new(),
            section: String::new(),
        }
    }

    #[test]
    fn recognizes_only_supported_rc003_nodes() {
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
        assert_eq!(devices.iter().filter(|device| device.is_rc003()).count(), 4);
    }

    #[test]
    fn target_lookup_never_crosses_remote_models() {
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
            target_for_bluetooth_address(&devices, "C05D39C2CF83", "cmiotA15"),
            None
        );
    }

    #[test]
    fn matches_rc003_driver_node_to_bluetooth_address() {
        let devices = vec![device(
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39C2CF83\instance",
            true,
            true,
            false,
        )];
        let matched = target_for_bluetooth_address(&devices, "c0:5d:39:c2:cf:83", "rc003");
        assert_eq!(
            matched.as_ref().map(|(_, installed)| *installed),
            Some(true)
        );
        assert!(target_for_bluetooth_address(&devices, "aa:bb:cc:dd:ee:ff", "rc003").is_none());
    }

    #[test]
    fn matches_reversed_bluetooth_instance_addresses() {
        let devices = vec![device(
            r"HID\VID_2717&PID_32B8\8&83CFC2395DC0&0&0055",
            true,
            true,
            false,
        )];
        assert!(target_for_bluetooth_address(&devices, "c0:5d:39:c2:cf:83", "rc003").is_some());
    }

    #[test]
    fn matches_the_reported_rc003_instance_id() {
        let devices = vec![device(
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39C2CF83\C&276375FB&D&0055",
            true,
            true,
            false,
        )];
        let matched = target_for_bluetooth_address(&devices, "C0:5D:39:C2:CF:83", "rc003");
        assert_eq!(matched.map(|(_, installed)| installed), Some(true));
    }

    #[test]
    fn preserves_installation_state_including_restart_before_install() {
        use crate::DriverInstallationState::*;
        for (state, expected, code) in [
            ("installed", Installed, 0),
            ("reinstalled", Reinstalled, 0),
            ("installed", Installed, 3010),
            ("reinstalled", Reinstalled, 3010),
            ("restart_before_install", RestartBeforeInstall, 3010),
        ] {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "version": 1, "action": "install",
                "outcome": if code == 3010 { "reboot_required" } else { "success" },
                "exitCode": code, "rebootRequired": code == 3010,
                "installationState": state, "message": "done"
            }))
            .unwrap();
            let reply = decode_reply(&bytes, Some(code), "install").unwrap();
            assert_eq!(reply.installation_state, Some(expected));
            assert_eq!(reply.reboot_required, code == 3010);
            let result = crate::DriverActionResult {
                log_path: "driver.log".into(),
                reboot_required: reply.reboot_required,
                installation_state: reply.installation_state,
            };
            assert_eq!(
                serde_json::to_value(result).unwrap()["installationState"],
                state
            );
        }
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
