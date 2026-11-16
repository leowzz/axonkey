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
    "hisenseRcf3b65",
    "phicommDb1R",
    "xboxBluetooth",
];

#[allow(dead_code)]
pub(crate) const BUNDLED_KINDS: &[&str] = KINDS;

const PERSISTED_DESCRIPTORS_FILE: &str = "cloud-device-descriptors.json";
const MAX_INTERNED_KINDS: usize = 512;
const MAX_INTERNED_DESCRIPTORS: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct CloudDescriptorSvg {
    pub kind: String,
    pub svg: String,
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
    active: BTreeMap<&'static str, ([u8; 32], &'static DeviceDescriptor)>,
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
        for &kind in guard.active.keys() {
            if !KINDS.contains(&kind) {
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
        valid_items.push(CloudDescriptorSvg { kind, svg });
    }

    let changed = guard.active.len() != next_active.len()
        || guard.active.iter().any(|(kind, (hash, _))| {
            next_active.get(kind).map(|(next_hash, _)| next_hash) != Some(hash)
        });
    let applied = next_active.len();
    guard.active = next_active;

    (
        CloudDescriptorSyncResult {
            applied,
            rejected,
            changed,
        },
        valid_items,
    )
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

/// Return the active cloud descriptor or bundled fallback for a device kind.
///
/// Bundled descriptors are parsed once after startup on first use. A malformed
/// file is treated as unsupported instead of falling back to a different model.
pub(crate) fn descriptor_for_kind(kind: &str) -> Option<&'static DeviceDescriptor> {
    if let Ok(guard) = dynamic_registry().read() {
        if let Some((_, descriptor)) = guard.active.get(kind) {
            return Some(*descriptor);
        }
    }
    bundled_descriptor_for_kind(kind)
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
        "hisenseRcf3b65" => crate::devices::hisense_rcf3b65::descriptor(),
        "phicommDb1R" => crate::devices::phicomm_db1_r::descriptor(),
        "xboxBluetooth" => xbox(),
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
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor.identities.iter().any(|identity| {
            matches_identity_number(identity, "vid", Some(vid))
                && matches_identity_number(identity, "pid", Some(pid))
                && matches_identity_number(identity, "usage-page", usage_page)
                && matches_identity_number(identity, "usage", usage)
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

fn identity_matches_hardware_id(
    identity: &super::device_descriptor::IdentityDescriptor,
    id: &str,
) -> bool {
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
    let (Some(vid), Some(pid)) = (number("VID"), number("PID")) else {
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
mod tests {
    use super::*;
    use crate::devices::engine::DescriptorEngine;
    use std::sync::Mutex;

    static DYNAMIC_TEST_LOCK: Mutex<()> = Mutex::new(());

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
}
