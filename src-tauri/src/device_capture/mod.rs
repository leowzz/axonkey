pub mod candidates;
pub mod compiler;
pub mod session;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const CAPTURE_EVENT_NAME: &str = "axonkey-device-capture";
pub const CAPTURE_SESSION_SCHEMA: &str = "axonkey.capture-session/v1";

static WORKBENCH_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_workbench_active(active: bool) {
    WORKBENCH_ACTIVE.store(active, Ordering::Release);
}

pub fn is_workbench_active() -> bool {
    WORKBENCH_ACTIVE.load(Ordering::Acquire)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureSafetyTier {
    Safe,
    Caution,
    Blocked,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureGattInfo {
    pub manufacturer: Option<String>,
    pub model_number: Option<String>,
    pub software_revision: Option<String>,
    pub bluetooth_address: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAncestorNode {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCandidate {
    pub target_id: String,
    pub display_name: String,
    pub transport: String,
    pub instance_id: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
    pub bound_to_quarbor: bool,
    pub recovery_active: bool,
    pub registered_kind: Option<String>,
    pub safety_tier: CaptureSafetyTier,
    pub safety_reason: Option<String>,
    pub gatt_info: Option<CaptureGattInfo>,
    #[serde(default)]
    pub ancestors: Vec<CaptureAncestorNode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDriverActionResult {
    pub ok: bool,
    pub instance_id: String,
    pub bound_to_quarbor: bool,
    pub reboot_required: bool,
    pub cancelled_by_user: bool,
    pub installation_state: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDraftInputItem {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    pub binding: String,
    pub press_hex: Option<String>,
    pub release_hex: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCaptureDraft {
    pub device_id: String,
    pub display_name: String,
    pub vendor: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub inputs: Vec<CaptureDraftInputItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSessionStatus {
    pub active: bool,
    pub target_id: Option<String>,
    pub instance_id: Option<String>,
    pub transport_mode: String,
    pub driver_version: Option<String>,
    pub supports_keysend: bool,
    pub supports_reset_input: bool,
    pub frame_count: u64,
    pub streaming_report_ids: Vec<u8>,
}

impl Default for CaptureSessionStatus {
    fn default() -> Self {
        Self {
            active: false,
            target_id: None,
            instance_id: None,
            transport_mode: "idle".into(),
            driver_version: None,
            supports_keysend: false,
            supports_reset_input: false,
            frame_count: 0,
            streaming_report_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedKeySample {
    pub input_id: String,
    pub report_id: u8,
    pub press_hex: String,
    pub release_hex: String,
    pub press_length: usize,
    pub release_length: usize,
    pub hold_count: u32,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCollisionWarning {
    pub first_input_id: String,
    pub second_input_id: String,
    pub report_id: u8,
    pub press_hex: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledCaptureResult {
    pub svg_content: String,
    pub markdown_summary: String,
    pub adapted_count: usize,
    pub pending_count: usize,
    pub collisions: Vec<CaptureCollisionWarning>,
    pub validated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureEvent {
    #[serde(rename_all = "camelCase")]
    Status {
        connected: bool,
        frame_count: u64,
        streaming_report_ids: Vec<u8>,
        message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RawFrame {
        sequence: u64,
        report_id: u8,
        hex: String,
        is_streaming_noise: bool,
    },
    #[serde(rename_all = "camelCase")]
    KeyCaptured { sample: CapturedKeySample },
    #[serde(rename_all = "camelCase")]
    LiveHit {
        input_id: String,
        pressed: bool,
        report_id: u8,
        hex: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSessionFile {
    #[serde(default = "default_session_schema")]
    pub schema: String,
    #[serde(default)]
    pub candidate: Option<CaptureCandidate>,
    #[serde(default)]
    pub samples: Vec<CapturedKeySample>,
}

fn default_session_schema() -> String {
    CAPTURE_SESSION_SCHEMA.to_string()
}

pub fn list_candidates(include_gatt: bool) -> Result<Vec<CaptureCandidate>, String> {
    candidates::list_candidates(include_gatt)
}

pub fn attach_driver(
    instance_id: &str,
    allow_caution: bool,
    allow_primary_input: bool,
    resource_dir: Option<&Path>,
    log_path: Option<&Path>,
) -> Result<CaptureDriverActionResult, String> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err("设备实例 ID 不能为空。".into());
    }
    let _ = session::stop_global_session();
    candidates::attach_driver(
        trimmed,
        allow_caution,
        allow_primary_input,
        resource_dir,
        log_path,
    )
}

pub fn detach_driver(
    instance_id: &str,
    resource_dir: Option<&Path>,
    log_path: Option<&Path>,
) -> Result<CaptureDriverActionResult, String> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err("设备实例 ID 不能为空。".into());
    }
    let _ = session::stop_global_session();
    candidates::detach_driver(trimmed, resource_dir, log_path)
}

pub fn parse_draft_svg(svg_content: &str) -> Result<ParsedCaptureDraft, String> {
    compiler::parse_draft_svg(svg_content)
}

pub fn start_session(
    target_id: String,
    instance_id: String,
    passthrough_standard_keys: bool,
    sink: Arc<dyn Fn(CaptureEvent) + Send + Sync>,
) -> Result<CaptureSessionStatus, String> {
    if instance_id.trim().is_empty() {
        return Err("设备实例 ID 不能为空。".into());
    }
    session::start_global_session(target_id, instance_id, passthrough_standard_keys, sink)
}

pub fn stop_session() -> Result<bool, String> {
    session::stop_global_session()
}

pub fn session_status() -> CaptureSessionStatus {
    session::global_session_status()
}

pub fn arm_key(input_id: Option<String>) -> Result<bool, String> {
    session::arm_global_key(input_id)
}

pub fn set_live_preview_svg(svg_content: Option<String>) -> Result<bool, String> {
    session::set_global_live_preview_svg(svg_content)
}

pub fn capture_single_key(
    instance_id: &str,
    input_id: &str,
    baseline_ms: u64,
    timeout_ms: u64,
) -> Result<(CapturedKeySample, Vec<u8>), String> {
    let instance_id = instance_id.trim();
    let input_id = input_id.trim();
    if instance_id.is_empty() {
        return Err("设备实例 ID 不能为空。".into());
    }
    if input_id.is_empty() {
        return Err("按键 ID 不能为空。".into());
    }
    session::capture_single_key(instance_id, input_id, baseline_ms, timeout_ms)
}

pub fn compile_svg(
    draft_svg: &str,
    candidate: Option<&CaptureCandidate>,
    samples: &[CapturedKeySample],
    target_status: Option<&str>,
) -> Result<CompiledCaptureResult, String> {
    compiler::compile_svg(draft_svg, candidate, samples, target_status)
}

pub fn save_export(
    svg_path: &str,
    svg_content: &str,
    markdown_path: Option<&str>,
    markdown_content: Option<&str>,
) -> Result<bool, String> {
    let svg_trimmed = svg_path.trim();
    if svg_trimmed.is_empty() {
        return Err("SVG 导出路径不能为空。".into());
    }
    compiler::validate_compiled_svg(svg_content)?;
    write_file_creating_parent(Path::new(svg_trimmed), svg_content)?;
    if let (Some(md_path), Some(md_body)) = (markdown_path, markdown_content) {
        let md_trimmed = md_path.trim();
        if !md_trimmed.is_empty() {
            write_file_creating_parent(Path::new(md_trimmed), md_body)?;
        }
    }
    Ok(true)
}

pub fn format_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_hex_bytes(hex: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for token in hex.split_whitespace() {
        let cleaned = token
            .strip_prefix("0x")
            .or_else(|| token.strip_prefix("0X"))
            .unwrap_or(token);
        let value =
            u8::from_str_radix(cleaned, 16).map_err(|_| format!("无效的十六进制字节：{token}"))?;
        bytes.push(value);
    }
    if bytes.is_empty() {
        return Err("十六进制报文不能为空。".into());
    }
    Ok(bytes)
}

fn write_file_creating_parent(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建导出目录 {}：{error}", parent.display()))?;
        }
    }
    fs::write(path, content)
        .map_err(|error| format!("无法写入导出文件 {}：{error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_contract_types_and_events_in_camel_case() {
        let candidate = CaptureCandidate {
            target_id: "ble:tcl".into(),
            display_name: "TCL RC802A".into(),
            transport: "bluetooth-le".into(),
            instance_id:
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0301\1"
                    .into(),
            vid: Some(0x0416),
            pid: Some(0x0301),
            usage_page: Some(0x01),
            usage: Some(0x06),
            bound_to_quarbor: true,
            recovery_active: true,
            registered_kind: Some("tclRc802a".into()),
            safety_tier: CaptureSafetyTier::Safe,
            safety_reason: None,
            gatt_info: Some(CaptureGattInfo {
                manufacturer: Some("TCL".into()),
                model_number: Some("BT_RC802A".into()),
                software_revision: Some("1.0".into()),
                bluetooth_address: Some("AA:BB:CC:DD:EE:FF".into()),
            }),
            ancestors: Vec::new(),
        };
        let json = serde_json::to_value(&candidate).unwrap();
        assert_eq!(json["targetId"], "ble:tcl");
        assert_eq!(json["displayName"], "TCL RC802A");
        assert_eq!(json["instanceId"], candidate.instance_id);
        assert_eq!(json["usagePage"], 1);
        assert_eq!(json["boundToQuarbor"], true);
        assert_eq!(json["recoveryActive"], true);
        assert_eq!(json["registeredKind"], "tclRc802a");
        assert_eq!(json["safetyTier"], "safe");
        assert_eq!(json["gattInfo"]["modelNumber"], "BT_RC802A");
        assert_eq!(json["gattInfo"]["softwareRevision"], "1.0");
        assert_eq!(json["gattInfo"]["bluetoothAddress"], "AA:BB:CC:DD:EE:FF");

        let raw_event = CaptureEvent::RawFrame {
            sequence: 7,
            report_id: 0x01,
            hex: "01 00 00 EF 00 00 00 00 00".into(),
            is_streaming_noise: false,
        };
        let raw_json = serde_json::to_value(&raw_event).unwrap();
        assert_eq!(raw_json["kind"], "rawFrame");
        assert_eq!(raw_json["reportId"], 1);
        assert_eq!(raw_json["isStreamingNoise"], false);

        let hit_event = CaptureEvent::LiveHit {
            input_id: "tcl-rc802a.mute".into(),
            pressed: true,
            report_id: 1,
            hex: "01 00 00 EF 00 00 00 00 00".into(),
        };
        let hit_json = serde_json::to_value(&hit_event).unwrap();
        assert_eq!(hit_json["kind"], "liveHit");
        assert_eq!(hit_json["inputId"], "tcl-rc802a.mute");
        assert_eq!(hit_json["pressed"], true);
        assert_eq!(hit_json["reportId"], 1);
    }

    #[test]
    fn hex_roundtrip_handles_spacing_and_prefixes() {
        let bytes = parse_hex_bytes("01 0x00 0XEF 09").unwrap();
        assert_eq!(bytes, vec![0x01, 0x00, 0xEF, 0x09]);
        assert_eq!(format_hex(&bytes), "01 00 EF 09");
        assert!(parse_hex_bytes("").is_err());
        assert!(parse_hex_bytes("01 ZZ").is_err());
    }
}
