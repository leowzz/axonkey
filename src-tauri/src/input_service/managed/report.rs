use std::collections::BTreeMap;

/// Values are normalized before gesture handling; separate reports update only their own controls.
pub(super) fn decode(kind: &str, report: &[u8]) -> Option<BTreeMap<String, f64>> {
    let descriptor = crate::devices::descriptor_registry::descriptor_for_kind(kind)?;
    let values = crate::devices::engine::decode_descriptor(descriptor, report)?;
    Some(
        values
            .into_iter()
            .map(|(id, value)| {
                let key = descriptor
                    .inputs
                    .iter()
                    .find(|input| input.id == id)
                    .map(crate::devices::descriptor_registry::input_key)
                    .unwrap_or(&id)
                    .to_string();
                (key, value)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn obe_keyboard_reports_press_and_release_each_projector_button() {
        for (usage, button) in [
            (0x66, "obeRcuR5.power"),
            (0x72, "obeRcuR5.locate"),
            (0x52, "obeRcuR5.up"),
            (0x51, "obeRcuR5.down"),
            (0x50, "obeRcuR5.left"),
            (0x4f, "obeRcuR5.right"),
            (0x28, "obeRcuR5.confirm"),
            (0x4a, "obeRcuR5.home"),
            (0x29, "obeRcuR5.back"),
            (0x73, "obeRcuR5.voice"),
            (0x81, "obeRcuR5.volumeDown"),
            (0x80, "obeRcuR5.volumeUp"),
        ] {
            let keys = decode("obeRcuR5", &[1, 0, 0, usage, 0, 0, 0, 0, 0]).unwrap();
            assert_eq!(keys[button], 1.);
            assert_eq!(keys.len(), 12);
            assert_eq!(keys.values().filter(|&&value| value == 1.).count(), 1);
            assert_eq!(
                decode("obeRcuR5", &[1, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap()[button],
                0.
            );
            assert_eq!(
                crate::devices::descriptor_registry::original_usage("obeRcuR5", button),
                Some((7, u16::from(usage)))
            );
        }
        assert!(decode("obeRcuR5", &[3, 0xe9, 0]).is_none());
        let mut old_voice = [0; 21];
        old_voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
        assert!(decode("obeRcuR5", &old_voice).is_none());
    }

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
    fn xm_bt_29_digits_and_delete_press_and_release_in_their_own_report_groups() {
        for (usage, id) in [
            (0x27, "xmBt29.digit0"),
            (0x1e, "xmBt29.digit1"),
            (0x1f, "xmBt29.digit2"),
            (0x20, "xmBt29.digit3"),
            (0x21, "xmBt29.digit4"),
            (0x22, "xmBt29.digit5"),
            (0x23, "xmBt29.digit6"),
            (0x24, "xmBt29.digit7"),
            (0x25, "xmBt29.digit8"),
            (0x26, "xmBt29.digit9"),
        ] {
            for report in [vec![1, 0, 0, usage], vec![1, 0, 0, usage, 0, 0, 0, 0, 0]] {
                let keys = decode("xmBt29", &report).unwrap();
                assert_eq!(keys[id], 1.);
                assert_eq!(keys.values().filter(|&&value| value == 1.).count(), 1);
                assert!(!keys.contains_key("xmBt29.delete"));
                assert!(!keys.contains_key("cmiotA15.voice"));
                assert_eq!(decode("xmBt29", &[1, 0, 0, 0]).unwrap()[id], 0.);
            }
        }
        let keys = decode("xmBt29", &[3, 0xfc, 0]).unwrap();
        assert_eq!(keys["xmBt29.delete"], 1.);
        assert!(!keys.contains_key("xmBt29.digit0"));
        assert_eq!(decode("xmBt29", &[3, 0, 0]).unwrap()["xmBt29.delete"], 0.);
        for kind in ["cmiotA15", "rc313"] {
            let keys = decode(kind, &[3, 0xfc, 0]).unwrap();
            assert!(!keys.contains_key("xmBt29.delete"));
            assert!(keys.values().all(|&value| value == 0.));
        }
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
        let descriptor =
            crate::devices::descriptor_registry::descriptor_for_kind("xboxBluetooth").unwrap();
        let pressed = |value, was_down| {
            crate::devices::engine::pressed(descriptor, "xbox.lt", value, was_down)
        };
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

    #[test]
    fn every_bundled_kind_decodes_through_the_descriptor_path() {
        let samples = [
            ("rc003", vec![1, 0x52, 0, 0, 0, 0, 0], "up"),
            (
                "cmiotA15",
                vec![1, 0, 0, 0x52, 0, 0, 0, 0, 0],
                "cmiotA15.up",
            ),
            ("xmBt29", vec![1, 0, 0, 0x1e], "xmBt29.digit1"),
            (
                "rc313",
                vec![1, 0, 0, 0x4e, 0, 0, 0, 0, 0],
                "cmiotA15.channelDown",
            ),
            (
                "obeRcuR5",
                vec![1, 0, 0, 0x73, 0, 0, 0, 0, 0],
                "obeRcuR5.voice",
            ),
            (
                "tclRc802a",
                vec![1, 0, 0, 0x28, 0, 0, 0, 0, 0],
                "tcl-rc802a.confirm",
            ),
            ("tclRc902n", vec![3, 0x42, 0], "tcl-rc902n.up"),
            ("tclRc902v", vec![3, 0x41, 0], "tcl-rc902v.confirm"),
            (
                "hisenseRcf3b65",
                vec![1, 0, 0, 0xdf, 0, 0, 0, 0, 0],
                "hisense-rcf3b65.voice",
            ),
            (
                "hisenseRcf3b65",
                vec![0x6f, 0x6a, 0x01, 0, 0, 0, 0, 0, 0],
                "hisense-rcf3b65.pointer",
            ),
            (
                "phicommDb1R",
                vec![1, 0, 0, 0x3e, 0, 0, 0, 0, 0],
                "phicomm-db1-r.voice",
            ),
            ("phicommDb1R", vec![2, 0x24, 0x02], "phicomm-db1-r.back"),
            (
                "xboxBluetooth",
                vec![1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
                "xbox.a",
            ),
        ];
        for (kind, report, key) in samples {
            let values = decode(kind, &report).expect("bundled descriptor should decode");
            assert_eq!(values.get(key), Some(&1.0), "{kind} did not decode {key}");
        }
    }
}
