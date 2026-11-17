use serde::Serialize;

#[cfg(any(target_os = "windows", test))]
const REALTEK_COMPANY_ID: &str = "005D";
#[cfg(any(target_os = "windows", test))]
const ERROR_NTE_BAD_KEY: u64 = 2_148_073_475; // 0x80090003
#[cfg(any(target_os = "windows", test))]
const ERROR_INVALID_FUNCTION: u64 = 2_147_942_401; // 0x80070001

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BluetoothAdapterStatus {
    pub name: String,
    pub instance_id: String,
    pub status: String,
    pub problem_code: Option<u32>,
    pub le_supported: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingFailureRecord {
    pub timestamp_iso: String,
    pub timestamp_ms: u64,
    pub provider: String,
    pub event_id: u32,
    pub kind: String,
    pub target_address: Option<String>,
    pub error_code_hex: Option<String>,
    pub title: String,
    pub explanation: String,
    pub resolved_now: bool,
    pub matching_chip_signature: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairedDeviceDiagnostic {
    pub address: String,
    pub name: String,
    pub vid_hex: Option<String>,
    pub pid_hex: Option<String>,
    pub chip_signature: Option<String>,
    pub chip_vendor_label: Option<String>,
    pub last_connected_ms: Option<u64>,
    pub last_seen_ms: Option<u64>,
    pub present: bool,
    pub bound_to_quarbor: bool,
    pub recovery_active: bool,
    pub supported_kind: Option<String>,
    pub suspect_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionTroubleshootReport {
    pub platform: String,
    pub checked_at_ms: u64,
    pub summary_kind: String,
    pub headline: String,
    pub detail: String,
    pub bluetooth_adapters: Vec<BluetoothAdapterStatus>,
    pub pairing_failures: Vec<PairingFailureRecord>,
    pub paired_devices: Vec<PairedDeviceDiagnostic>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub(crate) async fn diagnose_connection_issues() -> Result<ConnectionTroubleshootReport, String> {
    tauri::async_runtime::spawn_blocking(collect_report)
        .await
        .map_err(|error| format!("诊断任务执行失败：{error}"))?
}

fn collect_report() -> Result<ConnectionTroubleshootReport, String> {
    #[cfg(target_os = "windows")]
    {
        win_impl::collect()
    }
    #[cfg(target_os = "macos")]
    {
        macos::collect()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(ConnectionTroubleshootReport {
            platform: crate::current_platform().into(),
            checked_at_ms: now_ms(),
            summary_kind: "ok".into(),
            headline: "当前平台暂无系统级蓝牙事件日志分析".into(),
            detail: "请先确认设备已进入配对模式并完成系统蓝牙配对。".into(),
            bluetooth_adapters: vec![],
            pairing_failures: vec![],
            paired_devices: vec![],
            warnings: vec![],
        })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(any(target_os = "windows", test))]
fn normalize_mac(value: &str) -> Option<String> {
    let compact: String = value.chars().filter(|ch| ch.is_ascii_hexdigit()).collect();
    if compact.len() != 12 {
        return None;
    }
    Some(
        (0..6)
            .map(|idx| compact[idx * 2..idx * 2 + 2].to_ascii_uppercase())
            .collect::<Vec<_>>()
            .join(":"),
    )
}

#[cfg(any(target_os = "windows", test))]
fn extract_chip_signature(
    fingerprint: Option<&str>,
    manufacturer_id: Option<u32>,
    lmp_subversion: Option<u32>,
) -> Option<String> {
    if let Some(raw) = fingerprint {
        let mut parts = raw.split(';');
        let _header = parts.next()?;
        if let (Some(company), Some(subversion)) = (parts.next(), parts.next()) {
            let company = company.trim().to_ascii_uppercase();
            let subversion = subversion.trim().to_ascii_uppercase();
            if company.len() == 4
                && subversion.len() == 4
                && company != "0000"
                && company.bytes().all(|b| b.is_ascii_hexdigit())
                && subversion.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Some(format!("{company};{subversion}"));
            }
        }
    }
    if let (Some(mfg), Some(sub)) = (manufacturer_id, lmp_subversion) {
        if mfg > 0 {
            return Some(format!("{mfg:04X};{sub:04X}"));
        }
    }
    None
}

#[cfg(any(target_os = "windows", test))]
fn chip_vendor_label(signature: Option<&str>) -> Option<String> {
    let sig = signature?;
    let company = sig.split(';').next()?;
    let vendor = match company {
        "005D" => "Realtek",
        "0059" => "Nordic",
        "000A" => "Qualcomm",
        "05D6" => "Xiaomi",
        "004C" => "Apple",
        "000F" => "Broadcom",
        "0002" => "Intel",
        _ => return Some(format!("厂商 0x{company}")),
    };
    Some(format!("{vendor} ({sig})"))
}

#[cfg(any(target_os = "windows", test))]
fn format_protocol_error(raw: Option<u64>) -> Option<String> {
    let code = raw?;
    if code == 0 {
        return None;
    }
    let hex = format!("0x{code:08X}");
    match code {
        ERROR_NTE_BAD_KEY => Some(format!("{hex} (NTE_BAD_KEY)")),
        ERROR_INVALID_FUNCTION => Some(format!("{hex} (配对流程中止或超时)")),
        _ => Some(hex),
    }
}

#[cfg(any(target_os = "windows", test))]
fn parse_iso_utc_ms(value: &str) -> Option<u64> {
    let trimmed = value.trim().strip_suffix('Z')?;
    let (date_part, time_part) = trimmed.split_once('T')?;
    let mut date_iter = date_part.split('-');
    let year: i64 = date_iter.next()?.parse().ok()?;
    let month: u32 = date_iter.next()?.parse().ok()?;
    let day: u32 = date_iter.next()?.parse().ok()?;
    let (hms_part, frac_part) = match time_part.split_once('.') {
        Some((hms, frac)) => (hms, frac),
        None => (time_part, "0"),
    };
    let mut time_iter = hms_part.split(':');
    let hour: u64 = time_iter.next()?.parse().ok()?;
    let minute: u64 = time_iter.next()?.parse().ok()?;
    let second: u64 = time_iter.next()?.parse().ok()?;
    let mut ms_digits = frac_part.chars().take(3).collect::<String>();
    while ms_digits.len() < 3 {
        ms_digits.push('0');
    }
    let millis: u64 = ms_digits.parse().ok()?;
    let days = days_from_civil(year, month, day)?;
    if days < 0 {
        return None;
    }
    let total_seconds = (days as u64) * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(total_seconds * 1_000 + millis)
}

#[cfg(any(target_os = "windows", test))]
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let d = i64::from(day);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

#[cfg(any(target_os = "windows", test))]
fn filetime_to_unix_ms(filetime: u64) -> Option<u64> {
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
    if filetime <= EPOCH_DIFF_100NS {
        return None;
    }
    Some((filetime - EPOCH_DIFF_100NS) / 10_000)
}

#[cfg(any(target_os = "windows", test))]
fn parse_wevtutil_events(xml: &str) -> Vec<PairingFailureRecord> {
    let mut records = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Event") {
        let after_start = &rest[start..];
        let Some(end_offset) = after_start.find("</Event>") else {
            break;
        };
        let block = &after_start[..end_offset + "</Event>".len()];
        rest = &after_start[end_offset + "</Event>".len()..];
        if let Some(record) = parse_single_event(block) {
            records.push(record);
        }
    }
    records.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    records
}

#[cfg(any(target_os = "windows", test))]
fn parse_single_event(block: &str) -> Option<PairingFailureRecord> {
    let provider = extract_tag_attr(block, "Provider", "Name")?;
    let event_id: u32 = extract_tag_text(block, "EventID")?.trim().parse().ok()?;
    let timestamp_iso = extract_tag_attr(block, "TimeCreated", "SystemTime")?;
    let timestamp_ms = parse_iso_utc_ms(&timestamp_iso).unwrap_or(0);

    if provider.eq_ignore_ascii_case("BTHUSB") && event_id == 35 {
        let mut data_values = Vec::new();
        let mut scan = block;
        while let Some(pos) = scan.find("<Data") {
            let after = &scan[pos..];
            let Some(gt) = after.find('>') else {
                break;
            };
            let after_gt = &after[gt + 1..];
            let Some(end) = after_gt.find("</Data>") else {
                break;
            };
            data_values.push(after_gt[..end].trim());
            scan = &after_gt[end + "</Data>".len()..];
        }
        let target_address = data_values.into_iter().find_map(normalize_mac);
        return Some(PairingFailureRecord {
            timestamp_iso,
            timestamp_ms,
            provider,
            event_id,
            kind: "irk_collision".into(),
            target_address,
            error_code_hex: None,
            title: "蓝牙 IRK 身份密钥冲突 (BTHUSB 事件 35)".into(),
            explanation:
                "新设备与电脑中已配对设备返回了相同的 IRK 身份密钥，Windows 拒绝建立蓝牙配对。"
                    .into(),
            resolved_now: false,
            matching_chip_signature: None,
        });
    }

    if provider.eq_ignore_ascii_case("Microsoft-Windows-DeviceAssociationService")
        && matches!(event_id, 3501 | 3505)
    {
        let aep_id = extract_named_data(block, "AepId");
        let association_error: u64 = extract_named_data(block, "AssociationError")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let protocol_error: u64 = extract_named_data(block, "ProtocolError")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if association_error == 0 && protocol_error == 0 {
            return None;
        }
        let target_address = aep_id.as_deref().and_then(extract_mac_from_aep_id);
        let kind = if protocol_error == ERROR_NTE_BAD_KEY {
            "nte_bad_key"
        } else {
            "protocol_error"
        };
        let error_code_hex = format_protocol_error(Some(if protocol_error != 0 {
            protocol_error
        } else {
            association_error
        }));
        let (title, explanation) = if protocol_error == ERROR_NTE_BAD_KEY {
            (
                "配对密钥校验失败 (NTE_BAD_KEY)".into(),
                "Windows 蓝牙关联服务返回 0x80090003（常见于 BLE 设备 IRK 冲突或系统旧配对密钥不一致），设置界面通常显示「请尝试重新连接设备。」。".into(),
            )
        } else {
            (
                format!("系统蓝牙关联失败 (事件 {event_id})"),
                "Windows 蓝牙配对过程中断或设备未完成密钥交换，可尝试删除旧记录后让设备重新进入配对模式再连接。".into(),
            )
        };
        return Some(PairingFailureRecord {
            timestamp_iso,
            timestamp_ms,
            provider,
            event_id,
            kind: kind.into(),
            target_address,
            error_code_hex,
            title,
            explanation,
            resolved_now: false,
            matching_chip_signature: None,
        });
    }

    None
}

#[cfg(any(target_os = "windows", test))]
fn extract_mac_from_aep_id(aep_id: &str) -> Option<String> {
    let tail = aep_id.rsplit('-').next().unwrap_or(aep_id);
    normalize_mac(tail)
}

#[cfg(any(target_os = "windows", test))]
fn extract_tag_attr(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let needle = format!("<{tag}");
    let start = xml.find(&needle)?;
    let tag_slice = &xml[start..];
    let gt = tag_slice.find('>')?;
    let header = &tag_slice[..gt];
    for quote in ['\'', '"'] {
        let pattern = format!("{attr}={quote}");
        if let Some(attr_start) = header.find(&pattern) {
            let value_start = &header[attr_start + pattern.len()..];
            if let Some(attr_end) = value_start.find(quote) {
                return Some(value_start[..attr_end].to_string());
            }
        }
    }
    None
}

#[cfg(any(target_os = "windows", test))]
fn extract_tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let needle = format!("<{tag}");
    let start = xml.find(&needle)?;
    let after = &xml[start..];
    let gt = after.find('>')?;
    let content = &after[gt + 1..];
    let close_tag = format!("</{tag}>");
    let end = content.find(&close_tag)?;
    Some(&content[..end])
}

#[cfg(any(target_os = "windows", test))]
fn extract_named_data(xml: &str, name: &str) -> Option<String> {
    for quote in ['\'', '"'] {
        let open = format!("<Data Name={quote}{name}{quote}>");
        if let Some(start) = xml.find(&open) {
            let value_start = &xml[start + open.len()..];
            if let Some(end) = value_start.find("</Data>") {
                return Some(value_start[..end].trim().to_string());
            }
        }
    }
    None
}

#[cfg(any(target_os = "windows", test))]
fn finalize_diagnosis(
    platform: &str,
    adapters: Vec<BluetoothAdapterStatus>,
    mut failures: Vec<PairingFailureRecord>,
    mut paired: Vec<PairedDeviceDiagnostic>,
    warnings: Vec<String>,
) -> ConnectionTroubleshootReport {
    // Annotate pairing failures with resolved state and cached chip fingerprint.
    for failure in &mut failures {
        if let Some(target_mac) = &failure.target_address {
            if let Some(device) = paired.iter().find(|d| d.address == *target_mac) {
                failure.matching_chip_signature = device.chip_signature.clone();
                let connected_after = device
                    .last_connected_ms
                    .is_some_and(|connected| connected > failure.timestamp_ms);
                if connected_after || device.present {
                    failure.resolved_now = true;
                }
            }
        }
    }

    let unresolved_irk = failures
        .iter()
        .find(|f| !f.resolved_now && (f.kind == "irk_collision" || f.kind == "nte_bad_key"));
    let unresolved_irk_chip = unresolved_irk.and_then(|f| f.matching_chip_signature.as_deref());
    let unresolved_irk_mac = unresolved_irk.and_then(|f| f.target_address.as_deref());

    // Correlate suspect already-paired devices when an unresolved IRK/key failure exists.
    if unresolved_irk.is_some() {
        for device in &mut paired {
            if Some(device.address.as_str()) == unresolved_irk_mac {
                continue;
            }
            if let (Some(target_chip), Some(dev_chip)) =
                (unresolved_irk_chip, device.chip_signature.as_deref())
            {
                if target_chip == dev_chip {
                    device.suspect_reason = Some(format!(
                        "与配对失败设备芯片指纹相同 ({target_chip})，极大概率共享同一 IRK 身份密钥"
                    ));
                    continue;
                }
            }
            if unresolved_irk_chip.is_none()
                && device
                    .chip_signature
                    .as_deref()
                    .is_some_and(|sig| sig.starts_with(&format!("{REALTEK_COMPANY_ID};")))
            {
                device.suspect_reason = Some(
                    "使用 Realtek BLE 芯片，同品牌/同方案遥控器常共享默认 IRK，若冲突可优先尝试移除".into(),
                );
            }
        }
    }

    paired.sort_by(|a, b| {
        b.suspect_reason
            .is_some()
            .cmp(&a.suspect_reason.is_some())
            .then_with(|| b.bound_to_quarbor.cmp(&a.bound_to_quarbor))
            .then_with(|| b.present.cmp(&a.present))
            .then_with(|| b.last_connected_ms.cmp(&a.last_connected_ms))
            .then_with(|| a.name.cmp(&b.name))
    });

    let adapter_problem = adapters
        .iter()
        .find(|adapter| adapter.problem_code.is_some() || adapter.status != "OK");
    let unresolved_other = failures.iter().find(|f| !f.resolved_now);

    let (summary_kind, headline, detail) = if let Some(adapter) = adapter_problem {
        (
            "bluetooth_off".to_string(),
            format!("本机蓝牙适配器状态异常：{}", adapter.name),
            format!(
                "当前蓝牙适配器状态为 {}，可能已在设备管理器中被禁用或缺少驱动。请先在设备管理器或系统蓝牙设置中启用并确认工作正常。",
                adapter.status
            ),
        )
    } else if platform == "windows" && adapters.is_empty() {
        (
            "bluetooth_off".to_string(),
            "未检测到本机蓝牙适配器".to_string(),
            "系统未列出有效的蓝牙控制器。请确认电脑已开启蓝牙开关、蓝牙接收器已插稳，或在设备管理器中检查是否被禁用。".to_string(),
        )
    } else if let Some(irk) = unresolved_irk {
        let target = irk.target_address.as_deref().unwrap_or("待配对设备");
        let suspects: Vec<String> = paired
            .iter()
            .filter(|d| d.suspect_reason.is_some())
            .map(|d| format!("{} ({})", d.name, d.address))
            .collect();
        let suspect_note = if suspects.is_empty() {
            "请在已配对列表中查找同系列或不再使用的低功耗蓝牙遥控器/外设并删除配对后重试。"
                .to_string()
        } else {
            format!(
                "已定位疑似同芯片冲突设备：{}。请先在系统蓝牙设置中将其删除，再重新配对 {}。",
                suspects.join("、"),
                target
            )
        };
        (
            "irk_conflict".to_string(),
            format!("检测到蓝牙配对被拦截：{target} 可能发生 IRK 身份密钥冲突"),
            format!(
                "Windows 日志记录了最近的 {}。当两台同芯片遥控器使用了相同的出厂默认 IRK 时，Windows 会在设置中报错「请尝试重新连接设备。」。{suspect_note}",
                irk.title
            ),
        )
    } else if let Some(other) = unresolved_other {
        let target = other.target_address.as_deref().unwrap_or("待配对设备");
        (
            "pairing_error".to_string(),
            format!("近期存在未完成的蓝牙配对失败：{target}"),
            format!(
                "{}（{}）。建议在系统蓝牙设置中移除该设备的半成品配对记录，确认遥控器处于配对快闪状态后重新连接。",
                other.title,
                other.error_code_hex.as_deref().unwrap_or("系统配对中断")
            ),
        )
    } else if !failures.is_empty() {
        (
            "ok".to_string(),
            "当前未发现未解决的蓝牙配对冲突（历史异常记录已恢复）".to_string(),
            "系统日志中虽存在较早的配对错误记录，但对应设备之后已成功连接。如果新设备仍无法连上，请先核对设备是否已进入配对模式并参照下方清单排查。".to_string(),
        )
    } else {
        (
            "ok".to_string(),
            "本机蓝牙状态正常，未检测到系统配对拦截记录".to_string(),
            "如果设备在系统蓝牙设置或 Axonkey 中依然找不到，请依次核对设备是否已进入配对模式、是否连着其他主机，以及下方已配对设备和驱动状态。".to_string(),
        )
    };

    ConnectionTroubleshootReport {
        platform: platform.into(),
        checked_at_ms: now_ms(),
        summary_kind,
        headline,
        detail,
        bluetooth_adapters: adapters,
        pairing_failures: failures,
        paired_devices: paired,
        warnings,
    }
}

#[cfg(target_os = "windows")]
mod win_impl {
    use super::*;
    use std::collections::HashMap;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::time::Duration;
    use windows::core::{GUID, PCWSTR};
    use windows::Devices::Bluetooth::BluetoothAdapter;
    use windows::Win32::Devices::DeviceAndDriverInstallation::*;
    use windows::Win32::Foundation::{
        ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_DATA, ERROR_NO_MORE_ITEMS,
    };
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    const BLUETOOTH_CLASS: GUID = GUID::from_u128(0xe0cbf06c_cd8b_4647_bb8a_263b43f0f974);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const BTHPORT_DEVICES: &str = r"SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices";

    struct DeviceSet(HDEVINFO);
    impl Drop for DeviceSet {
        fn drop(&mut self) {
            unsafe {
                let _ = SetupDiDestroyDeviceInfoList(self.0);
            }
        }
    }

    pub(super) fn collect() -> Result<ConnectionTroubleshootReport, String> {
        let mut warnings = Vec::new();
        let adapters = collect_adapters(&mut warnings);
        let failures = collect_event_log_failures(&mut warnings);
        let driver_nodes = match crate::windows_driver_devices::list() {
            Ok(nodes) => nodes,
            Err(error) => {
                warnings.push(format!("未能读取设备驱动状态：{error}"));
                Vec::new()
            }
        };
        let paired = collect_paired_registry_devices(&driver_nodes, &mut warnings);
        Ok(finalize_diagnosis(
            "windows", adapters, failures, paired, warnings,
        ))
    }

    fn collect_adapters(warnings: &mut Vec<String>) -> Vec<BluetoothAdapterStatus> {
        let le_supported = read_default_adapter_le_support();
        let set = match unsafe {
            SetupDiGetClassDevsW(Some(&BLUETOOTH_CLASS), PCWSTR::null(), None, DIGCF_PRESENT)
        } {
            Ok(handle) => DeviceSet(handle),
            Err(error) => {
                warnings.push(format!("无法读取蓝牙控制器状态：{error}"));
                return Vec::new();
            }
        };
        let mut adapters = Vec::new();
        for index in 0.. {
            let mut info = SP_DEVINFO_DATA {
                cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            match unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut info) } {
                Ok(()) => {}
                Err(error) if error.code() == ERROR_NO_MORE_ITEMS.to_hresult() => break,
                Err(error) => {
                    warnings.push(format!("枚举蓝牙适配器中断：{error}"));
                    break;
                }
            }
            let Ok(instance_id) = dev_instance_id(&set, &info) else {
                continue;
            };
            let upper = instance_id.to_ascii_uppercase();
            if upper.starts_with("BTH\\")
                || upper.starts_with("BTHENUM\\")
                || upper.starts_with("BTHLE\\")
                || upper.starts_with("BTHLEDEVICE\\")
            {
                continue;
            }
            let mut name = dev_property(&set, &info, SPDRP_FRIENDLYNAME).unwrap_or_default();
            if name.is_empty() {
                name = dev_property(&set, &info, SPDRP_DEVICEDESC).unwrap_or_default();
            }
            if name.is_empty() {
                name = instance_id.clone();
            }
            let mut dev_status = CM_DEVNODE_STATUS_FLAGS::default();
            let mut problem = CM_PROB::default();
            let cfg_rc =
                unsafe { CM_Get_DevNode_Status(&mut dev_status, &mut problem, info.DevInst, 0) };
            let (status, problem_code) = if cfg_rc != CR_SUCCESS {
                (format!("异常 (0x{:08X})", cfg_rc.0), Some(cfg_rc.0))
            } else if problem.0 != 0 {
                let label = if problem == CM_PROB_DISABLED {
                    "已在设备管理器中被禁用"
                } else {
                    "存在驱动或设备问题"
                };
                (format!("{label} (代码 {})", problem.0), Some(problem.0))
            } else {
                ("OK".to_string(), None)
            };
            adapters.push(BluetoothAdapterStatus {
                name,
                instance_id,
                status,
                problem_code,
                le_supported,
            });
        }
        adapters
    }

    fn read_default_adapter_le_support() -> Option<bool> {
        let _apartment = crate::windows_runtime::initialize_mta().ok()?;
        let request = crate::windows_runtime::BluetoothRequest::new(Duration::from_secs(3), None);
        let adapter = request
            .run("读取默认蓝牙适配器", BluetoothAdapter::GetDefaultAsync)
            .ok()?;
        adapter.IsLowEnergySupported().ok()
    }

    fn collect_event_log_failures(warnings: &mut Vec<String>) -> Vec<PairingFailureRecord> {
        let wevtutil_path = std::env::var_os("SystemRoot")
            .map(|root| {
                std::path::PathBuf::from(root)
                    .join("System32")
                    .join("wevtutil.exe")
            })
            .filter(|path| path.is_file())
            .unwrap_or_else(|| std::path::PathBuf::from("wevtutil.exe"));
        let query = "/q:*[System[(Provider[@Name='BTHUSB'] and EventID=35) or (Provider[@Name='Microsoft-Windows-DeviceAssociationService'] and (EventID=3501 or EventID=3505))]]";
        let output = match Command::new(&wevtutil_path)
            .args(["qe", "System", query, "/c:40", "/rd:true", "/f:xml"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(out) => out,
            Err(error) => {
                warnings.push(format!("未能读取 Windows 系统事件日志：{error}"));
                return Vec::new();
            }
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !stderr.is_empty() {
                warnings.push(format!("读取系统事件日志返回异常：{stderr}"));
            }
            return Vec::new();
        }
        let xml = String::from_utf8_lossy(&output.stdout);
        parse_wevtutil_events(&xml)
    }

    fn collect_paired_registry_devices(
        driver_nodes: &[crate::quarbor_installer::Device],
        warnings: &mut Vec<String>,
    ) -> Vec<PairedDeviceDiagnostic> {
        let root = match RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(BTHPORT_DEVICES) {
            Ok(key) => key,
            Err(error) => {
                warnings.push(format!("未能读取系统蓝牙配对注册表：{error}"));
                return Vec::new();
            }
        };

        let mut pnp_by_mac: HashMap<String, Vec<&crate::quarbor_installer::Device>> =
            HashMap::new();
        for node in driver_nodes {
            if let Some(mac) = node_bluetooth_mac(node) {
                pnp_by_mac.entry(mac).or_default().push(node);
            }
        }

        let mut list = Vec::new();
        for subkey_name in root.enum_keys().flatten() {
            let Some(address) = normalize_mac(&subkey_name) else {
                continue;
            };
            let Ok(key) = root.open_subkey(&subkey_name) else {
                continue;
            };
            let le_name = read_reg_utf8_bytes(&key, "LEName");
            let classic_name = read_reg_utf8_bytes(&key, "Name");
            let vid: Option<u16> = key
                .get_value::<u32, _>("VID")
                .ok()
                .and_then(|v| u16::try_from(v).ok());
            let pid: Option<u16> = key
                .get_value::<u32, _>("PID")
                .ok()
                .and_then(|v| u16::try_from(v).ok());
            let fingerprint: Option<String> = key.get_value("FingerprintString").ok();
            let manufacturer_id: Option<u32> = key.get_value("ManufacturerId").ok();
            let lmp_subversion: Option<u32> = key.get_value("LmpSubversion").ok();
            let last_connected_ms = key
                .get_value::<u64, _>("LastConnected")
                .ok()
                .and_then(filetime_to_unix_ms);
            let last_seen_ms = key
                .get_value::<u64, _>("LastSeen")
                .ok()
                .and_then(filetime_to_unix_ms);

            let matching_nodes = pnp_by_mac.get(&address);
            let present = matching_nodes.is_some_and(|nodes| nodes.iter().any(|n| n.present));
            let bound_to_quarbor =
                matching_nodes.is_some_and(|nodes| nodes.iter().any(|n| n.bound));
            let recovery_active =
                matching_nodes.is_some_and(|nodes| nodes.iter().any(|n| n.recovery_active));
            let pnp_name = matching_nodes.and_then(|nodes| {
                nodes
                    .iter()
                    .map(|n| n.name.trim())
                    .find(|n| !n.is_empty())
                    .map(str::to_string)
            });

            let name = le_name.or(classic_name).or(pnp_name).unwrap_or_default();

            let chip_signature =
                extract_chip_signature(fingerprint.as_deref(), manufacturer_id, lmp_subversion);
            // Skip placeholder cache entries that lack name, VID/PID, chip signature, and activity.
            if name.is_empty()
                && vid.is_none()
                && chip_signature.is_none()
                && last_connected_ms.is_none()
            {
                continue;
            }
            let display_name = if name.is_empty() {
                format!("未命名设备 ({address})")
            } else {
                name
            };
            let supported_kind = match (vid, pid) {
                (Some(v), Some(p)) => crate::devices::descriptor_registry::registered_kinds()
                    .into_iter()
                    .find(|kind| {
                        crate::devices::descriptor_registry::matches_hardware(
                            kind, v, p, None, None,
                        )
                    })
                    .map(str::to_string),
                _ => None,
            };

            let chip_vendor_label = chip_vendor_label(chip_signature.as_deref());
            list.push(PairedDeviceDiagnostic {
                address,
                name: display_name,
                vid_hex: vid.map(|v| format!("0x{v:04X}")),
                pid_hex: pid.map(|p| format!("0x{p:04X}")),
                chip_signature,
                chip_vendor_label,
                last_connected_ms,
                last_seen_ms,
                present,
                bound_to_quarbor,
                recovery_active,
                supported_kind,
                suspect_reason: None,
            });
        }
        list
    }

    fn node_bluetooth_mac(node: &crate::quarbor_installer::Device) -> Option<String> {
        if let Some(addr) = node.bluetooth_address().and_then(|v| normalize_mac(&v)) {
            return Some(addr);
        }
        // BLE HID leaf nodes encode their MAC in segment 1 before optional &ColNN suffix.
        let segment = node.instance_id.split('\\').nth(1)?;
        let before_col = segment.split('&').next()?;
        let tail = before_col.rsplit('_').next()?;
        normalize_mac(tail)
    }

    fn read_reg_utf8_bytes(key: &RegKey, name: &str) -> Option<String> {
        let raw = key.get_raw_value(name).ok()?;
        let bytes = raw.bytes.split(|b| *b == 0).next()?;
        let text = String::from_utf8_lossy(bytes).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn dev_instance_id(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> Result<String, String> {
        let mut size = 0;
        let _ = unsafe { SetupDiGetDeviceInstanceIdW(set.0, info, None, Some(&mut size)) };
        let mut buffer = vec![0; size as usize];
        unsafe { SetupDiGetDeviceInstanceIdW(set.0, info, Some(&mut buffer), None) }
            .map_err(|error| format!("{error}"))?;
        Ok(String::from_utf16_lossy(&buffer)
            .trim_end_matches('\0')
            .into())
    }

    fn dev_property(
        set: &DeviceSet,
        info: &SP_DEVINFO_DATA,
        key: SETUP_DI_REGISTRY_PROPERTY,
    ) -> Result<String, String> {
        let mut size = 0;
        match unsafe {
            SetupDiGetDeviceRegistryPropertyW(set.0, info, key, None, None, Some(&mut size))
        } {
            Err(error) if error.code() == ERROR_INVALID_DATA.to_hresult() => {
                return Ok(String::new())
            }
            Err(error) if error.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() => {
                return Err(format!("{error}"))
            }
            _ => {}
        }
        let mut bytes = vec![0; size as usize];
        unsafe {
            SetupDiGetDeviceRegistryPropertyW(set.0, info, key, None, Some(&mut bytes), None)
        }
        .map_err(|error| format!("{error}"))?;
        let units: Vec<_> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        Ok(String::from_utf16_lossy(&units)
            .split('\0')
            .next()
            .unwrap_or_default()
            .into())
    }
}

#[cfg(any(target_os = "macos", test))]
fn build_macos_report(
    scan_result: Result<Vec<crate::input_service::managed::paired::Device>, String>,
) -> ConnectionTroubleshootReport {
    let mut warnings = Vec::new();
    let paired_devices = match scan_result {
        Ok(devices) => devices
            .into_iter()
            .map(|device| PairedDeviceDiagnostic {
                address: device.address,
                name: device.name,
                vid_hex: Some(format!("0x{:04X}", device.vendor_id)),
                pid_hex: Some(format!("0x{:04X}", device.product_id)),
                chip_signature: None,
                chip_vendor_label: None,
                last_connected_ms: None,
                last_seen_ms: None,
                present: false,
                bound_to_quarbor: false,
                recovery_active: false,
                supported_kind: crate::devices::descriptor_registry::registered_kinds()
                    .into_iter()
                    .find(|kind| {
                        crate::devices::descriptor_registry::matches_hardware(
                            kind,
                            device.vendor_id,
                            device.product_id,
                            None,
                            None,
                        )
                    })
                    .map(str::to_string),
                suspect_reason: None,
            })
            .collect(),
        Err(error) => {
            warnings.push(error);
            Vec::new()
        }
    };
    ConnectionTroubleshootReport {
        platform: "macos".into(),
        checked_at_ms: now_ms(),
        summary_kind: "ok".into(),
        headline: "macOS 设备配对与连接排查".into(),
        detail: "请先在「系统设置 -> 蓝牙」中完成配对，并确保已为 Axonkey 开启输入监控与辅助功能权限；若按键无响应或卡在配对，可选择忽略此设备后重新进入配对模式连接。".into(),
        bluetooth_adapters: vec![],
        pairing_failures: vec![],
        paired_devices,
        warnings,
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    pub(super) fn collect() -> Result<ConnectionTroubleshootReport, String> {
        Ok(build_macos_report(
            crate::input_service::managed::paired::scan(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_XML: &str = r#"
<Events>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DeviceAssociationService' Guid='{56c71c31-cfbd-4cdd-8559-505e042bbbe1}'/><EventID>3501</EventID><TimeCreated SystemTime='2026-11-15T02:48:29.3111829Z'/></System><EventData><Data Name='AepId'>BluetoothLE#BluetoothLEbc:c7:46:e4:32:c3-0c:e2:90:2e:27:4c</Data><Data Name='AssociationError'>0</Data><Data Name='ProtocolError'>2148073475</Data></EventData></Event>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='BTHUSB'/><EventID Qualifiers='49157'>35</EventID><TimeCreated SystemTime='2026-11-15T02:48:28.9417738Z'/></System><EventData><Data></Data><Data>(0c:e2:90:2e:27:4c)</Data></EventData></Event>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DeviceAssociationService'/><EventID>3501</EventID><TimeCreated SystemTime='2026-11-15T01:00:00.000Z'/></System><EventData><Data Name='AepId'>BluetoothLE#BluetoothLEbc:c7:46:e4:32:c3-aa:bb:cc:dd:ee:ff</Data><Data Name='AssociationError'>0</Data><Data Name='ProtocolError'>0</Data></EventData></Event>
</Events>
"#;

    #[test]
    fn parses_bthusb_35_and_das_3501_events_and_skips_zero_errors() {
        let records = parse_wevtutil_events(SAMPLE_XML);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].kind, "nte_bad_key");
        assert_eq!(
            records[0].target_address.as_deref(),
            Some("0C:E2:90:2E:27:4C")
        );
        assert_eq!(
            records[0].error_code_hex.as_deref(),
            Some("0x80090003 (NTE_BAD_KEY)")
        );
        assert_eq!(records[1].kind, "irk_collision");
        assert_eq!(records[1].event_id, 35);
        assert_eq!(
            records[1].target_address.as_deref(),
            Some("0C:E2:90:2E:27:4C")
        );
    }

    #[test]
    fn detects_same_chip_irk_suspect_when_target_is_unresolved() {
        let failures = parse_wevtutil_events(SAMPLE_XML);
        let adapters = vec![BluetoothAdapterStatus {
            name: "Realtek Bluetooth Adapter".into(),
            instance_id: "USB\\VID_0BDA&PID_0852\\1".into(),
            status: "OK".into(),
            problem_code: None,
            le_supported: Some(true),
        }];
        let paired = vec![
            PairedDeviceDiagnostic {
                address: "0C:F3:CE:7F:24:1E".into(),
                name: "YYYKQ".into(),
                vid_hex: Some("0x0416".into()),
                pid_hex: Some("0x0300".into()),
                chip_signature: Some("005D;8762".into()),
                chip_vendor_label: Some("Realtek (005D;8762)".into()),
                last_connected_ms: Some(1_794_600_000_000),
                last_seen_ms: None,
                present: true,
                bound_to_quarbor: true,
                recovery_active: false,
                supported_kind: Some("cmiotA15".into()),
                suspect_reason: None,
            },
            PairedDeviceDiagnostic {
                address: "0C:E2:90:2E:27:4C".into(),
                name: "TCL_RC902N_M1".into(),
                vid_hex: None,
                pid_hex: None,
                chip_signature: Some("005D;8762".into()),
                chip_vendor_label: Some("Realtek (005D;8762)".into()),
                last_connected_ms: None,
                last_seen_ms: Some(1_794_710_908_000),
                present: false,
                bound_to_quarbor: false,
                recovery_active: false,
                supported_kind: None,
                suspect_reason: None,
            },
        ];

        let report = finalize_diagnosis("windows", adapters, failures, paired, vec![]);
        assert_eq!(report.summary_kind, "irk_conflict");
        assert!(report.headline.contains("0C:E2:90:2E:27:4C"));
        assert!(report.detail.contains("YYYKQ (0C:F3:CE:7F:24:1E)"));
        assert!(!report.pairing_failures[0].resolved_now);
        assert_eq!(report.paired_devices[0].address, "0C:F3:CE:7F:24:1E");
        assert!(report.paired_devices[0].suspect_reason.is_some());
        assert!(report.paired_devices[1].suspect_reason.is_none());
    }

    #[test]
    fn marks_historical_failure_as_resolved_after_later_connection() {
        let failures = parse_wevtutil_events(SAMPLE_XML);
        let connected_after = parse_iso_utc_ms("2026-11-15T02:57:00.408Z").unwrap();
        let paired = vec![PairedDeviceDiagnostic {
            address: "0C:E2:90:2E:27:4C".into(),
            name: "TCL_RC902N_M1".into(),
            vid_hex: Some("0x0417".into()),
            pid_hex: Some("0x0304".into()),
            chip_signature: Some("005D;8762".into()),
            chip_vendor_label: Some("Realtek (005D;8762)".into()),
            last_connected_ms: Some(connected_after),
            last_seen_ms: Some(connected_after),
            present: true,
            bound_to_quarbor: false,
            recovery_active: false,
            supported_kind: Some("tclRc902n".into()),
            suspect_reason: None,
        }];
        let adapters = vec![BluetoothAdapterStatus {
            name: "Realtek Bluetooth Adapter".into(),
            instance_id: "USB\\VID_0BDA&PID_0852\\1".into(),
            status: "OK".into(),
            problem_code: None,
            le_supported: Some(true),
        }];
        let report = finalize_diagnosis("windows", adapters, failures, paired, vec![]);
        assert_eq!(report.summary_kind, "ok");
        assert!(report.pairing_failures.iter().all(|f| f.resolved_now));
        assert!(report.paired_devices[0].suspect_reason.is_none());
    }

    #[test]
    fn parses_chip_signature_and_filetime() {
        let fp = "Fingerprint:08;005D;8762;0000000000000000;000000;";
        assert_eq!(
            extract_chip_signature(Some(fp), None, None).as_deref(),
            Some("005D;8762")
        );
        assert_eq!(
            extract_chip_signature(None, Some(93), Some(34658)).as_deref(),
            Some("005D;8762")
        );
        assert_eq!(
            filetime_to_unix_ms(134_392_138_204_082_418),
            Some(134_392_138_204_082_418 / 10_000 - 11_644_473_600_000)
        );
    }

    #[test]
    fn falls_back_to_realtek_ble_suspects_when_failed_device_has_no_cached_fingerprint() {
        let failures = parse_wevtutil_events(SAMPLE_XML);
        let paired = vec![PairedDeviceDiagnostic {
            address: "0C:F3:CE:7F:24:1E".into(),
            name: "YYYKQ".into(),
            vid_hex: Some("0x0416".into()),
            pid_hex: Some("0x0300".into()),
            chip_signature: Some("005D;8762".into()),
            chip_vendor_label: Some("Realtek (005D;8762)".into()),
            last_connected_ms: Some(1_794_600_000_000),
            last_seen_ms: None,
            present: true,
            bound_to_quarbor: false,
            recovery_active: false,
            supported_kind: Some("cmiotA15".into()),
            suspect_reason: None,
        }];
        let adapters = vec![BluetoothAdapterStatus {
            name: "Realtek Bluetooth Adapter".into(),
            instance_id: "USB\\VID_0BDA&PID_0852\\1".into(),
            status: "OK".into(),
            problem_code: None,
            le_supported: Some(true),
        }];
        let report = finalize_diagnosis("windows", adapters, failures, paired, vec![]);
        assert_eq!(report.summary_kind, "irk_conflict");
        assert!(report.paired_devices[0].suspect_reason.is_some());
    }

    #[test]
    fn builds_macos_report_from_paired_scan_and_preserves_warnings() {
        let _scan_fn: fn() -> Result<Vec<crate::input_service::managed::paired::Device>, String> =
            crate::input_service::managed::paired::scan;

        let ok_report = build_macos_report(Ok(vec![
            crate::input_service::managed::paired::Device {
                address: "0C:E2:90:2E:27:4C".into(),
                name: "TCL_RC902N_M1".into(),
                vendor_id: 0x0417,
                product_id: 0x0304,
            },
            crate::input_service::managed::paired::Device {
                address: "AA:BB:CC:DD:EE:FF".into(),
                name: "Unknown HID".into(),
                vendor_id: 0xFFFF,
                product_id: 0xFFFF,
            },
        ]));
        assert_eq!(ok_report.platform, "macos");
        assert_eq!(ok_report.summary_kind, "ok");
        assert!(ok_report.warnings.is_empty());
        assert_eq!(ok_report.paired_devices.len(), 2);
        assert_eq!(
            ok_report.paired_devices[0].vid_hex.as_deref(),
            Some("0x0417")
        );
        assert_eq!(
            ok_report.paired_devices[0].pid_hex.as_deref(),
            Some("0x0304")
        );
        assert_eq!(
            ok_report.paired_devices[0].supported_kind.as_deref(),
            Some("tclRc902n")
        );
        assert_eq!(ok_report.paired_devices[1].supported_kind, None);

        let err_report = build_macos_report(Err("读取蓝牙配对列表超时".into()));
        assert!(err_report.paired_devices.is_empty());
        assert_eq!(err_report.warnings, vec!["读取蓝牙配对列表超时"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "reads live Windows Bluetooth registry, PnP, and System Event Log"]
    fn live_windows_collect_succeeds() {
        let report = win_impl::collect().expect("live Windows diagnostics");
        assert_eq!(report.platform, "windows");
        assert!(!report.bluetooth_adapters.is_empty());
        assert!(!report.paired_devices.is_empty());
        assert!(
            report
                .paired_devices
                .iter()
                .any(|d| d.chip_signature.as_deref() == Some("005D;8762")),
            "expected Realtek 005D;8762 paired device in live report"
        );
    }
}
