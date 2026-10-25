//! CMIOT-A15's numbered keyboard, consumer and vendor voice reports.
use std::collections::{HashMap, HashSet};

pub(crate) fn matches_instance(id: &str) -> bool {
    let id = id.to_ascii_uppercase();
    let tokens: Vec<_> = id.split(['&', '_', '\\', ' ']).collect();
    id.starts_with("BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_")
        && tokens
            .windows(2)
            .any(|p| p[0] == "VID" && matches!(p[1], "0416" | "010416"))
        && tokens.windows(2).any(|p| p[0] == "PID" && p[1] == "0300")
}

// Report ID, usage (or vendor state), device-scoped input ID.
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

pub(crate) fn original_usage(button: &str) -> Option<(u16, u16)> {
    BUTTONS.iter().find_map(|&(report, usage, id)| {
        (id == button && report != 0xf8).then_some((if report == 1 { 7 } else { 12 }, usage))
    })
}

fn decode(bytes: &[u8]) -> Option<(u8, HashSet<&'static str>)> {
    let report = *bytes.first()?;
    let usages: Vec<u16> = match report {
        1 if bytes.len() == 9 && bytes[1..3] == [0, 0] => {
            // Boot keyboard slots are bytes, not little-endian u16 pairs.
            if bytes[3..].iter().any(|u| (1..=3).contains(u)) {
                return None;
            }
            bytes[3..].iter().map(|&u| u16::from(u)).collect()
        }
        3 if bytes.len() == 3 => vec![u16::from_le_bytes([bytes[1], bytes[2]])],
        0xf8 if bytes.len() == 21
            && bytes[1..3] == [0x82, 3]
            && bytes[3] <= 1
            && bytes[4..].iter().all(|b| *b == 0) =>
        {
            vec![u16::from(bytes[3])]
        }
        _ => return None,
    };
    Some((
        report,
        BUTTONS
            .iter()
            .filter_map(|&(r, usage, id)| (r == report && usages.contains(&usage)).then_some(id))
            .collect(),
    ))
}

#[derive(Default)]
pub(crate) struct ReportState {
    active: HashMap<u8, HashSet<&'static str>>,
}

impl ReportState {
    /// Unrelated and malformed vendor packets do not release held keys.
    pub(crate) fn accept(&mut self, bytes: &[u8]) -> Vec<(&'static str, bool)> {
        let Some((report, current)) = decode(bytes) else {
            return Vec::new();
        };
        let previous = self.active.entry(report).or_default();
        let mut edges: Vec<_> = previous
            .difference(&current)
            .map(|id| (*id, false))
            .collect();
        edges.extend(current.difference(previous).map(|id| (*id, true)));
        *previous = current;
        edges
    }

    pub(crate) fn release_all(&mut self) -> Vec<(&'static str, bool)> {
        self.active
            .drain()
            .flat_map(|(_, keys)| keys.into_iter().map(|id| (id, false)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_documented_key_presses_and_releases_without_repeat_edges() {
        for &(report, usage, id) in BUTTONS {
            let (down, up) = match report {
                1 => (
                    vec![1, 0, 0, usage as u8, 0, 0, 0, 0, 0],
                    vec![1, 0, 0, 0, 0, 0, 0, 0, 0],
                ),
                3 => (vec![3, usage as u8, (usage >> 8) as u8], vec![3, 0, 0]),
                _ => {
                    let mut d = vec![0; 21];
                    d[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
                    let mut u = d.clone();
                    u[3] = 0;
                    (d, u)
                }
            };
            let mut state = ReportState::default();
            assert_eq!(state.accept(&down), vec![(id, true)]);
            assert!(state.accept(&down).is_empty());
            assert_eq!(state.accept(&up), vec![(id, false)]);
            assert!(state.release_all().is_empty());
        }
    }

    #[test]
    fn report_groups_release_independently_and_disconnect_clears_all() {
        let mut state = ReportState::default();
        assert_eq!(state.accept(&[1, 0, 0, 0x52, 0x50, 0, 0, 0, 0]).len(), 2);
        assert_eq!(
            state.accept(&[3, 0xe9, 0]),
            vec![("cmiotA15.volumeUp", true)]
        );
        assert!(state.accept(&[0xf8, 0x82, 3, 0]).is_empty());
        assert_eq!(state.accept(&[3, 0, 0]), vec![("cmiotA15.volumeUp", false)]);
        assert_eq!(state.release_all().len(), 2);
        assert!(state.release_all().is_empty());
    }

    #[test]
    fn identity_is_scoped_to_a15_hid_service() {
        let id = r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0300_REV&0100_0CF3F093935F\8&1EF99D83&2&0008";
        assert!(matches_instance(id));
        assert!(!matches_instance(&id.replace("0300", "03000")));
        assert!(!matches_instance(&id.replace("00001812", "0000180F")));
        assert!(!matches_instance(&id.replace("010416", "012717")));
    }
}
