use super::device_descriptor::{parse_svg, DeviceDescriptor};
use std::sync::OnceLock;

pub(crate) const KINDS: &[&str] = &[
    "rc003",
    "cmiotA15",
    "xmBt29",
    "rc313",
    "obeRcuR5",
    "xboxBluetooth",
];

/// Return the bundled descriptor for a discovered device kind.
///
/// Descriptors are parsed once after startup on first use. A malformed bundled
/// file is treated as unsupported instead of falling back to a different model.
pub(crate) fn descriptor_for_kind(kind: &str) -> Option<&'static DeviceDescriptor> {
    match kind {
        "rc003" => rc003(),
        "cmiotA15" => cmiot_a15(),
        "xmBt29" => xm_bt_29(),
        "rc313" => rc313(),
        "obeRcuR5" => obe_rcu_r5(),
        "xboxBluetooth" => xbox(),
        _ => None,
    }
}

fn load(
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

pub(crate) fn supports_key(kind: &str, key: &str) -> bool {
    descriptor_for_kind(kind).is_some_and(|descriptor| {
        descriptor.inputs.iter().any(|input| {
            input.id == key
                || input
                    .legacy_key
                    .as_deref()
                    .is_some_and(|aliases| aliases.split_whitespace().any(|alias| alias == key))
        })
    })
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
    value.split('|').filter_map(|value| {
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
    }

    #[test]
    fn saved_keys_original_output_and_voice_trigger_share_the_descriptor() {
        assert!(supports_key("rc003", "power"));
        assert!(supports_key("rc003", "xiaomi.rc003.power"));
        assert!(!supports_key("rc003", "cmiotA15.power"));
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
        for kind in [
            "rc003",
            "cmiotA15",
            "xmBt29",
            "rc313",
            "obeRcuR5",
            "xboxBluetooth",
        ] {
            let descriptor = descriptor_for_kind(kind)
                .unwrap_or_else(|| panic!("bundled descriptor failed to parse: {kind}"));
            assert_eq!(descriptor.revision, 1, "unexpected revision for {kind}");
            assert!(!descriptor.reports.is_empty(), "missing reports for {kind}");
            assert!(!descriptor.inputs.is_empty(), "missing inputs for {kind}");
        }
    }
}
