use std::collections::BTreeMap;

/// The verified Bluetooth layout of 045e:02e0. Never apply it to another PID.
/// Values are normalized before gesture handling; separate reports update only their own controls.
pub(super) fn decode(kind: &str, report: &[u8]) -> Option<BTreeMap<String, f64>> {
    let mut values = BTreeMap::new();
    if kind == "xboxBluetooth" {
        return crate::devices::xbox::decode(report).map(|values| {
            values
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect()
        });
    } else if kind == "rc003" {
        if report.len() != 7 || report[0] != 1 {
            return None;
        }
        let usages: Vec<u16> = report[1..]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        for (key, usage) in [
            ("voice", 0x3e),
            ("power", 0x66),
            ("home", 0x4a),
            ("tv", 0x35),
            ("menu", 0x65),
            ("confirm", 0x28),
            ("up", 0x52),
            ("down", 0x51),
            ("left", 0x50),
            ("right", 0x4f),
            ("back", 0xf1),
            ("volumeUp", 0x80),
            ("volumeDown", 0x81),
        ] {
            values.insert(key.into(), if usages.contains(&usage) { 1. } else { 0. });
        }
    } else if kind == "cmiotA15" {
        let (report_id, down) = crate::devices::cmiot_a15::decode(report)?;
        for &(id, _, button) in crate::devices::cmiot_a15::BUTTONS {
            if id == report_id {
                values.insert(button.into(), if down.contains(button) { 1. } else { 0. });
            }
        }
    } else {
        return None;
    }
    Some(values)
}

pub(super) fn pressed(value: f64, was_pressed: bool) -> bool {
    // Fixed hysteresis: crossing 55% presses; dropping below 35% releases.
    value >= if was_pressed { 0.35 } else { 0.55 }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a15_reports_update_only_their_own_controls() {
        let keys = decode("cmiotA15", &[1, 0, 0, 0x52, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(keys["cmiotA15.up"], 1.0);
        assert!(!keys.contains_key("cmiotA15.voice"));
        assert!(!keys.contains_key("cmiotA15.volumeUp"));
        let keys = decode("cmiotA15", &[3, 0xe9, 0]).unwrap();
        assert_eq!(keys["cmiotA15.volumeUp"], 1.0);
        assert!(!keys.contains_key("cmiotA15.up"));
        assert!(decode("cmiotA15", &[0xfc; 21]).is_none());
    }

    #[test]
    fn xbox_buttons_axes_and_diagonal_hat_are_independent() {
        let report = [1, 0, 0, 255, 255, 0, 128, 0, 128, 255, 3, 0, 0, 2, 1, 2];
        let v = decode("xboxBluetooth", &report).unwrap();
        assert_eq!(v["xbox.a"], 1.);
        assert_eq!(v["xbox.rs"], 1.);
        assert_eq!(v["xbox.ls.left"], 1.);
        assert_eq!(v["xbox.ls.down"], 1.);
        assert_eq!(v["xbox.lt"], 1.);
        assert_eq!(v["xbox.rt"], 0.);
        assert_eq!(v["xbox.dpad.up"], 1.);
        assert_eq!(v["xbox.dpad.right"], 1.);
        assert!(decode("xboxBluetooth", &[1, 0]).is_none());
        assert!(decode("unknown", &report).is_none());
    }
    #[test]
    fn guide_reports_do_not_release_other_buttons() {
        let v = decode("xboxBluetooth", &[2, 1]).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v["xbox.guide"], 1.);
    }
    #[test]
    fn analog_hysteresis_avoids_chatter() {
        assert!(!pressed(0.5, false));
        assert!(pressed(0.6, false));
        assert!(pressed(0.5, true));
        assert!(!pressed(0.3, true));
    }
    #[test]
    fn rc003_report_and_release() {
        assert_eq!(
            decode("rc003", &[1, 0x52, 0, 0x28, 0, 0, 0]).unwrap()["up"],
            1.
        );
        assert_eq!(decode("rc003", &[1, 0, 0, 0, 0, 0, 0]).unwrap()["up"], 0.);
    }
}
