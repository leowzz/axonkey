//! Physical-device ownership and input lifetime live here, independently of the editor window.
mod gesture;
mod paired;
#[cfg(target_os = "macos")]
mod remote;
mod report;
use super::{NativeBehavior, ProfileDirection, TriggerBehaviors};
use gesture::Gestures;
use hidapi::{HidApi, HidDevice};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub behaviors: serde_json::Value,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub binding: Option<String>,
    #[serde(default)]
    pub binding_quality: Option<String>,
    #[serde(default)]
    pub binding_pairing_id: Option<String>,
    #[serde(default)]
    pub voice_output_device: Option<String>,
    pub enabled: bool,
    pub profiles: Vec<Profile>,
    pub active_profile_id: String,
    #[serde(default)]
    pub legacy_profiles_migrated: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub version: u32,
    pub revision: u64,
    pub instances: Vec<Instance>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            instances: vec![],
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub transport: String,
    pub identity_quality: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub connected: bool,
    pub paired: bool,
    pub pairing_id: Option<String>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub error: Option<String>,
    pub reports: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub store: Store,
    pub discovered: Vec<Discovered>,
    pub runtime: BTreeMap<String, RuntimeStatus>,
    pub error: Option<String>,
    pub scan_error: Option<String>,
    pub scanning: bool,
}
struct Shared {
    snapshot: Mutex<Snapshot>,
    path: PathBuf,
    stop: AtomicBool,
    enabled: AtomicBool,
    emit: Box<dyn Fn(InputEvent) + Send + Sync>,
    legacy_remote: Box<dyn Fn(bool) -> bool + Send + Sync>,
}
pub struct DeviceManager {
    shared: Arc<Shared>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}
fn unique_id() -> String {
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    )
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn load(path: &std::path::Path) -> Result<Store, String> {
    let backup = path.with_extension("bak");
    let source_path = if !path.exists() && backup.exists() {
        backup.as_path()
    } else {
        path
    };
    if !source_path.exists() {
        return Ok(Store::default());
    }
    let store: Store =
        serde_json::from_slice(&std::fs::read(source_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("设备配置无法读取，已保留原文件：{e}"))?;
    if store.version != 1 {
        return Err("设备配置版本不受支持，已保留原文件".into());
    }
    validate(&store)?;
    Ok(store)
}
fn save(path: &std::path::Path, store: &Store) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if path.exists() {
        if backup.exists() {
            std::fs::remove_file(&backup).map_err(|e| e.to_string())?;
        }
        std::fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::rename(&backup, path);
        return Err(error.to_string());
    }
    Ok(())
}
fn validate(store: &Store) -> Result<(), String> {
    if store.instances.len() > 256 {
        return Err("设备数量超过上限".into());
    }
    let mut ids = HashSet::new();
    let mut bindings = HashSet::new();
    let mut pairing_ids = HashSet::new();
    for instance in &store.instances {
        if !ids.insert(&instance.id) || instance.id.is_empty() {
            return Err("设备实例 ID 重复或为空".into());
        }
        if !["xboxBluetooth", "rc003", "cmiotA15"].contains(&instance.kind.as_str()) {
            return Err("未知设备支持包".into());
        }
        if instance.name.trim().is_empty() || instance.name.len() > 200 {
            return Err("请填写有效的设备名称".into());
        }
        if let Some(binding) = &instance.binding {
            if !bindings.insert(binding) {
                return Err("该物理设备已经绑定其他实例".into());
            }
            if let Some(pairing_id) = &instance.binding_pairing_id {
                if !pairing_ids.insert(pairing_id) {
                    return Err("同一物理设备不能重复绑定".into());
                }
            }
        }
        if instance.profiles.is_empty()
            || instance.profiles.len() > 64
            || !instance
                .profiles
                .iter()
                .any(|p| p.id == instance.active_profile_id)
        {
            return Err("设备配置文件无效".into());
        }
        let mut profiles = HashSet::new();
        for profile in &instance.profiles {
            if profile.id.is_empty()
                || !profiles.insert(&profile.id)
                || profile.name.trim().is_empty()
            {
                return Err("配置文件名称或 ID 无效".into());
            }
            let maps: HashMap<String, TriggerBehaviors> =
                serde_json::from_value(profile.behaviors.clone())
                    .map_err(|e| format!("映射无效：{e}"))?;
            #[cfg(target_os = "macos")]
            super::macos::validate_settings(&super::NativeSettings {
                behaviors: maps.clone(),
                ..Default::default()
            })?;
            #[cfg(windows)]
            super::windows::validate_settings(&super::NativeSettings {
                behaviors: maps.clone(),
                ..Default::default()
            })?;
            for (input, mapping) in &maps {
                let valid = if instance.kind == "xboxBluetooth" {
                    super_input_ids().contains(&input.as_str())
                } else if instance.kind == "rc003" {
                    [
                        "power",
                        "voice",
                        "up",
                        "down",
                        "left",
                        "right",
                        "confirm",
                        "home",
                        "menu",
                        "tv",
                        "back",
                        "volumeUp",
                        "volumeDown",
                    ]
                    .contains(&input.as_str())
                } else {
                    input.starts_with("cmiotA15.")
                };
                if !valid || mapping.iter().count() > 256 {
                    return Err(format!("设备不支持此输入或序列过长：{input}"));
                }
            }
        }
    }
    Ok(())
}
fn super_input_ids() -> &'static [&'static str] {
    &[
        "xbox.a",
        "xbox.b",
        "xbox.x",
        "xbox.y",
        "xbox.lb",
        "xbox.rb",
        "xbox.lt",
        "xbox.rt",
        "xbox.view",
        "xbox.menu",
        "xbox.guide",
        "xbox.ls",
        "xbox.rs",
        "xbox.dpad.up",
        "xbox.dpad.down",
        "xbox.dpad.left",
        "xbox.dpad.right",
        "xbox.ls.up",
        "xbox.ls.down",
        "xbox.ls.left",
        "xbox.ls.right",
        "xbox.rs.up",
        "xbox.rs.down",
        "xbox.rs.left",
        "xbox.rs.right",
    ]
}
impl DeviceManager {
    pub fn start(app: tauri::AppHandle, path: PathBuf) -> Self {
        #[cfg(target_os = "macos")]
        let ownership_app = app.clone();
        Self::start_with_callbacks(
            path,
            Box::new(move |event| {
                let _ = app.emit("axonkey-device-input", event);
            }),
            Box::new(move |owned| {
                #[cfg(target_os = "macos")]
                {
                    ownership_app
                        .state::<super::InputService>()
                        .set_managed_remote_owned(owned)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = owned;
                    true
                }
            }),
        )
    }
    #[cfg(test)]
    fn start_with_emitter(path: PathBuf, emit: Box<dyn Fn(InputEvent) + Send + Sync>) -> Self {
        Self::start_with_callbacks(path, emit, Box::new(|_| true))
    }
    fn start_with_callbacks(
        path: PathBuf,
        emit: Box<dyn Fn(InputEvent) + Send + Sync>,
        legacy_remote: Box<dyn Fn(bool) -> bool + Send + Sync>,
    ) -> Self {
        let (store, error) = match load(&path) {
            Ok(store) => (store, None),
            Err(error) => (Store::default(), Some(error)),
        };
        let shared = Arc::new(Shared {
            snapshot: Mutex::new(Snapshot {
                store,
                discovered: vec![],
                runtime: BTreeMap::new(),
                error,
                scan_error: None,
                scanning: true,
            }),
            path,
            stop: AtomicBool::new(false),
            enabled: AtomicBool::new(false),
            emit,
            legacy_remote,
        });
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("Axonkey devices".into())
            .spawn(move || run(worker_shared));
        let worker = match worker {
            Ok(worker) => Some(worker),
            Err(error) => {
                shared.snapshot.lock().unwrap().error = Some(error.to_string());
                None
            }
        };
        Self {
            shared,
            worker: Mutex::new(worker),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.shared.snapshot.lock().unwrap().clone()
    }
    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
    pub fn set_enabled(&self, enabled: bool) {
        self.shared.enabled.store(enabled, Ordering::Release);
    }
    /// Compare-and-swap prevents a stale editor from overwriting a hardware profile switch.
    pub fn put(&self, revision: u64, mut instance: Instance) -> Result<Snapshot, String> {
        let mut snapshot = self.shared.snapshot.lock().unwrap();
        if let Some(error) = &snapshot.error {
            return Err(error.clone());
        }
        if revision != snapshot.store.revision {
            return Err("配置已经变化，请重试本次修改".into());
        }
        let old = snapshot
            .store
            .instances
            .iter()
            .find(|i| i.id == instance.id);
        if let Some(old) = old {
            if old.kind != instance.kind {
                return Err("不能更改已有实例的设备支持包".into());
            }
            if old.binding == instance.binding {
                instance.binding_quality = old.binding_quality.clone();
                instance.binding_pairing_id = old.binding_pairing_id.clone();
            }
        }
        if instance.binding != old.and_then(|i| i.binding.clone()) {
            if let Some(binding) = &instance.binding {
                let device = snapshot
                    .discovered
                    .iter()
                    .find(|d| &d.id == binding)
                    .ok_or("设备已经离线，请重新扫描")?;
                if device.identity_quality == "ambiguous" {
                    return Err("设备标识冲突，不能确定目标实物".into());
                }
                instance.binding_quality = Some(device.identity_quality.clone());
                instance.binding_pairing_id = device.pairing_id.clone();
                if device.kind != instance.kind {
                    return Err("设备与支持包不匹配".into());
                }
            }
        }
        if instance.binding.is_none() {
            instance.binding_quality = None;
            instance.binding_pairing_id = None;
        }
        if instance.id.is_empty() {
            instance.id = unique_id();
        }
        let mut next = snapshot.store.clone();
        if let Some(current) = next.instances.iter_mut().find(|i| i.id == instance.id) {
            *current = instance;
        } else {
            next.instances.push(instance);
        }
        validate(&next)?;
        next.revision += 1;
        save(&self.shared.path, &next)?;
        snapshot.store = next;
        Ok(snapshot.clone())
    }
    pub fn remove(&self, revision: u64, id: &str) -> Result<Snapshot, String> {
        let mut snapshot = self.shared.snapshot.lock().unwrap();
        if snapshot.error.is_some() || revision != snapshot.store.revision {
            return Err("配置已变化或无法读取，请刷新后重试".into());
        }
        let mut next = snapshot.store.clone();
        next.instances.retain(|i| i.id != id);
        next.revision += 1;
        save(&self.shared.path, &next)?;
        snapshot.store = next;
        Ok(snapshot.clone())
    }
}
impl Drop for DeviceManager {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

struct Reader {
    config: Instance,
    device: InputReader,
    values: BTreeMap<String, f64>,
    down: HashSet<String>,
    gestures: Gestures,
    maps: HashMap<String, TriggerBehaviors>,
    actions: SyncSender<Vec<NativeBehavior>>,
    cancel: Arc<AtomicBool>,
    reports: u64,
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputEvent {
    instance_id: String,
    values: BTreeMap<String, f64>,
    pressed: Vec<String>,
}
fn emit(shared: &Shared, id: &str, values: BTreeMap<String, f64>, pressed: Vec<String>) {
    (shared.emit)(InputEvent {
        instance_id: id.into(),
        values,
        pressed,
    });
}

enum InputReader {
    Hid(HidDevice),
    #[cfg(target_os = "macos")]
    Remote(remote::RemoteReader),
}
impl InputReader {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self {
            Self::Hid(device) => device.read(buffer).map_err(|e| e.to_string()),
            #[cfg(target_os = "macos")]
            Self::Remote(device) => device.read(buffer),
        }
    }
}
fn active_mappings(instance: &Instance) -> HashMap<String, TriggerBehaviors> {
    instance
        .profiles
        .iter()
        .find(|p| p.id == instance.active_profile_id)
        .and_then(|p| serde_json::from_value(p.behaviors.clone()).ok())
        .unwrap_or_default()
}

fn open_reader(
    api: &HidApi,
    path: &std::ffi::CStr,
    instance: &Instance,
    shared: &Arc<Shared>,
    cancel: &Arc<AtomicBool>,
) -> Result<InputReader, String> {
    #[cfg(target_os = "macos")]
    if instance.kind == "rc003" {
        let serial = api
            .device_list()
            .find(|info| info.path() == path)
            .and_then(|info| info.serial_number())
            .filter(|s| !s.is_empty())
            .ok_or("此遥控器没有稳定标识，无法按实例拦截")?;
        let settings = super::NativeSettings {
            enabled: true,
            behaviors: active_mappings(instance),
            ..super::NativeSettings::default()
        };
        let current_shared = shared.clone();
        let expected = instance.clone();
        let current_cancel = cancel.clone();
        let switch_shared = shared.clone();
        let id = instance.id.clone();
        return remote::RemoteReader::open(
            serial,
            settings,
            Box::new(move || actions_current(&current_shared, &expected, &current_cancel)),
            Box::new(move |direction, wrap| switch_profile(&switch_shared, &id, direction, wrap)),
        )
        .map(InputReader::Remote);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (shared, cancel);
    #[cfg(windows)]
    if instance.kind == "rc003" {
        return Err("Windows RC003 的按实例驱动适配尚未接入；可继续使用原遥控器工作区".into());
    }
    let device = open(api, path)?;
    device.set_blocking_mode(false).map_err(|e| e.to_string())?;
    Ok(InputReader::Hid(device))
}

fn open(api: &HidApi, path: &std::ffi::CStr) -> Result<HidDevice, String> {
    // Serialize the process-global macOS open mode across managers and diagnostics.
    static OPEN: Mutex<()> = Mutex::new(());
    let _open = OPEN.lock().unwrap();
    #[cfg(target_os = "macos")]
    unsafe {
        unsafe extern "C" {
            fn hid_darwin_set_open_exclusive(exclusive: i32);
        }
        hid_darwin_set_open_exclusive(1);
    }
    let result = api.open_path(path).map_err(|e| e.to_string());
    #[cfg(target_os = "macos")]
    unsafe {
        unsafe extern "C" {
            fn hid_darwin_set_open_exclusive(exclusive: i32);
        }
        hid_darwin_set_open_exclusive(0);
    }
    result
}
fn supported(info: &hidapi::DeviceInfo) -> Option<&'static str> {
    match (
        info.vendor_id(),
        info.product_id(),
        info.usage_page(),
        info.usage(),
    ) {
        (0x045e, 0x02e0, 1, 5) => Some("xboxBluetooth"),
        (0x2717, 0x32b8, 1, 6) => Some("rc003"),
        _ => None,
    }
}
// hidapi's macOS manager is process-global and is scheduled on its creator's
// CFRunLoop. Close it before that worker thread exits, otherwise a later manager
// can dereference the previous thread's released run loop.
struct HidSession {
    _guard: std::sync::MutexGuard<'static, ()>,
}
impl HidSession {
    fn acquire() -> Self {
        static SESSION: Mutex<()> = Mutex::new(());
        Self {
            _guard: SESSION.lock().unwrap_or_else(|e| e.into_inner()),
        }
    }
}
impl Drop for HidSession {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            unsafe extern "C" {
                fn hid_exit() -> i32;
            }
            hid_exit();
        }
    }
}
fn remember_pairing_ids(
    snapshot: &mut Snapshot,
    discovered: &[Discovered],
    path: &std::path::Path,
) {
    if snapshot.error.is_some() {
        return;
    }
    let mut next = snapshot.store.clone();
    let mut changed = false;
    for instance in &mut next.instances {
        if instance.binding_pairing_id.is_some() {
            continue;
        }
        if let Some(device) = discovered.iter().find(|d| {
            Some(&d.id) == instance.binding.as_ref()
                && d.kind == instance.kind
                && d.identity_quality != "ambiguous"
                && d.pairing_id.is_some()
        }) {
            instance.binding_pairing_id = device.pairing_id.clone();
            changed = true;
        }
    }
    if !changed {
        return;
    }
    next.revision += 1;
    match validate(&next).and_then(|_| save(path, &next)) {
        Ok(()) => snapshot.store = next,
        Err(error) => snapshot.error = Some(error),
    }
}

fn run(shared: Arc<Shared>) {
    let _session = HidSession::acquire();
    let mut api = match HidApi::new() {
        Ok(api) => api,
        Err(error) => {
            let mut s = shared.snapshot.lock().unwrap();
            s.scan_error = Some(error.to_string());
            s.scanning = false;
            return;
        }
    };
    let mut readers: HashMap<String, Reader> = HashMap::new();
    let mut failures: HashMap<String, (Instance, String)> = HashMap::new();
    let mut configs = Vec::new();
    let mut config_revision = u64::MAX;
    let mut paths = HashMap::new();
    let mut sessions: HashMap<String, String> = HashMap::new();
    let start = Instant::now();
    let mut next_scan = Instant::now();
    let mut next_event = Instant::now();
    let mut dirty = HashSet::new();
    // OS Bluetooth inventory queries can be slow. Keep them off the HID read loop.
    let (pair_tx, pair_rx) = sync_channel(1);
    let pair_shared = shared.clone();
    thread::spawn(move || {
        while !pair_shared.stop.load(Ordering::Acquire) {
            if pair_tx.send(paired::scan()).is_err() {
                break;
            }
            for _ in 0..50 {
                if pair_shared.stop.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    });
    let mut paired_devices = vec![];
    let mut pairing_error = None;
    while !shared.stop.load(Ordering::Acquire) {
        if let Ok(result) = pair_rx.try_recv() {
            match result {
                Ok(devices) => {
                    paired_devices = devices;
                    pairing_error = None;
                }
                // A failed query is not evidence that the user unpaired every device.
                Err(error) => pairing_error = Some(error),
            }
            next_scan = Instant::now();
        }
        let scanning = Instant::now() >= next_scan;
        if scanning {
            next_scan = Instant::now() + Duration::from_secs(2);
            let result = api.refresh_devices();
            let mut discovered = vec![];
            let mut seen_paths = HashSet::new();
            let mut next_paths = HashMap::new();
            let stored = shared.snapshot.lock().unwrap().store.instances.clone();
            let bindings: HashSet<String> =
                stored.iter().filter_map(|i| i.binding.clone()).collect();
            let pairing_bindings: HashMap<String, String> = stored
                .iter()
                .filter_map(|i| Some((i.binding_pairing_id.clone()?, i.binding.clone()?)))
                .collect();
            if result.is_ok() {
                for info in api.device_list() {
                    let Some(kind) = supported(info) else {
                        continue;
                    };
                    let path = info.path().to_string_lossy().into_owned();
                    seen_paths.insert(path.clone());
                    let serial = info.serial_number().filter(|s| !s.trim().is_empty());
                    let address = paired::hid_address(info);
                    let pairing_id = address.as_ref().map(|address| {
                        paired::identity(
                            kind,
                            info.vendor_id(),
                            info.product_id(),
                            address,
                            &HashSet::new(),
                        )
                    });
                    let legacy_id = serial.map(|serial| {
                        digest(&format!(
                            "{kind}:{}:{}:{serial}",
                            info.vendor_id(),
                            info.product_id()
                        ))
                    });
                    let id = if let Some(id) =
                        pairing_id.as_ref().and_then(|id| pairing_bindings.get(id))
                    {
                        id.clone()
                    } else if let Some(id) = legacy_id.as_ref().filter(|id| bindings.contains(*id))
                    {
                        id.clone()
                    } else if let Some(address) = &address {
                        paired::identity(
                            kind,
                            info.vendor_id(),
                            info.product_id(),
                            address,
                            &bindings,
                        )
                    } else if let Some(id) = legacy_id {
                        id
                    } else {
                        sessions
                            .entry(path.clone())
                            .or_insert_with(|| digest(&unique_id()))
                            .clone()
                    };
                    next_paths.insert(id.clone(), info.path().to_owned());
                    discovered.push(Discovered {
                        id,
                        kind: kind.into(),
                        name: info.product_string().unwrap_or(kind).into(),
                        transport: format!("{:?}", info.bus_type()),
                        identity_quality: if serial.is_some() || address.is_some() {
                            "serial"
                        } else {
                            "session"
                        }
                        .into(),
                        vendor_id: info.vendor_id(),
                        product_id: info.product_id(),
                        connected: true,
                        paired: false,
                        pairing_id,
                    });
                }
                sessions.retain(|path, _| seen_paths.contains(path));
                // Duplicate serials are ambiguous. Do not choose one arbitrarily.
                let mut counts = HashMap::new();
                for d in &discovered {
                    *counts.entry(d.id.clone()).or_insert(0) += 1;
                }
                for d in &mut discovered {
                    if counts[&d.id] > 1 {
                        next_paths.remove(&d.id);
                        d.identity_quality = "ambiguous".into();
                    }
                }
                discovered.dedup_by(|a, b| a.id == b.id);
                paired::merge(
                    &mut discovered,
                    &paired_devices,
                    &bindings,
                    &pairing_bindings,
                );
                paths = next_paths;
            }
            let mut snapshot = shared.snapshot.lock().unwrap();
            snapshot.scanning = false;
            let hid_ok = result.is_ok();
            snapshot.scan_error = result
                .err()
                .map(|e| e.to_string())
                .or_else(|| pairing_error.clone());
            if hid_ok {
                remember_pairing_ids(&mut snapshot, &discovered, &shared.path);
                snapshot.discovered = discovered;
            }
        }
        {
            let snapshot = shared.snapshot.lock().unwrap();
            if config_revision != snapshot.store.revision {
                config_revision = snapshot.store.revision;
                configs = snapshot.store.instances.clone();
            }
        }
        failures.retain(|id, _| configs.iter().any(|i| &i.id == id));
        let enabled = shared.enabled.load(Ordering::Acquire);
        readers.retain(|id, reader| {
            let keep = enabled
                && configs.iter().any(|i| {
                    i == &reader.config
                        && i.enabled
                        && i.binding.as_ref().is_some_and(|b| paths.contains_key(b))
                });
            if !keep {
                emit(&shared, id, BTreeMap::new(), vec![]);
            }
            keep
        });
        // Close removed readers before returning ownership to the legacy service.
        let owns_remote = configs
            .iter()
            .any(|i| i.kind == "rc003" && i.binding.is_some());
        let remote_ready = (shared.legacy_remote)(owns_remote);
        let mut statuses = BTreeMap::new();
        for instance in &configs {
            let mut status = RuntimeStatus::default();
            let path = instance.binding.as_ref().and_then(|id| paths.get(id));
            status.state = if !enabled || !instance.enabled {
                "paused"
            } else if instance.kind == "cmiotA15" {
                "unsupported"
            } else if instance.binding.is_none() {
                "unbound"
            } else if path.is_none() {
                if instance.binding_quality.as_deref() == Some("session") {
                    "needsRebind"
                } else {
                    "disconnected"
                }
            } else {
                "opening"
            }
            .into();
            if status.state == "opening" && !cfg!(target_os = "macos") {
                status.state = "unsupported".into();
                status.error = Some(if instance.kind == "rc003" {
                    "当前平台尚未接入遥控器实例拦截，请使用原遥控器工作区".into()
                } else {
                    "当前平台尚未支持此设备的独占拦截".into()
                });
            }
            if status.state == "opening" && instance.kind == "rc003" && !remote_ready {
                statuses.insert(instance.id.clone(), status);
                continue;
            }
            if status.state == "opening" && !readers.contains_key(&instance.id) {
                // Retry an open error on the next scan, not on every 8 ms tick.
                let retry = scanning
                    || !failures
                        .get(&instance.id)
                        .is_some_and(|(failed, _)| failed == instance);
                if retry {
                    let cancel = Arc::new(AtomicBool::new(false));
                    match open_reader(&api, path.unwrap(), instance, &shared, &cancel) {
                        Ok(device) => {
                            failures.remove(&instance.id);
                            // RC003 executes in its original native service; reports here
                            // only update the instance UI, never dispatch a second action.
                            let maps = if cfg!(target_os = "macos") && instance.kind == "rc003" {
                                HashMap::new()
                            } else {
                                active_mappings(instance)
                            };
                            let (tx, rx) = sync_channel::<Vec<NativeBehavior>>(32);
                            let action_shared = shared.clone();
                            let action_cancel = cancel.clone();
                            let id = instance.id.clone();
                            let expected = instance.clone();
                            thread::spawn(move || {
                                while let Ok(sequence) = rx.recv() {
                                    for behavior in sequence {
                                        if !actions_current(
                                            &action_shared,
                                            &expected,
                                            &action_cancel,
                                        ) {
                                            break;
                                        }
                                        if !behavior.enabled() {
                                            continue;
                                        }
                                        match behavior {
                                            NativeBehavior::Delay { ms, .. } => {
                                                let until = Instant::now()
                                                    + Duration::from_millis(ms.min(300_000));
                                                while Instant::now() < until
                                                    && actions_current(
                                                        &action_shared,
                                                        &expected,
                                                        &action_cancel,
                                                    )
                                                {
                                                    thread::sleep(Duration::from_millis(10));
                                                }
                                            }
                                            NativeBehavior::SwitchProfile {
                                                direction,
                                                wrap,
                                                ..
                                            } => {
                                                switch_profile(
                                                    &action_shared,
                                                    &id,
                                                    direction,
                                                    wrap,
                                                );
                                                break;
                                            }
                                            _ => {
                                                static OUTPUT: Mutex<()> = Mutex::new(());
                                                let _output = OUTPUT.lock().unwrap();
                                                if !actions_current(
                                                    &action_shared,
                                                    &expected,
                                                    &action_cancel,
                                                ) {
                                                    break;
                                                }
                                                #[cfg(target_os = "macos")]
                                                if super::InputService::accessibility_granted() {
                                                    super::macos::execute_behaviors(&[behavior]);
                                                }
                                                #[cfg(windows)]
                                                super::windows::execute_mouse_behavior(
                                                    &behavior, 10,
                                                );
                                            }
                                        }
                                    }
                                }
                            });
                            readers.insert(
                                instance.id.clone(),
                                Reader {
                                    config: instance.clone(),
                                    device,
                                    values: BTreeMap::new(),
                                    down: HashSet::new(),
                                    gestures: Gestures::default(),
                                    maps,
                                    actions: tx,
                                    cancel,
                                    reports: 0,
                                },
                            );
                        }
                        Err(error) => {
                            failures.insert(instance.id.clone(), (instance.clone(), error.clone()));
                            status.state = "error".into();
                            status.error = Some(error);
                        }
                    }
                } else if let Some((_, error)) = failures.get(&instance.id) {
                    status.state = "error".into();
                    status.error = Some(error.clone());
                }
            }
            if let Some(reader) = readers.get_mut(&instance.id) {
                status.state = "exclusive".into();
                let now = start.elapsed().as_millis() as u64;
                let mut sequence = reader.gestures.tick(now, &reader.maps);
                let mut failed = false;
                // Bound work per device so a busy controller cannot starve another instance.
                for _ in 0..32 {
                    let mut buffer = [0u8; 256];
                    match reader.device.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(len) => {
                            reader.reports += 1;
                            if let Some(values) = report::decode(&instance.kind, &buffer[..len]) {
                                for (id, value) in values {
                                    let was_down = reader.down.contains(&id);
                                    let down = report::pressed(value, was_down);
                                    if reader
                                        .values
                                        .get(&id)
                                        .is_none_or(|v| (v - value).abs() > 0.005)
                                    {
                                        dirty.insert(instance.id.clone());
                                    }
                                    reader.values.insert(id.clone(), value);
                                    if down != was_down {
                                        if down {
                                            reader.down.insert(id.clone());
                                        } else {
                                            reader.down.remove(&id);
                                        }
                                        sequence.extend(
                                            reader.gestures.edge(
                                                &id,
                                                down,
                                                now,
                                                reader
                                                    .maps
                                                    .get(&id)
                                                    .unwrap_or(&TriggerBehaviors::default()),
                                            ),
                                        );
                                        dirty.insert(instance.id.clone());
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            status.state = "error".into();
                            failures
                                .insert(instance.id.clone(), (instance.clone(), error.to_string()));
                            status.error = Some(error.to_string());
                            failed = true;
                            break;
                        }
                    }
                }
                status.reports = reader.reports;
                if !failed && !sequence.is_empty() && reader.actions.try_send(sequence).is_err() {
                    status.error = Some("动作队列已满，已丢弃本次动作".into());
                }
                if failed {
                    readers.remove(&instance.id);
                    emit(&shared, &instance.id, BTreeMap::new(), vec![]);
                }
            }
            statuses.insert(instance.id.clone(), status);
        }
        {
            let mut snapshot = shared.snapshot.lock().unwrap();
            for (id, status) in &statuses {
                if snapshot.runtime.get(id).is_none_or(|previous| {
                    previous.state != status.state || previous.error != status.error
                }) {
                    if let Some(error) = &status.error {
                        log::warn!(target: "axonkey::devices", "Instance {id}: {}: {error}", status.state);
                    } else {
                        log::info!(target: "axonkey::devices", "Instance {id}: {}", status.state);
                    }
                }
            }
            snapshot.runtime = statuses;
        }
        if Instant::now() >= next_event {
            next_event = Instant::now() + Duration::from_millis(40);
            for id in dirty.drain() {
                if let Some(reader) = readers.get(&id) {
                    emit(
                        &shared,
                        &id,
                        reader.values.clone(),
                        reader.down.iter().cloned().collect(),
                    );
                }
            }
        }
        thread::sleep(Duration::from_millis(8));
    }
    drop(readers);
    (shared.legacy_remote)(false);
}
fn actions_current(shared: &Shared, expected: &Instance, cancel: &AtomicBool) -> bool {
    !cancel.load(Ordering::Acquire)
        && !shared.stop.load(Ordering::Acquire)
        && shared.enabled.load(Ordering::Acquire)
        && shared
            .snapshot
            .lock()
            .unwrap()
            .store
            .instances
            .iter()
            .any(|instance| instance == expected && instance.enabled)
}
fn switch_profile(shared: &Shared, id: &str, direction: ProfileDirection, wrap: bool) {
    let mut snapshot = shared.snapshot.lock().unwrap();
    let mut next = snapshot.store.clone();
    let Some(instance) = next.instances.iter_mut().find(|i| i.id == id) else {
        return;
    };
    let current = instance
        .profiles
        .iter()
        .position(|p| p.id == instance.active_profile_id)
        .unwrap_or(0);
    let target = match direction {
        ProfileDirection::Next => {
            if current + 1 < instance.profiles.len() {
                current + 1
            } else if wrap {
                0
            } else {
                current
            }
        }
        ProfileDirection::Previous => {
            if current > 0 {
                current - 1
            } else if wrap {
                instance.profiles.len() - 1
            } else {
                current
            }
        }
    };
    if target == current {
        return;
    }
    instance.active_profile_id = instance.profiles[target].id.clone();
    next.revision += 1;
    match save(&shared.path, &next) {
        Ok(()) => snapshot.store = next,
        Err(error) => snapshot.error = Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn instance(id: &str, binding: &str) -> Instance {
        Instance {
            id: id.into(),
            kind: "xboxBluetooth".into(),
            name: id.into(),
            binding: Some(binding.into()),
            binding_quality: Some("serial".into()),
            binding_pairing_id: None,
            voice_output_device: None,
            enabled: true,
            profiles: vec![Profile {
                id: "default".into(),
                name: "默认".into(),
                behaviors: serde_json::json!({}),
            }],
            active_profile_id: "default".into(),
            legacy_profiles_migrated: false,
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires the connected 045e:02e0 controller; captures device input"]
    fn connected_controller_exclusive_read() {
        let _session = HidSession::acquire();
        let api = HidApi::new().unwrap();
        let info = api
            .device_list()
            .find(|d| supported(d) == Some("xboxBluetooth"))
            .expect("Connect the supported Bluetooth controller first");
        eprintln!(
            "controller found: {:04x}:{:04x}, {:?}, stable_identity={}",
            info.vendor_id(),
            info.product_id(),
            info.bus_type(),
            info.serial_number().is_some()
        );
        let device = open(&api, info.path()).unwrap();
        let until = Instant::now() + Duration::from_secs(8);
        let mut reports = 0;
        let mut decoded = 0;
        let mut inputs = HashSet::new();
        while Instant::now() < until {
            let mut buffer = [0; 256];
            let count = device.read_timeout(&mut buffer, 100).unwrap();
            if count == 0 {
                continue;
            }
            reports += 1;
            if let Some(values) = report::decode("xboxBluetooth", &buffer[..count]) {
                decoded += 1;
                for (key, value) in values {
                    if value > 0.55 {
                        inputs.insert(key);
                    }
                }
            }
        }
        eprintln!("exclusive HID reports={reports}, decoded={decoded}, active_inputs={inputs:?}");
        assert!(
            decoded > 0,
            "Move a stick while running this hardware check"
        );
    }
    fn await_state(manager: &DeviceManager, test: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let until = Instant::now() + Duration::from_secs(6);
        loop {
            let snapshot = manager.snapshot();
            if test(&snapshot) {
                return snapshot;
            }
            assert!(
                Instant::now() < until,
                "manager condition timed out: {}",
                serde_json::to_string(&snapshot.runtime).unwrap()
            );
            thread::sleep(Duration::from_millis(30));
        }
    }
    #[test]
    #[ignore = "requires a connected controller; temporary empty mappings; no output injection"]
    fn connected_controller_binding_lifecycle() {
        let path = std::env::temp_dir().join(format!("axonkey-lifecycle-{}.json", unique_id()));
        let manager = DeviceManager::start_with_emitter(path.clone(), Box::new(|_| {}));
        let snapshot = await_state(&manager, |s| !s.scanning);
        let physical = snapshot
            .discovered
            .iter()
            .find(|d| d.kind == "xboxBluetooth" && d.connected)
            .expect("Connect controller");
        let binding = physical.id.clone();
        let first = instance("test-controller", &binding);
        let saved = manager.put(0, first.clone()).unwrap();
        assert!(
            manager.put(0, first.clone()).is_err(),
            "stale editor must not overwrite config"
        );
        assert!(
            manager
                .put(saved.store.revision, instance("duplicate", &binding))
                .is_err(),
            "one physical device cannot be owned twice"
        );
        manager.set_enabled(true);
        let reading = await_state(&manager, |s| {
            s.runtime
                .get(&first.id)
                .is_some_and(|r| r.state == "exclusive" && r.reports > 10)
        });
        eprintln!(
            "native manager bound and exclusive, reports={}",
            reading.runtime[&first.id].reports
        );
        let mut paused = first.clone();
        paused.enabled = false;
        let saved = manager.put(reading.store.revision, paused).unwrap();
        await_state(&manager, |s| {
            s.runtime
                .get(&first.id)
                .is_some_and(|r| r.state == "paused")
        });
        let restored = manager.put(saved.store.revision, first.clone()).unwrap();
        await_state(&manager, |s| {
            s.runtime
                .get(&first.id)
                .is_some_and(|r| r.state == "exclusive" && r.reports > 10)
        });
        manager.shutdown();
        let manager = DeviceManager::start_with_emitter(path.clone(), Box::new(|_| {}));
        manager.set_enabled(true);
        await_state(&manager, |s| {
            s.runtime
                .get(&first.id)
                .is_some_and(|r| r.state == "exclusive" && r.reports > 10)
        });
        let removed = manager.remove(restored.store.revision, &first.id).unwrap();
        assert!(removed.store.instances.is_empty());
        await_state(&manager, |s| s.runtime.is_empty());
        manager.shutdown();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("bak"));
        eprintln!("verified bind, duplicate rejection, stale revision rejection, pause, resume, persisted restart, removal");
    }
    #[test]
    #[ignore = "requires a supported paired device; read-only inventory"]
    fn paired_devices_in_native_snapshot() {
        let path =
            std::env::temp_dir().join(format!("axonkey-paired-snapshot-{}.json", unique_id()));
        let manager = DeviceManager::start_with_emitter(path, Box::new(|_| {}));
        let snapshot = await_state(&manager, |s| s.discovered.iter().any(|d| d.paired));
        manager.shutdown();
        eprintln!(
            "PAIRED_SNAPSHOT={}",
            serde_json::to_string(&snapshot).unwrap()
        );
        assert!(snapshot.store.instances.is_empty());
        let mut identities = HashSet::new();
        for device in &snapshot.discovered {
            if let Some(pairing_id) = &device.pairing_id {
                assert!(
                    identities.insert(pairing_id),
                    "HID and pairing records must share one card"
                );
            }
        }
        assert!(
            snapshot.runtime.is_empty(),
            "listing paired devices must not start input sessions"
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires a connected RC003; temporarily blocks its keys without injecting actions"]
    fn connected_remote_legacy_handoff() {
        eprintln!(
            "native permissions: input={}, accessibility={}",
            super::super::InputService::input_monitoring_granted(),
            super::super::InputService::accessibility_granted()
        );
        let legacy = Arc::new(super::super::InputService::start());
        thread::sleep(Duration::from_millis(500));
        let ownership = legacy.clone();
        let path = std::env::temp_dir().join(format!("axonkey-handoff-{}.json", unique_id()));
        let manager = DeviceManager::start_with_callbacks(
            path.clone(),
            Box::new(|_| {}),
            Box::new(move |owned| ownership.set_managed_remote_owned(owned)),
        );
        let snapshot = await_state(&manager, |s| !s.scanning);
        let physical = snapshot
            .discovered
            .iter()
            .find(|d| d.kind == "rc003" && d.connected)
            .expect("Connect RC003");
        let mut remote = instance("test-remote", &physical.id);
        remote.kind = "rc003".into();
        remote.profiles[0].behaviors = ["power", "voice", "up", "down", "left", "right", "confirm", "home", "menu", "tv", "back", "volumeUp", "volumeDown"].iter().map(|id| (
            (*id).to_string(), serde_json::json!({"click": [{"id": "blocked", "type": "disabled", "enabled": true}], "doubleClick": [], "longPress": []})
        )).collect::<serde_json::Map<String, serde_json::Value>>().into();
        manager
            .put(snapshot.store.revision, remote.clone())
            .unwrap();
        manager.set_enabled(true);
        let opened = await_state(&manager, |s| {
            s.runtime
                .get(&remote.id)
                .is_some_and(|r| r.state == "exclusive" || r.state == "error")
        });
        let status = &opened.runtime[&remote.id];
        eprintln!("remote handoff: {}, error={:?}", status.state, status.error);
        let input_seconds = std::env::var("AXONKEY_TEST_INPUT_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let until = Instant::now() + Duration::from_secs(input_seconds);
        while Instant::now() < until {
            thread::sleep(Duration::from_millis(100));
        }
        let received = manager.snapshot();
        eprintln!(
            "remote reports received: {}",
            received.runtime[&remote.id].reports
        );
        let mut paused = remote.clone();
        paused.enabled = false;
        let saved = manager.put(received.store.revision, paused).unwrap();
        await_state(&manager, |s| s.runtime[&remote.id].state == "paused");
        manager.put(saved.store.revision, remote.clone()).unwrap();
        let reopened = await_state(&manager, |s| {
            matches!(s.runtime[&remote.id].state.as_str(), "exclusive" | "error")
        });
        eprintln!("remote reopened: {}", reopened.runtime[&remote.id].state);
        manager.shutdown();
        drop(manager);
        drop(legacy);
        let _ = std::fs::remove_file(path);
        assert!(
            matches!(status.state.as_str(), "exclusive"),
            "{:?}",
            status.error
        );
        assert!(matches!(
            reopened.runtime[&remote.id].state.as_str(),
            "exclusive"
        ));
        if input_seconds > 0 {
            assert!(
                received.runtime[&remote.id].reports > 0,
                "Press the remote during the capture window"
            );
        }
    }
    fn offline_manager(instances: Vec<Instance>) -> DeviceManager {
        DeviceManager {
            shared: Arc::new(Shared {
                snapshot: Mutex::new(Snapshot {
                    store: Store {
                        instances,
                        ..Store::default()
                    },
                    discovered: vec![],
                    runtime: BTreeMap::new(),
                    error: None,
                    scan_error: None,
                    scanning: false,
                }),
                path: std::env::temp_dir().join(format!("axonkey-offline-{}.json", unique_id())),
                stop: AtomicBool::new(false),
                enabled: AtomicBool::new(true),
                emit: Box::new(|_| {}),
                legacy_remote: Box::new(|_| true),
            }),
            worker: Mutex::new(None),
        }
    }
    #[test]
    fn configuration_change_cancels_only_its_own_pending_actions() {
        let first = instance("first", "a");
        let second = instance("second", "b");
        let manager = offline_manager(vec![first.clone(), second.clone()]);
        let cancel = AtomicBool::new(false);
        assert!(actions_current(&manager.shared, &first, &cancel));
        manager.shared.snapshot.lock().unwrap().store.instances[0].enabled = false;
        assert!(!actions_current(&manager.shared, &first, &cancel));
        assert!(actions_current(&manager.shared, &second, &cancel));
        cancel.store(true, Ordering::Release);
        assert!(!actions_current(&manager.shared, &second, &cancel));
    }
    #[test]
    fn bindings_validate_identity_and_preserve_server_owned_quality() {
        let manager = offline_manager(vec![]);
        let mut discovered = Discovered {
            id: "a".into(),
            kind: "xboxBluetooth".into(),
            name: "controller".into(),
            transport: "Bluetooth".into(),
            identity_quality: "ambiguous".into(),
            vendor_id: 0x045e,
            product_id: 0x02e0,
            connected: true,
            paired: false,
            pairing_id: None,
        };
        manager.shared.snapshot.lock().unwrap().discovered = vec![discovered.clone()];
        assert!(manager.put(0, instance("one", "a")).is_err());
        discovered.identity_quality = "session".into();
        manager.shared.snapshot.lock().unwrap().discovered = vec![discovered];
        let saved = manager.put(0, instance("one", "a")).unwrap();
        assert_eq!(
            saved.store.instances[0].binding_quality.as_deref(),
            Some("session")
        );
        let mut rename = instance("one", "a");
        rename.name = "New name".into();
        let saved = manager.put(1, rename).unwrap();
        assert_eq!(
            saved.store.instances[0].binding_quality.as_deref(),
            Some("session")
        );
        let mut wrong_kind = instance("one", "a");
        wrong_kind.kind = "rc003".into();
        assert!(manager.put(2, wrong_kind).is_err());
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }
    #[test]
    fn same_model_has_independent_bindings_and_profiles() {
        let mut store = Store {
            instances: vec![
                instance("one", "physical-one"),
                instance("two", "physical-two"),
            ],
            ..Store::default()
        };
        assert!(validate(&store).is_ok());
        store.instances[1].binding = store.instances[0].binding.clone();
        assert!(validate(&store).is_err());
    }
    #[test]
    fn paired_offline_device_can_be_bound_and_keeps_its_configuration() {
        let manager = offline_manager(vec![]);
        manager.shared.snapshot.lock().unwrap().discovered = vec![Discovered {
            id: "paired-controller".into(),
            kind: "xboxBluetooth".into(),
            name: "Controller".into(),
            transport: "Bluetooth".into(),
            identity_quality: "serial".into(),
            vendor_id: 0x045e,
            product_id: 0x02e0,
            connected: false,
            paired: true,
            pairing_id: Some("pairing-controller".into()),
        }];
        let saved = manager
            .put(0, instance("desk", "paired-controller"))
            .unwrap();
        assert_eq!(saved.store.instances.len(), 1);
        // An empty online scan or OS unpairing must not delete user mappings.
        manager.shared.snapshot.lock().unwrap().discovered.clear();
        let mut changed = saved.store.instances[0].clone();
        changed.name = "Desk controller".into();
        manager.put(1, changed).unwrap();
        let restored = load(&manager.shared.path).unwrap();
        assert_eq!(
            restored.instances[0].binding.as_deref(),
            Some("paired-controller")
        );
        assert_eq!(restored.instances[0].name, "Desk controller");
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }
    #[test]
    fn legacy_binding_learns_pairing_identity_without_changing_id_or_profiles() {
        let mut old = instance("saved", "legacy-serial-id");
        old.kind = "rc003".into();
        let manager = offline_manager(vec![old]);
        let canonical = paired::identity(
            "rc003",
            0x2717,
            0x32b8,
            "AA:BB:CC:DD:EE:01",
            &HashSet::new(),
        );
        let online = vec![Discovered {
            id: "legacy-serial-id".into(),
            kind: "rc003".into(),
            name: "Remote".into(),
            transport: "Bluetooth".into(),
            identity_quality: "serial".into(),
            vendor_id: 0x2717,
            product_id: 0x32b8,
            connected: true,
            paired: true,
            pairing_id: Some(canonical.clone()),
        }];
        let mut snapshot = manager.shared.snapshot.lock().unwrap();
        let original = snapshot.store.instances[0].clone();
        remember_pairing_ids(&mut snapshot, &online, &manager.shared.path);
        let restored = load(&manager.shared.path).unwrap();
        let saved = &restored.instances[0];
        assert_eq!(saved.id, original.id);
        assert_eq!(saved.binding, original.binding);
        assert!(saved.profiles == original.profiles);
        assert_eq!(saved.binding_pairing_id.as_ref(), Some(&canonical));
        remember_pairing_ids(&mut snapshot, &online, &manager.shared.path);
        assert_eq!(
            snapshot.store.revision, restored.revision,
            "metadata is persisted only once"
        );
        let mut offline = vec![];
        paired::merge(
            &mut offline,
            &[paired::Device {
                address: "AA:BB:CC:DD:EE:01".into(),
                name: "Remote".into(),
                vendor_id: 0x2717,
                product_id: 0x32b8,
            }],
            &HashSet::from(["legacy-serial-id".into()]),
            &HashMap::from([(canonical, "legacy-serial-id".into())]),
        );
        assert_eq!(offline.len(), 1);
        assert_eq!(offline[0].id, "legacy-serial-id");
        assert!(!offline[0].connected);
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }
    #[test]
    fn legacy_capture_field_is_ignored_and_not_saved() {
        let path = std::env::temp_dir().join(format!("axonkey-capture-{}.json", unique_id()));
        let store = Store {
            revision: 3,
            instances: vec![instance("controller", "physical-controller")],
            ..Store::default()
        };
        for mode in ["shared", "exclusive"] {
            let mut legacy = serde_json::to_value(&store).unwrap();
            legacy["instances"][0]["capture"] = mode.into();
            std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
            let loaded = load(&path).unwrap();
            assert_eq!(loaded.revision, 3);
            assert!(loaded.instances == store.instances);
            save(&path, &loaded).unwrap();
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(saved["instances"][0].get("capture").is_none());
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("bak"));
    }
    #[test]
    fn persistence_round_trip_and_corruption_preservation() {
        let path = std::env::temp_dir().join(format!("axonkey-devices-{}.json", unique_id()));
        let mut store = Store {
            instances: vec![instance("one", "physical-one")],
            ..Store::default()
        };
        save(&path, &store).unwrap();
        store.instances.push(instance("two", "physical-two"));
        save(&path, &store).unwrap();
        assert_eq!(load(&path).unwrap().instances.len(), 2);
        std::fs::write(&path, "invalid").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("bak"));
    }
}
