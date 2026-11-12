//! Hisense RCF3B65 projector voice remote descriptor entry.
//! Front button HID reports are captured; voice decoding remains pending.

use super::device_descriptor::DeviceDescriptor;
use std::sync::OnceLock;

pub(crate) fn descriptor() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    super::descriptor_registry::load(
        include_str!("../../../../public/device-descriptors/hisense-rcf3b65.svg"),
        &DESCRIPTOR,
    )
}
