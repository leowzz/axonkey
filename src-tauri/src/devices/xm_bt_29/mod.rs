//! XM-BT-29 adds numeric keyboard usages and a consumer delete key to A15's protocol.

#[cfg(test)]
mod tests {
    use crate::devices::cmiot_a15::{HidSession, ReportState};
    use crate::devices::descriptor_registry::original_usage;

    #[test]
    fn repeats_do_not_create_edges_and_report_groups_release_independently() {
        let mut state = ReportState::for_kind("xmBt29");
        assert_eq!(state.accept(&[1, 0, 0, 0x27]), [("xmBt29.digit0", true)]);
        assert!(state.accept(&[1, 0, 0, 0x27]).is_empty());
        assert_eq!(state.accept(&[3, 0xfc, 0]), [("xmBt29.delete", true)]);
        assert!(state.accept(&[3, 0xfc, 0]).is_empty());
        assert!(state.accept(&[0xfc; 21]).is_empty());
        assert_eq!(state.accept(&[1, 0, 0, 0]), [("xmBt29.digit0", false)]);
        assert_eq!(state.release_all(), [("xmBt29.delete", false)]);
        assert!(state.release_all().is_empty());
        assert_eq!(original_usage("xmBt29", "xmBt29.digit0"), Some((7, 0x27)));
        assert_eq!(original_usage("xmBt29", "xmBt29.delete"), Some((12, 0xfc)));
    }

    #[test]
    fn hid_session_maps_new_keys_and_keeps_voice_recording() {
        let mut session = HidSession::for_kind("xmBt29");
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
