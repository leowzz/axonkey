//! Hisense RCF3B65 voice and air-mouse remote support.

use super::device_descriptor::DeviceDescriptor;
use std::sync::OnceLock;

pub(crate) const KIND: &str = "hisenseRcf3b65";
pub(crate) const DESCRIPTOR_ID: &str = "hisense-rcf3b65";
const POINTER_LOGICAL_MAX: u16 = 0x7fff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PointerPosition {
    pub x: u16,
    pub y: u16,
}

pub(crate) fn descriptor() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    super::descriptor_registry::load(
        include_str!("../../../../public/device-descriptors/hisense-rcf3b65.svg"),
        &DESCRIPTOR,
    )
}

/// Decode a 9-byte `0x3F 0x10` absolute pointer HID report and normalize its
/// `0..=32767` coordinates into `0..=65535`.
pub(crate) fn parse_pointer_report(bytes: &[u8]) -> Option<PointerPosition> {
    let &[0x3f, 0x10, x_lo, x_hi, y_lo, y_hi, _, _, _] = bytes else {
        return None;
    };
    Some(PointerPosition {
        x: normalize_coordinate(u16::from_le_bytes([x_lo, x_hi])),
        y: normalize_coordinate(u16::from_le_bytes([y_lo, y_hi])),
    })
}

fn normalize_coordinate(raw: u16) -> u16 {
    let clamped = u64::from(raw.min(POINTER_LOGICAL_MAX));
    ((clamped * u64::from(u16::MAX) + u64::from(POINTER_LOGICAL_MAX / 2))
        / u64::from(POINTER_LOGICAL_MAX)) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_captured_pointer_reports_and_scales_to_u16_range() {
        let samples = [
            (
                [0x3f, 0x10, 0x90, 0x63, 0x27, 0x0d, 0x00, 0x00, 0x00],
                6_734,
            ),
            (
                [0x3f, 0x10, 0x90, 0x63, 0x6f, 0x0d, 0x00, 0x00, 0x00],
                6_878,
            ),
            (
                [0x3f, 0x10, 0x90, 0x63, 0xb5, 0x0d, 0x00, 0x00, 0x00],
                7_018,
            ),
            (
                [0x3f, 0x10, 0x90, 0x63, 0xd5, 0x0d, 0x00, 0x00, 0x00],
                7_082,
            ),
        ];
        for (bytes, expected_y) in samples {
            assert_eq!(
                parse_pointer_report(&bytes),
                Some(PointerPosition {
                    x: 50_977,
                    y: expected_y,
                })
            );
        }
    }

    #[test]
    fn clamps_pointer_logical_bounds_and_ignores_non_pointer_reports() {
        assert_eq!(
            parse_pointer_report(&[0x3f, 0x10, 0x00, 0x00, 0xff, 0x7f, 0x00, 0x00, 0x00]),
            Some(PointerPosition { x: 0, y: u16::MAX })
        );
        assert_eq!(
            parse_pointer_report(&[0x3f, 0x10, 0xff, 0xff, 0x00, 0x80, 0x00, 0x00, 0x00]),
            Some(PointerPosition {
                x: u16::MAX,
                y: u16::MAX,
            })
        );
        assert_eq!(
            parse_pointer_report(&[0x01, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00]),
            None
        );
        assert_eq!(
            parse_pointer_report(&[0x6f, 0x6a, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
            None
        );
        assert_eq!(
            parse_pointer_report(&[0x3f, 0x11, 0x90, 0x63, 0x27, 0x0d, 0x00, 0x00, 0x00]),
            None
        );
        assert_eq!(
            parse_pointer_report(&[0x3f, 0x10, 0x90, 0x63, 0x27, 0x0d, 0x00, 0x00]),
            None
        );
    }
}
