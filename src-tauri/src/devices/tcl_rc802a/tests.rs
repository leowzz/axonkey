use crate::devices::{
    cmiot_a15::recording::RecordingMode, cmiot_a15::HidSession, descriptor_registry::*,
    engine::DescriptorEngine,
};
use quick_xml::{events::Event, Reader, XmlVersion};

#[test]
fn captured_tcl_reports_drive_the_real_descriptor_engine() {
    for (kind, svg, count) in [
        (
            "tclRc802a",
            include_str!("../../../../docs/device-drafts/tcl-rc802a.svg"),
            22,
        ),
        (
            "tclRc902n",
            include_str!("../../../../docs/device-drafts/tcl-rc902n.svg"),
            22,
        ),
        (
            "tclRc902v",
            include_str!("../../../../docs/device-drafts/tcl-rc902v.svg"),
            27,
        ),
    ] {
        let descriptor = descriptor_for_kind(kind).unwrap();
        let mut reader = Reader::from_str(svg);
        let mut key = String::new();
        let mut tested = 0;
        loop {
            match reader.read_event().unwrap() {
                Event::Start(element) if element.name().as_ref() == b"ak:input" => {
                    key = element
                        .attributes()
                        .map(Result::unwrap)
                        .find(|attr| attr.key.as_ref() == b"id")
                        .unwrap()
                        .normalized_value(XmlVersion::Implicit1_0)
                        .unwrap()
                        .into_owned();
                }
                Event::Empty(element) if element.name().as_ref() == b"ak:hid-capture" => {
                    let attributes = element
                        .attributes()
                        .map(Result::unwrap)
                        .map(|attr| {
                            (
                                String::from_utf8(attr.key.as_ref().to_vec()).unwrap(),
                                attr.normalized_value(XmlVersion::Implicit1_0)
                                    .unwrap()
                                    .into_owned(),
                            )
                        })
                        .collect::<std::collections::HashMap<_, _>>();
                    let Some(press) = attributes.get("press") else {
                        continue;
                    };
                    let bytes = |value: &str| {
                        value
                            .split_whitespace()
                            .map(|byte| u8::from_str_radix(byte, 16).unwrap())
                            .collect::<Vec<_>>()
                    };
                    let mut engine = DescriptorEngine::default();
                    let press = bytes(press);
                    assert_eq!(
                        engine.accept(descriptor, &press),
                        [(key.clone(), true)],
                        "{kind}: {key}"
                    );
                    assert!(engine.accept(descriptor, &press).is_empty());
                    assert!(engine.accept(descriptor, &[0xec; 21]).is_empty());
                    assert_eq!(
                        engine.accept(descriptor, &bytes(&attributes["release"])),
                        [(key.clone(), false)]
                    );
                    tested += 1;
                }
                Event::Eof => break,
                _ => {}
            }
        }
        assert_eq!(tested, count);
        assert!(descriptor.inputs.iter().all(|input| !input.original));
    }
    let confirm = descriptor_for_kind("tclRc902n")
        .unwrap()
        .inputs
        .iter()
        .find(|input| input.id == "tcl-rc902n.confirm")
        .unwrap();
    assert!(!confirm.pending && confirm.sources.len() == 1);
    assert_eq!(voice_engine("tclRc902n"), Some("tcl-rc902v-atvv"));
    assert_eq!(voice_key("tclRc902n"), Some("tcl-rc902n.assistant"));
    assert_eq!(voice_engine("tclRc902v"), Some("tcl-rc902v-atvv"));
    assert_eq!(voice_key("tclRc902v"), Some("tcl-rc902v.assistant"));
    for kind in ["tclRc902n", "tclRc902v"] {
        assert_eq!(
            descriptor_for_kind(kind)
                .unwrap()
                .voices
                .first()
                .and_then(|voice| voice.attributes.get("trigger-modes"))
                .map(String::as_str),
            Some("hold click")
        );
    }
}

#[test]
fn tcl_identity_requires_hardware_and_every_information_marker() {
    for (kind, vendor, model, manufacturer, software) in [
        (
            "tclRc802a",
            0x0416,
            Some("BT_RC802A_v1"),
            Some("TCL Electronics"),
            None,
        ),
        ("tclRc902n", 0x0417, None, None, Some("TCL_RC902N_v1")),
        ("tclRc902v", 0x0417, None, None, Some("TCL_RC902V_v1")),
    ] {
        let product = if kind == "tclRc802a" { 0x0301 } else { 0x0304 };
        assert!(requires_information(kind));
        assert!(matches_information(
            kind,
            vendor,
            product,
            model,
            manufacturer,
            software
        ));
        assert!(!matches_information(
            kind,
            vendor,
            product + 1,
            model,
            manufacturer,
            software
        ));
        assert!(!matches_information(
            kind,
            vendor + 1,
            product,
            model,
            manufacturer,
            software
        ));
        for (m, f, s) in [
            (None, manufacturer, software),
            (model, None, software),
            (model, manufacturer, None),
        ] {
            if (model.is_some() && m.is_none())
                || (manufacturer.is_some() && f.is_none())
                || (software.is_some() && s.is_none())
            {
                assert!(!matches_information(kind, vendor, product, m, f, s));
            }
        }
        let id = format!(
            r"BTHLEDEVICE\{{00001812-0000-1000-8000-00805F9B34FB}}_DEV_VID&01{vendor:04X}_PID&{product:04X}_AABBCCDDEEFF\instance"
        );
        assert!(matches_instance(kind, &id));
        assert!(!matches_instance(kind, &id.replace("_PID&", "0_PID&")));
        assert!(!matches_instance(kind, &id.replace("00001812", "0000180A")));
        assert!(!matches_instance(
            kind,
            &id.replace("DEV_VID&01", "DEV_VID&05")
        ));
    }
    assert!(!matches_information(
        "tclRc802a",
        0x0416,
        0x0301,
        Some("RC802A"),
        Some("TCL"),
        None
    ));
    assert!(!matches_information(
        "tclRc802a",
        0x0416,
        0x0301,
        Some("BT_RC802A"),
        Some("other"),
        None
    ));
    assert!(!matches_information(
        "tclRc902n",
        0x0417,
        0x0304,
        None,
        None,
        Some("RC902V")
    ));
    assert!(!matches_information(
        "tclRc902v",
        0x0417,
        0x0304,
        None,
        None,
        Some("RC902N")
    ));
}

#[test]
fn rc802a_hold_and_click_send_eb_commands_with_independent_key_edges() {
    for mode in [RecordingMode::Hold, RecordingMode::Click] {
        let mut session = HidSession::for_kind("tclRc802a");
        session.start(mode);
        let mut writes = Vec::new();
        for (index, pressed) in [true, false, true, false].into_iter().enumerate() {
            let report = [1, 0, 0, if pressed { 0xad } else { 0 }, 0, 0, 0, 0, 0];
            let mut send = |command| {
                writes.push(command);
                Ok(())
            };
            assert_eq!(
                session.accept(&report, &mut send).unwrap().0,
                [("tcl-rc802a.voice", pressed)]
            );
            assert!(session.accept(&report, &mut send).unwrap().0.is_empty());
            assert_eq!(
                session.recording(),
                if mode == RecordingMode::Hold {
                    pressed
                } else {
                    index < 2
                }
            );
        }
        assert_eq!(
            writes,
            if mode == RecordingMode::Hold {
                vec![[0xeb, 1], [0xeb, 0], [0xeb, 1], [0xeb, 0]]
            } else {
                vec![[0xeb, 1], [0xeb, 0]]
            }
        );
        assert!(session
            .toggle_recording(|command| {
                assert_eq!(command, [0xeb, 1]);
                Ok(())
            })
            .unwrap());
        assert!(session
            .stop_recording(|_| Err("write failed".into()))
            .is_err());
        assert!(session.recording());
        session
            .stop(|command| {
                assert_eq!(command, [0xeb, 0]);
                Ok(())
            })
            .unwrap();
        assert!(!session.recording());
    }
}
