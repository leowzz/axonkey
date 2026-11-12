use super::{digest, Discovered, Shared, Snapshot};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs, io,
    path::Path,
    sync::{atomic::Ordering, mpsc, Arc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

fn kind_for_software(kind: &str, software: Option<&str>) -> Option<&'static str> {
    use crate::devices::descriptor_registry::{
        descriptor_for_kind, matches_hardware, primary_hardware, KINDS,
    };
    if !super::uses_hid_voice(kind) {
        return None;
    }
    let (vendor, product) = primary_hardware(kind)?;
    let candidates = KINDS
        .iter()
        .copied()
        .filter(|candidate| matches_hardware(candidate, vendor, product, None, None))
        .collect::<Vec<_>>();
    candidates
        .iter()
        .copied()
        .find(|candidate| {
            descriptor_for_kind(candidate).is_some_and(|descriptor| {
                descriptor.identities.iter().any(|identity| {
                    identity
                        .attributes
                        .get("software-contains")
                        .is_some_and(|marker| {
                            software.is_some_and(|software| {
                                marker.split('|').any(|marker| software.contains(marker))
                            })
                        })
                })
            })
        })
        .or_else(|| {
            candidates.iter().copied().find(|candidate| {
                descriptor_for_kind(candidate).is_some_and(|descriptor| {
                    descriptor.identities.iter().any(|identity| {
                        identity
                            .attributes
                            .get("software-fallback")
                            .is_some_and(|value| value == "true")
                    })
                })
            })
        })
        .or_else(|| (candidates.len() == 1).then(|| candidates[0]))
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

#[derive(Default)]
pub(super) struct BatteryCache {
    levels: BTreeMap<String, u8>,
    dirty: bool,
}

impl BatteryCache {
    pub(super) fn load(store_path: &Path) -> Self {
        let mut levels: BTreeMap<String, u8> = fs::read(store_path.with_extension("battery.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        levels.retain(|_, level| *level <= 100);
        Self {
            levels,
            dirty: false,
        }
    }

    fn level(&self, address: &str) -> Option<u8> {
        self.levels.get(&digest(address)).copied()
    }

    fn remember(&mut self, store_path: &Path, address: &str, level: u8) -> io::Result<()> {
        self.dirty |= self.levels.insert(digest(address), level) != Some(level);
        if !self.dirty {
            return Ok(());
        }
        let path = store_path.with_extension("battery.json");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension("tmp");
        fs::write(&temp, serde_json::to_vec(&self.levels)?)?;
        fs::rename(temp, path)?;
        self.dirty = false;
        Ok(())
    }
}

pub(super) fn request(shared: &Shared, binding: &str) -> Result<Snapshot, String> {
    let mut snapshot = shared.snapshot.lock().unwrap();
    let device = snapshot
        .discovered
        .iter_mut()
        .find(|device| device.id == binding)
        .ok_or("未找到绑定设备")?;
    if crate::devices::descriptor_registry::voice_engine(&device.kind).is_none()
        || !device.connected
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
const MISSING_BATTERY_REFRESH: Duration = Duration::from_secs(30);
#[cfg(windows)]
const READ_TIMEOUT: Duration = Duration::from_secs(15);
#[derive(Default)]
struct Schedule {
    next: Option<Instant>,
    retries: u8,
}
impl Schedule {
    fn due(&self, now: Instant) -> bool {
        self.next.is_none_or(|next| now >= next)
    }
    fn complete(&mut self, info: &DeviceInformation, expect_battery: bool, now: Instant) -> bool {
        let missing_battery = expect_battery && info.battery_level.is_none();
        let retry = (info.error.is_some() || missing_battery) && self.retries < 3;
        let delay = if retry {
            self.retries += 1;
            RETRY
        } else if missing_battery {
            MISSING_BATTERY_REFRESH
        } else {
            self.retries = 0;
            REFRESH
        };
        self.next = Some(now + delay);
        retry
    }
}

type ReadingKey = (String, String);

struct Reading {
    target: Discovered,
    info: DeviceInformation,
    complete: bool,
}

impl Reading {
    fn apply(
        mut self,
        shared: &Shared,
        schedules: &mut HashMap<ReadingKey, Schedule>,
        in_flight: &mut HashSet<ReadingKey>,
    ) {
        if self.complete {
            let key = (
                self.target.id.clone(),
                self.target.bluetooth_address.clone().unwrap(),
            );
            in_flight.remove(&key);
            let Some(schedule) = schedules.get_mut(&key) else {
                return;
            };
            let expect_battery = cfg!(windows) && self.target.kind == "rc003";
            let retry = schedule.complete(&self.info, expect_battery, Instant::now());
            self.info.status = if self.info.error.is_none() {
                "ready"
            } else if retry {
                "retrying"
            } else {
                "error"
            }
            .into();
        }
        self.info.updated_at = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        apply_information(shared, &self.target, self.info);
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub(super) fn start(shared: Arc<Shared>) {
    thread::spawn(move || run(shared, start_reading));
}

#[cfg(any(windows, target_os = "macos", test))]
fn run(
    shared: Arc<Shared>,
    start_reading: impl Fn(Vec<Discovered>, Vec<Discovered>, Arc<Shared>, mpsc::Sender<Reading>),
) {
    let mut schedules = HashMap::<ReadingKey, Schedule>::new();
    let mut in_flight = HashSet::new();
    let (sender, receiver) = mpsc::channel::<Reading>();
    let mut next_reading = None;
    while !shared.stop.load(Ordering::Acquire) {
        let targets: Vec<_> = shared
            .snapshot
            .lock()
            .unwrap()
            .discovered
            .iter()
            .filter(|d| {
                crate::devices::descriptor_registry::voice_engine(&d.kind).is_some()
                    && d.connected
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
        for reading in next_reading.take().into_iter().chain(receiver.try_iter()) {
            reading.apply(&shared, &mut schedules, &mut in_flight);
        }
        let due: Vec<_> = targets
            .iter()
            .filter(|target| {
                let key = (target.id.clone(), target.bluetooth_address.clone().unwrap());
                !in_flight.contains(&key) && schedules.entry(key).or_default().due(Instant::now())
            })
            .cloned()
            .collect();
        if !due.is_empty() {
            // macOS shares discovery while streaming each matched device.
            let can_start = !cfg!(target_os = "macos") || in_flight.is_empty();
            if can_start {
                for target in &due {
                    in_flight
                        .insert((target.id.clone(), target.bluetooth_address.clone().unwrap()));
                }
                start_reading(due, targets, shared.clone(), sender.clone());
            }
        }
        next_reading = receiver.recv_timeout(Duration::from_millis(250)).ok();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InformationUpdate {
    id: String,
    bluetooth_address: Option<String>,
    device_info: DeviceInformation,
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
    let fresh_battery = info.battery_level;
    let previous = &device.device_info;
    info.bluetooth_name = info
        .bluetooth_name
        .or_else(|| previous.bluetooth_name.clone());
    info.battery_level = fresh_battery.or(previous.battery_level);
    info.manufacturer = info.manufacturer.or_else(|| previous.manufacturer.clone());
    info.serial_number = info
        .serial_number
        .or_else(|| previous.serial_number.clone());
    info.hardware_revision = info
        .hardware_revision
        .or_else(|| previous.hardware_revision.clone());
    info.firmware_revision = info
        .firmware_revision
        .or_else(|| previous.firmware_revision.clone());
    info.software_revision = info
        .software_revision
        .or_else(|| previous.software_revision.clone());
    // A battery-only update must not select the software-version fallback model.
    info.detected_kind = if info.software_revision.is_some() || info.status == "ready" {
        kind_for_software(device.kind.as_str(), info.software_revision.as_deref())
            .map(str::to_owned)
    } else {
        previous.detected_kind.clone()
    };
    device.device_info = info;
    let update = InformationUpdate {
        id: device.id.clone(),
        bluetooth_address: device.bluetooth_address.clone(),
        device_info: device.device_info.clone(),
    };
    drop(snapshot);
    if let Some(app) = shared.app.lock().unwrap().as_ref() {
        let _ = app.emit("axonkey-device-information", update);
    }
    if let (Some(address), Some(level)) = (target.bluetooth_address.as_deref(), fresh_battery) {
        let mut cache = shared.battery_cache.lock().unwrap();
        if let Err(error) = cache.remember(&shared.path, address, level) {
            log::warn!("无法保存设备电量缓存：{error}");
        }
    }
}

pub(super) fn retain_readings(
    discovered: &mut [Discovered],
    previous: &[Discovered],
    cache: &BatteryCache,
) {
    for device in discovered {
        if device.connected && device.identity_quality != "ambiguous" {
            if let Some(old) = previous.iter().find(|old| {
                old.connected
                    && old.identity_quality != "ambiguous"
                    && old.id == device.id
                    && old.bluetooth_address == device.bluetooth_address
            }) {
                device.device_info = old.device_info.clone();
            }
            if device.device_info.battery_level.is_none() {
                device.device_info.battery_level = device
                    .bluetooth_address
                    .as_deref()
                    .and_then(|address| cache.level(address));
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
fn read(
    target: &Discovered,
    stop: &std::sync::atomic::AtomicBool,
    mut publish: impl FnMut(&DeviceInformation),
) -> DeviceInformation {
    use windows::Devices::Bluetooth::BluetoothLEDevice;
    let mut info = DeviceInformation::default();
    let _apartment = match crate::windows_runtime::initialize_mta() {
        Ok(apartment) => apartment,
        Err(error) => {
            info.error = Some(error.to_string());
            return info;
        }
    };
    let request = crate::windows_runtime::BluetoothRequest::new(READ_TIMEOUT, Some(stop));
    let result = (|| -> Result<(), ReadError> {
        let address = u64::from_str_radix(
            &target.bluetooth_address.as_ref().unwrap().replace(':', ""),
            16,
        )
        .map_err(|e| ReadError::Field(e.to_string()))?;
        let device = request.run("打开设备信息连接", || {
            BluetoothLEDevice::FromBluetoothAddressAsync(address)
        })?;
        info.bluetooth_name = device
            .Name()
            .ok()
            .map(|name| name.to_string())
            .filter(|name| !name.is_empty());
        publish(&info);
        let result = read_sequence(&[0x180f, 0x180a], None, |service_id| {
            let characteristics: &[u16] = match service_id {
                0x180f => &[0x2a19],
                0x180a => &[0x2a29, 0x2a25, 0x2a27, 0x2a26, 0x2a28],
                _ => unreachable!(),
            };
            read_service(
                &device,
                service_id,
                characteristics,
                &request,
                &mut info,
                &mut publish,
            )
        });
        let _ = device.Close();
        result
    })();
    info.error = result.err().map(|error| error.to_string());
    info
}

#[cfg(windows)]
fn read_service(
    device: &windows::Devices::Bluetooth::BluetoothLEDevice,
    service_id: u16,
    ids: &[u16],
    request: &crate::windows_runtime::BluetoothRequest<'_>,
    info: &mut DeviceInformation,
    publish: &mut impl FnMut(&DeviceInformation),
) -> Result<(), ReadError> {
    use windows::{
        core::GUID,
        Devices::Bluetooth::{
            BluetoothCacheMode,
            GenericAttributeProfile::{GattOpenStatus, GattSharingMode},
        },
        Storage::Streams::DataReader,
    };
    let uuid = |id: u16| GUID::from_u128(((id as u128) << 96) | 0x0000_1000_8000_00805f9b34fb);
    let services = request.run(
        &format!("发现设备信息服务 {service_id:04X}"),
        || {
            device.GetGattServicesForUuidWithCacheModeAsync(
                uuid(service_id),
                BluetoothCacheMode::Cached,
            )
        },
    )?;
    gatt_status(
        &format!("服务 {service_id:04X}"),
        services.Status()?,
        || services.ProtocolError().and_then(|code| code.Value()),
    )?;
    let services = services.Services()?;
    if services.Size()? == 0 {
        return Ok(());
    }
    let service = services.GetAt(0)?;
    let result = (|| -> Result<(), ReadError> {
        let opened = request.run(
            &format!("打开设备信息服务 {service_id:04X}"),
            || service.OpenAsync(GattSharingMode::SharedReadOnly),
        )?;
        if opened != GattOpenStatus::Success && opened != GattOpenStatus::AlreadyOpened {
            return Err(ReadError::Field(format!(
                "无法共享访问服务 {service_id:04X} ({})",
                opened.0
            )));
        }
        read_fields(ids, info, publish, |id| {
            let chars = request.run(&format!("发现设备信息特征 {id:04X}"), || {
                service.GetCharacteristicsForUuidWithCacheModeAsync(
                    uuid(id),
                    BluetoothCacheMode::Cached,
                )
            })?;
            gatt_status(&format!("特征 {id:04X} 发现"), chars.Status()?, || {
                chars.ProtocolError().and_then(|code| code.Value())
            })?;
            let chars = chars.Characteristics()?;
            if chars.Size()? == 0 {
                return Ok(None);
            }
            let characteristic = chars.GetAt(0)?;
            let value = request.run(&format!("读取设备信息特征 {id:04X}"), || {
                characteristic.ReadValueWithCacheModeAsync(BluetoothCacheMode::Uncached)
            })?;
            gatt_status(&format!("特征 {id:04X} 读取"), value.Status()?, || {
                value.ProtocolError().and_then(|code| code.Value())
            })?;
            let buffer = value.Value()?;
            let mut bytes = vec![0; buffer.Length()? as usize];
            DataReader::FromBuffer(&buffer).and_then(|r| r.ReadBytes(&mut bytes))?;
            Ok(Some(bytes))
        })
    })();
    let _ = service.Close();
    result
}

#[cfg(windows)]
#[derive(Debug)]
enum ReadError {
    Windows(windows::core::Error),
    Field(String),
    Batch(Vec<ReadError>),
}

#[cfg(windows)]
impl ReadError {
    fn terminal(&self) -> bool {
        match self {
            Self::Windows(error) => matches!(error.code().0 as u32, 0x800705b4 | 0x800704c7),
            Self::Field(_) => false,
            Self::Batch(errors) => errors.iter().any(Self::terminal),
        }
    }
}

#[cfg(windows)]
impl From<windows::core::Error> for ReadError {
    fn from(error: windows::core::Error) -> Self {
        Self::Windows(error)
    }
}

#[cfg(windows)]
impl From<String> for ReadError {
    fn from(error: String) -> Self {
        Self::Field(error)
    }
}

#[cfg(windows)]
impl std::fmt::Display for ReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Windows(error) => std::fmt::Display::fmt(error, formatter),
            Self::Field(error) => formatter.write_str(error),
            Self::Batch(errors) => {
                for (index, error) in errors.iter().enumerate() {
                    if index > 0 {
                        formatter.write_str("；")?;
                    }
                    write!(formatter, "{error}")?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(windows)]
fn read_sequence(
    ids: &[u16],
    optional: Option<u16>,
    mut read: impl FnMut(u16) -> Result<(), ReadError>,
) -> Result<(), ReadError> {
    let mut errors = Vec::new();
    for &id in ids {
        if let Err(error) = read(id) {
            let terminal = error.terminal();
            if terminal || Some(id) != optional {
                errors.push(error);
            }
            if terminal {
                break;
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ReadError::Batch(errors))
    }
}

#[cfg(windows)]
fn read_fields(
    ids: &[u16],
    info: &mut DeviceInformation,
    publish: &mut impl FnMut(&DeviceInformation),
    mut read: impl FnMut(u16) -> Result<Option<Vec<u8>>, ReadError>,
) -> Result<(), ReadError> {
    read_sequence(ids, Some(0x2a28), |id| {
        let Some(bytes) = read(id)? else {
            return Ok(());
        };
        match id {
            0x2a19 => info.battery_level = Some(percent(&bytes)?),
            0x2a29 => info.manufacturer = text(&bytes)?,
            0x2a25 => info.serial_number = text(&bytes)?,
            0x2a27 => info.hardware_revision = text(&bytes)?,
            0x2a26 => info.firmware_revision = text(&bytes)?,
            0x2a28 => info.software_revision = text(&bytes)?,
            _ => unreachable!(),
        }
        publish(info);
        Ok(())
    })
}

#[cfg(windows)]
fn gatt_status(
    stage: &str,
    status: windows::Devices::Bluetooth::GenericAttributeProfile::GattCommunicationStatus,
    protocol_error: impl FnOnce() -> windows::core::Result<u8>,
) -> Result<(), ReadError> {
    use windows::Devices::Bluetooth::GenericAttributeProfile::GattCommunicationStatus;
    if status == GattCommunicationStatus::Success {
        return Ok(());
    }
    let name = match status {
        GattCommunicationStatus::Unreachable => "Unreachable",
        GattCommunicationStatus::ProtocolError => "ProtocolError",
        GattCommunicationStatus::AccessDenied => "AccessDenied",
        _ => "Unknown",
    };
    let mut error = format!("{stage}失败：{name} ({})", status.0);
    if status == GattCommunicationStatus::ProtocolError {
        if let Ok(code) = protocol_error() {
            error.push_str(&format!("，ATT 0x{code:02X}"));
        }
    }
    Err(ReadError::Field(error))
}

#[cfg(windows)]
fn start_reading(
    targets: Vec<Discovered>,
    _all_targets: Vec<Discovered>,
    shared: Arc<Shared>,
    sender: mpsc::Sender<Reading>,
) {
    for target in targets {
        let worker_target = target.clone();
        let worker_sender = sender.clone();
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("Axonkey device information".into())
            .spawn(move || {
                let started = Instant::now();
                let mut first_battery = true;
                let info = read(&worker_target, &worker_shared.stop, |info| {
                    if first_battery && info.battery_level.is_some() {
                        first_battery = false;
                        log::info!(target: "axonkey::devices", "Device {} battery read in {} ms", worker_target.id, started.elapsed().as_millis());
                    }
                    let _ = worker_sender.send(Reading {
                        target: worker_target.clone(),
                        info: info.clone(),
                        complete: false,
                    });
                });
                log::info!(target: "axonkey::devices", "Device {} information read in {} ms: {}", worker_target.id, started.elapsed().as_millis(), info.error.as_deref().unwrap_or("ready"));
                let _ = worker_sender.send(Reading {
                    target: worker_target,
                    info,
                    complete: true,
                });
            });
        if let Err(error) = worker {
            let _ = sender.send(Reading {
                target,
                info: DeviceInformation {
                    error: Some(format!("无法启动设备信息读取：{error}")),
                    ..Default::default()
                },
                complete: true,
            });
        }
    }
}

#[cfg(target_os = "macos")]
fn start_reading(
    targets: Vec<Discovered>,
    all_targets: Vec<Discovered>,
    _shared: Arc<Shared>,
    sender: mpsc::Sender<Reading>,
) {
    let failure_targets = targets.clone();
    let failure_sender = sender.clone();
    let worker = thread::Builder::new()
        .name("Axonkey device information".into())
        .spawn(move || read_macos(&targets, &all_targets, sender));
    if let Err(error) = worker {
        for target in failure_targets {
            let _ = failure_sender.send(Reading {
                target,
                info: DeviceInformation {
                    error: Some(format!("无法启动设备信息读取：{error}")),
                    ..Default::default()
                },
                complete: true,
            });
        }
    }
}

#[cfg(target_os = "macos")]
fn read_macos(targets: &[Discovered], all_targets: &[Discovered], sender: mpsc::Sender<Reading>) {
    use std::ffi::{c_char, c_void, CStr, CString};
    unsafe extern "C" {
        fn axonkey_device_information_stream(
            requests: *const c_char,
            context: *mut c_void,
            callback: unsafe extern "C" fn(*mut c_void, usize, *const c_char, bool),
        );
    }
    struct Reader<'a> {
        targets: &'a [Discovered],
        sender: mpsc::Sender<Reading>,
        started: Instant,
        battery_published: HashSet<usize>,
    }
    unsafe extern "C" fn progress(
        context: *mut c_void,
        index: usize,
        value: *const c_char,
        complete: bool,
    ) {
        let reader = unsafe { &mut *(context as *mut Reader<'_>) };
        let Some(target) = reader.targets.get(index) else {
            return;
        };
        let info: Option<DeviceInformation> = if value.is_null() {
            None
        } else {
            serde_json::from_slice(unsafe { CStr::from_ptr(value) }.to_bytes()).ok()
        };
        let info = match info {
            Some(info) => info,
            None if !complete => return,
            None => DeviceInformation {
                error: Some("无法读取设备信息".into()),
                ..Default::default()
            },
        };
        if info.battery_level.is_some() && reader.battery_published.insert(index) {
            log::info!(target: "axonkey::devices", "Device {} battery read in {} ms", target.id, reader.started.elapsed().as_millis());
        }
        if complete {
            log::info!(target: "axonkey::devices", "Device {} information read in {} ms: {}", target.id, reader.started.elapsed().as_millis(), info.error.as_deref().unwrap_or("ready"));
        }
        let _ = reader.sender.send(Reading {
            target: target.clone(),
            info,
            complete,
        });
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
    let mut reader = Reader {
        targets,
        sender,
        started: Instant::now(),
        battery_published: HashSet::new(),
    };
    unsafe {
        axonkey_device_information_stream(
            request.as_ptr(),
            &mut reader as *mut Reader<'_> as *mut c_void,
            progress,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{information_remote, offline_manager};
    use super::*;

    #[cfg(windows)]
    #[test]
    fn terminal_field_error_stops_fields_and_services_without_erasing_progress() {
        use crate::windows_runtime::BluetoothRequest;
        use windows::core::{Error, HRESULT};
        use windows_future::IAsyncOperation;

        let request = BluetoothRequest::new(Duration::from_secs(1), None);
        let mut info = DeviceInformation::default();
        let mut published = Vec::new();
        let mut services = Vec::new();
        let mut fields = Vec::new();
        let result = read_sequence(&[0x180f, 0x180a, 0x1800], None, |service_id| {
            services.push(service_id);
            let ids: &[u16] = if service_id == 0x180f {
                &[0x2a19]
            } else {
                &[0x2a29, 0x2a25, 0x2a27, 0x2a26, 0x2a28]
            };
            read_fields(
                ids,
                &mut info,
                &mut |info| published.push(info.clone()),
                |id| {
                    fields.push(id);
                    if id == 0x2a25 {
                        return Err(ReadError::Field("序列号读取失败".into()));
                    }
                    let value = request.run("test field", || {
                        Ok(IAsyncOperation::ready(match id {
                            0x2a19 => Ok(54u32),
                            0x2a29 => Ok(1),
                            0x2a27 => Err(Error::from_hresult(HRESULT(0x800705b4u32 as i32))),
                            _ => panic!("field started after the request terminated"),
                        }))
                    })?;
                    Ok(Some(if id == 0x2a19 {
                        vec![value as u8]
                    } else {
                        b"Maker".to_vec()
                    }))
                },
            )
        });
        let error = result.unwrap_err();
        assert!(error.terminal());
        let error = error.to_string();
        assert!(error.contains("序列号读取失败"));
        assert_eq!(error.matches("0x800705B4").count(), 1);
        assert_eq!(services, [0x180f, 0x180a]);
        assert_eq!(fields, [0x2a19, 0x2a29, 0x2a25, 0x2a27]);
        assert_eq!(info.battery_level, Some(54));
        assert_eq!(info.manufacturer.as_deref(), Some("Maker"));
        assert_eq!(published.len(), 2);
        assert_eq!(published[0].battery_level, Some(54));
        assert_eq!(published[1].manufacturer.as_deref(), Some("Maker"));
    }

    #[cfg(windows)]
    #[test]
    fn real_request_deadline_stops_the_production_field_sequence() {
        use crate::windows_runtime::BluetoothRequest;
        use windows_future::IAsyncOperation;

        let request = BluetoothRequest::new(Duration::from_millis(100), None);
        let mut info = DeviceInformation::default();
        let mut fields = Vec::new();
        let (resume, paused) = mpsc::channel();
        let mut paused = Some(paused);
        let error = read_fields(&[0x2a19, 0x2a29, 0x2a25], &mut info, &mut |_| {}, |id| {
            fields.push(id);
            let value = request.run("field", || {
                Ok(if id == 0x2a19 {
                    IAsyncOperation::ready(Ok(0u8))
                } else {
                    assert_eq!(id, 0x2a29, "must not initiate fields after timeout");
                    let paused = paused.take().unwrap();
                    IAsyncOperation::spawn(move || {
                        paused.recv().unwrap();
                        Ok(1u8)
                    })
                })
            })?;
            Ok(Some(vec![value]))
        })
        .unwrap_err();
        resume.send(()).unwrap();
        assert!(error.terminal());
        assert_eq!(fields, [0x2a19, 0x2a29]);
        assert_eq!(info.battery_level, Some(0));
    }

    #[cfg(windows)]
    #[test]
    fn optional_software_errors_do_not_hide_request_timeout_or_cancellation() {
        use crate::windows_runtime::BluetoothRequest;
        use windows::core::{Error, HRESULT};
        use windows_future::IAsyncOperation;

        for code in [0x80070005u32, 0x800705b4, 0x800704c7] {
            let request = BluetoothRequest::new(Duration::from_secs(1), None);
            let mut info = DeviceInformation::default();
            let mut fields = Vec::new();
            let result = read_fields(&[0x2a28, 0x2a26], &mut info, &mut |_| {}, |id| {
                fields.push(id);
                request.run::<u32>("software", || {
                    Ok(IAsyncOperation::ready(if id == 0x2a28 {
                        Err(Error::from_hresult(HRESULT(code as i32)))
                    } else {
                        Ok(1)
                    }))
                })?;
                Ok(Some(b"FW1".to_vec()))
            });
            if code == 0x80070005 {
                assert!(
                    result.is_ok(),
                    "ordinary optional failure must stay optional"
                );
                assert_eq!(fields, [0x2a28, 0x2a26]);
                assert_eq!(info.firmware_revision.as_deref(), Some("FW1"));
            } else {
                assert!(result.unwrap_err().terminal());
                assert_eq!(fields, [0x2a28]);
                assert!(info.firmware_revision.is_none());
            }
            assert!(info.software_revision.is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn gatt_diagnostics_distinguish_unreachable_and_att_protocol_errors() {
        use windows::Devices::Bluetooth::GenericAttributeProfile::GattCommunicationStatus;
        assert!(
            gatt_status("read", GattCommunicationStatus::Success, || panic!(
                "no protocol error"
            ))
            .is_ok()
        );
        for (status, name) in [
            (GattCommunicationStatus::Unreachable, "Unreachable (1)"),
            (GattCommunicationStatus::AccessDenied, "AccessDenied (3)"),
        ] {
            let error = gatt_status("特征 2A19 读取", status, || {
                panic!("not a protocol error")
            })
            .unwrap_err();
            assert!(!error.terminal());
            assert!(error.to_string().contains(name));
        }
        let error = gatt_status(
            "特征 2A19 读取",
            GattCommunicationStatus::ProtocolError,
            || Ok(0x0a),
        )
        .unwrap_err();
        assert!(error.to_string().contains("ProtocolError (2)，ATT 0x0A"));
    }

    #[test]
    fn refresh_received_during_a_read_reuses_its_completion() {
        let manager = offline_manager(vec![]);
        let remote = information_remote("one", "AA:BB:CC:DD:EE:01");
        let shared = manager.shared.clone();
        shared.snapshot.lock().unwrap().discovered = vec![remote.clone()];
        let (started, requests) = mpsc::channel();
        let (resume, paused) = mpsc::channel();
        let worker_shared = shared.clone();
        let worker = thread::spawn(move || {
            let first = std::cell::Cell::new(true);
            run(worker_shared, |targets, _, _, sender| {
                started.send((targets, sender)).unwrap();
                if first.replace(false) {
                    paused.recv().unwrap();
                }
            });
        });
        let (_, sender) = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        manager.refresh_information(&remote.id).unwrap();
        sender
            .send(Reading {
                target: remote,
                info: DeviceInformation::default(),
                complete: true,
            })
            .unwrap();
        resume.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while manager.snapshot().discovered[0].device_info.status != "ready" {
            assert!(Instant::now() < deadline, "reading did not complete");
            thread::sleep(Duration::from_millis(2));
        }
        let duplicate = requests.recv_timeout(Duration::from_millis(50));
        shared.stop.store(true, Ordering::Release);
        worker.join().unwrap();
        assert!(
            duplicate.is_err(),
            "refresh queued a duplicate read after completion"
        );
    }

    #[test]
    fn scheduler_publishes_progress_while_another_read_is_still_in_flight() {
        let manager = offline_manager(vec![]);
        let slow = information_remote("slow", "AA:BB:CC:DD:EE:01");
        let fast = information_remote("fast", "AA:BB:CC:DD:EE:02");
        let shared = manager.shared.clone();
        shared.snapshot.lock().unwrap().discovered = vec![slow.clone(), fast.clone()];
        let (started, requests) = mpsc::channel();
        let worker_shared = shared.clone();
        let worker = thread::spawn(move || {
            run(worker_shared, |targets, _, _, sender| {
                started.send((targets, sender)).unwrap();
            });
        });
        let (targets, sender) = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(targets.len(), 2);
        for (target, complete, level) in [(slow.clone(), false, 54), (fast, true, 100)] {
            sender
                .send(Reading {
                    target,
                    info: DeviceInformation {
                        battery_level: Some(level),
                        ..Default::default()
                    },
                    complete,
                })
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let snapshot = manager.snapshot();
            if snapshot.discovered[0].device_info.battery_level == Some(54)
                && snapshot.discovered[1].device_info.status == "ready"
            {
                assert_eq!(snapshot.discovered[0].device_info.status, "pending");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "scheduler waited for the unfinished device"
            );
            thread::sleep(Duration::from_millis(2));
        }
        manager.refresh_information(&slow.id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !shared.information_requests.lock().unwrap().is_empty() {
            assert!(
                Instant::now() < deadline,
                "scheduler stopped handling refresh requests"
            );
            thread::sleep(Duration::from_millis(2));
        }
        assert!(
            requests.try_recv().is_err(),
            "refresh duplicated an in-flight read"
        );
        shared.stop.store(true, Ordering::Release);
        worker.join().unwrap();
        fs::remove_file(shared.path.with_extension("battery.json")).unwrap();
    }

    #[test]
    fn partial_fields_and_completed_devices_publish_without_waiting_for_other_devices() {
        let manager = offline_manager(vec![]);
        let slow = information_remote("slow", "AA:BB:CC:DD:EE:01");
        let fast = information_remote("fast", "AA:BB:CC:DD:EE:02");
        let shared = &manager.shared;
        shared.snapshot.lock().unwrap().discovered = vec![slow.clone(), fast.clone()];
        let slow_key = (slow.id.clone(), slow.bluetooth_address.clone().unwrap());
        let fast_key = (fast.id.clone(), fast.bluetooth_address.clone().unwrap());
        let mut schedules = HashMap::from([
            (slow_key.clone(), Schedule::default()),
            (fast_key.clone(), Schedule::default()),
        ]);
        let mut in_flight = HashSet::from([slow_key.clone(), fast_key.clone()]);
        Reading {
            target: slow.clone(),
            info: DeviceInformation {
                battery_level: Some(0),
                manufacturer: Some("Maker".into()),
                ..Default::default()
            },
            complete: false,
        }
        .apply(shared, &mut schedules, &mut in_flight);
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.discovered[0].device_info.battery_level, Some(0));
        assert_eq!(snapshot.discovered[0].device_info.status, "pending");
        assert_eq!(snapshot.discovered[0].device_info.detected_kind, None);
        assert!(schedules[&slow_key].next.is_none());
        assert_eq!(in_flight.len(), 2);

        Reading {
            target: fast,
            info: DeviceInformation {
                battery_level: Some(100),
                software_revision: Some("CMIOT3_B311".into()),
                ..Default::default()
            },
            complete: true,
        }
        .apply(shared, &mut schedules, &mut in_flight);
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.discovered[0].device_info.status, "pending");
        assert_eq!(snapshot.discovered[1].device_info.status, "ready");
        assert_eq!(snapshot.discovered[1].device_info.battery_level, Some(100));
        assert_eq!(
            snapshot.discovered[1].device_info.detected_kind.as_deref(),
            Some("cmiotA15")
        );
        assert_eq!(in_flight, HashSet::from([slow_key.clone()]));
        assert!(schedules[&fast_key].next.is_some());

        Reading {
            target: slow,
            info: DeviceInformation {
                error: Some("读取固件版本超时".into()),
                ..Default::default()
            },
            complete: true,
        }
        .apply(shared, &mut schedules, &mut in_flight);
        let snapshot = manager.snapshot();
        let info = &snapshot.discovered[0].device_info;
        assert_eq!(info.status, "retrying");
        assert_eq!(info.battery_level, Some(0));
        assert_eq!(info.manufacturer.as_deref(), Some("Maker"));
        assert_eq!(info.error.as_deref(), Some("读取固件版本超时"));
        assert!(info.updated_at.is_some());
        assert!(in_flight.is_empty());
        assert_eq!(schedules[&slow_key].retries, 1);
        fs::remove_file(shared.path.with_extension("battery.json")).unwrap();
    }

    #[test]
    fn incremental_updates_preserve_details_and_do_not_erase_detected_model_on_failure() {
        let manager = offline_manager(vec![]);
        let remote = information_remote("one", "AA:BB:CC:DD:EE:01");
        let shared = &manager.shared;
        shared.snapshot.lock().unwrap().discovered = vec![remote.clone()];
        apply_information(
            shared,
            &remote,
            DeviceInformation {
                status: "ready".into(),
                bluetooth_name: Some("Remote".into()),
                manufacturer: Some("Maker".into()),
                serial_number: Some("Serial".into()),
                hardware_revision: Some("HW1".into()),
                firmware_revision: Some("FW1".into()),
                software_revision: Some("XFRSD0D_M_R01_761".into()),
                ..Default::default()
            },
        );
        for status in ["pending", "retrying", "error"] {
            apply_information(
                shared,
                &remote,
                DeviceInformation {
                    status: status.into(),
                    error: (status != "pending").then(|| "设备信息读取超时".into()),
                    ..Default::default()
                },
            );
            let snapshot = manager.snapshot();
            let info = &snapshot.discovered[0].device_info;
            assert_eq!(info.status, status);
            assert_eq!(info.bluetooth_name.as_deref(), Some("Remote"));
            assert_eq!(info.manufacturer.as_deref(), Some("Maker"));
            assert_eq!(info.serial_number.as_deref(), Some("Serial"));
            assert_eq!(info.hardware_revision.as_deref(), Some("HW1"));
            assert_eq!(info.firmware_revision.as_deref(), Some("FW1"));
            assert_eq!(info.software_revision.as_deref(), Some("XFRSD0D_M_R01_761"));
            assert_eq!(info.detected_kind.as_deref(), Some("xmBt29"));
        }
    }

    #[test]
    fn reading_completion_after_disconnect_or_address_change_cannot_update_another_device() {
        let manager = offline_manager(vec![]);
        let remote = information_remote("one", "AA:BB:CC:DD:EE:01");
        for (connected, address) in [(false, "AA:BB:CC:DD:EE:01"), (true, "AA:BB:CC:DD:EE:02")] {
            let mut current = remote.clone();
            current.connected = connected;
            current.bluetooth_address = Some(address.into());
            manager.shared.snapshot.lock().unwrap().discovered = vec![current];
            apply_information(
                &manager.shared,
                &remote,
                DeviceInformation {
                    manufacturer: Some("Old remote".into()),
                    ..Default::default()
                },
            );
            assert!(manager.snapshot().discovered[0]
                .device_info
                .manufacturer
                .is_none());
        }
    }

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
        let failed = DeviceInformation {
            error: Some("设备信息读取超时".into()),
            ..Default::default()
        };
        let mut schedule = Schedule::default();
        let mut now = Instant::now();
        assert!(schedule.due(now));
        for retry in [true, true, true, false] {
            assert_eq!(schedule.complete(&failed, false, now), retry);
            let delay = if retry { RETRY } else { REFRESH };
            assert!(!schedule.due(now + delay - Duration::from_millis(1)));
            now += delay;
            assert!(schedule.due(now));
        }
        assert!(schedule.complete(&failed, false, now));
        assert!(!schedule.complete(&DeviceInformation::default(), false, now));
        assert_eq!(schedule.retries, 0);
        assert_eq!(schedule.next, Some(now + REFRESH));
    }

    #[test]
    fn missing_rc003_battery_keeps_refreshing_until_a_value_is_read() {
        let missing_battery = DeviceInformation::default();
        let mut schedule = Schedule::default();
        let mut now = Instant::now();
        for _ in 0..3 {
            assert!(schedule.due(now));
            assert!(schedule.complete(&missing_battery, true, now));
            now += RETRY;
        }
        for _ in 0..2 {
            assert!(schedule.due(now));
            assert!(!schedule.complete(&missing_battery, true, now));
            assert!(!schedule.due(now + MISSING_BATTERY_REFRESH - Duration::from_millis(1)));
            now += MISSING_BATTERY_REFRESH;
        }

        let battery_read = DeviceInformation {
            battery_level: Some(0),
            ..Default::default()
        };
        assert!(schedule.due(now));
        assert!(!schedule.complete(&battery_read, true, now));
        assert_eq!(schedule.next, Some(now + REFRESH));
        assert_eq!(schedule.retries, 0);
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
        for device in &mut next {
            device.device_info = DeviceInformation::default();
        }
        let cache = BatteryCache::default();
        retain_readings(&mut next, &previous, &cache);
        assert_eq!(next[0].device_info.battery_level, Some(100));
        assert_eq!(next[1].device_info.battery_level, Some(0));
        next[0].connected = false;
        next[1].identity_quality = "ambiguous".into();
        retain_readings(&mut next, &previous, &cache);
        assert!(next.iter().all(|d| d.device_info.battery_level.is_none()));
    }
}
