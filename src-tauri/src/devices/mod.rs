pub(crate) mod cmiot_a15;
pub(crate) mod cmiot_a15_fc;
pub(crate) mod cmiot_a15_recording;
mod siren;
pub(crate) mod xiaomi_remote;

pub(crate) mod xbox;

/// HID service suffix of an uppercased Windows BLE instance ID.
pub(crate) fn bluetooth_hid_service(id: &str) -> Option<&str> {
    let suffix = id.strip_prefix("BTHLEDEVICE")?;
    suffix
        .strip_prefix('\\')
        .unwrap_or(suffix)
        .strip_prefix("{00001812-0000-1000-8000-00805F9B34FB}_")
}
