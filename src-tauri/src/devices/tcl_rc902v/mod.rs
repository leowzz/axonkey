//! TCL RC902V uses the captured report layout in its SVG descriptor.
use super::device_descriptor::DeviceDescriptor;
use std::sync::OnceLock;

pub(crate) fn descriptor() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    super::descriptor_registry::load(
        include_str!("../../../../public/device-descriptors/tcl-rc902v.svg"),
        &DESCRIPTOR,
    )
}
