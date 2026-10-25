//! System pairing records outlive HID connections. Never infer identity from a name.
use super::{digest, Discovered};
use std::collections::{HashMap, HashSet};

pub(super) struct Device {
    pub address: String,
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
}

pub(super) fn address(value: &str) -> Option<String> {
    let compact: String = value.chars().filter(|c| *c != ':' && *c != '-').collect();
    if compact.len() != 12 || !compact.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        (0..6)
            .map(|i| compact[i * 2..i * 2 + 2].to_ascii_uppercase())
            .collect::<Vec<_>>()
            .join(":"),
    )
}

pub(super) fn kind(vendor: u16, product: u16) -> Option<&'static str> {
    match (vendor, product) {
        (0x045e, 0x02e0) => Some("xboxBluetooth"),
        (0x2717, 0x32b8) => Some("rc003"),
        _ => None,
    }
}

pub(super) fn hid_address(info: &hidapi::DeviceInfo) -> Option<String> {
    if !matches!(info.bus_type(), hidapi::BusType::Bluetooth) {
        return None;
    }
    if let Some(address) = info.serial_number().and_then(address) {
        return Some(address);
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn axonkey_hid_bluetooth_address(
                registry_id: u64,
                output: *mut std::ffi::c_char,
                capacity: usize,
            ) -> bool;
        }
        let registry_id = info
            .path()
            .to_str()
            .ok()?
            .strip_prefix("DevSrvsID:")?
            .parse()
            .ok()?;
        let mut output = [0 as std::ffi::c_char; 64];
        if unsafe { axonkey_hid_bluetooth_address(registry_id, output.as_mut_ptr(), output.len()) }
        {
            return unsafe { std::ffi::CStr::from_ptr(output.as_ptr()) }
                .to_str()
                .ok()
                .and_then(address);
        }
    }
    None
}

pub(super) fn identity(
    kind: &str,
    vendor: u16,
    product: u16,
    serial: &str,
    bindings: &HashSet<String>,
) -> String {
    let hash = |serial: &str| digest(&format!("{kind}:{vendor}:{product}:{serial}"));
    let Some(address) = address(serial) else {
        return hash(serial);
    };
    // Keep bindings saved before address normalization, regardless of OS formatting.
    for separator in [":", "-", ""] {
        let variant = address.replace(':', separator);
        for candidate in [&variant, &variant.to_ascii_lowercase()] {
            let id = hash(candidate);
            if bindings.contains(&id) {
                return id;
            }
        }
    }
    hash(&address)
}

pub(super) fn merge(
    online: &mut Vec<Discovered>,
    paired: &[Device],
    bindings: &HashSet<String>,
    pairing_bindings: &HashMap<String, String>,
) {
    for device in paired {
        let Some(kind) = kind(device.vendor_id, device.product_id) else {
            continue;
        };
        let Some(address) = address(&device.address) else {
            continue;
        };
        let pairing_id = identity(
            kind,
            device.vendor_id,
            device.product_id,
            &address,
            &HashSet::new(),
        );
        let id = pairing_bindings
            .get(&pairing_id)
            .cloned()
            .unwrap_or_else(|| {
                identity(
                    kind,
                    device.vendor_id,
                    device.product_id,
                    &address,
                    bindings,
                )
            });
        if let Some(connected) = online
            .iter_mut()
            .find(|d| d.id == id || d.pairing_id.as_ref() == Some(&pairing_id))
        {
            connected.paired = true;
            continue;
        }
        online.push(Discovered {
            id,
            kind: kind.into(),
            name: device.name.clone(),
            transport: "Bluetooth".into(),
            identity_quality: "serial".into(),
            vendor_id: device.vendor_id,
            product_id: device.product_id,
            connected: false,
            paired: true,
            pairing_id: Some(pairing_id),
        });
    }
}

#[cfg(target_os = "macos")]
fn parse_macos(bytes: &[u8]) -> Result<Vec<Device>, String> {
    let json: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "无法解析系统蓝牙配对列表")?;
    let adapters = json
        .get("SPBluetoothDataType")
        .and_then(|v| v.as_array())
        .ok_or("系统蓝牙配对列表不完整")?;
    let mut devices = vec![];
    for adapter in adapters {
        for key in ["device_connected", "device_not_connected"] {
            let Some(rows) = adapter.get(key).and_then(|v| v.as_array()) else {
                continue;
            };
            for row in rows {
                let Some(entries) = row.as_object() else {
                    continue;
                };
                for (name, value) in entries {
                    let number = |key| {
                        value
                            .get(key)
                            .and_then(|v| v.as_str())
                            .and_then(|v| u16::from_str_radix(v.trim_start_matches("0x"), 16).ok())
                    };
                    let (Some(vendor_id), Some(product_id), Some(address)) = (
                        number("device_vendorID"),
                        number("device_productID"),
                        value.get("device_address").and_then(|v| v.as_str()),
                    ) else {
                        continue;
                    };
                    devices.push(Device {
                        address: address.into(),
                        name: name.clone(),
                        vendor_id,
                        product_id,
                    });
                }
            }
        }
    }
    Ok(devices)
}

#[cfg(target_os = "macos")]
pub(super) fn scan() -> Result<Vec<Device>, String> {
    use std::{
        io::Read,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    let mut child = Command::new("/usr/sbin/system_profiler")
        .args(["SPBluetoothDataType", "-json", "-timeout", "5"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法读取蓝牙配对列表：{e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        let mut bytes = vec![];
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(7);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("读取蓝牙配对列表超时".to_string());
            }
        }
    };
    let output = reader
        .join()
        .map_err(|_| "读取蓝牙配对列表失败")?
        .map_err(|_| "读取蓝牙配对列表失败")?;
    if !status?.success() {
        return Err("无法读取蓝牙配对列表".into());
    }
    parse_macos(&output)
}

#[cfg(windows)]
pub(super) fn scan() -> Result<Vec<Device>, String> {
    use windows::{
        core::{Interface, HSTRING},
        Devices::{
            Bluetooth::{BluetoothDevice, BluetoothLEDevice},
            Enumeration::DeviceInformation,
        },
        Foundation::IPropertyValue,
        Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    };
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    if !initialized {
        return Err("无法初始化蓝牙配对查询".into());
    }
    let result = (|| -> windows::core::Result<Vec<Device>> {
        let mut devices = vec![];
        for (index, selector) in [
            BluetoothDevice::GetDeviceSelectorFromPairingState(true)?,
            BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)?,
        ]
        .into_iter()
        .enumerate()
        {
            let properties: windows_collections::IIterable<HSTRING> = vec![
                HSTRING::from("System.Devices.Aep.DeviceAddress"),
                HSTRING::from("System.DeviceInterface.Bluetooth.VendorId"),
                HSTRING::from("System.DeviceInterface.Bluetooth.ProductId"),
                HSTRING::from("System.DeviceInterface.Bluetooth.VendorIdSource"),
            ]
            .into();
            let records = DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(
                &selector,
                &properties,
            )?
            .get()?;
            for record in records {
                let values = record.Properties()?;
                let property = |key: &str| {
                    values
                        .Lookup(&HSTRING::from(key))
                        .and_then(|v| v.cast::<IPropertyValue>())
                        .ok()
                };
                // HID support packages use USB vendor IDs, not Bluetooth company IDs.
                let Some(2) = property("System.DeviceInterface.Bluetooth.VendorIdSource")
                    .and_then(|v| v.GetUInt16().ok())
                else {
                    continue;
                };
                let (Some(vendor_id), Some(product_id)) = (
                    property("System.DeviceInterface.Bluetooth.VendorId")
                        .and_then(|v| v.GetUInt16().ok()),
                    property("System.DeviceInterface.Bluetooth.ProductId")
                        .and_then(|v| v.GetUInt16().ok()),
                ) else {
                    continue;
                };
                if kind(vendor_id, product_id).is_none() {
                    continue;
                }
                let address = if let Some(address) = property("System.Devices.Aep.DeviceAddress")
                    .and_then(|v| v.GetString().ok())
                    .and_then(|v| address(&v.to_string()))
                {
                    address
                } else {
                    // The paired selector can return a device interface without AEP properties.
                    let address = if index == 0 {
                        let device = BluetoothDevice::FromIdAsync(&record.Id()?)?.get()?;
                        let address = device.BluetoothAddress()?;
                        device.Close()?;
                        address
                    } else {
                        let device = BluetoothLEDevice::FromIdAsync(&record.Id()?)?.get()?;
                        let address = device.BluetoothAddress()?;
                        device.Close()?;
                        address
                    };
                    format!("{address:012X}")
                };
                devices.push(Device {
                    address,
                    name: record.Name()?.to_string(),
                    vendor_id,
                    product_id,
                });
            }
        }
        Ok(devices)
    })();
    unsafe { CoUninitialize() };
    result.map_err(|e| format!("无法读取蓝牙配对列表：{e}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn scan() -> Result<Vec<Device>, String> {
    Ok(vec![])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn controller(address: &str) -> Device {
        Device {
            address: address.into(),
            name: "Controller".into(),
            vendor_id: 0x045e,
            product_id: 0x02e0,
        }
    }
    #[test]
    fn disconnect_reconnect_and_unpair_keep_physical_identity() {
        let paired = vec![
            controller("AA:BB:CC:DD:EE:01"),
            controller("AA:BB:CC:DD:EE:02"),
        ];
        let bindings = HashSet::new();
        let mut offline = vec![];
        merge(&mut offline, &paired, &bindings, &HashMap::new());
        assert_eq!(offline.len(), 2);
        assert!(offline.iter().all(|d| !d.connected && d.paired));
        assert_ne!(offline[0].id, offline[1].id);
        let mut online = vec![offline[0].clone()];
        online[0].connected = true;
        merge(&mut online, &paired, &bindings, &HashMap::new());
        assert_eq!(online.len(), 2);
        assert!(online[0].connected);
        assert_eq!(online[0].id, offline[0].id);
        let mut after_unpair = vec![];
        merge(&mut after_unpair, &paired[1..], &bindings, &HashMap::new());
        assert_eq!(after_unpair.len(), 1);
        assert_eq!(after_unpair[0].id, offline[1].id);
        // Duplicate OS records and unsupported/name-only devices cannot add duplicates.
        merge(&mut after_unpair, &paired[1..], &bindings, &HashMap::new());
        assert_eq!(after_unpair.len(), 1);
    }
    #[test]
    fn address_formats_preserve_existing_bindings() {
        let legacy = digest("xboxBluetooth:1118:736:aa-bb-cc-dd-ee-01");
        let bindings = HashSet::from([legacy.clone()]);
        assert_eq!(
            identity("xboxBluetooth", 1118, 736, "AA:BB:CC:DD:EE:01", &bindings),
            legacy
        );
        assert_eq!(
            address("aabbccddee01").as_deref(),
            Some("AA:BB:CC:DD:EE:01")
        );
        assert!(address("not-a-hardware-address").is_none());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reads_offline_records_without_guessing_from_names() {
        let records = parse_macos(br#"{"SPBluetoothDataType":[{"device_not_connected":[{"Xbox Wireless Controller":{"device_address":"AA:BB:CC:DD:EE:01","device_vendorID":"0x045E","device_productID":"0x02E0"}},{"Xbox Wireless Controller":{"device_address":"AA:BB:CC:DD:EE:02"}}]}]}"#).unwrap();
        assert_eq!(records.len(), 1);
        assert!(parse_macos(b"{}").is_err());
        assert!(parse_macos(b"{\"SPBluetoothDataType\":[]}")
            .unwrap()
            .is_empty());
    }
    #[test]
    #[ignore = "reads the current OS pairing inventory without connecting devices"]
    fn system_pairing_inventory() {
        let records = scan().unwrap();
        let mut devices = vec![];
        merge(&mut devices, &records, &HashSet::new(), &HashMap::new());
        for device in &devices {
            eprintln!(
                "paired {} {:04x}:{:04x} …{}",
                device.kind,
                device.vendor_id,
                device.product_id,
                &device.id[device.id.len() - 6..]
            );
        }
        assert!(
            !devices.is_empty(),
            "Pair a supported device before this read-only check"
        );
    }
}
