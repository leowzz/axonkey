//! XM-BT-29 adds numeric keyboard usages and a consumer delete key to A15's protocol.

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
    (1, 0x27, "xmBt29.digit0"),
    (1, 0x1e, "xmBt29.digit1"),
    (1, 0x1f, "xmBt29.digit2"),
    (1, 0x20, "xmBt29.digit3"),
    (1, 0x21, "xmBt29.digit4"),
    (1, 0x22, "xmBt29.digit5"),
    (1, 0x23, "xmBt29.digit6"),
    (1, 0x24, "xmBt29.digit7"),
    (1, 0x25, "xmBt29.digit8"),
    (1, 0x26, "xmBt29.digit9"),
    (3, 0xfc, "xmBt29.delete"),
];

pub(crate) fn decode(bytes: &[u8]) -> Option<(u8, HashSet<&'static str>)> {
    if bytes.len() == 4 && bytes[0] == 1 {
        let mut keyboard = [0; 9];
        keyboard[..4].copy_from_slice(bytes);
        return super::cmiot_a15::decode_with_buttons(&keyboard, BUTTONS);
    }
    super::cmiot_a15::decode_with_buttons(bytes, BUTTONS)
}

pub(crate) fn original_usage(button: &str) -> Option<(u16, u16)> {
    BUTTONS.iter().find_map(|&(report, usage, id)| {
        (id == button && report != 0xf8).then_some((if report == 1 { 7 } else { 12 }, usage))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::cmiot_a15::{HidSession, ReportState};

    #[test]
    fn repeats_do_not_create_edges_and_report_groups_release_independently() {
        let mut state = ReportState::with_decoder(decode);
        assert_eq!(state.accept(&[1, 0, 0, 0x27]), [("xmBt29.digit0", true)]);
        assert!(state.accept(&[1, 0, 0, 0x27]).is_empty());
        assert_eq!(state.accept(&[3, 0xfc, 0]), [("xmBt29.delete", true)]);
        assert!(state.accept(&[3, 0xfc, 0]).is_empty());
        assert!(state.accept(&[0xfc; 21]).is_empty());
        assert_eq!(state.accept(&[1, 0, 0, 0]), [("xmBt29.digit0", false)]);
        assert_eq!(state.release_all(), [("xmBt29.delete", false)]);
        assert!(state.release_all().is_empty());
        assert_eq!(original_usage("xmBt29.digit0"), Some((7, 0x27)));
        assert_eq!(original_usage("xmBt29.delete"), Some((12, 0xfc)));
    }

    #[test]
    fn hid_session_maps_new_keys_and_keeps_voice_recording() {
        let mut session = HidSession::with_decoder(decode);
        session.start(crate::devices::cmiot_a15::recording::RecordingMode::Hold);
        assert_eq!(
            session.accept(&[1, 0, 0, 0x1e], |_| Ok(())).unwrap().0,
            [("xmBt29.digit1", true)]
        );
        assert_eq!(
            session.accept(&[3, 0xfc, 0], |_| Ok(())).unwrap().0,
            [("xmBt29.delete", true)]
        );
        let mut voice = [0; 21];
        voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
        let mut writes = Vec::new();
        assert_eq!(
            session
                .accept(&voice, |report| {
                    writes.push(report);
                    Ok(())
                })
                .unwrap()
                .0,
            [("cmiotA15.voice", true)]
        );
        assert!(session.recording());
        voice[3] = 0;
        session
            .accept(&voice, |report| {
                writes.push(report);
                Ok(())
            })
            .unwrap();
        assert!(!session.recording());
        assert_eq!(writes, [[0xfb, 1], [0xfb, 0]]);
    }
}
