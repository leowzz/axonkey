//! Phicomm (斐讯) DB1-R projector voice remote descriptor entry.
//! Front button HID reports are captured; voice decoding remains pending.

use super::device_descriptor::DeviceDescriptor;
use std::sync::OnceLock;

pub(crate) fn descriptor() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    super::descriptor_registry::load(
        include_str!("../../../../public/device-descriptors/phicomm-db1-r.svg"),
        &DESCRIPTOR,
    )
}

#[cfg(test)]
mod tests {
    use crate::devices::{descriptor_registry::descriptor_for_kind, engine::DescriptorEngine};
    use quick_xml::{events::Event, Reader, XmlVersion};
    use std::collections::HashMap;

    #[test]
    fn captured_projector_remote_reports_drive_the_real_descriptor_engine() {
        for (kind, svgs, count) in [
            (
                "hisenseRcf3b65",
                [
                    include_str!("../../../../public/device-descriptors/hisense-rcf3b65.svg"),
                    include_str!("../../../../docs/device-drafts/hisense-rcf3b65.svg"),
                ],
                18,
            ),
            (
                "phicommDb1R",
                [
                    include_str!("../../../../public/device-descriptors/phicomm-db1-r.svg"),
                    include_str!("../../../../docs/device-drafts/phicomm-db1-r.svg"),
                ],
                12,
            ),
        ] {
            let descriptor = descriptor_for_kind(kind).unwrap();
            for svg in svgs {
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
                                "{kind}: {key}"
                            );
                            assert!(engine.accept(descriptor, &press).is_empty());
                            assert_eq!(engine.accept(descriptor, &release), [(key.clone(), false)]);
                            tested += 1;
                        }
                        Event::Eof => break,
                        _ => {}
                    }
                }
                assert_eq!(tested, count);
            }
            assert!(descriptor.inputs.iter().all(|input| !input.original));
            assert!(descriptor.voices.is_empty());
        }
    }

    #[test]
    fn separate_report_groups_release_independently() {
        let phicomm = descriptor_for_kind("phicommDb1R").unwrap();
        let mut engine = DescriptorEngine::default();
        assert_eq!(
            engine.accept(phicomm, &[0x01, 0x00, 0x00, 0x28, 0, 0, 0, 0, 0]),
            [("phicomm-db1-r.confirm".into(), true)]
        );
        assert_eq!(
            engine.accept(phicomm, &[0x02, 0x24, 0x02]),
            [("phicomm-db1-r.back".into(), true)]
        );
        assert_eq!(
            engine.accept(phicomm, &[0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0]),
            [("phicomm-db1-r.confirm".into(), false)]
        );
        assert_eq!(
            engine.accept(phicomm, &[0x02, 0x00, 0x00]),
            [("phicomm-db1-r.back".into(), false)]
        );
        assert!(engine.release_all().is_empty());

        let hisense = descriptor_for_kind("hisenseRcf3b65").unwrap();
        assert_eq!(
            engine.accept(hisense, &[0x01, 0x00, 0x00, 0x52, 0, 0, 0, 0, 0]),
            [("hisense-rcf3b65.up".into(), true)]
        );
        assert_eq!(
            engine.accept(hisense, &[0x6f, 0x6a, 0x01, 0, 0, 0, 0, 0, 0]),
            [("hisense-rcf3b65.pointer".into(), true)]
        );
        assert!(engine
            .accept(hisense, &[0x3f, 0x10, 0x90, 0x63, 0x27, 0x0d, 0, 0, 0])
            .is_empty());
        assert_eq!(
            engine.accept(hisense, &[0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0]),
            [("hisense-rcf3b65.up".into(), false)]
        );
        assert_eq!(
            engine.accept(hisense, &[0x6f, 0x6a, 0x03, 0, 0, 0, 0, 0, 0]),
            [("hisense-rcf3b65.pointer".into(), false)]
        );
        assert!(engine.release_all().is_empty());
    }
}
