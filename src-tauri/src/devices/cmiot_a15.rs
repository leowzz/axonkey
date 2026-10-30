//! CMIOT-A15's numbered keyboard, consumer and vendor voice reports.
use std::collections::{HashMap, HashSet};

pub(crate) fn matches_instance(id: &str) -> bool {
    let id = id.to_ascii_uppercase();
    let tokens: Vec<_> = id.split(['&', '_', '\\', ' ']).collect();
    super::bluetooth_hid_service(&id).is_some()
        && tokens
            .windows(2)
            .any(|p| p[0] == "VID" && matches!(p[1], "0416" | "010416" | "050416"))
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

pub(crate) fn decode(bytes: &[u8]) -> Option<(u8, HashSet<&'static str>)> {
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

/// One exclusive HID connection. Recording and key mapping consume the same
/// voice edge independently, including when click-to-record stays active.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Default)]
pub(crate) struct HidSession {
    reports: ReportState,
    recording: super::cmiot_a15_recording::RecordingControl,
    voice: super::cmiot_a15_fc::VoiceStream,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl HidSession {
    pub fn start(&mut self, mode: super::cmiot_a15_recording::RecordingMode) {
        self.recording
            .synchronize(mode, true, |_| Ok::<_, String>(()))
            .unwrap();
    }

    pub fn recording(&self) -> bool {
        self.recording.is_recording()
    }

    pub fn toggle_recording(
        &mut self,
        send: impl FnMut([u8; 2]) -> Result<(), String>,
    ) -> Result<bool, String> {
        let recording = self.recording.toggle(send)?;
        self.voice.synchronize(recording);
        Ok(recording)
    }

    pub fn accept(
        &mut self,
        report: &[u8],
        mut send: impl FnMut([u8; 2]) -> Result<(), String>,
    ) -> Result<
        (
            Vec<(&'static str, bool)>,
            Option<super::cmiot_a15_fc::PcmFrame>,
        ),
        String,
    > {
        let edges = self.reports.accept(report);
        for &(button, pressed) in &edges {
            if button == "cmiotA15.voice" {
                self.recording.edge(pressed, &mut send)?;
                self.voice.synchronize(self.recording());
            }
        }
        let pcm = match self.voice.feed(report) {
            Ok(pcm) => pcm,
            Err(error) => {
                log::warn!(target: "axonkey::audio", "A15 audio packet: {error}");
                None
            }
        };
        Ok((edges, pcm))
    }

    pub fn stop_recording(
        &mut self,
        send: impl FnMut([u8; 2]) -> Result<(), String>,
    ) -> Result<bool, String> {
        self.recording.stop(send)?;
        self.voice.synchronize(false);
        Ok(false)
    }

    pub fn stop(&mut self, send: impl FnMut([u8; 2]) -> Result<(), String>) -> Result<(), String> {
        let result = self.recording.stop(send);
        self.recording.reset();
        self.voice.reset();
        self.reports.release_all();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_stop_is_idempotent_preserves_held_keys_and_can_retry() {
        use super::super::cmiot_a15_recording::RecordingMode;
        for mode in [RecordingMode::Hold, RecordingMode::Click] {
            let mut session = HidSession::default();
            session.start(mode);
            let mut voice = [0; 21];
            voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
            let mut reports = Vec::new();
            let (edges, _) = session
                .accept(&voice, |r| {
                    reports.push(r);
                    Ok(())
                })
                .unwrap();
            assert_eq!(edges, [("cmiotA15.voice", true)]);
            assert!(session
                .stop_recording(|_| Err("write failed".into()))
                .is_err());
            assert!(session.recording());
            for _ in 0..2 {
                assert!(!session
                    .stop_recording(|r| {
                        reports.push(r);
                        Ok(())
                    })
                    .unwrap());
            }
            let (edges, _) = session
                .accept(&voice, |r| {
                    reports.push(r);
                    Ok(())
                })
                .unwrap();
            assert!(edges.is_empty());
            assert!(
                !session.recording(),
                "a held voice key cannot restart recording after a stop"
            );
            voice[3] = 0;
            let (edges, _) = session
                .accept(&voice, |r| {
                    reports.push(r);
                    Ok(())
                })
                .unwrap();
            assert_eq!(edges, [("cmiotA15.voice", false)]);
            assert_eq!(reports, [[0xfb, 1], [0xfb, 0]]);
            voice[3] = 1;
            session.accept(&voice, |_| Ok(())).unwrap();
            assert!(
                session.recording(),
                "a new press still starts the next recording"
            );
        }
    }

    #[test]
    fn manual_recording_toggles_the_hid_session_without_key_events() {
        let mut session = HidSession::default();
        session.start(super::super::cmiot_a15_recording::RecordingMode::Hold);
        let mut reports = Vec::new();
        assert!(session
            .toggle_recording(|report| {
                reports.push(report);
                Ok(())
            })
            .unwrap());
        assert!(session.recording());
        assert!(session
            .toggle_recording(|_| Err("write failed".into()))
            .is_err());
        assert!(session.recording());
        assert!(!session
            .toggle_recording(|report| {
                reports.push(report);
                Ok(())
            })
            .unwrap());
        assert!(!session.recording());
        assert_eq!(reports, [[0xfb, 1], [0xfb, 0]]);
    }

    #[test]
    fn hid_session_keeps_voice_key_edges_independent_of_click_recording() {
        use super::super::cmiot_a15_recording::RecordingMode;
        for mode in [RecordingMode::Hold, RecordingMode::Click] {
            let mut session = HidSession::default();
            session.start(mode);
            let mut writes = Vec::new();
            let mut send = |report| {
                writes.push(report);
                Ok(())
            };
            let mut report = [0; 21];
            report[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
            let (edges, _) = session.accept(&report, &mut send).unwrap();
            assert_eq!(edges, vec![("cmiotA15.voice", true)]);
            assert!(session.recording());
            assert!(session.accept(&report, &mut send).unwrap().0.is_empty());
            report[3] = 0;
            assert_eq!(
                session.accept(&report, &mut send).unwrap().0,
                vec![("cmiotA15.voice", false)]
            );
            assert_eq!(session.recording(), mode == RecordingMode::Click);
            session.stop(&mut send).unwrap();
            assert!(!session.recording());
            assert_eq!(writes, [[0xfb, 1], [0xfb, 0]]);
        }
    }

    #[test]
    fn hid_session_drops_audio_outside_recording_and_does_not_commit_failed_start() {
        let mut session = HidSession::default();
        session.start(super::super::cmiot_a15_recording::RecordingMode::Hold);
        assert!(session.accept(&[0xfc; 21], |_| Ok(())).unwrap().1.is_none());
        let mut report = [0; 21];
        report[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
        assert!(session
            .accept(&report, |_| Err("write failed".into()))
            .is_err());
        assert!(!session.recording());
        session.stop(|_| Ok(())).unwrap();
        session.start(super::super::cmiot_a15_recording::RecordingMode::Hold);
        assert_eq!(
            session.accept(&report, |_| Ok(())).unwrap().0,
            vec![("cmiotA15.voice", true)]
        );
        assert!(session.recording());
    }

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
        for vendor in ["0416", "010416", "050416"] {
            for prefix in ["BTHLEDEVICE\\", "BTHLEDEVICE"] {
                let id = id
                    .replace("010416", vendor)
                    .replace("BTHLEDEVICE\\", prefix);
                assert!(matches_instance(&id), "{id}");
                assert!(matches_instance(&id.to_ascii_lowercase()));
                assert!(!matches_instance(&id.replace("0300", "03000")));
                assert!(!matches_instance(&id.replace("00001812", "0000180F")));
                assert!(!matches_instance(&id.replace(vendor, "012717")));
                assert!(!matches_instance(&id.replace(vendor, "0504160")));
                assert!(!matches_instance(&id.replace("BTHLEDEVICE", "USB")));
            }
        }
        assert!(matches_instance(
            r"BTHLEDEVICE{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&050416_PID&0300_REV&0505_0CF3CE7F241E\8&11237C06&0&0025"
        ));
    }
}
