use super::{Discovered, Shared, Snapshot};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CMIOT_A15_SOFTWARE_MARKER: &str = "CMIOT3_B311";
const XM_BT_29_SOFTWARE_MARKER: &str = "XFRSD0D_M_R01_761";
const RC_313_SOFTWARE_MARKER: &str = "CMIOT18_B302";

fn kind_for_software(kind: &str, software: Option<&str>) -> Option<&'static str> {
    if kind == "obeRcuR5" {
        return Some("obeRcuR5");
    }
    if !matches!(kind, "cmiotA15" | "xmBt29" | "rc313") {
        return None;
    }
    Some(match software {
        Some(version) if version.contains(CMIOT_A15_SOFTWARE_MARKER) => "cmiotA15",
        Some(version) if version.contains(XM_BT_29_SOFTWARE_MARKER) => "xmBt29",
        Some(version) if version.contains(RC_313_SOFTWARE_MARKER) => "rc313",
        _ => "rc313",
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceInformation {
    pub status: String,
    pub bluetooth_name: Option<String>,
    pub battery_level: Option<u8>,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub hardware_revision: Option<String>,
    pub firmware_revision: Option<String>,
    pub software_revision: Option<String>,
    pub detected_kind: Option<String>,
    pub updated_at: Option<u64>,
    pub error: Option<String>,
}
impl Default for DeviceInformation {
    fn default() -> Self {
        Self {
            status: "pending".into(),
            bluetooth_name: None,
            battery_level: None,
            manufacturer: None,
            serial_number: None,
            hardware_revision: None,
            firmware_revision: None,
            software_revision: None,
            detected_kind: None,
            updated_at: None,
            error: None,
        }
    }
}

pub(super) fn request(shared: &Shared, binding: &str) -> Result<Snapshot, String> {
    let mut snapshot = shared.snapshot.lock().unwrap();
    let device = snapshot
        .discovered
        .iter_mut()
        .find(|device| device.id == binding)
        .ok_or("未找到绑定设备")?;
    if !matches!(
        device.kind.as_str(),
        "rc003" | "cmiotA15" | "xmBt29" | "rc313" | "obeRcuR5"
    ) || !device.connected
        || device.identity_quality == "ambiguous"
        || device.bluetooth_address.is_none()
    {
        return Err("设备未连接或无法读取设备信息".into());
    }
    device.device_info.status = "pending".into();
    device.device_info.error = None;
    shared
        .information_requests
        .lock()
        .unwrap()
        .insert(binding.into());
    Ok(snapshot.clone())
}

const REFRESH: Duration = Duration::from_secs(300);
const RETRY: Duration = Duration::from_secs(3);
#[derive(Default)]
struct Schedule {
    next: Option<Instant>,
    retries: u8,
}
impl Schedule {
    fn due(&self, now: Instant) -> bool {
        self.next.is_none_or(|next| now >= next)
    }
    fn complete(&mut self, success: bool, now: Instant) -> bool {
        let retry = !success && self.retries < 3;
        self.retries = if retry { self.retries + 1 } else { 0 };
        self.next = Some(now + if retry { RETRY } else { REFRESH });
        retry
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub(super) fn start(shared: Arc<Shared>) {
    thread::spawn(move || {
        let mut schedules = HashMap::<(String, String), Schedule>::new();
        while !shared.stop.load(Ordering::Acquire) {
            let targets: Vec<_> = shared
                .snapshot
                .lock()
                .unwrap()
                .discovered
                .iter()
                .filter(|d| {
                    matches!(
                        d.kind.as_str(),
                        "rc003" | "cmiotA15" | "xmBt29" | "rc313" | "obeRcuR5"
                    ) && d.connected
                        && d.identity_quality != "ambiguous"
                        && d.bluetooth_address.is_some()
                })
                .cloned()
                .collect();
            schedules.retain(|(id, address), _| {
                targets
                    .iter()
                    .any(|d| &d.id == id && d.bluetooth_address.as_ref() == Some(address))
            });
            let requested = std::mem::take(&mut *shared.information_requests.lock().unwrap());
            for ((id, _), schedule) in &mut schedules {
                if requested.contains(id) {
                    *schedule = Schedule::default();
                }
            }
            let due: Vec<_> = targets
                .iter()
                .filter(|target| {
                    let key = (target.id.clone(), target.bluetooth_address.clone().unwrap());
                    schedules.entry(key).or_default().due(Instant::now())
                })
                .cloned()
                .collect();
            if !due.is_empty() {
                // A single platform batch shares discovery across remotes on macOS.
                let readings = read_batch(&due, &targets);
                for (target, mut info) in due.iter().zip(readings) {
                    if shared.stop.load(Ordering::Acquire) {
                        return;
                    }
                    let key = (target.id.clone(), target.bluetooth_address.clone().unwrap());
                    let schedule = schedules.get_mut(&key).unwrap();
                    let success = info.error.is_none();
                    let retry = schedule.complete(success, Instant::now());
                    info.status = if success {
                        "ready"
                    } else if retry {
                        "retrying"
                    } else {
                        "error"
                    }
                    .into();
                    info.updated_at = Some(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    );
                    apply_information(&shared, target, info);
                }
            }
            thread::sleep(Duration::from_millis(250));
        }
    });
}

pub(super) fn apply_information(shared: &Shared, target: &Discovered, mut info: DeviceInformation) {
    let mut snapshot = shared.snapshot.lock().unwrap();
    let Some(device) = snapshot.discovered.iter_mut().find(|d| {
        d.id == target.id
            && d.bluetooth_address == target.bluetooth_address
            && d.connected
            && d.identity_quality != "ambiguous"
    }) else {
        return;
    };
    info.detected_kind = kind_for_software(device.kind.as_str(), info.software_revision.as_deref())
        .map(str::to_owned);
    device.device_info = info;
}

pub(super) fn retain_readings(discovered: &mut [Discovered], previous: &[Discovered]) {
    for device in discovered {
        if device.connected && device.identity_quality != "ambiguous" {
            if let Some(old) = previous.iter().find(|old| {
                old.connected
                    && old.id == device.id
                    && old.bluetooth_address == device.bluetooth_address
            }) {
                device.device_info = old.device_info.clone();
            }
        } else {
            device.device_info = DeviceInformation {
                status: "disconnected".into(),
                ..Default::default()
            };
        }
    }
}

fn percent(bytes: &[u8]) -> Result<u8, String> {
    match bytes {
        [level @ 0..=100] => Ok(*level),
        _ => Err("电量数据格式无效".into()),
    }
}
fn text(bytes: &[u8]) -> Result<Option<String>, String> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| "设备信息不是有效 UTF-8 文本")?
        .trim_matches('\0')
        .trim();
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

#[cfg(windows)]
fn read(target: &Discovered, _unique_model: bool) -> DeviceInformation {
    use windows::Devices::Bluetooth::BluetoothLEDevice;
    let mut info = DeviceInformation::default();
    let _apartment = match crate::windows_runtime::initialize_mta() {
        Ok(apartment) => apartment,
        Err(error) => {
            info.error = Some(error.to_string());
            return info;
        }
    };
    let _bluetooth_calls = crate::windows_runtime::bluetooth_call_guard();
    let result = (|| -> Result<(), String> {
        let address = u64::from_str_radix(
            &target.bluetooth_address.as_ref().unwrap().replace(':', ""),
            16,
        )
        .map_err(|e| e.to_string())?;
        let device = BluetoothLEDevice::FromBluetoothAddressAsync(address)
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?;
        info.bluetooth_name = device
            .Name()
            .ok()
            .map(|name| name.to_string())
            .filter(|name| !name.is_empty());
        let mut errors = Vec::new();
        for (service_id, characteristics) in [
            (0x180f, &[0x2a19][..]),
            (0x180a, &[0x2a29, 0x2a25, 0x2a27, 0x2a26, 0x2a28][..]),
        ] {
            if let Err(error) = read_service(&device, service_id, characteristics, &mut info) {
                errors.push(error);
            }
        }
        let _ = device.Close();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    })();
    info.error = result.err();
    info
}

#[cfg(windows)]
fn read_service(
    device: &windows::Devices::Bluetooth::BluetoothLEDevice,
    service_id: u16,
    ids: &[u16],
    info: &mut DeviceInformation,
) -> Result<(), String> {
    use windows::{
        core::GUID,
        Devices::Bluetooth::{
            BluetoothCacheMode,
            GenericAttributeProfile::{GattCommunicationStatus, GattOpenStatus, GattSharingMode},
        },
        Storage::Streams::DataReader,
    };
    let uuid = |id: u16| GUID::from_u128(((id as u128) << 96) | 0x0000_1000_8000_00805f9b34fb);
    let services = device
        .GetGattServicesForUuidWithCacheModeAsync(uuid(service_id), BluetoothCacheMode::Cached)
        .and_then(|op| op.get())
        .map_err(|e| e.to_string())?;
    if services.Status().map_err(|e| e.to_string())? != GattCommunicationStatus::Success {
        return Err(format!("服务 {service_id:04X} 暂时无法访问"));
    }
    let services = services.Services().map_err(|e| e.to_string())?;
    if services.Size().map_err(|e| e.to_string())? == 0 {
        return Ok(());
    }
    let service = services.GetAt(0).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let opened = service
            .OpenAsync(GattSharingMode::SharedReadOnly)
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?;
        if opened != GattOpenStatus::Success && opened != GattOpenStatus::AlreadyOpened {
            return Err(format!("无法共享访问服务 {service_id:04X} ({})", opened.0));
        }
        let mut errors = Vec::new();
        for &id in ids {
            let read = (|| -> Result<(), String> {
                let chars = service
                    .GetCharacteristicsForUuidWithCacheModeAsync(
                        uuid(id),
                        BluetoothCacheMode::Cached,
                    )
                    .and_then(|op| op.get())
                    .map_err(|e| e.to_string())?;
                if chars.Status().map_err(|e| e.to_string())? != GattCommunicationStatus::Success {
                    return Err(format!("无法读取特征 {id:04X}"));
                }
                let chars = chars.Characteristics().map_err(|e| e.to_string())?;
                if chars.Size().map_err(|e| e.to_string())? == 0 {
                    return Ok(());
                }
                let value = chars
                    .GetAt(0)
                    .and_then(|c| c.ReadValueWithCacheModeAsync(BluetoothCacheMode::Uncached))
                    .and_then(|op| op.get())
                    .map_err(|e| e.to_string())?;
                if value.Status().map_err(|e| e.to_string())? != GattCommunicationStatus::Success {
                    return Err(format!("特征 {id:04X} 读取失败"));
                }
                let buffer = value.Value().map_err(|e| e.to_string())?;
                let mut bytes = vec![0; buffer.Length().map_err(|e| e.to_string())? as usize];
                DataReader::FromBuffer(&buffer)
                    .and_then(|r| r.ReadBytes(&mut bytes))
                    .map_err(|e| e.to_string())?;
                match id {
                    0x2a19 => info.battery_level = Some(percent(&bytes)?),
                    0x2a29 => info.manufacturer = text(&bytes)?,
                    0x2a25 => info.serial_number = text(&bytes)?,
                    0x2a27 => info.hardware_revision = text(&bytes)?,
                    0x2a26 => info.firmware_revision = text(&bytes)?,
                    0x2a28 => info.software_revision = text(&bytes)?,
                    _ => unreachable!(),
                }
                Ok(())
            })();
            if let Err(error) = read {
                // Software Version is optional in the Device Information Service.
                // A missing or unreadable 2A28 must leave the field empty without
                // making the rest of the device information look unavailable.
                if id == 0x2a28 {
                    continue;
                }
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    })();
    let _ = service.Close();
    result
}

#[cfg(windows)]
fn read_batch(targets: &[Discovered], _all_targets: &[Discovered]) -> Vec<DeviceInformation> {
    const TIMEOUT: Duration = Duration::from_secs(15);
    targets
        .iter()
        .map(|target| {
            let target = target.clone();
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            thread::spawn(move || {
                let _ = sender.send(read(&target, true));
            });
            receiver
                .recv_timeout(TIMEOUT)
                .unwrap_or_else(|_| DeviceInformation {
                    error: Some("设备信息读取超时".into()),
                    ..Default::default()
                })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn read_batch(targets: &[Discovered], all_targets: &[Discovered]) -> Vec<DeviceInformation> {
    use std::ffi::{c_char, CStr, CString};
    unsafe extern "C" {
        fn axonkey_device_information(requests: *const c_char) -> *mut c_char;
        fn axonkey_device_information_free(value: *mut c_char);
    }
    let requests: Vec<_> = targets
        .iter()
        .map(|target| {
            serde_json::json!({
                "address": target.bluetooth_address,
                "vendor": target.vendor_id,
                "product": target.product_id,
                "uniqueModel": all_targets.iter().filter(|d| d.kind == target.kind).count() == 1,
            })
        })
        .collect();
    let request = CString::new(serde_json::to_string(&requests).unwrap()).unwrap();
    let raw = unsafe { axonkey_device_information(request.as_ptr()) };
    let parsed = if raw.is_null() {
        None
    } else {
        let result: Option<Vec<DeviceInformation>> =
            serde_json::from_slice(unsafe { CStr::from_ptr(raw) }.to_bytes()).ok();
        unsafe { axonkey_device_information_free(raw) };
        result
    };
    parsed.unwrap_or_else(|| {
        targets
            .iter()
            .map(|_| DeviceInformation {
                error: Some("无法读取设备信息".into()),
                ..Default::default()
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obe_model_does_not_depend_on_software_revision() {
        for software in [None, Some("CMIOT3_B311"), Some("unknown")] {
            assert_eq!(kind_for_software("obeRcuR5", software), Some("obeRcuR5"));
        }
    }

    #[test]
    fn software_version_selects_model_and_missing_version_defaults_to_rc313() {
        assert_eq!(
            kind_for_software("cmiotA15", Some("CMIOT3_B311")),
            Some("cmiotA15")
        );
        assert_eq!(
            kind_for_software("cmiotA15", Some("CMIOT3_B311_debug")),
            Some("cmiotA15")
        );
        assert_eq!(
            kind_for_software("cmiotA15", Some("XFRSD0D_M_R01_761")),
            Some("xmBt29")
        );
        assert_eq!(
            kind_for_software("cmiotA15", Some("XFRSD0D_M_R01_761_debug")),
            Some("xmBt29")
        );
        assert_eq!(kind_for_software("xmBt29", None), Some("rc313"));
        assert_eq!(
            kind_for_software("cmiotA15", Some("CMIOT18_B302_1601")),
            Some("rc313")
        );
        assert_eq!(
            kind_for_software("cmiotA15", Some("CMIOT18_B302_1601_debug")),
            Some("rc313")
        );
        assert_eq!(kind_for_software("rc313", None), Some("rc313"));
        assert_eq!(
            kind_for_software("cmiotA15", Some("unknown")),
            Some("rc313")
        );
        assert_eq!(kind_for_software("rc003", Some("XFRSD0D_M_R01_761")), None);
    }

    #[test]
    fn retries_three_times_then_waits_five_minutes_and_resets_after_success() {
        let mut schedule = Schedule::default();
        let mut now = Instant::now();
        assert!(schedule.due(now));
        for retry in [true, true, true, false] {
            assert_eq!(schedule.complete(false, now), retry);
            let delay = if retry { RETRY } else { REFRESH };
            assert!(!schedule.due(now + delay - Duration::from_millis(1)));
            now += delay;
            assert!(schedule.due(now));
        }
        assert!(schedule.complete(false, now));
        assert!(!schedule.complete(true, now));
        assert_eq!(schedule.retries, 0);
        assert_eq!(schedule.next, Some(now + REFRESH));
    }
    #[test]
    fn parses_wire_values_and_optional_strings() {
        for value in [0, 56, 100] {
            assert_eq!(percent(&[value]), Ok(value));
        }
        for bytes in [vec![], vec![101], vec![255], vec![1, 2]] {
            assert!(percent(&bytes).is_err());
        }
        assert_eq!(text(b"Maker\0"), Ok(Some("Maker".into())));
        assert_eq!(text(b"\0"), Ok(None));
        assert!(text(&[0xff]).is_err());
    }
    #[test]
    fn scans_preserve_per_device_information_and_clear_disconnected_readings() {
        let device = |id: &str, level| Discovered {
            id: id.into(),
            kind: "cmiotA15".into(),
            name: "A15".into(),
            transport: "Bluetooth".into(),
            identity_quality: "serial".into(),
            vendor_id: 0x0416,
            product_id: 0x0300,
            connected: true,
            paired: true,
            pairing_id: None,
            hid_instance_id: None,
            bluetooth_address: Some(id.into()),
            device_info: DeviceInformation {
                battery_level: Some(level),
                ..Default::default()
            },
        };
        let previous = vec![device("one", 0), device("two", 100)];
        let mut next = vec![previous[1].clone(), previous[0].clone()];
        retain_readings(&mut next, &previous);
        assert_eq!(next[0].device_info.battery_level, Some(100));
        assert_eq!(next[1].device_info.battery_level, Some(0));
        next[0].connected = false;
        next[1].identity_quality = "ambiguous".into();
        retain_readings(&mut next, &previous);
        assert!(next.iter().all(|d| d.device_info.battery_level.is_none()));
    }
}
