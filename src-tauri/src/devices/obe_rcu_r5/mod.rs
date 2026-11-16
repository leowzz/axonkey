//! OBE_RCU_R5 keyboard reports and its 60-byte custom SBC voice transport.

pub(crate) mod voice;

#[cfg(test)]
mod tests {

    #[test]
    fn voice_state_survives_gaps_in_the_shared_keyboard_report() {
        let mut state = super::super::cmiot_a15::ReportState::for_kind("obeRcuR5");
        let voice_and_up = [1, 0, 0, 0x73, 0x52, 0, 0, 0, 0];
        assert_eq!(state.accept(&voice_and_up).len(), 2);
        assert_eq!(state.release_non_voice(), [("obeRcuR5.up", false)]);
        assert!(state.accept(&[1, 0, 0, 0x73, 0, 0, 0, 0, 0]).is_empty());
        assert_eq!(
            state.accept(&[1, 0, 0, 0, 0, 0, 0, 0, 0]),
            [("obeRcuR5.voice", false)]
        );
    }

    #[test]
    fn matches_projector_remote_hid_service_by_vid_and_pid() {
        let id = r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&011D5A_PID&C081_REV&0000_C9B5965E4F92\8&30D338AA&0&001F";
        use crate::devices::descriptor_registry::matches_instance;
        assert!(matches_instance("obeRcuR5", id));
        assert!(matches_instance("obeRcuR5", &id.to_ascii_lowercase()));
        assert!(matches_instance(
            "obeRcuR5",
            &id.replace("REV&0000", "REV&1234")
        ));
        assert!(!matches_instance(
            "obeRcuR5",
            &id.replace("011D5A", "010416")
        ));
        assert!(!matches_instance("obeRcuR5", &id.replace("C081", "C082")));
        assert!(!matches_instance(
            "obeRcuR5",
            &id.replace("00001812", "0000180A")
        ));
    }
}
