use super::{CaptureCandidate, CaptureDriverActionResult, CaptureGattInfo, CaptureSafetyTier};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default)]
pub(crate) struct RawCandidateNode {
    pub instance_id: String,
    pub hardware_id: String,
    pub parent_chain: Vec<String>,
    pub name: String,
    pub product_name: Option<String>,
    pub manufacturer_name: Option<String>,
    pub bluetooth_address: Option<String>,
    pub present: bool,
    pub bound: bool,
    pub recovery_active: bool,
    pub is_keyboard_class: bool,
    pub is_mouse_class: bool,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
}

pub fn list_candidates(include_gatt: bool) -> Result<Vec<CaptureCandidate>, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::list_candidates(include_gatt)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = include_gatt;
        non_windows_impl::list_candidates()
    }
}

pub(crate) fn attach_driver(
    instance_id: &str,
    allow_caution: bool,
    allow_primary_input: bool,
    resource_dir: Option<&Path>,
    log_path: Option<&Path>,
) -> Result<CaptureDriverActionResult, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::attach_driver(
            instance_id,
            allow_caution,
            allow_primary_input,
            resource_dir,
            log_path,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            instance_id,
            allow_caution,
            allow_primary_input,
            resource_dir,
            log_path,
        );
        Err("当前系统无需挂载 Quarbor 驱动，可直接开启输入采集会话。".into())
    }
}

pub(crate) fn detach_driver(
    instance_id: &str,
    resource_dir: Option<&Path>,
    log_path: Option<&Path>,
) -> Result<CaptureDriverActionResult, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::detach_driver(instance_id, resource_dir, log_path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (instance_id, resource_dir, log_path);
        Err("当前系统未使用 Quarbor 驱动。".into())
    }
}

pub(crate) fn classify_and_build_candidates(
    raw_nodes: Vec<RawCandidateNode>,
) -> Vec<CaptureCandidate> {
    let physical_keyboard_count = count_physical_keyboards(&raw_nodes);
    let folded_nodes = fold_ble_hogp_children(raw_nodes);

    let mut candidates = Vec::new();
    for node in folded_nodes {
        if !node.present && !node.bound && !node.recovery_active {
            continue;
        }
        if is_hard_excluded(&node) {
            continue;
        }
        let transport = infer_transport(&node);
        let (vid, pid) = resolve_vid_pid(&node);
        let (safety_tier, safety_reason) =
            classify_safety(&node, &transport, physical_keyboard_count);
        let display_name = choose_display_name(&node, vid, pid);
        let address = node
            .bluetooth_address
            .clone()
            .or_else(|| extract_ble_address(&node.instance_id))
            .map(|raw| format_mac_colon(&raw));
        let registered_kind =
            detect_registered_kind(&node.instance_id, vid, pid, node.usage_page, node.usage);
        let gatt_info = address.map(|bluetooth_address| CaptureGattInfo {
            manufacturer: node.manufacturer_name.clone(),
            model_number: None,
            software_revision: None,
            bluetooth_address: Some(bluetooth_address),
        });

        candidates.push(CaptureCandidate {
            target_id: make_target_id(&transport, &node.instance_id),
            display_name,
            transport,
            instance_id: node.instance_id,
            vid,
            pid,
            usage_page: node.usage_page,
            usage: node.usage,
            bound_to_quarbor: node.bound,
            recovery_active: node.recovery_active,
            registered_kind,
            safety_tier,
            safety_reason,
            gatt_info,
        });
    }

    candidates.sort_by(|left, right| {
        let left_bound = left.bound_to_quarbor || left.recovery_active;
        let right_bound = right.bound_to_quarbor || right.recovery_active;
        right_bound
            .cmp(&left_bound)
            .then_with(|| tier_rank(left.safety_tier).cmp(&tier_rank(right.safety_tier)))
            .then_with(|| left.display_name.cmp(&right.display_name))
            .then_with(|| left.instance_id.cmp(&right.instance_id))
    });
    candidates
}

fn tier_rank(tier: CaptureSafetyTier) -> u8 {
    match tier {
        CaptureSafetyTier::Safe => 0,
        CaptureSafetyTier::Caution => 1,
        CaptureSafetyTier::Blocked => 2,
    }
}

pub(crate) fn is_hard_excluded_id(id: &str, hardware_id: &str) -> bool {
    let upper = id.trim().to_ascii_uppercase();
    let hw_upper = hardware_id.trim().to_ascii_uppercase();
    upper.is_empty()
        || upper.starts_with("ROOT\\QUARBORUNIVERSALKEYBOARDOUTPUT")
        || upper.starts_with("QUARBOR\\")
        || upper.starts_with("ROOT\\")
        || upper.starts_with("SWD\\")
        || upper.starts_with("VHF\\")
        || upper.starts_with("UMB\\")
        || upper.starts_with("ACPI\\")
        || upper.starts_with("HID\\VIRTUAL")
        || upper.contains("PNP03")
        || upper.contains("PNP0F")
        || hw_upper.starts_with("QUARBOR\\")
        || hw_upper.starts_with("ACPI\\")
        || hw_upper.contains("PNP03")
        || hw_upper.contains("PNP0F")
}

fn is_virtual_node(node: &RawCandidateNode) -> bool {
    let upper = node.instance_id.to_ascii_uppercase();
    upper.starts_with("ROOT\\")
        || upper.starts_with("QUARBOR\\")
        || upper.starts_with("SWD\\")
        || upper.starts_with("VHF\\")
        || upper.starts_with("UMB\\")
        || upper.starts_with("HID\\VIRTUAL")
        || node.parent_chain.iter().any(|parent| {
            let p = parent.to_ascii_uppercase();
            p.starts_with("ROOT\\") || p.starts_with("SWD\\") || p.starts_with("VHF\\")
        })
}

fn is_hard_excluded(node: &RawCandidateNode) -> bool {
    if is_hard_excluded_id(&node.instance_id, &node.hardware_id) || is_virtual_node(node) {
        return true;
    }
    if node.usage_page == Some(0x0D) && node.usage == Some(0x05) {
        return true;
    }
    let has_external_bus = node.instance_id.to_ascii_uppercase().starts_with("BTH")
        || node.parent_chain.iter().any(|parent| {
            let p = parent.to_ascii_uppercase();
            p.starts_with("USB\\") || p.starts_with("BTH")
        });
    let has_acpi_parent = node
        .parent_chain
        .iter()
        .any(|parent| parent.to_ascii_uppercase().starts_with("ACPI\\"));
    has_acpi_parent && !has_external_bus
}

fn is_ble_hogp_id(id: &str) -> bool {
    let upper = id.to_ascii_uppercase();
    upper.starts_with("BTHLEDEVICE\\")
        || crate::devices::shared::bluetooth_hid_service(&upper).is_some()
}

fn is_keyboard_node(node: &RawCandidateNode) -> bool {
    node.is_keyboard_class || (node.usage_page == Some(0x01) && node.usage == Some(0x06))
}

fn is_mouse_node(node: &RawCandidateNode) -> bool {
    node.is_mouse_class
        || (node.usage_page == Some(0x01) && matches!(node.usage, Some(0x01 | 0x02)))
}

fn count_physical_keyboards(raw_nodes: &[RawCandidateNode]) -> usize {
    let mut containers = BTreeSet::new();
    for node in raw_nodes {
        if !node.present || is_virtual_node(node) {
            continue;
        }
        // BLE HOGP remotes declare keyboard collections for D-pad keys, so they
        // must never count as a replacement typing keyboard for a sole USB keyboard.
        if is_ble_hogp_id(&node.instance_id)
            || node
                .parent_chain
                .iter()
                .any(|parent| is_ble_hogp_id(parent))
        {
            continue;
        }
        if is_keyboard_node(node) {
            containers.insert(keyboard_container_key(node));
        }
    }
    containers.len()
}

fn keyboard_container_key(node: &RawCandidateNode) -> String {
    let upper = node.instance_id.to_ascii_uppercase();
    if upper.starts_with("ACPI\\")
        || upper.contains("PNP03")
        || node.hardware_id.to_ascii_uppercase().contains("PNP03")
    {
        return "INTERNAL_KEYBOARD".into();
    }
    if let Some(address) = &node.bluetooth_address {
        return format!("BT:{}", address.to_ascii_uppercase());
    }
    for parent in &node.parent_chain {
        let p = parent.to_ascii_uppercase();
        if p.starts_with("USB\\") && !p.contains("&MI_") {
            return p;
        }
        if p.starts_with("BTHENUM\\DEV_") {
            return p;
        }
    }
    if let (Some(vid), Some(pid)) = resolve_vid_pid(node) {
        return format!("VID:{vid:04X}:PID:{pid:04X}");
    }
    upper
}

fn fold_ble_hogp_children(raw_nodes: Vec<RawCandidateNode>) -> Vec<RawCandidateNode> {
    let mut ble_parents: BTreeMap<String, RawCandidateNode> = BTreeMap::new();
    let mut others = Vec::new();
    let mut ble_children = Vec::new();

    for node in raw_nodes {
        if is_ble_hogp_id(&node.instance_id) {
            ble_parents.insert(node.instance_id.to_ascii_uppercase(), node);
        } else if let Some(ble_parent) = node
            .parent_chain
            .iter()
            .find(|parent| is_ble_hogp_id(parent))
            .cloned()
        {
            ble_children.push((ble_parent, node));
        } else {
            others.push(node);
        }
    }

    for (ble_parent_id, child) in ble_children {
        let key = ble_parent_id.to_ascii_uppercase();
        let entry = ble_parents.entry(key).or_insert_with(|| RawCandidateNode {
            instance_id: ble_parent_id.clone(),
            hardware_id: ble_parent_id,
            parent_chain: Vec::new(),
            name: child.name.clone(),
            product_name: child.product_name.clone(),
            manufacturer_name: child.manufacturer_name.clone(),
            bluetooth_address: child.bluetooth_address.clone(),
            present: child.present,
            bound: child.bound,
            recovery_active: child.recovery_active,
            is_keyboard_class: false,
            is_mouse_class: false,
            vid: child.vid,
            pid: child.pid,
            usage_page: child.usage_page,
            usage: child.usage,
        });
        entry.present |= child.present;
        if entry.product_name.is_none() {
            entry.product_name = child.product_name;
        }
        if entry.manufacturer_name.is_none() {
            entry.manufacturer_name = child.manufacturer_name;
        }
        if entry.vid.is_none() {
            entry.vid = child.vid;
        }
        if entry.pid.is_none() {
            entry.pid = child.pid;
        }
        if should_prefer_usage(entry.usage_page, entry.usage, child.usage_page, child.usage) {
            entry.usage_page = child.usage_page;
            entry.usage = child.usage;
        }
        if is_generic_windows_name(&entry.name) && !is_generic_windows_name(&child.name) {
            entry.name = child.name;
        }
    }

    let mut combined: Vec<RawCandidateNode> = ble_parents.into_values().collect();
    combined.extend(others);
    combined
}

fn should_prefer_usage(
    current_page: Option<u16>,
    current_usage: Option<u16>,
    next_page: Option<u16>,
    next_usage: Option<u16>,
) -> bool {
    if current_page.is_none() && next_page.is_some() {
        return true;
    }
    let rank = |page: Option<u16>, usage: Option<u16>| match (page, usage) {
        (Some(0x0C), _) => 3,
        (Some(0x01), Some(0x06)) => 2,
        (Some(p), _) if p >= 0xFF00 => 2,
        (Some(_), _) => 1,
        _ => 0,
    };
    rank(next_page, next_usage) > rank(current_page, current_usage)
}

fn infer_transport(node: &RawCandidateNode) -> String {
    let upper = node.instance_id.to_ascii_uppercase();
    if is_ble_hogp_id(&upper)
        || upper.contains("{00001812-0000-1000-8000-00805F9B34FB}")
        || node.parent_chain.iter().any(|p| is_ble_hogp_id(p))
    {
        return "bluetooth-le".into();
    }
    if upper.starts_with("BTHENUM\\")
        || upper.contains("{00001124-0000-1000-8000-00805F9B34FB}")
        || node.bluetooth_address.is_some()
        || node
            .parent_chain
            .iter()
            .any(|p| p.to_ascii_uppercase().starts_with("BTHENUM\\"))
    {
        return "bluetooth-hid".into();
    }
    if upper.starts_with("USB\\")
        || node
            .parent_chain
            .iter()
            .any(|p| p.to_ascii_uppercase().starts_with("USB\\"))
    {
        return "usb-hid".into();
    }
    "hid".into()
}

fn classify_safety(
    node: &RawCandidateNode,
    transport: &str,
    physical_keyboard_count: usize,
) -> (CaptureSafetyTier, Option<String>) {
    if transport == "bluetooth-le" {
        return (CaptureSafetyTier::Safe, None);
    }
    if is_mouse_node(node) {
        return (
            CaptureSafetyTier::Blocked,
            Some("鼠标或指针设备禁止挂载拦截驱动，避免失去界面点击能力。".into()),
        );
    }
    if is_keyboard_node(node) {
        if physical_keyboard_count <= 1 {
            return (
                CaptureSafetyTier::Blocked,
                Some("当前仅检测到这一把实体键盘，禁止挂载拦截驱动以免锁死主输入。".into()),
            );
        }
        return (
            CaptureSafetyTier::Caution,
            Some(
                "挂载拦截驱动后该键盘的系统原按键将暂停，请确认另一把主键盘与鼠标正常可用。".into(),
            ),
        );
    }
    (CaptureSafetyTier::Safe, None)
}

pub(crate) fn parse_hex_token_after(text: &str, key: &str) -> Option<u32> {
    let upper = text.to_ascii_uppercase();
    let tokens: Vec<&str> = upper
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    tokens.windows(2).find_map(|pair| {
        (pair[0] == key)
            .then(|| u32::from_str_radix(pair[1], 16).ok())
            .flatten()
    })
}

fn resolve_vid_pid(node: &RawCandidateNode) -> (Option<u16>, Option<u16>) {
    let vid = node
        .vid
        .or_else(|| parse_hex_token_after(&node.instance_id, "VID").map(|v| v as u16))
        .or_else(|| parse_hex_token_after(&node.hardware_id, "VID").map(|v| v as u16));
    let pid = node
        .pid
        .or_else(|| parse_hex_token_after(&node.instance_id, "PID").map(|v| v as u16))
        .or_else(|| parse_hex_token_after(&node.hardware_id, "PID").map(|v| v as u16));
    (vid, pid)
}

pub(crate) fn extract_ble_address(instance_id: &str) -> Option<String> {
    let upper = instance_id.to_ascii_uppercase();
    let service = crate::devices::shared::bluetooth_hid_service(&upper)?;
    let head = service.split('\\').next()?;
    let candidate = head.rsplit('_').next()?;
    (candidate.len() == 12 && candidate.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| candidate.to_string())
}

fn format_mac_colon(address: &str) -> String {
    let hex: String = address
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .flat_map(|ch| ch.to_uppercase())
        .collect();
    if hex.len() == 12 {
        hex.as_bytes()
            .chunks(2)
            .map(|pair| std::str::from_utf8(pair).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(":")
    } else {
        address.to_string()
    }
}

fn is_generic_windows_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "hid keyboard device"
            | "hid-compliant consumer control device"
            | "hid-compliant vendor-defined device"
            | "hid-compliant system controller"
            | "hid-compliant device"
            | "usb input device"
            | "bluetooth le generic attribute service"
            | "bluetooth low energy gatt compliant hid device"
    ) || trimmed.contains("符合 HID 标准")
        || trimmed.contains("HID Keyboard Device")
        || trimmed.contains("蓝牙低功耗 GATT 兼容 HID 设备")
}

fn choose_display_name(node: &RawCandidateNode, vid: Option<u16>, pid: Option<u16>) -> String {
    if let Some(product) = node
        .product_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !is_generic_windows_name(name))
    {
        return product.to_string();
    }
    if !node.name.trim().is_empty() && !is_generic_windows_name(&node.name) {
        return node.name.trim().to_string();
    }
    if !node.name.trim().is_empty() {
        if let (Some(v), Some(p)) = (vid, pid) {
            return format!("{} ({v:04X}:{p:04X})", node.name.trim());
        }
        return node.name.trim().to_string();
    }
    if let (Some(v), Some(p)) = (vid, pid) {
        return format!("HID 设备 ({v:04X}:{p:04X})");
    }
    node.instance_id.clone()
}

fn make_target_id(transport: &str, instance_id: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in instance_id.to_ascii_uppercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{transport}:{hash:016x}")
}

fn detect_registered_kind(
    instance_id: &str,
    vid: Option<u16>,
    pid: Option<u16>,
    usage_page: Option<u16>,
    usage: Option<u16>,
) -> Option<String> {
    use crate::devices::descriptor_registry::{
        matches_hardware, matches_instance, requires_information, KINDS,
    };
    let instance_matches: Vec<&str> = KINDS
        .iter()
        .copied()
        .filter(|kind| matches_instance(kind, instance_id))
        .collect();
    if instance_matches.len() == 1 && !requires_information(instance_matches[0]) {
        return Some(instance_matches[0].to_string());
    }
    if let (Some(v), Some(p)) = (vid, pid) {
        let hw_matches: Vec<&str> = KINDS
            .iter()
            .copied()
            .filter(|kind| {
                !requires_information(kind) && matches_hardware(kind, v, p, usage_page, usage)
            })
            .collect();
        if hw_matches.len() == 1 {
            return Some(hw_matches[0].to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::time::Duration;
    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_Device_IDW, CM_Get_Parent, CM_Locate_DevNodeW, SetupDiDestroyDeviceInfoList,
        SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
        CM_LOCATE_DEVNODE_PHANTOM, CR_SUCCESS, DIGCF_ALLCLASSES, DIGCF_PRESENT, HDEVINFO,
        SP_DEVINFO_DATA,
    };
    use windows::Win32::Foundation::ERROR_NO_MORE_ITEMS;

    const KEYBOARD_CLASS: GUID = GUID::from_u128(0x4d36e96b_e325_11ce_bfc1_08002be10318);
    const MOUSE_CLASS: GUID = GUID::from_u128(0x4d36e96f_e325_11ce_bfc1_08002be10318);

    struct DevInfoGuard(HDEVINFO);
    impl Drop for DevInfoGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = SetupDiDestroyDeviceInfoList(self.0);
            }
        }
    }

    pub(super) fn list_candidates(include_gatt: bool) -> Result<Vec<CaptureCandidate>, String> {
        let driver_devices = crate::windows_driver_devices::list()?;
        let class_map = read_pnp_classes();
        let hid_hints = read_hidapi_hints();

        let mut raw_nodes = Vec::with_capacity(driver_devices.len());
        for dev in driver_devices {
            if !dev.present && !dev.bound && !dev.recovery_active {
                continue;
            }
            let upper = dev.instance_id.to_ascii_uppercase();
            let (is_keyboard_class, is_mouse_class) =
                class_map.get(&upper).copied().unwrap_or((false, false));
            let parent_chain = query_parent_chain(&dev.instance_id);
            let mut node = RawCandidateNode {
                bluetooth_address: dev.bluetooth_address(),
                instance_id: dev.instance_id,
                hardware_id: dev.hardware_id,
                parent_chain,
                name: dev.name,
                product_name: None,
                manufacturer_name: None,
                present: dev.present,
                bound: dev.bound,
                recovery_active: dev.recovery_active,
                is_keyboard_class,
                is_mouse_class,
                vid: None,
                pid: None,
                usage_page: None,
                usage: None,
            };
            enrich_from_hidapi(&mut node, &hid_hints);
            raw_nodes.push(node);
        }

        let mut candidates = classify_and_build_candidates(raw_nodes);
        if include_gatt {
            enrich_candidates_with_gatt(&mut candidates);
        }
        Ok(candidates)
    }

    pub(super) fn attach_driver(
        instance_id: &str,
        allow_caution: bool,
        allow_primary_input: bool,
        resource_dir: Option<&Path>,
        log_path: Option<&Path>,
    ) -> Result<CaptureDriverActionResult, String> {
        if is_hard_excluded_id(instance_id, "") {
            return Err("该系统底层输入节点受安全保护，禁止挂载拦截驱动。".into());
        }
        let candidates = list_candidates(false)?;
        let matched = candidates
            .iter()
            .find(|c| c.instance_id.eq_ignore_ascii_case(instance_id));

        if let Some(candidate) = matched {
            match candidate.safety_tier {
                CaptureSafetyTier::Blocked if !allow_primary_input => {
                    return Err(candidate
                        .safety_reason
                        .clone()
                        .unwrap_or_else(|| "该设备为主输入设备，禁止挂载拦截驱动。".into()));
                }
                CaptureSafetyTier::Caution if !allow_caution && !allow_primary_input => {
                    return Err(candidate.safety_reason.clone().unwrap_or_else(|| {
                        "该设备为附加实体键盘，需确认风险后才能挂载拦截驱动。".into()
                    }));
                }
                _ => {}
            }
        } else if !allow_primary_input {
            return Err(format!(
                "未在可安全采集列表中找到设备节点 {instance_id}，请先刷新设备列表。"
            ));
        }

        let target_id = matched
            .map(|c| c.instance_id.clone())
            .unwrap_or_else(|| instance_id.to_string());
        let currently_bound = matched.is_some_and(|c| c.bound_to_quarbor);
        run_installer_action(
            "install",
            &target_id,
            currently_bound,
            resource_dir,
            log_path,
        )
    }

    pub(super) fn detach_driver(
        instance_id: &str,
        resource_dir: Option<&Path>,
        log_path: Option<&Path>,
    ) -> Result<CaptureDriverActionResult, String> {
        let devices = crate::windows_driver_devices::list()?;
        let matched = devices
            .iter()
            .find(|d| d.instance_id.eq_ignore_ascii_case(instance_id));
        let target_id = matched
            .map(|d| d.instance_id.clone())
            .unwrap_or_else(|| instance_id.to_string());
        let currently_bound = matched.is_some_and(|d| d.bound);
        run_installer_action(
            "uninstall",
            &target_id,
            currently_bound,
            resource_dir,
            log_path,
        )
    }

    fn run_installer_action(
        action: &str,
        instance_id: &str,
        currently_bound: bool,
        resource_dir: Option<&Path>,
        log_path: Option<&Path>,
    ) -> Result<CaptureDriverActionResult, String> {
        let fallback_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let exe = crate::quarbor_installer::find(resource_dir.unwrap_or(&fallback_dir))?;
        let default_log = std::env::temp_dir().join(format!("axonkey-capture-{action}.log"));
        let log_target = log_path.unwrap_or(&default_log);
        if !log_target.exists() {
            let _ = std::fs::write(log_target, b"");
        }

        match crate::quarbor_installer::invoke(&exe, action, Some(instance_id), Some(log_target)) {
            Ok(reply) => {
                let bound_after = crate::windows_driver_devices::list()
                    .ok()
                    .and_then(|list| {
                        list.into_iter()
                            .find(|d| d.instance_id.eq_ignore_ascii_case(instance_id))
                            .map(|d| d.bound)
                    })
                    .unwrap_or(action == "install");
                let installation_state = reply
                    .installation_state
                    .and_then(|state| serde_json::to_value(state).ok())
                    .and_then(|v| v.as_str().map(str::to_owned));
                Ok(CaptureDriverActionResult {
                    ok: true,
                    instance_id: instance_id.to_string(),
                    bound_to_quarbor: bound_after,
                    reboot_required: reply.reboot_required || reply.exit_code == 3010,
                    cancelled_by_user: false,
                    installation_state,
                    message: None,
                })
            }
            Err(error) if error.contains("取消管理员授权") => {
                Ok(CaptureDriverActionResult {
                    ok: false,
                    instance_id: instance_id.to_string(),
                    bound_to_quarbor: currently_bound,
                    reboot_required: false,
                    cancelled_by_user: true,
                    installation_state: None,
                    message: Some(error),
                })
            }
            Err(error) => Err(error),
        }
    }

    #[derive(Clone, Debug)]
    struct HidHint {
        path_upper: String,
        vid: u16,
        pid: u16,
        usage_page: u16,
        usage: u16,
        product: Option<String>,
        manufacturer: Option<String>,
    }

    fn read_hidapi_hints() -> Vec<HidHint> {
        let Ok(api) = hidapi::HidApi::new() else {
            return Vec::new();
        };
        api.device_list()
            .map(|info| HidHint {
                path_upper: info.path().to_string_lossy().to_ascii_uppercase(),
                vid: info.vendor_id(),
                pid: info.product_id(),
                usage_page: info.usage_page(),
                usage: info.usage(),
                product: info
                    .product_string()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                manufacturer: info
                    .manufacturer_string()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            })
            .collect()
    }

    fn enrich_from_hidapi(node: &mut RawCandidateNode, hints: &[HidHint]) {
        // Windows HID device interface paths replace `\` in the PnP instance ID with `#`.
        let needle = node.instance_id.to_ascii_uppercase().replace('\\', "#");
        for hint in hints {
            if hint.path_upper.contains(&needle) {
                node.vid = Some(hint.vid);
                node.pid = Some(hint.pid);
                if should_prefer_usage(
                    node.usage_page,
                    node.usage,
                    Some(hint.usage_page),
                    Some(hint.usage),
                ) {
                    node.usage_page = Some(hint.usage_page);
                    node.usage = Some(hint.usage);
                }
                if node.product_name.is_none() {
                    node.product_name = hint.product.clone();
                }
                if node.manufacturer_name.is_none() {
                    node.manufacturer_name = hint.manufacturer.clone();
                }
            }
        }
    }

    fn read_pnp_classes() -> BTreeMap<String, (bool, bool)> {
        let mut classes = BTreeMap::new();
        let Ok(handle) = (unsafe {
            SetupDiGetClassDevsW(None, PCWSTR::null(), None, DIGCF_ALLCLASSES | DIGCF_PRESENT)
        }) else {
            return classes;
        };
        let set = DevInfoGuard(handle);
        for index in 0.. {
            let mut info = SP_DEVINFO_DATA {
                cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            match unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut info) } {
                Ok(()) => {}
                Err(e) if e.code() == ERROR_NO_MORE_ITEMS.to_hresult() => break,
                Err(_) => break,
            }
            if info.ClassGuid != KEYBOARD_CLASS && info.ClassGuid != MOUSE_CLASS {
                continue;
            }
            let mut size = 0u32;
            let _ = unsafe { SetupDiGetDeviceInstanceIdW(set.0, &info, None, Some(&mut size)) };
            if size == 0 {
                continue;
            }
            let mut buf = vec![0u16; size as usize];
            if unsafe { SetupDiGetDeviceInstanceIdW(set.0, &info, Some(&mut buf), None) }.is_ok() {
                let id = String::from_utf16_lossy(&buf)
                    .trim_end_matches('\0')
                    .to_ascii_uppercase();
                classes.insert(
                    id,
                    (
                        info.ClassGuid == KEYBOARD_CLASS,
                        info.ClassGuid == MOUSE_CLASS,
                    ),
                );
            }
        }
        classes
    }

    fn query_parent_chain(instance_id: &str) -> Vec<String> {
        let wide: Vec<u16> = instance_id.encode_utf16().chain(Some(0)).collect();
        let mut node = 0u32;
        let mut chain = Vec::new();
        unsafe {
            if CM_Locate_DevNodeW(&mut node, PCWSTR(wide.as_ptr()), CM_LOCATE_DEVNODE_PHANTOM)
                != CR_SUCCESS
            {
                return chain;
            }
            for _ in 0..16 {
                let mut parent = 0u32;
                if CM_Get_Parent(&mut parent, node, 0) != CR_SUCCESS {
                    break;
                }
                let mut buf = [0u16; 512];
                if CM_Get_Device_IDW(parent, &mut buf, 0) != CR_SUCCESS {
                    break;
                }
                let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
                chain.push(String::from_utf16_lossy(&buf[..len]));
                node = parent;
            }
        }
        chain
    }

    fn enrich_candidates_with_gatt(candidates: &mut [CaptureCandidate]) {
        use crate::devices::descriptor_registry::{
            matches_information, requires_information, KINDS,
        };
        let Ok(_mta) = crate::windows_runtime::initialize_mta() else {
            return;
        };
        for candidate in candidates.iter_mut() {
            if candidate.transport != "bluetooth-le" {
                continue;
            }
            let Some(address_str) = candidate
                .gatt_info
                .as_ref()
                .and_then(|g| g.bluetooth_address.clone())
                .or_else(|| {
                    extract_ble_address(&candidate.instance_id).map(|a| format_mac_colon(&a))
                })
            else {
                continue;
            };
            if let Some((ble_name, mut gatt)) = query_ble_gatt_dis(&address_str) {
                gatt.bluetooth_address = Some(address_str);
                if let Some(name) = ble_name.filter(|n| !n.trim().is_empty()) {
                    if is_generic_windows_name(&candidate.display_name)
                        || candidate.display_name.contains('(')
                    {
                        candidate.display_name = name;
                    }
                } else if let Some(model) = gatt.model_number.as_deref() {
                    if is_generic_windows_name(&candidate.display_name)
                        || candidate.display_name.contains('(')
                    {
                        candidate.display_name = model.to_string();
                    }
                }
                if candidate.registered_kind.is_none() {
                    if let (Some(vid), Some(pid)) = (candidate.vid, candidate.pid) {
                        candidate.registered_kind = KINDS
                            .iter()
                            .copied()
                            .find(|kind| {
                                requires_information(kind)
                                    && matches_information(
                                        kind,
                                        vid,
                                        pid,
                                        gatt.model_number.as_deref(),
                                        gatt.manufacturer.as_deref(),
                                        gatt.software_revision.as_deref(),
                                    )
                            })
                            .map(str::to_owned);
                    }
                }
                candidate.gatt_info = Some(gatt);
            }
        }
    }

    fn query_ble_gatt_dis(address_str: &str) -> Option<(Option<String>, CaptureGattInfo)> {
        use windows::core::GUID;
        use windows::Devices::Bluetooth::{
            BluetoothCacheMode, BluetoothLEDevice, GenericAttributeProfile::GattCommunicationStatus,
        };
        use windows::Storage::Streams::DataReader;

        let compact: String = address_str
            .chars()
            .filter(|ch| ch.is_ascii_hexdigit())
            .collect();
        let raw_address = u64::from_str_radix(&compact, 16).ok()?;
        let request =
            crate::windows_runtime::BluetoothRequest::new(Duration::from_millis(1800), None);
        let op_timeout = Duration::from_millis(750);

        let device = request
            .run_with_timeout("打开蓝牙设备信息", op_timeout, || {
                BluetoothLEDevice::FromBluetoothAddressAsync(raw_address)
            })
            .ok()?;

        let ble_name = device
            .Name()
            .ok()
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty());

        let uuid16 =
            |short: u16| GUID::from_u128(((short as u128) << 96) | 0x0000_1000_8000_00805f9b34fb);
        let mut info = CaptureGattInfo::default();

        if let Ok(services_result) =
            request.run_with_timeout("查询 GATT 180A 服务", op_timeout, || {
                device.GetGattServicesForUuidWithCacheModeAsync(
                    uuid16(0x180A),
                    BluetoothCacheMode::Cached,
                )
            })
        {
            if services_result.Status().ok() == Some(GattCommunicationStatus::Success) {
                if let Ok(services) = services_result.Services() {
                    if let Ok(service) = services.GetAt(0) {
                        for (char_id, slot) in [
                            (0x2A29u16, &mut info.manufacturer),
                            (0x2A24u16, &mut info.model_number),
                            (0x2A28u16, &mut info.software_revision),
                        ] {
                            if let Ok(chars_res) =
                                request.run_with_timeout("查询 GATT 特征", op_timeout, || {
                                    service.GetCharacteristicsForUuidWithCacheModeAsync(
                                        uuid16(char_id),
                                        BluetoothCacheMode::Cached,
                                    )
                                })
                            {
                                if let Ok(chars) = chars_res.Characteristics() {
                                    if let Ok(ch) = chars.GetAt(0) {
                                        if let Ok(val_res) = request.run_with_timeout(
                                            "读取 GATT 特征值",
                                            op_timeout,
                                            || {
                                                ch.ReadValueWithCacheModeAsync(
                                                    BluetoothCacheMode::Cached,
                                                )
                                            },
                                        ) {
                                            if val_res.Status().ok()
                                                == Some(GattCommunicationStatus::Success)
                                            {
                                                if let Ok(buf) = val_res.Value() {
                                                    if let Ok(len) = buf.Length() {
                                                        if len > 0 && len <= 256 {
                                                            if let Ok(reader) =
                                                                DataReader::FromBuffer(&buf)
                                                            {
                                                                let mut bytes =
                                                                    vec![0u8; len as usize];
                                                                if reader
                                                                    .ReadBytes(&mut bytes)
                                                                    .is_ok()
                                                                {
                                                                    if let Ok(text) =
                                                                        std::str::from_utf8(&bytes)
                                                                    {
                                                                        let cleaned = text
                                                                            .trim_matches('\0')
                                                                            .trim();
                                                                        if !cleaned.is_empty() {
                                                                            *slot = Some(
                                                                                cleaned.to_string(),
                                                                            );
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        let _ = service.Close();
                    }
                }
            }
        }
        let _ = device.Close();
        Some((ble_name, info))
    }
}

#[cfg(not(target_os = "windows"))]
mod non_windows_impl {
    use super::*;

    pub(super) fn list_candidates() -> Result<Vec<CaptureCandidate>, String> {
        let api = hidapi::HidApi::new().map_err(|e| format!("无法初始化 HID 枚举：{e}"))?;
        let mut raw_nodes = Vec::new();
        for info in api.device_list() {
            let path = info.path().to_string_lossy().into_owned();
            let transport_hint = info.bus_type();
            let prefix = match transport_hint {
                hidapi::BusType::Bluetooth => "BTHENUM\\",
                hidapi::BusType::Usb => "USB\\",
                _ => "",
            };
            raw_nodes.push(RawCandidateNode {
                instance_id: path.clone(),
                hardware_id: format!(
                    "{prefix}VID_{:04X}&PID_{:04X}",
                    info.vendor_id(),
                    info.product_id()
                ),
                parent_chain: if prefix.is_empty() {
                    Vec::new()
                } else {
                    vec![format!(
                        "{prefix}VID_{:04X}&PID_{:04X}",
                        info.vendor_id(),
                        info.product_id()
                    )]
                },
                name: info.product_string().unwrap_or_default().to_string(),
                product_name: info.product_string().map(str::to_owned),
                manufacturer_name: info.manufacturer_string().map(str::to_owned),
                bluetooth_address: info
                    .serial_number()
                    .filter(|s| s.chars().filter(|c| c.is_ascii_hexdigit()).count() == 12)
                    .map(str::to_owned),
                present: true,
                bound: false,
                recovery_active: false,
                is_keyboard_class: info.usage_page() == 0x01 && info.usage() == 0x06,
                is_mouse_class: info.usage_page() == 0x01 && matches!(info.usage(), 0x01 | 0x02),
                vid: Some(info.vendor_id()),
                pid: Some(info.product_id()),
                usage_page: Some(info.usage_page()),
                usage: Some(info.usage()),
            });
        }
        Ok(classify_and_build_candidates(raw_nodes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_node(id: &str) -> RawCandidateNode {
        RawCandidateNode {
            instance_id: id.into(),
            hardware_id: id.into(),
            present: true,
            ..Default::default()
        }
    }

    #[test]
    fn hard_excludes_quarbor_virtual_acpi_ps2_and_touchpad_nodes() {
        let mut quarbor_out = raw_node(r"ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\0000");
        quarbor_out.is_keyboard_class = true;

        let mut quarbor_col = raw_node(r"QUARBOR\UNIVERSALHIDCOLLECTION\1");
        quarbor_col.usage_page = Some(0x01);
        quarbor_col.usage = Some(0x06);

        let mut acpi_kb = raw_node(r"ACPI\PNP0303\4&123456&0");
        acpi_kb.is_keyboard_class = true;

        let mut touchpad = raw_node(r"HID\VEN_ELAN&DEV_1200&Col02\5&abc&0&0001");
        touchpad.usage_page = Some(0x0D);
        touchpad.usage = Some(0x05);

        let list = classify_and_build_candidates(vec![quarbor_out, quarbor_col, acpi_kb, touchpad]);
        assert!(list.is_empty());
    }

    #[test]
    fn blocks_mice_and_sole_physical_keyboard_even_when_ble_remote_and_quarbor_output_exist() {
        let mut quarbor_synth = raw_node(r"ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\0000");
        quarbor_synth.is_keyboard_class = true;

        let mut sole_usb_kb = raw_node(r"HID\VID_046D&PID_C31C&MI_00\7&1111&0&0000");
        sole_usb_kb.parent_chain = vec![r"USB\VID_046D&PID_C31C\SN001".into()];
        sole_usb_kb.is_keyboard_class = true;
        sole_usb_kb.usage_page = Some(0x01);
        sole_usb_kb.usage = Some(0x06);
        sole_usb_kb.name = "Logitech USB Keyboard".into();

        let mut usb_mouse = raw_node(r"HID\VID_046D&PID_C077\7&2222&0&0000");
        usb_mouse.parent_chain = vec![r"USB\VID_046D&PID_C077\SN002".into()];
        usb_mouse.is_mouse_class = true;
        usb_mouse.usage_page = Some(0x01);
        usb_mouse.usage = Some(0x02);
        usb_mouse.name = "Logitech USB Mouse".into();

        let ble_parent_id = r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0301_REV&0001_AABBCCDDEEFF\8&9999&0&0011";
        let ble_parent = raw_node(ble_parent_id);
        let mut ble_child_kb = raw_node(
            r"HID\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0301&Col01\9&8888&0&0000",
        );
        ble_child_kb.parent_chain = vec![ble_parent_id.into()];
        ble_child_kb.is_keyboard_class = true;
        ble_child_kb.usage_page = Some(0x01);
        ble_child_kb.usage = Some(0x06);
        ble_child_kb.product_name = Some("TCL RC802A".into());

        let candidates = classify_and_build_candidates(vec![
            quarbor_synth,
            sole_usb_kb,
            usb_mouse,
            ble_parent,
            ble_child_kb,
        ]);

        assert_eq!(candidates.len(), 3);
        let ble = candidates
            .iter()
            .find(|c| c.transport == "bluetooth-le")
            .expect("folded BLE parent must exist");
        assert_eq!(ble.instance_id, ble_parent_id);
        assert_eq!(ble.display_name, "TCL RC802A");
        assert_eq!(ble.vid, Some(0x0416));
        assert_eq!(ble.pid, Some(0x0301));
        assert_eq!(ble.safety_tier, CaptureSafetyTier::Safe);
        assert_eq!(
            ble.gatt_info
                .as_ref()
                .and_then(|g| g.bluetooth_address.as_deref()),
            Some("AA:BB:CC:DD:EE:FF")
        );

        let kb = candidates
            .iter()
            .find(|c| c.display_name == "Logitech USB Keyboard")
            .unwrap();
        assert_eq!(kb.safety_tier, CaptureSafetyTier::Blocked);
        assert!(kb.safety_reason.is_some());

        let mouse = candidates
            .iter()
            .find(|c| c.display_name == "Logitech USB Mouse")
            .unwrap();
        assert_eq!(mouse.safety_tier, CaptureSafetyTier::Blocked);
    }

    #[test]
    fn marks_external_keyboard_caution_when_laptop_internal_or_second_keyboard_exists() {
        let mut internal_laptop_kb = raw_node(r"ACPI\PNP0303\4&1111&0");
        internal_laptop_kb.is_keyboard_class = true;

        let mut usb_keypad = raw_node(r"HID\VID_1189&PID_8890&MI_00\7&3333&0&0000");
        usb_keypad.parent_chain = vec![r"USB\VID_1189&PID_8890\KP01".into()];
        usb_keypad.is_keyboard_class = true;
        usb_keypad.usage_page = Some(0x01);
        usb_keypad.usage = Some(0x06);
        usb_keypad.name = "USB Macro Keypad".into();

        let mut usb_keypad_consumer = raw_node(r"HID\VID_1189&PID_8890&MI_01&Col01\7&3333&0&0001");
        usb_keypad_consumer.parent_chain = vec![r"USB\VID_1189&PID_8890\KP01".into()];
        usb_keypad_consumer.usage_page = Some(0x0C);
        usb_keypad_consumer.usage = Some(0x01);
        usb_keypad_consumer.name = "USB Macro Consumer".into();

        let candidates = classify_and_build_candidates(vec![
            internal_laptop_kb,
            usb_keypad,
            usb_keypad_consumer,
        ]);
        assert_eq!(candidates.len(), 2);

        let kb = candidates
            .iter()
            .find(|c| c.display_name == "USB Macro Keypad")
            .unwrap();
        assert_eq!(kb.safety_tier, CaptureSafetyTier::Caution);

        let consumer = candidates
            .iter()
            .find(|c| c.display_name == "USB Macro Consumer")
            .unwrap();
        assert_eq!(consumer.safety_tier, CaptureSafetyTier::Safe);
    }

    #[test]
    fn retains_offline_quarbor_bound_or_recovery_nodes_for_one_click_restore() {
        let mut offline_bound = raw_node(
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&01005D_PID&0001\offline",
        );
        offline_bound.present = false;
        offline_bound.bound = true;
        offline_bound.name = "Phicomm DB1-R".into();

        let candidates = classify_and_build_candidates(vec![offline_bound]);
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].bound_to_quarbor);
        assert_eq!(
            candidates[0].registered_kind.as_deref(),
            Some("phicommDb1R")
        );
    }
}
