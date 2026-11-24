use super::device_descriptor::{parse_svg, DeviceDescriptor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::{OnceLock, RwLock};

pub(crate) const KINDS: &[&str] = &[
    "rc003",
    "cmiotA15",
    "xmBt29",
    "rc313",
    "obeRcuR5",
    "tclRc802a",
    "tclRc902n",
    "tclRc902v",
    "rmfTx800c",
    "hisenseRcf3b65",
    "phicommDb1R",
    "oneplusRc001a",
    "xboxBluetooth",
    "kivoK18Lite",
    "g17Touch",
];

#[allow(dead_code)]
pub(crate) const BUNDLED_KINDS: &[&str] = KINDS;

const PERSISTED_DESCRIPTORS_FILE: &str = "cloud-device-descriptors.json";
pub(crate) const CUSTOM_DEVICES_DIR: &str = "custom-devices";
const MAX_INTERNED_KINDS: usize = 512;
const MAX_INTERNED_DESCRIPTORS: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CloudDescriptorSvg {
    pub kind: String,
    pub svg: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalCustomDeviceEntry {
    pub kind: String,
    pub device_id: String,
    pub name: String,
    pub model: String,
    pub vendor: String,
    pub svg: String,
    pub file_path: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudDescriptorSyncResult {
    pub applied: usize,
    pub rejected: Vec<String>,
    pub changed: bool,
}

#[derive(Default)]
struct DynamicRegistry {
    interned_kinds: BTreeMap<String, &'static str>,
    interned_descriptors: BTreeMap<(String, [u8; 32]), &'static DeviceDescriptor>,
    cloud_active: BTreeMap<&'static str, ([u8; 32], &'static DeviceDescriptor)>,
    cloud_entries: BTreeMap<&'static str, String>,
    local_active: BTreeMap<&'static str, ([u8; 32], &'static DeviceDescriptor)>,
    local_entries: Vec<LocalCustomDeviceEntry>,
}

fn dynamic_registry() -> &'static RwLock<DynamicRegistry> {
    static REGISTRY: OnceLock<RwLock<DynamicRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(DynamicRegistry::default()))
}

fn valid_cloud_kind(kind: &str) -> bool {
    !kind.is_empty()
        && kind.len() <= 64
        && kind != "mouse"
        && kind.as_bytes()[0].is_ascii_alphabetic()
        && kind
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl DynamicRegistry {
    fn intern_kind(&mut self, kind: &str) -> Option<&'static str> {
        if let Some(&bundled) = KINDS.iter().find(|&&candidate| candidate == kind) {
            return Some(bundled);
        }
        if let Some(&existing) = self.interned_kinds.get(kind) {
            return Some(existing);
        }
        if self.interned_kinds.len() >= MAX_INTERNED_KINDS {
            return None;
        }
        let leaked: &'static str = Box::leak(kind.to_owned().into_boxed_str());
        self.interned_kinds.insert(kind.to_owned(), leaked);
        Some(leaked)
    }

    fn intern_descriptor(
        &mut self,
        kind: &str,
        hash: [u8; 32],
        descriptor: DeviceDescriptor,
    ) -> Option<&'static DeviceDescriptor> {
        let key = (kind.to_owned(), hash);
        if let Some(&existing) = self.interned_descriptors.get(&key) {
            return Some(existing);
        }
        if self.interned_descriptors.len() >= MAX_INTERNED_DESCRIPTORS {
            return None;
        }
        let leaked: &'static DeviceDescriptor = Box::leak(Box::new(descriptor));
        self.interned_descriptors.insert(key, leaked);
        Some(leaked)
    }
}

pub(crate) fn registered_kinds() -> Vec<&'static str> {
    let mut kinds = KINDS.to_vec();
    if let Ok(guard) = dynamic_registry().read() {
        for &kind in guard.cloud_active.keys().chain(guard.local_active.keys()) {
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
    }
    kinds
}

#[allow(dead_code)]
pub(crate) fn sync_cloud_descriptors(
    descriptors: &[CloudDescriptorSvg],
) -> CloudDescriptorSyncResult {
    sync_cloud_descriptors_with_valid(descriptors).0
}

pub(crate) fn sync_cloud_descriptors_with_valid(
    descriptors: &[CloudDescriptorSvg],
) -> (CloudDescriptorSyncResult, Vec<CloudDescriptorSvg>) {
    let mut rejected = Vec::new();
    let mut parsed_entries = Vec::new();
    let mut seen_kinds = BTreeSet::new();

    for entry in descriptors {
        let kind = entry.kind.trim();
        if !valid_cloud_kind(kind) {
            let label = if kind.is_empty() { "<empty>" } else { kind };
            log::warn!(target: "axonkey::devices", "Rejected cloud descriptor with invalid kind: {label}");
            rejected.push(label.to_owned());
            continue;
        }
        if !seen_kinds.insert(kind.to_owned()) {
            continue;
        }
        let trimmed_svg = entry.svg.trim();
        match parse_svg(trimmed_svg) {
            Ok(descriptor) => {
                let hash: [u8; 32] = Sha256::digest(trimmed_svg.as_bytes()).into();
                parsed_entries.push((kind.to_owned(), trimmed_svg.to_owned(), hash, descriptor));
            }
            Err(error) => {
                log::warn!(
                    target: "axonkey::devices",
                    "Rejected cloud SVG descriptor for kind={kind}: {error}"
                );
                rejected.push(kind.to_owned());
            }
        }
    }

    let mut guard = dynamic_registry()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut next_active = BTreeMap::new();
    let mut next_cloud_entries = BTreeMap::new();
    let mut valid_items = Vec::new();

    for (kind, svg, hash, descriptor) in parsed_entries {
        let Some(static_kind) = guard.intern_kind(&kind) else {
            rejected.push(kind);
            continue;
        };
        let Some(static_descriptor) = guard.intern_descriptor(static_kind, hash, descriptor) else {
            rejected.push(kind);
            continue;
        };
        next_active.insert(static_kind, (hash, static_descriptor));
        next_cloud_entries.insert(static_kind, svg.clone());
        valid_items.push(CloudDescriptorSvg { kind, svg });
    }

    let changed = guard.cloud_active.len() != next_active.len()
        || guard.cloud_active.iter().any(|(kind, (hash, _))| {
            next_active.get(kind).map(|(next_hash, _)| next_hash) != Some(hash)
        });
    let applied = next_active.len();
    guard.cloud_active = next_active;
    guard.cloud_entries = next_cloud_entries;
    if changed {
        warn_local_cloud_overrides(&guard);
    }

    (
        CloudDescriptorSyncResult {
            applied,
            rejected,
            changed,
        },
        valid_items,
    )
}

fn collect_local_cloud_overrides(guard: &DynamicRegistry) -> Vec<(String, String, bool)> {
    guard
        .local_active
        .iter()
        .filter_map(|(&kind, (local_hash, _))| {
            let (cloud_hash, _) = guard.cloud_active.get(kind)?;
            let file_path = guard
                .local_entries
                .iter()
                .find(|entry| entry.kind == kind)
                .map(|entry| entry.file_path.as_str())
                .unwrap_or("<custom-devices>");
            Some((
                kind.to_owned(),
                file_path.to_owned(),
                local_hash != cloud_hash,
            ))
        })
        .collect()
}

fn warn_local_cloud_overrides(guard: &DynamicRegistry) {
    for (kind, file_path, differs_from_cloud) in collect_local_cloud_overrides(guard) {
        if differs_from_cloud {
            log::warn!(
                target: "axonkey::devices",
                "Local custom descriptor overrides cloud descriptor with different SVG content: kind={kind}, file={file_path}; cloud updates for this device will not take effect until the local file is removed"
            );
        } else {
            log::warn!(
                target: "axonkey::devices",
                "Local custom descriptor shadows cloud descriptor: kind={kind}, file={file_path}; future cloud updates will be overridden until the local file is removed"
            );
        }
    }
}

pub(crate) fn derive_kind_from_device_id(device_id: &str) -> Option<String> {
    let trimmed = device_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(&bundled) = BUNDLED_KINDS
        .iter()
        .find(|&&kind| bundled_descriptor_for_kind(kind).is_some_and(|desc| desc.id == trimmed))
    {
        return Some(bundled.to_owned());
    }
    let parts: Vec<&str> = trimmed
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut code = String::new();
    for (index, part) in parts.iter().enumerate() {
        if index == 0 {
            code.push_str(&part.to_ascii_lowercase());
        } else {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                code.push(first.to_ascii_uppercase());
                for rest in chars {
                    code.push(rest.to_ascii_lowercase());
                }
            }
        }
    }
    if code.as_bytes().first().is_some_and(|b| b.is_ascii_digit()) {
        code.insert(0, 'd');
    }
    if code.len() > 64 {
        code.truncate(64);
    }
    if code == "mouse" {
        code = "customMouse".into();
    }
    valid_cloud_kind(&code).then_some(code)
}

fn sanitize_custom_device_stem(device_id: &str) -> String {
    let mut stem: String = device_id
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    stem = stem.trim_matches(|c| c == '-' || c == '.').to_owned();
    if stem.is_empty() {
        stem = "custom-device".into();
    }
    if stem.len() > 80 {
        stem.truncate(80);
    }
    stem
}

fn inspect_custom_svg_header(svg: &str) -> (bool, Option<String>) {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(svg);
    reader.config_mut().trim_text(true);
    let mut is_draft = false;
    let mut display_name = None;

    loop {
        let Ok(event) = reader.read_event() else {
            break;
        };
        match event {
            Event::Start(element) | Event::Empty(element) => {
                let raw_name = element.name();
                let local = raw_name
                    .as_ref()
                    .rsplit(|&b| b == b':')
                    .next()
                    .unwrap_or(raw_name.as_ref());
                if local.eq_ignore_ascii_case(b"svg") || local.eq_ignore_ascii_case(b"device") {
                    for attr in element.attributes().flatten() {
                        let key = attr.key.as_ref();
                        let Ok(val) = attr.normalized_value(quick_xml::XmlVersion::default())
                        else {
                            continue;
                        };
                        let val_trimmed = val.trim();
                        if (key.eq_ignore_ascii_case(b"status")
                            || key.eq_ignore_ascii_case(b"data-ak-status"))
                            && val_trimmed.eq_ignore_ascii_case("draft")
                        {
                            is_draft = true;
                        } else if local.eq_ignore_ascii_case(b"device")
                            && key.eq_ignore_ascii_case(b"display-name")
                            && !val_trimmed.is_empty()
                        {
                            display_name = Some(val_trimmed.to_owned());
                        }
                    }
                    if local.eq_ignore_ascii_case(b"device") {
                        break;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    (is_draft, display_name)
}

fn parse_runnable_custom_svg(
    svg_content: &str,
    file_path: &Path,
) -> Result<(LocalCustomDeviceEntry, [u8; 32], DeviceDescriptor), String> {
    let trimmed = svg_content.trim();
    if trimmed.is_empty() {
        return Err("SVG 内容为空。".into());
    }
    let (explicitly_draft, header_display_name) = inspect_custom_svg_header(trimmed);
    if explicitly_draft {
        return Err(
            "当前 SVG 仍为未完成草稿（status=\"draft\"），请至少采集 1 个按键并启用正式状态后再放入本机测试。"
                .into(),
        );
    }
    let descriptor =
        parse_svg(trimmed).map_err(|error| format!("SVG 描述符校验未通过：{error}"))?;
    let has_real_vid_pid = descriptor.identities.iter().any(|identity| {
        let vid_ok = identity
            .attributes
            .get("vid")
            .is_some_and(|v| identity_numbers(v).any(|n| n > 0));
        let pid_ok = identity
            .attributes
            .get("pid")
            .is_some_and(|p| identity_numbers(p).any(|n| n > 0));
        vid_ok && pid_ok
    });
    if !has_real_vid_pid {
        return Err("设备 VID/PID 仍为占位值 0x0000:0x0000，请先连接真实硬件完成采集。".into());
    }
    if !descriptor
        .inputs
        .iter()
        .any(|input| !input.pending && !input.sources.is_empty())
    {
        return Err("至少需要完成 1 个按键的报文采集才能放入本机测试。".into());
    }
    let kind = derive_kind_from_device_id(&descriptor.id)
        .ok_or_else(|| format!("无法从设备 ID「{}」推导合法型号标识。", descriptor.id))?;
    let name = header_display_name.unwrap_or_else(|| {
        if descriptor.vendor.trim().is_empty()
            || descriptor.vendor == "Unknown"
            || descriptor.model.starts_with(&descriptor.vendor)
        {
            descriptor.model.clone()
        } else {
            format!("{} {}", descriptor.vendor, descriptor.model)
        }
    });
    let hash: [u8; 32] = Sha256::digest(trimmed.as_bytes()).into();
    let entry = LocalCustomDeviceEntry {
        kind,
        device_id: descriptor.id.clone(),
        name,
        model: descriptor.model.clone(),
        vendor: descriptor.vendor.clone(),
        svg: trimmed.to_owned(),
        file_path: file_path.to_string_lossy().into_owned(),
    };
    Ok((entry, hash, descriptor))
}

pub(crate) fn custom_devices_dir(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(CUSTOM_DEVICES_DIR)
}

pub(crate) fn load_local_custom_descriptors(
    app_data_dir: &Path,
) -> (bool, Vec<LocalCustomDeviceEntry>) {
    let dir = custom_devices_dir(app_data_dir);
    let mut svg_paths = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
            {
                svg_paths.push(path);
            }
        }
    }
    svg_paths.sort();

    let mut parsed_list = Vec::new();
    let mut seen_kinds = BTreeSet::new();
    for path in svg_paths {
        let Ok(raw_svg) = fs::read_to_string(&path) else {
            continue;
        };
        match parse_runnable_custom_svg(&raw_svg, &path) {
            Ok((entry, hash, descriptor)) => {
                if seen_kinds.insert(entry.kind.clone()) {
                    parsed_list.push((entry, hash, descriptor));
                }
            }
            Err(error) => {
                log::warn!(
                    target: "axonkey::devices",
                    "Ignoring invalid local custom SVG {}: {error}",
                    path.display()
                );
            }
        }
    }

    let mut guard = dynamic_registry()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut next_local = BTreeMap::new();
    let mut next_entries = Vec::new();

    for (entry, hash, descriptor) in parsed_list {
        let Some(static_kind) = guard.intern_kind(&entry.kind) else {
            continue;
        };
        let Some(static_descriptor) = guard.intern_descriptor(static_kind, hash, descriptor) else {
            continue;
        };
        next_local.insert(static_kind, (hash, static_descriptor));
        next_entries.push(entry);
    }

    let changed = guard.local_active.len() != next_local.len()
        || guard.local_active.iter().any(|(kind, (hash, _))| {
            next_local.get(kind).map(|(next_hash, _)| next_hash) != Some(hash)
        });
    guard.local_active = next_local;
    guard.local_entries = next_entries.clone();
    if changed {
        warn_local_cloud_overrides(&guard);
    }
    (changed, next_entries)
}

pub(crate) fn install_local_custom_descriptor(
    app_data_dir: &Path,
    svg_content: &str,
    markdown_content: Option<&str>,
) -> Result<(LocalCustomDeviceEntry, bool), String> {
    let dir = custom_devices_dir(app_data_dir);
    let preview_path = dir.join("pending.svg");
    let (validated_entry, _, _) = parse_runnable_custom_svg(svg_content, &preview_path)?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建本机设备目录：{error}"))?;

    let stem = sanitize_custom_device_stem(&validated_entry.device_id);
    let svg_path = dir.join(format!("{stem}.svg"));
    let temp_svg = dir.join(format!("{stem}.svg.tmp"));
    fs::write(&temp_svg, validated_entry.svg.as_bytes())
        .map_err(|error| format!("写入本机设备 SVG 失败：{error}"))?;
    fs::rename(&temp_svg, &svg_path).map_err(|error| format!("保存本机设备 SVG 失败：{error}"))?;

    if let Some(md) = markdown_content.map(str::trim).filter(|s| !s.is_empty()) {
        let md_path = dir.join(format!("{stem}.md"));
        let _ = fs::write(&md_path, md.as_bytes());
    }

    let (changed, entries) = load_local_custom_descriptors(app_data_dir);
    let installed = entries
        .into_iter()
        .find(|item| item.kind == validated_entry.kind)
        .unwrap_or(LocalCustomDeviceEntry {
            file_path: svg_path.to_string_lossy().into_owned(),
            ..validated_entry
        });
    Ok((installed, changed))
}

#[cfg(test)]
pub(crate) fn clear_local_custom_descriptors_for_test() {
    let mut guard = dynamic_registry()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.local_active.clear();
    guard.local_entries.clear();
}

pub(crate) fn load_persisted_cloud_descriptors(directory: &Path) {
    let path = directory.join(PERSISTED_DESCRIPTORS_FILE);
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(items) = serde_json::from_str::<Vec<CloudDescriptorSvg>>(&raw) else {
        log::warn!(target: "axonkey::devices", "Ignoring unreadable cloud-device-descriptors.json");
        return;
    };
    let _ = sync_cloud_descriptors(&items);
}

pub(crate) fn save_persisted_cloud_descriptors(
    directory: &Path,
    valid_items: &[CloudDescriptorSvg],
) {
    let path = directory.join(PERSISTED_DESCRIPTORS_FILE);
    if valid_items.is_empty() {
        let _ = fs::remove_file(&path);
        return;
    }
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    let Ok(serialized) = serde_json::to_vec(valid_items) else {
        return;
    };
    let temp = path.with_extension("tmp");
    if fs::write(&temp, serialized).is_ok() {
        let _ = fs::rename(&temp, &path);
    }
}

/// Return the active local custom descriptor, cloud descriptor, or bundled fallback for a device kind.
///
/// Bundled descriptors are parsed once after startup on first use. A malformed
/// file is treated as unsupported instead of falling back to a different model.
pub(crate) fn descriptor_for_kind(kind: &str) -> Option<&'static DeviceDescriptor> {
    if let Ok(guard) = dynamic_registry().read() {
        if let Some((_, descriptor)) = guard.local_active.get(kind) {
            return Some(*descriptor);
        }
        if let Some((_, descriptor)) = guard.cloud_active.get(kind) {
            return Some(*descriptor);
        }
    }
    bundled_descriptor_for_kind(kind)
}

/// Return the raw dynamic SVG for a kind (local custom override preferred over cloud descriptor).
pub(crate) fn dynamic_svg_for_kind(kind: &str) -> Option<String> {
    let guard = dynamic_registry().read().ok()?;
    if let Some(entry) = guard.local_entries.iter().find(|entry| entry.kind == kind) {
        return Some(entry.svg.clone());
    }
    guard.cloud_entries.get(kind).cloned()
}

pub(crate) fn bundled_descriptor_for_kind(kind: &str) -> Option<&'static DeviceDescriptor> {
    match kind {
        "rc003" => rc003(),
        "cmiotA15" => cmiot_a15(),
        "xmBt29" => xm_bt_29(),
        "rc313" => rc313(),
        "obeRcuR5" => obe_rcu_r5(),
        "tclRc802a" => crate::devices::tcl_rc802a::descriptor(),
        "tclRc902n" => crate::devices::tcl_rc902n::descriptor(),
        "tclRc902v" => crate::devices::tcl_rc902v::descriptor(),
        "rmfTx800c" => rmf_tx800c(),
        "hisenseRcf3b65" => crate::devices::hisense_rcf3b65::descriptor(),
        "phicommDb1R" => crate::devices::phicomm_db1_r::descriptor(),
        "oneplusRc001a" => crate::devices::oneplus_rc_001a::descriptor(),
        "xboxBluetooth" => xbox(),
        "kivoK18Lite" => crate::devices::kivo_k18_lite::descriptor(),
        "g17Touch" => g17_touch(),
        _ => None,
    }
}

pub(super) fn load(
    svg: &'static str,
    slot: &'static OnceLock<Option<DeviceDescriptor>>,
) -> Option<&'static DeviceDescriptor> {
    slot.get_or_init(|| parse_svg(svg).ok()).as_ref()
}

fn rc003() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/rc003.svg"),
        &DESCRIPTOR,
    )
}

fn cmiot_a15() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/cmiot-a15.svg"),
        &DESCRIPTOR,
    )
}

fn xm_bt_29() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/xm-bt-29.svg"),
        &DESCRIPTOR,
    )
}

fn rc313() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/rc313.svg"),
        &DESCRIPTOR,
    )
}

fn obe_rcu_r5() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/obe-rcu-r5.svg"),
        &DESCRIPTOR,
    )
}

fn xbox() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/xbox.svg"),
        &DESCRIPTOR,
    )
}

fn rmf_tx800c() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/rmf-tx800c.svg"),
        &DESCRIPTOR,
    )
}

fn g17_touch() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    load(
        include_str!("../../../public/device-descriptors/g17-touch.svg"),
        &DESCRIPTOR,
    )
}

/// Compatibility key used by saved profiles while a descriptor can expose a
/// namespaced stable key.
pub(crate) fn input_key(input: &super::device_descriptor::InputDescriptor) -> &str {
    input
        .legacy_key
        .as_deref()
        .and_then(|aliases| aliases.split_whitespace().next())
        .unwrap_or(&input.id)
}

pub(crate) fn profile_key(kind: &str, key: &str) -> Option<&'static str> {
    descriptor_for_kind(kind)?
        .inputs
        .iter()
        .find(|input| {
            input.id == key
                || input
                    .legacy_key
                    .as_deref()
                    .is_some_and(|aliases| aliases.split_whitespace().any(|alias| alias == key))
        })
        .map(input_key)
}

pub(crate) fn input_icon_and_kind(
    kind: &str,
    key: &str,
) -> Option<(Option<&'static str>, &'static str)> {
    let input = descriptor_for_kind(kind)?.inputs.iter().find(|input| {
        input.id == key
            || input
                .legacy_key
                .as_deref()
                .is_some_and(|aliases| aliases.split_whitespace().any(|alias| alias == key))
    })?;
    Some((input.icon.as_deref(), input.kind.as_str()))
}

pub(crate) fn primary_hardware(kind: &str) -> Option<(u16, u16)> {
    let descriptor = descriptor_for_kind(kind)?;
    descriptor.identities.iter().find_map(|identity| {
        Some((
            identity_numbers(identity.attributes.get("vid")?).next()? as u16,
            identity_numbers(identity.attributes.get("pid")?).next()? as u16,
        ))
    })
}

pub(crate) fn original_usage(kind: &str, key: &str) -> Option<(u16, u16)> {
    let descriptor = descriptor_for_kind(kind)?;
    let input = descriptor.inputs.iter().find(|input| {
        input.id == key
            || input
                .legacy_key
                .as_deref()
                .is_some_and(|aliases| aliases.split_whitespace().any(|alias| alias == key))
    })?;
    if !input.original {
        return None;
    }
    input
        .sources
        .iter()
        .find_map(|source| Some((source.page?, source.usage?)))
}

pub(crate) fn voice_engine(kind: &str) -> Option<&'static str> {
    Some(&descriptor_for_kind(kind)?.voices.first()?.engine)
}

pub(crate) fn voice_key(kind: &str) -> Option<&'static str> {
    let descriptor = descriptor_for_kind(kind)?;
    let voice = descriptor.voices.first()?;
    descriptor
        .inputs
        .iter()
        .find(|input| input.id == voice.trigger_key)
        .map(input_key)
}

pub(crate) fn uses_vendor_usb_hid(kind: &str) -> bool {
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        !descriptor.identities.is_empty()
            && descriptor.identities.iter().all(|identity| {
                identity
                    .attributes
                    .get("transport")
                    .is_some_and(|transport| transport == "usb-hid")
                    && identity.attributes.get("usage-page").is_some_and(|page| {
                        identity_numbers(page).next().is_some()
                            && identity_numbers(page)
                                .all(|value| (0xff00..=0xffff).contains(&value))
                    })
            })
    })
}

pub(crate) fn requires_information(kind: &str) -> bool {
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor.identities.iter().any(|identity| {
            identity
                .attributes
                .get("information-required")
                .is_some_and(|value| value == "true")
        })
    })
}

pub(crate) fn matches_information(
    kind: &str,
    vendor: u16,
    product: u16,
    model: Option<&str>,
    manufacturer: Option<&str>,
    software: Option<&str>,
) -> bool {
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor.identities.iter().any(|identity| {
            matches_identity_number(identity, "vid", Some(vendor))
                && matches_identity_number(identity, "pid", Some(product))
                && [
                    ("model-contains", model),
                    ("manufacturer-contains", manufacturer),
                    ("software-contains", software),
                ]
                .iter()
                .all(|(key, actual)| {
                    identity.attributes.get(*key).is_none_or(|markers| {
                        actual.is_some_and(|value| {
                            markers.split('|').any(|marker| value.contains(marker))
                        })
                    })
                })
        })
    })
}

pub(crate) fn matches_hardware(
    kind: &str,
    vid: u16,
    pid: u16,
    usage_page: Option<u16>,
    usage: Option<u16>,
) -> bool {
    matches_hardware_for_transport(kind, vid, pid, usage_page, usage, None)
}

pub(crate) fn matches_hardware_for_transport(
    kind: &str,
    vid: u16,
    pid: u16,
    usage_page: Option<u16>,
    usage: Option<u16>,
    transport: Option<&str>,
) -> bool {
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor.identities.iter().any(|identity| {
            matches_identity_transport(identity, transport)
                && matches_identity_number(identity, "vid", Some(vid))
                && matches_identity_number(identity, "pid", Some(pid))
                && matches_identity_number(identity, "usage-page", usage_page)
                && matches_identity_number(identity, "usage", usage)
        })
    })
}

fn matches_identity_transport(
    identity: &super::device_descriptor::IdentityDescriptor,
    actual: Option<&str>,
) -> bool {
    let Some(actual) = actual else {
        return true;
    };
    match identity.attributes.get("transport").map(String::as_str) {
        Some("bluetooth-hid") => actual != "usb-hid",
        Some("usb-hid") => actual != "bluetooth-hid",
        _ => true,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn matches_bluetooth_vendor_source(
    kind: &str,
    vendor: u16,
    product: u16,
    source: Option<u16>,
) -> bool {
    let Some(source) = source else {
        return false;
    };
    let qualified_vid = ((source as u32) << 16) | (vendor as u32);
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor.identities.iter().any(|identity| {
            identity.attributes.get("vid").is_some_and(|expected| {
                identity_numbers(expected).any(|value| value == qualified_vid)
            }) && matches_identity_number(identity, "pid", Some(product))
        })
    })
}

pub(crate) fn matches_instance(kind: &str, id: &str) -> bool {
    let id = id.to_ascii_uppercase();
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor.identities.iter().any(|identity| {
            identity_matches_hardware_id(identity, &id)
                && identity
                    .attributes
                    .get("windows-prefix")
                    .is_none_or(|prefix| id.starts_with(&prefix.to_ascii_uppercase()))
                && identity
                    .attributes
                    .get("service")
                    .is_none_or(|service| id.contains(&service.to_ascii_uppercase()))
        })
    })
}

pub(crate) fn matches_hardware_id(kind: &str, id: &str) -> bool {
    let id = id.to_ascii_uppercase();
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor
            .identities
            .iter()
            .any(|identity| identity_matches_hardware_id(identity, &id))
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn hardware_vid_pid(id: &str) -> Option<(u16, u16)> {
    let (vid, pid) = parse_hardware_id_vid_pid(&id.to_ascii_uppercase())?;
    Some((vid as u16, pid as u16))
}

fn parse_hardware_id_vid_pid(id: &str) -> Option<(u32, u32)> {
    let tokens = id
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let number = |name| {
        tokens.windows(2).find_map(|pair| {
            (pair[0] == name)
                .then(|| u32::from_str_radix(pair[1], 16).ok())
                .flatten()
        })
    };
    Some((number("VID")?, number("PID")?))
}

fn identity_matches_hardware_id(
    identity: &super::device_descriptor::IdentityDescriptor,
    id: &str,
) -> bool {
    let Some((vid, pid)) = parse_hardware_id_vid_pid(id) else {
        return false;
    };
    identity
        .attributes
        .get("vid")
        .is_some_and(|expected| identity_numbers(expected).any(|value| value == vid))
        && identity
            .attributes
            .get("pid")
            .is_some_and(|expected| identity_numbers(expected).any(|value| value == pid))
}

fn matches_identity_number(
    identity: &super::device_descriptor::IdentityDescriptor,
    key: &str,
    actual: Option<u16>,
) -> bool {
    identity.attributes.get(key).is_none_or(|expected| {
        actual.is_none_or(|actual| identity_numbers(expected).any(|value| value as u16 == actual))
    })
}

fn identity_numbers(value: &str) -> impl Iterator<Item = u32> + '_ {
    value
        .split(|c: char| c.is_ascii_whitespace() || c == '|' || c == ',')
        .filter(|token| !token.is_empty())
        .filter_map(|value| {
            let value = value.trim();
            if let Some(hex) = value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
            {
                u32::from_str_radix(hex, 16).ok()
            } else {
                value.parse().ok()
            }
        })
}

#[cfg(test)]
pub(crate) static DYNAMIC_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::engine::DescriptorEngine;

    fn custom_remote_svg(device_id: &str, vid: &str, pid: &str) -> String {
        format!(
            r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="240" height="520" viewBox="0 0 240 520"
     data-ak-schema="axonkey.device/1"
     data-ak-device="{device_id}"
     data-ak-revision="1">
  <metadata>
    <ak:device schema="axonkey.device/1" id="{device_id}" vendor="Custom" model="CR-X1" revision="1" display-name="自定义遥控器 X">
      <ak:identity>
        <ak:match transport="bluetooth-hid" vid="{vid}" pid="{pid}" usage-page="0x0C" usage="0x01" windows-prefix="BTHLEDEVICE" />
      </ak:identity>
      <ak:reports>
        <ak:report id="consumer" direction="input" report-id="0x02" length="3" encoding="le-u16-single" usage-page="0x0C" payload-offset="1" endian="little" state-group="consumer" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="{device_id}.ok" label="确认键" short="OK" icon="center" order="0" kind="button" target="#ok-btn" report="consumer" page="0x0C" usage="0x0041" original="true" />
        <ak:input id="{device_id}.back" label="返回键" short="返回" icon="back" order="1" kind="button" target="#back-btn" report="consumer" page="0x0C" usage="0x0224" original="true" />
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="ok-btn"><circle cx="120" cy="180" r="36" /></g>
  <g id="back-btn"><circle cx="120" cy="300" r="24" /></g>
  <path data-ak-region="{device_id}.ok" data-ak-anchor="120 180" d="M84 180a36 36 0 1 0 72 0a36 36 0 1 0 -72 0" />
  <path data-ak-region="{device_id}.back" data-ak-anchor="120 300" d="M96 300a24 24 0 1 0 48 0a24 24 0 1 0 -48 0" />
</svg>"##
        )
    }

    #[test]
    fn identities_use_svg_hardware_interface_and_windows_node_constraints() {
        assert!(matches_hardware("rc003", 0x2717, 0x32b8, Some(1), Some(6)));
        assert!(!matches_hardware(
            "rc003",
            0x2717,
            0x32b8,
            Some(12),
            Some(1)
        ));
        assert!(matches_instance(
            "cmiotA15",
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&050416_PID&0300\instance"
        ));
        assert!(!matches_instance(
            "cmiotA15",
            r"USB\VID_0416&PID_0300\instance"
        ));
        assert!(matches_instance(
            "xboxBluetooth",
            r"HID\VID_045E&PID_02E0\instance"
        ));
        assert!(!matches_instance(
            "xboxBluetooth",
            r"BTHENUM\VID_045E&PID_02E0\instance"
        ));
        assert!(!matches_instance(
            "xboxBluetooth",
            r"HID\VID_045E&PID_02E00\instance"
        ));
        assert!(matches_hardware_id(
            "rc003",
            r"BTHLEDEVICE\VID_012717&PID_32B8\instance"
        ));
        assert!(!matches_hardware_id(
            "rc003",
            r"BTHLEDEVICE\VID_012717&PID_32B80\instance"
        ));
        assert!(matches_instance(
            "hisenseRcf3b65",
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&01109B_PID&3837\instance"
        ));
        assert!(!matches_instance(
            "hisenseRcf3b65",
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&05109B_PID&3837\instance"
        ));
        assert!(matches_hardware(
            "hisenseRcf3b65",
            0x109b,
            0x3837,
            Some(1),
            Some(6)
        ));
        assert!(matches_instance(
            "phicommDb1R",
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&01005D_PID&0001\instance"
        ));
        assert!(!matches_instance(
            "phicommDb1R",
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&05005D_PID&0001\instance"
        ));
        assert!(matches_hardware(
            "phicommDb1R",
            0x005d,
            0x0001,
            Some(12),
            Some(1)
        ));
        assert!(matches_instance(
            "oneplusRc001a",
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012B31_PID&4858\instance"
        ));
        assert!(!matches_instance(
            "oneplusRc001a",
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&052B31_PID&4858\instance"
        ));
        assert!(matches_hardware(
            "oneplusRc001a",
            0x2b31,
            0x4858,
            Some(12),
            Some(1)
        ));
        assert!(matches_hardware(
            "kivoK18Lite",
            0x2e8a,
            0xa018,
            Some(0xff60),
            Some(0x01)
        ));
        assert!(!matches_hardware(
            "kivoK18Lite",
            0x2e8a,
            0xa018,
            Some(0x01),
            Some(0x06)
        ));
        assert!(matches_hardware(
            "g17Touch",
            0x1209,
            0xa017,
            Some(0xff60),
            Some(0x01)
        ));
        assert!(!matches_hardware(
            "g17Touch",
            0x1209,
            0xa017,
            Some(0x01),
            Some(0x06)
        ));
        assert!(uses_vendor_usb_hid("kivoK18Lite"));
        assert!(uses_vendor_usb_hid("g17Touch"));
        assert!(!uses_vendor_usb_hid("xboxBluetooth"));
        assert!(!uses_vendor_usb_hid("rc003"));
        assert!(!uses_vendor_usb_hid("unknown"));

        assert!(matches_hardware_for_transport(
            "tclRc902v",
            0x045e,
            0x0040,
            Some(1),
            Some(2),
            None
        ));
        assert!(matches_hardware_for_transport(
            "tclRc902v",
            0x045e,
            0x0040,
            Some(1),
            Some(2),
            Some("bluetooth-hid")
        ));
        assert!(!matches_hardware_for_transport(
            "tclRc902v",
            0x045e,
            0x0040,
            Some(1),
            Some(2),
            Some("usb-hid")
        ));
        assert!(matches_hardware_for_transport(
            "kivoK18Lite",
            0x2e8a,
            0xa018,
            Some(0xff60),
            Some(0x01),
            Some("usb-hid")
        ));
        assert!(!matches_hardware_for_transport(
            "kivoK18Lite",
            0x2e8a,
            0xa018,
            Some(0xff60),
            Some(0x01),
            Some("bluetooth-hid")
        ));
    }

    #[test]
    fn hardware_vid_pid_extracts_low_16_bit_ids_from_pnp_strings() {
        assert_eq!(
            hardware_vid_pid(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&02045E_PID&0040_REV&0001_AABBCCDDEEFF\instance"
            ),
            Some((0x045e, 0x0040))
        );
        assert_eq!(
            hardware_vid_pid(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&01045E_PID&0040_REV&0001_AABBCCDDEEFF\instance"
            ),
            Some((0x045e, 0x0040))
        );
        assert_eq!(
            hardware_vid_pid(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010417_PID&0304\instance"
            ),
            Some((0x0417, 0x0304))
        );
        assert_eq!(
            hardware_vid_pid(r"BTHLEDEVICE\DEV_AABBCCDDEEFF\instance"),
            None
        );
    }

    #[test]
    fn bluetooth_vendor_source_checks_qualified_vid_and_pid() {
        assert!(matches_bluetooth_vendor_source(
            "tclRc902v",
            0x045e,
            0x0040,
            Some(1)
        ));
        assert!(matches_bluetooth_vendor_source(
            "tclRc902v",
            0x045e,
            0x0040,
            Some(2)
        ));
        assert!(!matches_bluetooth_vendor_source(
            "tclRc902v",
            0x045e,
            0x0040,
            Some(5)
        ));
        assert!(!matches_bluetooth_vendor_source(
            "tclRc902v",
            0x045e,
            0x0040,
            None
        ));
        assert!(!matches_bluetooth_vendor_source(
            "xboxBluetooth",
            0x045e,
            0x02e0,
            Some(1)
        ));
    }

    #[test]
    fn g17_touch_decodes_mechanical_keys_touch_zones_and_slider_swipes() {
        let descriptor = descriptor_for_kind("g17Touch").expect("g17Touch descriptor must parse");
        assert_eq!(descriptor.inputs.len(), 23);

        let mut engine = crate::devices::engine::DescriptorEngine::default();
        // Press Num (b0 bit0), Enter (b1 bit6), T2 (b2 bit5), and SwipeUp (b3 bit0)
        let events = engine.accept(
            descriptor,
            &[0x01, 0x01, 0x40, 0x20, 0x01, 0x01, 0x01, 0x00],
        );
        assert_eq!(
            events,
            vec![
                ("g17.touch.num".to_string(), true),
                ("g17.touch.enter".to_string(), true),
                ("g17.touch.t2".to_string(), true),
                ("g17.touch.swipeUp".to_string(), true),
            ]
        );

        let release = engine.accept(
            descriptor,
            &[0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00],
        );
        assert_eq!(
            release,
            vec![
                ("g17.touch.num".to_string(), false),
                ("g17.touch.enter".to_string(), false),
                ("g17.touch.t2".to_string(), false),
                ("g17.touch.swipeUp".to_string(), false),
            ]
        );
    }

    #[test]
    fn saved_keys_original_output_and_voice_trigger_share_the_descriptor() {
        assert_eq!(profile_key("rc003", "power"), Some("power"));
        assert_eq!(profile_key("rc003", "xiaomi.rc003.power"), Some("power"));
        assert_eq!(profile_key("rc003", "cmiotA15.power"), None);
        assert_eq!(original_usage("rc003", "volumeUp"), Some((7, 0x80)));
        assert_eq!(
            original_usage("cmiotA15", "cmiotA15.back"),
            Some((12, 0x224))
        );
        assert_eq!(voice_key("rc003"), Some("voice"));
        assert_eq!(voice_engine("xmBt29"), Some("cmiot-a15.g7221"));
        assert_eq!(voice_key("obeRcuR5"), Some("obeRcuR5.voice"));
        assert_eq!(voice_engine("xboxBluetooth"), None);
    }

    #[test]
    fn bundled_descriptors_parse_for_every_supported_kind() {
        for kind in BUNDLED_KINDS {
            let descriptor = descriptor_for_kind(kind)
                .unwrap_or_else(|| panic!("bundled descriptor failed to parse: {kind}"));
            assert!(descriptor.revision >= 1, "unexpected revision for {kind}");
            assert!(!descriptor.inputs.is_empty(), "missing inputs for {kind}");
            assert!(!descriptor.reports.is_empty(), "missing reports for {kind}");
        }
    }

    #[test]
    fn sony_rmf_tx800c_matches_and_decodes_captured_reports() {
        let kind = "rmfTx800c";
        let descriptor = bundled_descriptor_for_kind(kind).unwrap();
        assert_eq!(descriptor.id, "rmf-tx800c");
        assert_eq!(
            derive_kind_from_device_id(&descriptor.id).as_deref(),
            Some(kind)
        );
        assert!(requires_information(kind));
        for manufacturer in ["Sony Corporation", "Sony_Corporation"] {
            assert!(matches_information(
                kind,
                0x054c,
                0x0df7,
                None,
                Some(manufacturer),
                None
            ));
        }
        assert!(!matches_information(
            kind,
            0x054c,
            0x0df8,
            None,
            Some("Sony Corporation"),
            None
        ));
        assert!(!matches_information(kind, 0x054c, 0x0df7, None, None, None));

        let cases = [
            ("tv", [0x89, 0x00]),
            ("settings", [0xc3, 0x03]),
            ("input", [0x33, 0x05]),
            ("number", [0x1f, 0x05]),
            ("up", [0x42, 0x00]),
            ("left", [0x44, 0x00]),
            ("confirm", [0x41, 0x00]),
            ("right", [0x45, 0x00]),
            ("down", [0x43, 0x00]),
            ("back", [0x24, 0x02]),
            ("home", [0x23, 0x02]),
            ("mute", [0xe2, 0x00]),
            ("menu", [0x8b, 0x03]),
            ("volumeUp", [0xe9, 0x00]),
            ("volumeDown", [0xea, 0x00]),
        ];
        let mut engine = DescriptorEngine::default();
        for (key, [lo, hi]) in cases {
            let id = format!("rmf-tx800c.{key}");
            assert_eq!(
                engine.accept(descriptor, &[0x04, lo, hi, 0, 0]),
                [(id.clone(), true)]
            );
            assert!(engine.accept(descriptor, &[0x04, 0, 0]).is_empty());
            assert_eq!(
                engine.accept(descriptor, &[0x04, 0, 0, 0, 0]),
                [(id, false)]
            );
        }
        let pending: Vec<_> = descriptor
            .inputs
            .iter()
            .filter(|input| input.pending && input.sources.is_empty())
            .map(|input| input.id.as_str())
            .collect();
        assert_eq!(pending, ["rmf-tx800c.power"]);
        assert_eq!(
            descriptor
                .inputs
                .iter()
                .filter(|input| input.target.is_some())
                .count(),
            16
        );
        assert!(descriptor
            .inputs
            .iter()
            .filter(|input| input.pending)
            .all(|input| input.target.is_none()));
        assert_eq!(voice_key(kind), Some("rmf-tx800c.voice"));
        assert_eq!(voice_engine(kind), Some("tcl-rc902v-atvv"));
        let voice = descriptor
            .inputs
            .iter()
            .find(|input| input.id == "rmf-tx800c.voice")
            .unwrap();
        assert_eq!(voice.target.as_deref(), Some("#key-voice"));
        assert_eq!(voice.sources[0].report, "voice-control");
        let mut search = [0; 20];
        search[0] = 0x08;
        assert!(engine.accept(descriptor, &search).is_empty());
    }

    #[test]
    fn dynamic_cloud_descriptor_activates_new_kind_decodes_hid_and_interns_without_leaking() {
        let _guard = DYNAMIC_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let svg = custom_remote_svg("custom.remote.x", "0x2B00", "0x9901");
        let first = sync_cloud_descriptors(&[CloudDescriptorSvg {
            kind: "customRemoteX".into(),
            svg: svg.clone(),
        }]);
        assert_eq!(
            first,
            CloudDescriptorSyncResult {
                applied: 1,
                rejected: vec![],
                changed: true,
            }
        );
        assert!(registered_kinds().contains(&"customRemoteX"));
        assert!(matches_hardware(
            "customRemoteX",
            0x2b00,
            0x9901,
            Some(0x0c),
            Some(0x01)
        ));
        assert_eq!(
            profile_key("customRemoteX", "custom.remote.x.ok"),
            Some("custom.remote.x.ok")
        );
        assert_eq!(
            original_usage("customRemoteX", "custom.remote.x.back"),
            Some((0x0c, 0x0224))
        );

        let desc_ptr_1 = descriptor_for_kind("customRemoteX").expect("cloud descriptor registered");
        let mut engine = DescriptorEngine::default();
        let press = engine.accept(desc_ptr_1, &[0x02, 0x41, 0x00]);
        assert_eq!(press, vec![("custom.remote.x.ok".to_string(), true)]);
        let release = engine.accept(desc_ptr_1, &[0x02, 0x00, 0x00]);
        assert_eq!(release, vec![("custom.remote.x.ok".to_string(), false)]);

        // Syncing identical SVG again reports changed=false and reuses the exact interned pointer.
        let second = sync_cloud_descriptors(&[CloudDescriptorSvg {
            kind: "customRemoteX".into(),
            svg,
        }]);
        assert!(!second.changed);
        let desc_ptr_2 = descriptor_for_kind("customRemoteX").unwrap();
        assert!(std::ptr::eq(desc_ptr_1, desc_ptr_2));

        let reset = sync_cloud_descriptors(&[]);
        assert!(reset.changed);
        assert!(descriptor_for_kind("customRemoteX").is_none());
        assert_eq!(registered_kinds(), KINDS.to_vec());
    }

    #[test]
    fn unsafe_or_malformed_cloud_svg_is_rejected_without_breaking_bundled_or_valid_models() {
        let _guard = DYNAMIC_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let base_svg = custom_remote_svg("custom.remote.y", "0x2B01", "0x9902");
        let with_script = base_svg.replace("</svg>", "<script>alert(1)</script></svg>");
        let with_foreign = base_svg.replace(
            "</svg>",
            "<foreignObject width=\"10\" height=\"10\"></foreignObject></svg>",
        );
        let with_event = base_svg.replace("<g id=\"ok-btn\">", "<g id=\"ok-btn\" onclick=\"x()\">");
        let with_ext_image = base_svg.replace(
            "</svg>",
            "<image href=\"https://evil.invalid/track.svg\" width=\"1\" height=\"1\" /></svg>",
        );
        let broken_rc003 = base_svg.replace("report=\"consumer\"", "report=\"missing\"");

        let bundled_rc003 = bundled_descriptor_for_kind("rc003").unwrap();
        let result = sync_cloud_descriptors(&[
            CloudDescriptorSvg {
                kind: "badScript".into(),
                svg: with_script,
            },
            CloudDescriptorSvg {
                kind: "badForeign".into(),
                svg: with_foreign,
            },
            CloudDescriptorSvg {
                kind: "badEvent".into(),
                svg: with_event,
            },
            CloudDescriptorSvg {
                kind: "badImage".into(),
                svg: with_ext_image,
            },
            CloudDescriptorSvg {
                kind: "rc003".into(),
                svg: broken_rc003,
            },
            CloudDescriptorSvg {
                kind: "mouse".into(),
                svg: base_svg.clone(),
            },
            CloudDescriptorSvg {
                kind: "customRemoteY".into(),
                svg: base_svg,
            },
        ]);

        assert_eq!(result.applied, 1);
        assert_eq!(
            result.rejected,
            vec![
                "badScript",
                "badForeign",
                "badEvent",
                "badImage",
                "rc003",
                "mouse"
            ]
        );
        assert!(std::ptr::eq(
            descriptor_for_kind("rc003").unwrap(),
            bundled_rc003
        ));
        assert!(descriptor_for_kind("customRemoteY").is_some());

        let _ = sync_cloud_descriptors(&[]);
    }

    #[test]
    fn persisted_cloud_descriptors_roundtrip_and_remove_when_empty() {
        let _guard = DYNAMIC_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "axonkey-cloud-descriptors-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let svg = custom_remote_svg("custom.remote.z", "0x2B02", "0x9903");
        let item = CloudDescriptorSvg {
            kind: "customRemoteZ".into(),
            svg,
        };
        save_persisted_cloud_descriptors(&dir, std::slice::from_ref(&item));
        let _ = sync_cloud_descriptors(&[]);
        assert!(descriptor_for_kind("customRemoteZ").is_none());

        load_persisted_cloud_descriptors(&dir);
        assert!(descriptor_for_kind("customRemoteZ").is_some());

        save_persisted_cloud_descriptors(&dir, &[]);
        assert!(!dir.join(PERSISTED_DESCRIPTORS_FILE).exists());
        let _ = sync_cloud_descriptors(&[]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_custom_descriptors_install_persist_and_survive_cloud_refresh() {
        let _guard = DYNAMIC_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_local_custom_descriptors_for_test();
        let _ = sync_cloud_descriptors(&[]);

        let dir = std::env::temp_dir().join(format!(
            "axonkey-local-custom-devices-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(
            derive_kind_from_device_id("mini-pad-v2"),
            Some("miniPadV2".into())
        );
        assert_eq!(
            derive_kind_from_device_id("phicomm-db1-r"),
            Some("phicommDb1R".into())
        );

        let draft_svg = custom_remote_svg("local-test-pad", "0x2E8A", "0xA099").replace(
            "display-name=\"自定义遥控器 X\"",
            "display-name=\"本机测试小键盘\" status=\"draft\"",
        );
        assert!(install_local_custom_descriptor(&dir, &draft_svg, None).is_err());

        let placeholder_svg = custom_remote_svg("local-test-pad", "0x0000", "0x0000");
        assert!(install_local_custom_descriptor(&dir, &placeholder_svg, None).is_err());

        let active_svg = custom_remote_svg("local-test-pad", "0x2E8A", "0xA099");
        let (installed, changed) =
            install_local_custom_descriptor(&dir, &active_svg, Some("# 采集摘要\n")).unwrap();
        assert!(changed);
        assert_eq!(installed.kind, "localTestPad");
        assert_eq!(installed.device_id, "local-test-pad");
        assert_eq!(installed.name, "自定义遥控器 X");
        assert!(Path::new(&installed.file_path).is_file());
        assert!(dir
            .join(CUSTOM_DEVICES_DIR)
            .join("local-test-pad.md")
            .is_file());
        assert!(registered_kinds().contains(&"localTestPad"));
        assert!(descriptor_for_kind("localTestPad").is_some());

        // Cloud refresh with an empty or different model list must NOT clobber local custom devices.
        let _ = sync_cloud_descriptors(&[]);
        assert!(registered_kinds().contains(&"localTestPad"));
        assert!(descriptor_for_kind("localTestPad").is_some());

        // When cloud registers the same kind, local custom overrides cloud and is reported by collect_local_cloud_overrides.
        let _ = sync_cloud_descriptors(&[CloudDescriptorSvg {
            kind: "localTestPad".into(),
            svg: active_svg.clone(),
        }]);
        assert_eq!(
            dynamic_svg_for_kind("localTestPad").as_deref(),
            Some(active_svg.trim())
        );
        {
            let guard = dynamic_registry().read().unwrap();
            assert_eq!(
                collect_local_cloud_overrides(&guard),
                vec![("localTestPad".into(), installed.file_path.clone(), false)]
            );
        }

        let updated_cloud_svg = active_svg.replace("自定义遥控器 X", "云端更新版遥控器");
        let _ = sync_cloud_descriptors(&[CloudDescriptorSvg {
            kind: "localTestPad".into(),
            svg: updated_cloud_svg.clone(),
        }]);
        assert_eq!(
            dynamic_svg_for_kind("localTestPad").as_deref(),
            Some(active_svg.trim())
        );
        {
            let guard = dynamic_registry().read().unwrap();
            assert_eq!(
                collect_local_cloud_overrides(&guard),
                vec![("localTestPad".into(), installed.file_path.clone(), true)]
            );
        }
        assert_eq!(descriptor_for_kind("localTestPad").unwrap().model, "CR-X1");

        // Deleting the file from custom-devices and reloading removes the local custom device cleanly.
        fs::remove_file(&installed.file_path).unwrap();
        let (removed_changed, remaining) = load_local_custom_descriptors(&dir);
        assert!(removed_changed);
        assert!(remaining.is_empty());
        {
            let guard = dynamic_registry().read().unwrap();
            assert!(collect_local_cloud_overrides(&guard).is_empty());
        }
        assert!(descriptor_for_kind("localTestPad").is_some());
        assert_eq!(
            dynamic_svg_for_kind("localTestPad").as_deref(),
            Some(updated_cloud_svg.trim())
        );
        let _ = sync_cloud_descriptors(&[]);
        assert!(descriptor_for_kind("localTestPad").is_none());
        assert!(dynamic_svg_for_kind("localTestPad").is_none());

        clear_local_custom_descriptors_for_test();
        let _ = fs::remove_dir_all(&dir);
    }
}
