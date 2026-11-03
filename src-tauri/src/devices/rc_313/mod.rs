//! RC-313 currently uses the same HID report and voice protocol as CMIOT-A15.
//! Keep a separate device module so its protocol can diverge without changing
//! the model-specific discovery and mapping type.

pub(crate) use super::cmiot_a15::{decode, BUTTONS};
