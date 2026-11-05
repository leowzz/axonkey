//! OBE_RCU_R5 keyboard reports and its 60-byte custom SBC voice transport.

use std::collections::HashSet;

pub(crate) mod voice;

pub(crate) fn matches_instance(id: &str) -> bool {
    let id = id.to_ascii_uppercase();
    let tokens: Vec<_> = id.split(['&', '_', '\\', ' ']).collect();
    super::shared::bluetooth_hid_service(&id).is_some()
        && tokens
            .windows(2)
            .any(|p| p[0] == "VID" && matches!(p[1], "1D5A" | "011D5A" | "051D5A"))
        && tokens.windows(2).any(|p| p[0] == "PID" && p[1] == "C081")
}

// Report ID, keyboard usage, device-scoped input ID.
pub(crate) const BUTTONS: &[(u8, u16, &str)] = &[
    (1, 0x66, "obeRcuR5.power"),
    (1, 0x72, "obeRcuR5.locate"),
    (1, 0x52, "obeRcuR5.up"),
    (1, 0x50, "obeRcuR5.left"),
    (1, 0x28, "obeRcuR5.confirm"),
    (1, 0x4f, "obeRcuR5.right"),
    (1, 0x51, "obeRcuR5.down"),
    (1, 0x4a, "obeRcuR5.home"),
    (1, 0x29, "obeRcuR5.back"),
    (1, 0x73, "obeRcuR5.voice"),
    (1, 0x81, "obeRcuR5.volumeDown"),
    (1, 0x80, "obeRcuR5.volumeUp"),
];

pub(crate) fn original_usage(button: &str) -> Option<(u16, u16)> {
    BUTTONS
        .iter()
        .find_map(|&(_, usage, id)| (id == button).then_some((7, usage)))
}

pub(crate) fn decode(bytes: &[u8]) -> Option<(u8, HashSet<&'static str>)> {
    if bytes.first() != Some(&1) {
        return None;
    }
    super::cmiot_a15::decode_with_buttons(bytes, BUTTONS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_state_survives_gaps_in_the_shared_keyboard_report() {
        let mut state = super::super::cmiot_a15::ReportState::with_decoder(decode);
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
        assert!(matches_instance(id));
        assert!(matches_instance(&id.to_ascii_lowercase()));
        assert!(matches_instance(&id.replace("REV&0000", "REV&1234")));
        assert!(!matches_instance(&id.replace("011D5A", "010416")));
        assert!(!matches_instance(&id.replace("C081", "C082")));
        assert!(!matches_instance(&id.replace("00001812", "0000180A")));
    }
}
