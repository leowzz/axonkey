#[cfg(test)]
mod tests {
    #[test]
    fn analog_hysteresis_and_report_collections_are_instance_scoped() {
        let descriptor =
            super::super::descriptor_registry::descriptor_for_kind("xboxBluetooth").unwrap();
        let mut first = super::super::engine::DescriptorEngine::default();
        let mut second = super::super::engine::DescriptorEngine::default();
        let mut report = [1, 0, 128, 0, 128, 0, 128, 0, 128, 0, 0, 0, 0, 0, 0, 0];
        for (trigger, expected) in [(600u16, Some(true)), (500, None), (300, Some(false))] {
            report[9..11].copy_from_slice(&trigger.to_le_bytes());
            let edges = first.accept(descriptor, &report);
            assert_eq!(
                edges
                    .iter()
                    .find(|(key, _)| key == "xbox.lt")
                    .map(|(_, down)| *down),
                expected
            );
            let (values, _) = first.take_update().unwrap();
            assert!((values["xbox.lt"] - f64::from(trigger) / 1023.0).abs() < 0.0001);
            assert!(first.accept(descriptor, &report).is_empty());
            assert!(first.take_update().is_none());
        }
        assert_eq!(
            first.accept(descriptor, &[2, 1]),
            vec![("xbox.guide".into(), true)]
        );
        first.take_update();
        assert!(first.accept(descriptor, &report).is_empty());
        assert!(first.accept(descriptor, &[0xff, 1]).is_empty());
        assert!(first.take_update().is_none());
        assert!(second.take_update().is_none());
        assert_eq!(first.release_all(), vec![("xbox.guide".into(), false)]);
        let (values, down) = first.take_update().unwrap();
        assert!(values.values().all(|v| *v == 0.0));
        assert!(down.is_empty());
    }

    #[test]
    fn only_supported_xbox_hid_nodes_use_this_layout() {
        use crate::devices::descriptor_registry::matches_instance;
        assert!(matches_instance(
            "xboxBluetooth",
            r"HID\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002045E_PID&02E0\instance"
        ));
        assert!(matches_instance(
            "xboxBluetooth",
            r"HID\VID_045E&PID_02E0&IG_00\instance"
        ));
        assert!(!matches_instance(
            "xboxBluetooth",
            r"HID\VID_045E&PID_02E00\instance"
        ));
        assert!(!matches_instance(
            "xboxBluetooth",
            r"BTHENUM\VID_045E&PID_02E0\instance"
        ));
    }
}
