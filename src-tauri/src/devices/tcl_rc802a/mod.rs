//! TCL RC802A uses the captured report layout in its SVG descriptor.
use super::device_descriptor::DeviceDescriptor;
use std::sync::OnceLock;

pub(crate) fn descriptor() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    super::descriptor_registry::load(
        include_str!("../../../../public/device-descriptors/tcl-rc802a.svg"),
        &DESCRIPTOR,
    )
}

pub(crate) fn voice_stream() -> super::cmiot_a15::voice::VoiceStream {
    super::cmiot_a15::voice::VoiceStream::with_ico_report(0xec, true)
}

#[cfg(test)]
mod tests;
