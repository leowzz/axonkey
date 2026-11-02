use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn matches_instance(id: &str) -> bool {
    let id = id.to_ascii_uppercase();
    let tokens: Vec<_> = id.split(['&', '_', '\\']).collect();
    id.starts_with("HID\\")
        && tokens
            .windows(2)
            .any(|p| p[0] == "VID" && matches!(p[1], "045E" | "0002045E"))
        && tokens.windows(2).any(|p| p == ["PID", "02E0"])
}

// Only the verified 045e:02e0 Bluetooth layout; retain the physical report ID.
pub(crate) fn decode(report: &[u8]) -> Option<BTreeMap<&'static str, f64>> {
    let mut values = BTreeMap::new();
    if report.first() == Some(&2) && report.len() == 2 {
        values.insert("xbox.guide", f64::from(report[1] & 1));
        return Some(values);
    }
    if report.len() != 16 || report[0] != 1 {
        return None;
    }
    let word = |offset| u16::from_le_bytes([report[offset], report[offset + 1]]);
    for (offset, directions) in [
        (
            1,
            [
                "xbox.ls.left",
                "xbox.ls.right",
                "xbox.ls.up",
                "xbox.ls.down",
            ],
        ),
        (
            5,
            [
                "xbox.rs.left",
                "xbox.rs.right",
                "xbox.rs.up",
                "xbox.rs.down",
            ],
        ),
    ] {
        let x = (f64::from(word(offset)) - 32767.5) / 32767.5;
        let y = (f64::from(word(offset + 2)) - 32767.5) / 32767.5;
        for (direction, value) in directions.into_iter().zip([-x, x, -y, y]) {
            values.insert(direction, value.max(0.));
        }
    }
    values.insert("xbox.lt", (f64::from(word(9)) / 1023.).min(1.));
    values.insert("xbox.rt", (f64::from(word(11)) / 1023.).min(1.));
    for (direction, hats) in [
        ("xbox.dpad.up", [8, 1, 2]),
        ("xbox.dpad.right", [2, 3, 4]),
        ("xbox.dpad.down", [4, 5, 6]),
        ("xbox.dpad.left", [6, 7, 8]),
    ] {
        values.insert(direction, if hats.contains(&report[13]) { 1. } else { 0. });
    }
    let bits = word(14);
    for (bit, key) in [
        "xbox.a",
        "xbox.b",
        "xbox.x",
        "xbox.y",
        "xbox.lb",
        "xbox.rb",
        "xbox.view",
        "xbox.menu",
        "xbox.ls",
        "xbox.rs",
    ]
    .iter()
    .enumerate()
    {
        values.insert(*key, f64::from((bits >> bit) & 1));
    }
    Some(values)
}

#[derive(Default)]
pub(crate) struct ReportState {
    values: BTreeMap<&'static str, f64>,
    down: BTreeSet<&'static str>,
    dirty: bool,
}
impl ReportState {
    pub(crate) fn accept(&mut self, bytes: &[u8]) -> Vec<(&'static str, bool)> {
        let Some(values) = decode(bytes) else {
            return vec![];
        };
        let mut edges = vec![];
        for (key, value) in values {
            let was_down = self.down.contains(key);
            let down = value >= if was_down { 0.35 } else { 0.55 };
            self.dirty |= self
                .values
                .get(key)
                .is_none_or(|old| (old - value).abs() > 0.005)
                || down != was_down;
            self.values.insert(key, value);
            if down != was_down {
                if down {
                    self.down.insert(key);
                } else {
                    self.down.remove(key);
                }
                edges.push((key, down));
            }
        }
        edges
    }

    pub(crate) fn release_all(&mut self) -> Vec<(&'static str, bool)> {
        self.dirty |= self.values.values().any(|value| *value != 0.0);
        self.values.values_mut().for_each(|value| *value = 0.0);
        std::mem::take(&mut self.down)
            .into_iter()
            .map(|key| (key, false))
            .collect()
    }

    pub(crate) fn take_update(&mut self) -> Option<(BTreeMap<String, f64>, Vec<String>)> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        Some((
            self.values
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect(),
            self.down.iter().map(|k| k.to_string()).collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn analog_hysteresis_and_report_collections_are_instance_scoped() {
        let mut first = ReportState::default();
        let mut second = ReportState::default();
        let mut report = [1, 0, 128, 0, 128, 0, 128, 0, 128, 0, 0, 0, 0, 0, 0, 0];
        for (trigger, expected) in [(600u16, Some(true)), (500, None), (300, Some(false))] {
            report[9..11].copy_from_slice(&trigger.to_le_bytes());
            let edges = first.accept(&report);
            assert_eq!(
                edges
                    .iter()
                    .find(|(key, _)| *key == "xbox.lt")
                    .map(|(_, down)| *down),
                expected
            );
            let (values, _) = first.take_update().unwrap();
            assert!((values["xbox.lt"] - f64::from(trigger) / 1023.0).abs() < 0.0001);
            assert!(first.accept(&report).is_empty());
            assert!(first.take_update().is_none());
        }
        assert_eq!(first.accept(&[2, 1]), vec![("xbox.guide", true)]);
        first.take_update();
        assert!(first.accept(&report).is_empty());
        assert!(first.accept(&[0xff, 1]).is_empty());
        assert!(first.take_update().is_none());
        assert!(second.take_update().is_none());
        assert_eq!(first.release_all(), vec![("xbox.guide", false)]);
        let (values, down) = first.take_update().unwrap();
        assert!(values.values().all(|v| *v == 0.0));
        assert!(down.is_empty());
    }

    #[test]
    fn only_supported_xbox_hid_nodes_use_this_layout() {
        assert!(matches_instance(
            r"HID\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002045E_PID&02E0\instance"
        ));
        assert!(matches_instance(r"HID\VID_045E&PID_02E0&IG_00\instance"));
        assert!(!matches_instance(r"HID\VID_045E&PID_02E00\instance"));
        assert!(!matches_instance(r"BTHENUM\VID_045E&PID_02E0\instance"));
    }
}
