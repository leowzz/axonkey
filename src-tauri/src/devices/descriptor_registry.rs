use super::device_descriptor::{parse_svg, DeviceDescriptor};
use std::sync::OnceLock;

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

#[cfg(test)]
mod tests {
    use super::descriptor_for_kind;

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
