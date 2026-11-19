//! OnePlus RC-001A projector voice remote descriptor entry.
//! Front and side button HID reports are captured; voice decoding remains pending.

use super::device_descriptor::DeviceDescriptor;
use std::sync::OnceLock;

pub(crate) fn descriptor() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    super::descriptor_registry::load(
        include_str!("../../../../public/device-descriptors/oneplus-rc-001a.svg"),
        &DESCRIPTOR,
    )
}

#[cfg(test)]
mod tests {
    use crate::devices::{descriptor_registry::descriptor_for_kind, engine::DescriptorEngine};
    use quick_xml::{events::Event, Reader, XmlVersion};
    use std::collections::HashMap;

    const KIND: &str = "oneplusRc001a";
    const DESCRIPTOR_ID: &str = "oneplus-rc-001a";

    #[test]
    fn captured_oneplus_reports_drive_the_real_descriptor_engine() {
        let descriptor = descriptor_for_kind(KIND).unwrap();
        assert_eq!(descriptor.id, DESCRIPTOR_ID);
        assert_eq!(descriptor.vendor, "OnePlus");
        assert_eq!(descriptor.model, "RC-001A");

        let svg = include_str!("../../../../public/device-descriptors/oneplus-rc-001a.svg");
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
                        .collect::<HashMap<_, _>>();
                    let bytes = |value: &str| {
                        value
                            .split_whitespace()
                            .map(|byte| u8::from_str_radix(byte, 16).unwrap())
                            .collect::<Vec<_>>()
                    };
                    let mut engine = DescriptorEngine::default();
                    let press = bytes(&attributes["press"]);
                    let release = bytes(&attributes["release"]);
                    assert_eq!(
                        engine.accept(descriptor, &press),
                        [(key.clone(), true)],
                        "{KIND}: {key}"
                    );
                    assert!(engine.accept(descriptor, &press).is_empty());
                    assert_eq!(engine.accept(descriptor, &release), [(key.clone(), false)]);
                    tested += 1;
                }
                Event::Eof => break,
                _ => {}
            }
        }
        assert_eq!(tested, 13);
        assert!(descriptor.inputs.iter().all(|input| !input.original));
        assert!(descriptor.voices.is_empty());
    }

    #[test]
    fn separate_report_groups_release_independently() {
        let descriptor = descriptor_for_kind(KIND).unwrap();
        let mut engine = DescriptorEngine::default();
        assert_eq!(
            engine.accept(descriptor, &[0x01, 0x00, 0x00, 0x3b, 0, 0, 0, 0, 0]),
            [("oneplus.oneplus".into(), true)]
        );
        assert_eq!(
            engine.accept(descriptor, &[0x03, 0x41, 0x00]),
            [("oneplus.ok".into(), true)]
        );
        assert_eq!(
            engine.accept(descriptor, &[0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0]),
            [("oneplus.oneplus".into(), false)]
        );
        assert_eq!(
            engine.accept(descriptor, &[0x03, 0x00, 0x00]),
            [("oneplus.ok".into(), false)]
        );
        assert!(engine.release_all().is_empty());
    }
}
