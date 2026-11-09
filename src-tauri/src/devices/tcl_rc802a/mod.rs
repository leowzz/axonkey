//! TCL RC802A starts with the CMIOT-A15 report and voice adapter scaffold.

use std::collections::HashSet;

pub(crate) const BUTTONS: &[(u8, u16, &str)] = &[
    (1, 0x66, "cmiotA15.power"),
    (0xf8, 1, "cmiotA15.voice"),
    (1, 0x52, "cmiotA15.up"),
    (1, 0x50, "cmiotA15.left"),
    (3, 0x41, "cmiotA15.confirm"),
    (1, 0x4f, "cmiotA15.right"),
    (1, 0x51, "cmiotA15.down"),
    (3, 0x224, "cmiotA15.back"),
    (3, 0xe9, "cmiotA15.volumeUp"),
    (3, 0x223, "cmiotA15.home"),
    (3, 0xea, "cmiotA15.volumeDown"),
    (1, 0x65, "cmiotA15.menu"),
    (3, 0xe2, "cmiotA15.mute"),
    (3, 0xeb, "cmiotA15.settings"),
    (1, 0x4b, "cmiotA15.channelUp"),
    (1, 0x4e, "cmiotA15.channelDown"),
    (3, 0xf0, "cmiotA15.m"),
];

pub(crate) fn decode(bytes: &[u8]) -> Option<(u8, HashSet<&'static str>)> {
    super::cmiot_a15::decode_with_buttons(bytes, BUTTONS)
}

pub(crate) fn matches_instance(id: &str) -> bool {
    let id = id.to_ascii_uppercase();
    let Some(service) = super::shared::bluetooth_hid_service(&id) else {
        return false;
    };
    let tokens: Vec<_> = service.split(['&', '_', '\\', ' ']).collect();
    tokens.windows(2).any(|p| p[0] == "VID" && p[1] == "010416")
        && tokens.windows(2).any(|p| p[0] == "PID" && p[1] == "0301")
}

pub(crate) fn matches_information(
    vendor: u16,
    product: u16,
    model_number: Option<&str>,
    manufacturer: Option<&str>,
) -> bool {
    vendor == 0x0416
        && product == 0x0301
        && model_number.is_some_and(|value| value.contains("BT_RC802A"))
        && manufacturer.is_some_and(|value| value.contains("TCL"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_requested_bluetooth_hid_hardware() {
        let id = r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0301_REV&0000_AABBCCDDEEFF\8&1234&0&001F";
        assert!(matches_instance(id));
        assert!(matches_instance(&id.to_ascii_lowercase()));
        assert!(!matches_instance(&id.replace("010416", "050416")));
        assert!(!matches_instance(&id.replace("010416", "0416")));
        assert!(!matches_instance(&id.replace("0301", "0300")));
        assert!(!matches_instance(&id.replace("0301", "03010")));
        assert!(!matches_instance(&id.replace("00001812", "0000180A")));
        assert!(!matches_instance(&id.replace("BTHLEDEVICE", "HID")));
    }

    #[test]
    fn requires_both_tcl_information_markers_and_the_hardware_pair() {
        assert!(matches_information(
            0x0416,
            0x0301,
            Some("prefix_BT_RC802A_suffix"),
            Some("TCL Electronics")
        ));
        for (vendor, product, model, manufacturer) in [
            (0x0416, 0x0301, None, Some("TCL")),
            (0x0416, 0x0301, Some("BT_RC802A"), None),
            (0x0416, 0x0301, Some("RC802A"), Some("TCL")),
            (0x0416, 0x0301, Some("BT_RC802A"), Some("Other")),
            (0x0416, 0x0300, Some("BT_RC802A"), Some("TCL")),
            (0x0417, 0x0301, Some("BT_RC802A"), Some("TCL")),
        ] {
            assert!(!matches_information(vendor, product, model, manufacturer));
        }
    }
}
