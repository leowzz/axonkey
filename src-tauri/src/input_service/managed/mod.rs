//! Physical-device ownership and input lifetime live here, independently of the editor window.
#[cfg(target_os = "macos")]
mod a15;
mod app_profiles;
mod device_info;
mod gesture;
mod paired;
#[cfg(target_os = "macos")]
mod remote;
#[cfg(test)]
mod report;
#[cfg(all(windows, not(test)))]
use super::windows::ManagedQuarborChannel;
use super::{NativeBehavior, NativeSettings, ProfileDirection, TriggerBehaviors};
use app_profiles::{application_binding, effective_instance, ApplicationProfile};
use gesture::Gestures;
use hidapi::{HidApi, HidDevice};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::{CStr, CString},
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
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;

fn device_kind_matches(device: &Discovered, kind: &str) -> bool {
    if crate::devices::descriptor_registry::requires_information(kind) {
        return crate::devices::descriptor_registry::matches_information(
            kind,
            device.vendor_id,
            device.product_id,
            device.device_info.model_number.as_deref(),
            device.device_info.manufacturer.as_deref(),
            device.device_info.software_revision.as_deref(),
        );
    }
    device.kind == kind
        || crate::devices::descriptor_registry::matches_hardware(
            kind,
            device.vendor_id,
            device.product_id,
            None,
            None,
        )
}

fn uses_hid_voice(kind: &str) -> bool {
    matches!(
        crate::devices::descriptor_registry::voice_engine(kind),
        Some("cmiot-a15.g7221" | "obe-rcu-r5.sbc" | "tcl-rc802a.ico")
    )
}

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
    pub audio_gain_db: i16,
    #[serde(default)]
    pub cmiot_a15_recording_mode: crate::devices::cmiot_a15::recording::RecordingMode,
    #[serde(default, skip_serializing)]
    pub voice_target: Option<String>,
    #[serde(default)]
    pub quarbor_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_driver_missing_reminder: Option<bool>,
    pub enabled: bool,
    pub profiles: Vec<Profile>,
    pub active_profile_id: String,
    #[serde(default)]
    pub app_profile_switching: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub application_profiles: Vec<ApplicationProfile>,
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
    pub device_info: device_info::DeviceInformation,
    pub pairing_id: Option<String>,
    pub bluetooth_address: Option<String>,
    #[serde(skip)]
    pub hid_instance_id: Option<String>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: String,
    pub error: Option<String>,
    pub reports: u64,
    pub recording: bool,
    pub effective_profile_id: Option<String>,
    #[serde(default)]
    pub driver_installed: bool,
    #[serde(default)]
    pub driver_state: String,
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

#[cfg(all(windows, not(test)))]
struct QuarborRegistration {
    target: String,
    kind: String,
    settings: NativeSettings,
}

#[cfg(all(windows, not(test)))]
struct QuarborRegistry {
    app: tauri::AppHandle,
    emit: Arc<dyn Fn(InputEvent) + Send + Sync>,
    channels: Mutex<BTreeMap<String, (String, ManagedQuarborChannel)>>,
    gate: Arc<AtomicBool>,
}

#[cfg(all(windows, not(test)))]
impl QuarborRegistry {
    fn new(app: tauri::AppHandle, emit: Arc<dyn Fn(InputEvent) + Send + Sync>) -> Self {
        Self {
            app,
            emit,
            channels: Mutex::new(BTreeMap::new()),
            gate: Arc::new(AtomicBool::new(false)),
        }
    }

    fn sync(&self, registrations: &BTreeMap<String, QuarborRegistration>) {
        let Ok(mut channels) = self.channels.lock() else {
            return;
        };
        if self.gate.load(Ordering::Acquire) {
            return;
        }
        let stale = channels
            .keys()
            .filter(|id| !registrations.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        for id in stale {
            channels.remove(&id);
        }
        for (id, registration) in registrations {
            if let Some((target, channel)) = channels.get(id) {
                if target == &registration.target && channel.kind == registration.kind {
                    channel.update_settings(registration.settings.clone());
                    continue;
                }
            }
            channels.remove(id);
            let event_emit = Arc::clone(&self.emit);
            let instance_id = id.clone();
            let pressed_keys = Mutex::new(HashSet::new());
            let emit = Arc::new(move |button: String, pressed: bool| {
                let mut keys = pressed_keys.lock().unwrap();
                if pressed {
                    keys.insert(button);
                } else {
                    keys.remove(&button);
                }
                let values = keys.iter().map(|key| (key.clone(), 1.0)).collect();
                event_emit(InputEvent {
                    instance_id: instance_id.clone(),
                    values,
                    pressed: keys.iter().cloned().collect(),
                });
            });
            let input_emit = Arc::clone(&self.emit);
            let input_instance = id.clone();
            let input = Arc::new(move |values, pressed| {
                input_emit(InputEvent {
                    instance_id: input_instance.clone(),
                    values,
                    pressed,
                });
            });
            channels.insert(
                id.clone(),
                (
                    registration.target.clone(),
                    ManagedQuarborChannel::start(
                        id.clone(),
                        registration.target.clone(),
                        registration.kind.clone(),
                        registration.settings.clone(),
                        self.app.clone(),
                        Arc::clone(&self.gate),
                        emit,
                        input,
                    ),
                ),
            );
        }
    }

    fn status(&self, id: &str) -> Option<super::InputServiceStatus> {
        self.channels
            .lock()
            .ok()
            .and_then(|channels| channels.get(id).map(|(_, channel)| channel.status()))
    }
}

enum RecordingRequest {
    Toggle,
    Stop,
}

struct Shared {
    app: Mutex<Option<tauri::AppHandle>>,
    snapshot: Mutex<Snapshot>,
    battery_cache: Mutex<device_info::BatteryCache>,
    information_requests: Mutex<HashSet<String>>,
    recording_requests: Mutex<Vec<(String, RecordingRequest, SyncSender<Result<bool, String>>)>>,
    path: PathBuf,
    stop: AtomicBool,
    enabled: AtomicBool,
    emit: Arc<dyn Fn(InputEvent) + Send + Sync>,
    #[cfg(all(windows, not(test)))]
    quarbor: Option<Arc<QuarborRegistry>>,
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
    let mut store: Store =
        serde_json::from_slice(&std::fs::read(source_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("设备配置无法读取，已保留原文件：{e}"))?;
    if store.version != 1 {
        return Err("设备配置版本不受支持，已保留原文件".into());
    }
    validate(&store)?;
    for instance in &mut store.instances {
        normalize_instance(instance);
    }
    Ok(store)
}
fn normalize_instance(instance: &mut Instance) {
    for profile in &mut instance.profiles {
        let behaviors = profile
            .behaviors
            .as_object_mut()
            .expect("validated profile is an object");
        *behaviors = std::mem::take(behaviors)
            .into_iter()
            .map(|(input, behavior)| {
                let key = crate::devices::descriptor_registry::profile_key(&instance.kind, &input)
                    .expect("validated profile input has a descriptor key");
                (if key == input { input } else { key.to_string() }, behavior)
            })
            .collect();
    }
    let modes = crate::devices::descriptor_registry::descriptor_for_kind(&instance.kind)
        .and_then(|descriptor| descriptor.voices.first())
        .and_then(|voice| voice.attributes.get("trigger-modes"));
    if modes.is_some_and(|modes| !modes.split_whitespace().any(|mode| mode == "click")) {
        instance.cmiot_a15_recording_mode =
            crate::devices::cmiot_a15::recording::RecordingMode::Hold;
    }
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
        if crate::devices::descriptor_registry::descriptor_for_kind(&instance.kind).is_none() {
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
        app_profiles::validate(instance)?;
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
            let mut inputs = HashSet::new();
            for (input, mapping) in &maps {
                let Some(key) =
                    crate::devices::descriptor_registry::profile_key(&instance.kind, input)
                else {
                    return Err(format!("设备不支持此输入或序列过长：{input}"));
                };
                if mapping.iter().count() > 256 {
                    return Err(format!("设备不支持此输入或序列过长：{input}"));
                }
                if !inputs.insert(key) {
                    return Err(format!("同一输入重复配置：{input}"));
                }
            }
        }
    }
    Ok(())
}
impl DeviceManager {
    pub fn start(app: tauri::AppHandle, path: PathBuf) -> Self {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let ownership_app = app.clone();
        let emit_app = app.clone();
        let emit = Box::new(move |event| {
            let _ = emit_app.emit("axonkey-device-input", event);
        });
        let legacy_remote = Box::new(move |owned| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                ownership_app
                    .state::<super::InputService>()
                    .set_managed_remote_owned(owned)
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = owned;
                true
            }
        });
        #[cfg(all(target_os = "windows", not(test)))]
        return Self::start_with_callbacks_and_app(path, emit, legacy_remote, Some(app));
        #[cfg(any(not(target_os = "windows"), test))]
        {
            let manager = Self::start_with_callbacks(path, emit, legacy_remote);
            *manager.shared.app.lock().unwrap() = Some(app);
            manager
        }
    }
    #[cfg(test)]
    fn start_with_emitter(path: PathBuf, emit: Box<dyn Fn(InputEvent) + Send + Sync>) -> Self {
        Self::start_with_callbacks(path, emit, Box::new(|_| true))
    }
    #[cfg_attr(all(windows, not(test)), allow(dead_code))]
    fn start_with_callbacks(
        path: PathBuf,
        emit: Box<dyn Fn(InputEvent) + Send + Sync>,
        legacy_remote: Box<dyn Fn(bool) -> bool + Send + Sync>,
    ) -> Self {
        #[cfg(all(windows, not(test)))]
        return Self::start_with_callbacks_and_app(path, emit, legacy_remote, None);
        #[cfg(any(not(windows), test))]
        Self::start_with_shared(path, Arc::from(emit), legacy_remote)
    }
    #[cfg(all(windows, not(test)))]
    fn start_with_callbacks_and_app(
        path: PathBuf,
        emit: Box<dyn Fn(InputEvent) + Send + Sync>,
        legacy_remote: Box<dyn Fn(bool) -> bool + Send + Sync>,
        app: Option<tauri::AppHandle>,
    ) -> Self {
        let emit: Arc<dyn Fn(InputEvent) + Send + Sync> = Arc::from(emit);
        let quarbor = app.map(|app| Arc::new(QuarborRegistry::new(app, Arc::clone(&emit))));
        Self::start_with_shared(path, emit, legacy_remote, quarbor)
    }
    #[cfg(all(windows, not(test)))]
    fn start_with_shared(
        path: PathBuf,
        emit: Arc<dyn Fn(InputEvent) + Send + Sync>,
        legacy_remote: Box<dyn Fn(bool) -> bool + Send + Sync>,
        quarbor: Option<Arc<QuarborRegistry>>,
    ) -> Self {
        let (store, error) = match load(&path) {
            Ok(store) => (store, None),
            Err(error) => (Store::default(), Some(error)),
        };
        let shared = Arc::new(Shared {
            app: Mutex::new(quarbor.as_ref().map(|registry| registry.app.clone())),
            battery_cache: Mutex::new(device_info::BatteryCache::load(&path)),
            information_requests: Mutex::new(HashSet::new()),
            recording_requests: Mutex::new(Vec::new()),
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
            quarbor,
        });
        Self::spawn(shared)
    }
    #[cfg(any(not(windows), test))]
    fn start_with_shared(
        path: PathBuf,
        emit: Arc<dyn Fn(InputEvent) + Send + Sync>,
        legacy_remote: Box<dyn Fn(bool) -> bool + Send + Sync>,
    ) -> Self {
        let (store, error) = match load(&path) {
            Ok(store) => (store, None),
            Err(error) => (Store::default(), Some(error)),
        };
        let shared = Arc::new(Shared {
            app: Mutex::new(None),
            battery_cache: Mutex::new(device_info::BatteryCache::load(&path)),
            information_requests: Mutex::new(HashSet::new()),
            recording_requests: Mutex::new(Vec::new()),
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
        Self::spawn(shared)
    }
    fn spawn(shared: Arc<Shared>) -> Self {
        #[cfg(all(any(windows, target_os = "macos"), not(test)))]
        device_info::start(shared.clone());
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
        let (_, app_id) = crate::foreground::context();
        let mut snapshot = self.shared.snapshot.lock().unwrap().clone();
        for instance in &snapshot.store.instances {
            let profile_id = effective_instance(instance, app_id.as_deref())
                .active_profile_id
                .clone();
            snapshot
                .runtime
                .entry(instance.id.clone())
                .or_default()
                .effective_profile_id = Some(profile_id);
        }
        snapshot
    }
    pub fn refresh_information(&self, binding: &str) -> Result<Snapshot, String> {
        device_info::request(&self.shared, binding)
    }

    pub fn toggle_recording(&self, instance_id: &str) -> Result<bool, String> {
        self.request_recording(instance_id, RecordingRequest::Toggle)
    }

    pub(crate) fn stop_recording(&self, instance_id: &str) -> Result<bool, String> {
        self.request_recording(instance_id, RecordingRequest::Stop)
    }

    fn request_recording(
        &self,
        instance_id: &str,
        request: RecordingRequest,
    ) -> Result<bool, String> {
        self.validate_recording_target(instance_id)?;
        let (reply, result) = sync_channel(1);
        self.shared
            .recording_requests
            .lock()
            .unwrap()
            .push((instance_id.into(), request, reply));
        result
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "录音控制未响应，请检查设备连接".to_string())?
    }

    fn validate_recording_target(&self, instance_id: &str) -> Result<(), String> {
        let snapshot = self.shared.snapshot.lock().unwrap();
        let instance = snapshot
            .store
            .instances
            .iter()
            .find(|item| item.id == instance_id)
            .ok_or("设备已被移除")?;
        if !uses_hid_voice(&instance.kind) {
            return Err("仅 CMIOT A15 / XM-BT-29 / RC-313 / OBE_RCU_R5 支持手动控制录音".into());
        }
        if !self.shared.enabled.load(Ordering::Acquire)
            || !instance.enabled
            || instance.binding.is_none()
            || !snapshot
                .runtime
                .get(instance_id)
                .is_some_and(|status| status.state == "exclusive")
        {
            return Err("请先连接并启用 CMIOT A15 / XM-BT-29 / RC-313 / OBE_RCU_R5 设备".into());
        }
        Ok(())
    }

    #[cfg(windows)]
    pub fn pause_for_driver_migration(&self) {
        #[cfg(not(test))]
        if let Some(registry) = &self.shared.quarbor {
            let mut channels = registry.channels.lock().unwrap();
            registry.gate.store(true, Ordering::Release);
            // Dropping a channel joins its worker and releases the driver handle.
            channels.clear();
        }
    }
    #[cfg(windows)]
    pub fn resume_after_driver_migration(&self) {
        #[cfg(not(test))]
        if let Some(registry) = &self.shared.quarbor {
            registry.gate.store(false, Ordering::Release);
        }
    }
    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
    pub(crate) fn switch_instance_profile(
        &self,
        id: &str,
        direction: ProfileDirection,
        wrap: bool,
    ) {
        switch_profile(&self.shared, id, direction, wrap);
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
                instance.voice_target = old.voice_target.clone();
                instance.quarbor_target = old.quarbor_target.clone();
            }
        }
        if instance.binding != old.and_then(|i| i.binding.clone()) {
            instance.quarbor_target = None;
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
                instance.voice_target = device.bluetooth_address.clone();
                if !device_kind_matches(device, &instance.kind) {
                    return Err("设备与支持包不匹配".into());
                }
            }
        }
        if instance.binding.is_none() {
            instance.binding_quality = None;
            instance.binding_pairing_id = None;
            instance.voice_target = None;
            instance.quarbor_target = None;
        }
        if instance.id.is_empty() {
            instance.id = unique_id();
        }
        let mut next = snapshot.store.clone();
        let index = if let Some((index, current)) = next
            .instances
            .iter_mut()
            .enumerate()
            .find(|(_, i)| i.id == instance.id)
        {
            *current = instance;
            index
        } else {
            next.instances.push(instance);
            next.instances.len() - 1
        };
        validate(&next)?;
        normalize_instance(&mut next.instances[index]);
        next.revision += 1;
        save(&self.shared.path, &next)?;
        snapshot.store = next;
        Ok(snapshot.clone())
    }
    pub fn remember_quarbor_target(
        &self,
        instance_id: &str,
        target: &str,
    ) -> Result<Snapshot, String> {
        let mut snapshot = self.shared.snapshot.lock().unwrap();
        let mut next = snapshot.store.clone();
        let instance = next
            .instances
            .iter_mut()
            .find(|instance| instance.id == instance_id)
            .ok_or("未找到要更新驱动状态的设备实例")?;
        if crate::devices::descriptor_registry::descriptor_for_kind(&instance.kind).is_none() {
            return Err("此设备不支持 Quarbor 按键驱动".into());
        }
        if instance.quarbor_target.as_deref() != Some(target) {
            instance.quarbor_target = Some(target.to_string());
            next.revision += 1;
            validate(&next)?;
            save(&self.shared.path, &next)?;
            snapshot.store = next;
        }
        Ok(snapshot.clone())
    }
    pub fn unbind(&self, instance_id: &str) -> Result<Snapshot, String> {
        let mut snapshot = self.shared.snapshot.lock().unwrap();
        let mut next = snapshot.store.clone();
        let instance = next
            .instances
            .iter_mut()
            .find(|instance| instance.id == instance_id)
            .ok_or("未找到要解除绑定的设备实例")?;
        if instance.binding.is_none() {
            return Ok(snapshot.clone());
        }
        instance.binding = None;
        instance.binding_quality = None;
        instance.binding_pairing_id = None;
        instance.voice_target = None;
        instance.quarbor_target = None;
        instance.hide_driver_missing_reminder = None;
        next.revision += 1;
        validate(&next)?;
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
    pub fn reorder(&self, revision: u64, ids: &[String]) -> Result<Snapshot, String> {
        let mut snapshot = self.shared.snapshot.lock().unwrap();
        if snapshot.error.is_some() || revision != snapshot.store.revision {
            return Err("配置已变化或无法读取，请刷新后重试".into());
        }
        if ids.len() != snapshot.store.instances.len()
            || ids.iter().collect::<HashSet<_>>().len() != ids.len()
            || ids.iter().any(|id| {
                !snapshot
                    .store
                    .instances
                    .iter()
                    .any(|instance| &instance.id == id)
            })
        {
            return Err("设备顺序无效".into());
        }
        let instances = snapshot.store.instances.clone();
        let mut next = snapshot.store.clone();
        next.instances = ids
            .iter()
            .filter_map(|id| {
                instances
                    .iter()
                    .find(|instance| &instance.id == id)
                    .cloned()
            })
            .collect();
        if next.instances == snapshot.store.instances {
            return Ok(snapshot.clone());
        }
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
    config: Arc<ReaderConfig>,
    path: CString,
    device: InputReader,
    descriptor: &'static crate::devices::device_descriptor::DeviceDescriptor,
    engine: crate::devices::engine::DescriptorEngine,
    gestures: Gestures,
    maps: HashMap<String, TriggerBehaviors>,
    actions: SyncSender<(Arc<ReaderConfig>, Vec<gesture::Execution>)>,
    reports: u64,
}
impl Reader {
    fn update_config(&mut self, shared: &Arc<Shared>, instance: &Instance) -> bool {
        if &self.config.instance == instance {
            return true;
        }
        #[cfg(not(target_os = "macos"))]
        let _ = shared;
        let config = Arc::new(ReaderConfig::new(instance));
        let settings = input_settings(instance);
        match &mut self.device {
            #[cfg(target_os = "macos")]
            InputReader::Remote(device) => {
                if !device.update_settings(settings, action_guard(shared, &config)) {
                    return false;
                }
            }
            #[cfg(target_os = "macos")]
            InputReader::A15(device) => {
                if let Err(error) = device.update_settings(settings, action_guard(shared, &config))
                {
                    log::warn!(target: "axonkey::devices", "Instance {}: {error}", instance.id);
                    return false;
                }
            }
            InputReader::Hid(_) => {
                if self.maps != settings.behaviors {
                    self.gestures = Gestures::default();
                    self.maps = settings.behaviors;
                }
            }
        }
        self.config.cancel.store(true, Ordering::Release);
        self.config = config;
        true
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.config.cancel.store(true, Ordering::Release);
    }
}

struct ReaderConfig {
    instance: Instance,
    cancel: AtomicBool,
}

impl ReaderConfig {
    fn new(instance: &Instance) -> Self {
        Self {
            instance: instance.clone(),
            cancel: AtomicBool::new(false),
        }
    }

    fn is_current(&self, shared: &Shared) -> bool {
        actions_current(shared, &self.instance, &self.cancel)
    }
}

#[cfg(target_os = "macos")]
fn action_guard(
    shared: &Arc<Shared>,
    config: &Arc<ReaderConfig>,
) -> super::macos::RemoteActionGuard {
    let shared = shared.clone();
    let config = config.clone();
    Box::new(move || config.is_current(&shared))
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
    #[cfg(target_os = "macos")]
    A15(a15::A15Reader),
    Hid(HidDevice),
    #[cfg(target_os = "macos")]
    Remote(remote::RemoteReader),
}
impl InputReader {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self {
            #[cfg(target_os = "macos")]
            Self::A15(device) => device.read(buffer),
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

fn input_settings(instance: &Instance) -> NativeSettings {
    NativeSettings {
        enabled: true,
        behaviors: active_mappings(instance),
        cmiot_a15_recording_mode: instance.cmiot_a15_recording_mode,
        ..Default::default()
    }
}

fn open_reader(
    api: &HidApi,
    path: &CStr,
    shared: &Arc<Shared>,
    config: &Arc<ReaderConfig>,
) -> Result<InputReader, String> {
    let instance = &config.instance;
    #[cfg(target_os = "macos")]
    if instance.kind == "rc003" {
        let serial = api
            .device_list()
            .find(|info| info.path() == path)
            .and_then(|info| info.serial_number())
            .filter(|s| !s.is_empty())
            .ok_or("此遥控器没有稳定标识，无法按实例拦截")?;
        let switch_shared = shared.clone();
        let id = instance.id.clone();
        return remote::RemoteReader::open(
            serial,
            &instance.id,
            input_settings(instance),
            action_guard(shared, config),
            Box::new(move |direction, wrap| switch_profile(&switch_shared, &id, direction, wrap)),
        )
        .map(InputReader::Remote);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = shared;
    #[cfg(windows)]
    if instance.kind == "rc003" {
        return Err("Windows RC003 的按实例驱动适配尚未接入；可继续使用原遥控器工作区".into());
    }
    #[cfg(target_os = "macos")]
    if uses_hid_voice(&instance.kind) && !super::InputService::input_monitoring_granted() {
        return Err("请先授予输入监控权限，再连接 A15".into());
    }
    let device = open(api, path)?;
    device.set_blocking_mode(false).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if uses_hid_voice(&instance.kind) {
        return Ok(InputReader::A15(a15::A15Reader::open(
            device, shared, config,
        )));
    }
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
    crate::devices::descriptor_registry::KINDS
        .iter()
        .copied()
        .filter(|kind| cfg!(target_os = "macos") || !uses_hid_voice(kind))
        .find(|kind| {
            crate::devices::descriptor_registry::matches_hardware(
                kind,
                info.vendor_id(),
                info.product_id(),
                Some(info.usage_page()),
                Some(info.usage()),
            )
        })
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
        if instance.binding_pairing_id.is_none() {
            if let Some(device) = discovered.iter().find(|d| {
                Some(&d.id) == instance.binding.as_ref()
                    && device_kind_matches(d, &instance.kind)
                    && d.identity_quality != "ambiguous"
                    && d.pairing_id.is_some()
            }) {
                instance.binding_pairing_id = device.pairing_id.clone();
                changed = true;
            }
        }
        if crate::devices::descriptor_registry::voice_engine(&instance.kind).is_some()
            && instance.voice_target.is_none()
        {
            if let Some(device) = discovered.iter().find(|d| {
                Some(&d.id) == instance.binding.as_ref()
                    && device_kind_matches(d, &instance.kind)
                    && d.identity_quality != "ambiguous"
                    && d.bluetooth_address.is_some()
            }) {
                instance.voice_target = device.bluetooth_address.clone();
                changed = true;
            }
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

#[cfg(windows)]
fn driver_connection_state(
    target: Option<&str>,
    installed: bool,
    capture_active: bool,
) -> &'static str {
    if target.is_none() {
        "offline"
    } else if !installed {
        "missing"
    } else if capture_active {
        "connected"
    } else {
        "connecting"
    }
}

#[cfg(windows)]
pub(crate) fn driver_target(
    instance: &Instance,
    instances: &[Instance],
    discovered: &[Discovered],
    devices: &[crate::quarbor_installer::Device],
) -> Option<(String, bool)> {
    if instance.binding.is_none() {
        return None;
    }
    if crate::devices::descriptor_registry::requires_information(&instance.kind)
        && !discovered.iter().any(|device| {
            Some(&device.id) == instance.binding.as_ref()
                && device_kind_matches(device, &instance.kind)
        })
    {
        return None;
    }
    if let Some(device) = instance.quarbor_target.as_ref().and_then(|target| {
        devices
            .iter()
            .find(|d| d.instance_id.eq_ignore_ascii_case(target) && d.matches_kind(&instance.kind))
    }) {
        return Some((
            device.instance_id.clone(),
            device.bound || device.recovery_active,
        ));
    }
    if instance.kind == "xboxBluetooth" {
        if let Some(target) = discovered
            .iter()
            .find(|d| Some(&d.id) == instance.binding.as_ref() && d.identity_quality != "ambiguous")
            .and_then(|d| d.hid_instance_id.as_ref())
        {
            return devices
                .iter()
                .find(|d| {
                    d.instance_id.eq_ignore_ascii_case(target) && d.matches_kind(&instance.kind)
                })
                .map(|d| (d.instance_id.clone(), d.bound || d.recovery_active));
        }
    }
    let address = instance.voice_target.as_deref().or_else(|| {
        discovered
            .iter()
            .find(|d| Some(&d.id) == instance.binding.as_ref())
            .and_then(|d| d.bluetooth_address.as_deref())
    });
    if let Some(address) = address {
        return crate::quarbor_installer::target_for_bluetooth_address(
            devices,
            address,
            &instance.kind,
        );
    }
    // Compatibility for old RC003 bindings without a Bluetooth identity.
    if instance.kind == "rc003"
        && instances
            .iter()
            .filter(|i| i.kind == "rc003" && i.binding.is_some())
            .count()
            == 1
    {
        return crate::quarbor_installer::unique_installed_rc003_target(devices);
    }
    None
}

#[cfg(windows)]
fn merge_driver_devices(
    discovered: &mut Vec<Discovered>,
    devices: &[crate::quarbor_installer::Device],
    bindings: &HashSet<String>,
    pairing_bindings: &HashMap<String, String>,
) {
    for device in devices {
        let Some(kind) = crate::devices::descriptor_registry::KINDS
            .iter()
            .copied()
            .find(|kind| device.matches_kind(kind))
        else {
            continue;
        };
        let Some((vendor_id, product_id)) =
            crate::devices::descriptor_registry::primary_hardware(kind)
        else {
            continue;
        };
        let Some(address) = device
            .bluetooth_address()
            .and_then(|address| paired::address(&address))
        else {
            continue;
        };
        let pairing_id = paired::identity(kind, vendor_id, product_id, &address, &HashSet::new());
        let id = pairing_bindings
            .get(&pairing_id)
            .cloned()
            .unwrap_or_else(|| paired::identity(kind, vendor_id, product_id, &address, bindings));
        if let Some(existing) = discovered
            .iter_mut()
            .find(|d| d.id == id || d.pairing_id.as_ref() == Some(&pairing_id))
        {
            existing.connected |= device.present;
            continue;
        }
        // Offline historical PnP nodes are not proof of an active pairing.
        if !device.present {
            continue;
        }
        discovered.push(Discovered {
            id,
            kind: kind.into(),
            name: device.name.clone(),
            transport: "Bluetooth".into(),
            identity_quality: "serial".into(),
            vendor_id,
            product_id,
            connected: true,
            paired: false,
            device_info: Default::default(),
            pairing_id: Some(pairing_id),
            bluetooth_address: Some(address),
            hid_instance_id: None,
        });
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
    let mut config_revision = (u64::MAX, u64::MAX);
    #[cfg(all(windows, not(test)))]
    let mut driver_devices = Vec::new();
    let mut paths = HashMap::new();
    let mut sessions: HashMap<String, String> = HashMap::new();
    let start = Instant::now();
    let mut next_scan = Instant::now();
    let mut next_event = Instant::now();
    let mut next_usage = Instant::now();
    let mut voice_sessions = HashMap::<String, String>::new();
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
            #[cfg(all(windows, not(test)))]
            let driver_error = match crate::windows_driver_devices::list_present() {
                Ok(devices) => {
                    driver_devices = devices;
                    None
                }
                Err(error) => Some(error),
            };
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
                        device_info: Default::default(),
                        pairing_id,
                        bluetooth_address: address,
                        hid_instance_id: path.strip_prefix(r"\\?\").and_then(|path| {
                            path.rsplit_once("#{").map(|(id, _)| id.replace('#', "\\"))
                        }),
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
                #[cfg(all(windows, not(test)))]
                merge_driver_devices(
                    &mut discovered,
                    &driver_devices,
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
            #[cfg(all(windows, not(test)))]
            if snapshot.scan_error.is_none() {
                snapshot.scan_error = driver_error;
            }
            if hid_ok {
                device_info::retain_readings(
                    &mut discovered,
                    &snapshot.discovered,
                    &shared.battery_cache.lock().unwrap(),
                );
                remember_pairing_ids(&mut snapshot, &discovered, &shared.path);
                snapshot.discovered = discovered;
            }
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let mut audio_targets = None;
        {
            let (generation, app_id) = crate::foreground::context();
            let snapshot = shared.snapshot.lock().unwrap();
            if config_revision != (snapshot.store.revision, generation) {
                config_revision = (snapshot.store.revision, generation);
                configs = snapshot
                    .store
                    .instances
                    .iter()
                    .map(|instance| effective_instance(instance, app_id.as_deref()).into_owned())
                    .collect();
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                {
                    audio_targets = Some(crate::audio_targets(&snapshot));
                }
            }
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if scanning && audio_targets.is_none() {
                audio_targets = Some(crate::audio_targets(&snapshot));
            }
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(targets) = audio_targets {
            let app = shared.app.lock().unwrap().clone();
            if let Some(audio) = app
                .as_ref()
                .and_then(|app| app.try_state::<crate::audio_service::AudioServiceManager>())
            {
                audio.sync_instances(&targets);
            }
        }
        failures.retain(|id, _| configs.iter().any(|i| &i.id == id));
        let enabled = shared.enabled.load(Ordering::Acquire);
        #[cfg(all(windows, not(test)))]
        let mut driver_matches: BTreeMap<String, (Option<String>, bool)> = BTreeMap::new();
        #[cfg(all(windows, not(test)))]
        if shared.quarbor.is_some() {
            let snapshot = shared.snapshot.lock().unwrap();
            for instance in &configs {
                if crate::devices::descriptor_registry::descriptor_for_kind(&instance.kind)
                    .is_none()
                {
                    continue;
                }
                let matched =
                    driver_target(instance, &configs, &snapshot.discovered, &driver_devices);
                driver_matches.insert(
                    instance.id.clone(),
                    matched
                        .map(|(target, installed)| (Some(target), installed))
                        .unwrap_or((None, false)),
                );
            }
        }
        #[cfg(all(windows, not(test)))]
        if let Some(registry) = &shared.quarbor {
            let mut registrations = BTreeMap::new();
            for instance in &configs {
                let Some((Some(target), true)) = driver_matches.get(&instance.id) else {
                    continue;
                };
                if instance.binding.is_none() || !instance.enabled || !enabled {
                    continue;
                }
                registrations.insert(
                    instance.id.clone(),
                    QuarborRegistration {
                        target: target.clone(),
                        kind: instance.kind.clone(),
                        settings: input_settings(instance),
                    },
                );
            }
            registry.sync(&registrations);
        }
        let information_matches: HashSet<_> = {
            let snapshot = shared.snapshot.lock().unwrap();
            configs
                .iter()
                .filter(|instance| {
                    !crate::devices::descriptor_registry::requires_information(&instance.kind)
                        || snapshot.discovered.iter().any(|device| {
                            Some(&device.id) == instance.binding.as_ref()
                                && device_kind_matches(device, &instance.kind)
                        })
                })
                .map(|instance| instance.id.clone())
                .collect()
        };
        readers.retain(|id, reader| {
            let keep = enabled
                && information_matches.contains(id)
                && configs.iter().any(|instance| {
                    &instance.id == id
                        && instance.enabled
                        && instance.kind == reader.config.instance.kind
                        && instance.binding == reader.config.instance.binding
                        && instance.binding.as_ref().and_then(|b| paths.get(b))
                            == Some(&reader.path)
                        && reader.update_config(&shared, instance)
                });
            if !keep {
                if reader
                    .descriptor
                    .voices
                    .iter()
                    .any(|voice| voice.engine == "tcl-rc902v-atvv")
                {
                    notify_rc902_voice_key_edge(&shared, id, false);
                }
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
            let path = instance
                .binding
                .as_ref()
                .and_then(|id| paths.get(id))
                .filter(|_| information_matches.contains(&instance.id));
            status.state = if !enabled || !instance.enabled {
                "paused"
            } else if uses_hid_voice(&instance.kind) && !cfg!(any(windows, target_os = "macos")) {
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
            #[cfg(all(windows, not(test)))]
            if crate::devices::descriptor_registry::descriptor_for_kind(&instance.kind).is_some() {
                let (target, installed) = driver_matches
                    .get(&instance.id)
                    .cloned()
                    .unwrap_or((None, false));
                let service = shared
                    .quarbor
                    .as_ref()
                    .and_then(|registry| registry.status(&instance.id));
                status.driver_installed = installed;
                let capture_active = service
                    .as_ref()
                    .is_some_and(|service| service.capture_active);
                status.driver_state =
                    driver_connection_state(target.as_deref(), installed, capture_active).into();
                status.recording = service
                    .as_ref()
                    .is_some_and(|service| service.cmiot_a15_recording);
                if enabled && instance.enabled && instance.binding.is_some() {
                    status.state = if target.is_none() {
                        "disconnected"
                    } else if !installed {
                        "driverMissing"
                    } else if service
                        .as_ref()
                        .is_some_and(|service| service.capture_active)
                    {
                        "exclusive"
                    } else {
                        "disconnected"
                    }
                    .into();
                    if target.is_some() {
                        status.error = service.and_then(|service| service.error);
                    }
                }
                statuses.insert(instance.id.clone(), status);
                continue;
            }
            if status.state == "opening" && !cfg!(target_os = "macos") && instance.kind != "rc003" {
                status.state = "unsupported".into();
                status.error = Some("当前平台尚未支持此设备的独占拦截".into());
            }
            if status.state == "opening" && instance.kind == "rc003" && !remote_ready {
                statuses.insert(instance.id.clone(), status);
                continue;
            }
            if status.state == "opening"
                && (cfg!(target_os = "macos") || instance.kind != "rc003")
                && !readers.contains_key(&instance.id)
            {
                // Retry an open error on the next scan, not on every 8 ms tick.
                let retry = scanning
                    || !failures
                        .get(&instance.id)
                        .is_some_and(|(failed, _)| failed == instance);
                if retry {
                    let config = Arc::new(ReaderConfig::new(instance));
                    let path = path.unwrap();
                    match open_reader(&api, path, &shared, &config) {
                        Ok(device) => {
                            failures.remove(&instance.id);
                            // macOS remote adapters execute their own actions; reports here
                            // only update the instance UI.
                            let maps = if cfg!(target_os = "macos")
                                && (instance.kind == "rc003" || uses_hid_voice(&instance.kind))
                            {
                                HashMap::new()
                            } else {
                                active_mappings(instance)
                            };
                            let actions = spawn_action_worker(shared.clone(), instance.id.clone());
                            readers.insert(
                                instance.id.clone(),
                                Reader {
                                    config,
                                    path: path.clone(),
                                    device,
                                    descriptor:
                                        crate::devices::descriptor_registry::descriptor_for_kind(
                                            &instance.kind,
                                        )
                                        .expect("validated device kind has a descriptor"),
                                    engine: Default::default(),
                                    gestures: Gestures::default(),
                                    maps,
                                    actions,
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
                            if accept_direct_pointer_report(&instance.kind, &buffer[..len]) {
                                continue;
                            }
                            for (id, down) in
                                reader.engine.accept(reader.descriptor, &buffer[..len])
                            {
                                if reader.descriptor.voices.iter().any(|voice| {
                                    voice.engine == "tcl-rc902v-atvv" && voice.trigger_key == id
                                }) {
                                    notify_rc902_voice_key_edge(&shared, &instance.id, down);
                                }
                                let key = reader
                                    .descriptor
                                    .inputs
                                    .iter()
                                    .find(|input| input.id == id)
                                    .map(crate::devices::descriptor_registry::input_key)
                                    .unwrap_or(&id);
                                sequence.extend(reader.gestures.edge(
                                    key,
                                    down,
                                    now,
                                    reader.maps.get(key).unwrap_or(&TriggerBehaviors::default()),
                                ));
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
                #[cfg(target_os = "macos")]
                if let InputReader::A15(device) = &reader.device {
                    status.recording = device.recording();
                }
                status.reports = reader.reports;
                if !failed
                    && !sequence.is_empty()
                    && reader
                        .actions
                        .try_send((reader.config.clone(), sequence))
                        .is_err()
                {
                    status.error = Some("动作队列已满，已丢弃本次动作".into());
                }
                if failed {
                    if reader
                        .descriptor
                        .voices
                        .iter()
                        .any(|voice| voice.engine == "tcl-rc902v-atvv")
                    {
                        notify_rc902_voice_key_edge(&shared, &instance.id, false);
                    }
                    readers.remove(&instance.id);
                    emit(&shared, &instance.id, BTreeMap::new(), vec![]);
                }
            }
            statuses.insert(instance.id.clone(), status);
        }
        for (id, request, reply) in std::mem::take(&mut *shared.recording_requests.lock().unwrap())
        {
            #[cfg(all(windows, not(test)))]
            {
                let channels = shared
                    .quarbor
                    .as_ref()
                    .map(|registry| registry.channels.lock().unwrap());
                if let Some((_, channel)) = channels.as_ref().and_then(|channels| channels.get(&id))
                {
                    match request {
                        RecordingRequest::Toggle => channel.toggle_recording(reply),
                        RecordingRequest::Stop => channel.stop_recording(reply),
                    }
                } else {
                    let _ = reply.send(Err("设备录音通道未连接".into()));
                }
            }
            #[cfg(target_os = "macos")]
            {
                let result = match readers.get_mut(&id).map(|reader| &mut reader.device) {
                    Some(InputReader::A15(device)) => match request {
                        RecordingRequest::Toggle => device.toggle_recording(),
                        RecordingRequest::Stop => device.stop_recording(),
                    },
                    _ => Err("设备录音通道未连接".into()),
                };
                if let Ok(recording) = &result {
                    if let Some(status) = statuses.get_mut(&id) {
                        status.recording = *recording;
                    }
                }
                let _ = reply.send(result);
            }
            #[cfg(not(any(all(windows, not(test)), target_os = "macos")))]
            {
                let _ = (id, request);
                let _ = reply.send(Err("当前平台不支持手动控制录音".into()));
            }
        }
        if Instant::now() >= next_usage {
            next_usage = Instant::now() + Duration::from_millis(40);
            let mut recording = HashMap::new();
            for instance in &configs {
                let mut active = statuses
                    .get(&instance.id)
                    .is_some_and(|status| status.recording);
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                if matches!(
                    crate::devices::descriptor_registry::voice_engine(&instance.kind),
                    Some("rc003-atvv" | "tcl-rc902v-atvv")
                ) && enabled
                    && instance.enabled
                {
                    let app = shared.app.lock().unwrap();
                    active = app
                        .as_ref()
                        .and_then(|app| {
                            app.try_state::<crate::audio_service::AudioServiceManager>()
                        })
                        .is_some_and(|audio| audio.status(Some(&instance.id)).forwarding);
                }
                if active {
                    let mode = match instance.cmiot_a15_recording_mode {
                        crate::devices::cmiot_a15::recording::RecordingMode::Hold => "hold",
                        crate::devices::cmiot_a15::recording::RecordingMode::Click => "click",
                    };
                    recording.insert(instance.id.clone(), mode.to_owned());
                }
            }
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if !configs.iter().any(|instance| {
                instance.kind == "rc003" && instance.enabled && instance.binding.is_some()
            }) {
                let app = shared.app.lock().unwrap();
                if app
                    .as_ref()
                    .and_then(|app| app.try_state::<crate::audio_service::AudioServiceManager>())
                    .is_some_and(|audio| audio.status(None).forwarding)
                {
                    recording.insert("legacy-rc003".into(), "hold".into());
                }
            }
            sync_voice_sessions(&mut voice_sessions, recording);
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
            for (id, reader) in &mut readers {
                if let Some((values, down)) = reader.engine.take_update() {
                    let key = |id: String| {
                        reader
                            .descriptor
                            .inputs
                            .iter()
                            .find(|input| input.id == id)
                            .map(crate::devices::descriptor_registry::input_key)
                            .unwrap_or(&id)
                            .to_string()
                    };
                    emit(
                        &shared,
                        id,
                        values
                            .into_iter()
                            .map(|(id, value)| (key(id), value))
                            .collect(),
                        down.into_iter().map(key).collect(),
                    );
                }
            }
        }
        thread::sleep(Duration::from_millis(8));
    }
    drop(readers);
    sync_voice_sessions(&mut voice_sessions, HashMap::new());
    (shared.legacy_remote)(false);
}
fn voice_session_changes(
    previous: &HashMap<String, String>,
    current: &HashMap<String, String>,
) -> Vec<(String, Option<String>)> {
    let mut changes = Vec::new();
    for (key, mode) in previous {
        if current.get(key) != Some(mode) {
            changes.push((key.clone(), None));
        }
    }
    for (key, mode) in current {
        if previous.get(key) != Some(mode) {
            changes.push((key.clone(), Some(mode.clone())));
        }
    }
    changes
}

fn sync_voice_sessions(previous: &mut HashMap<String, String>, current: HashMap<String, String>) {
    for (key, mode) in voice_session_changes(previous, &current) {
        if let Some(mode) = mode {
            crate::library_usage::voice_start(&key, &mode);
        } else {
            crate::library_usage::voice_stop(&key);
        }
    }
    *previous = current;
}

fn notify_rc902_voice_key_edge(shared: &Shared, instance_id: &str, pressed: bool) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let app = shared.app.lock().unwrap();
        if let Some(audio) = app
            .as_ref()
            .and_then(|app| app.try_state::<crate::audio_service::AudioServiceManager>())
        {
            audio.handle_voice_key_edge(Some(instance_id), pressed);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (shared, instance_id, pressed);
}

fn accept_direct_pointer_report(kind: &str, bytes: &[u8]) -> bool {
    if kind != crate::devices::hisense_rcf3b65::KIND {
        return false;
    }
    let Some(position) = crate::devices::hisense_rcf3b65::parse_pointer_report(bytes) else {
        return false;
    };
    #[cfg(target_os = "macos")]
    if super::InputService::accessibility_granted() {
        super::macos::post_absolute_cursor_move(position.x, position.y);
    }
    #[cfg(windows)]
    super::windows::send_absolute_mouse_move(position.x, position.y);
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = position;
    true
}

fn spawn_action_worker(
    shared: Arc<Shared>,
    id: String,
) -> SyncSender<(Arc<ReaderConfig>, Vec<gesture::Execution>)> {
    let (tx, rx) = sync_channel::<(Arc<ReaderConfig>, Vec<gesture::Execution>)>(32);
    thread::spawn(move || {
        while let Ok((config, sequence)) = rx.recv() {
            let is_current = || config.is_current(&shared);
            for execution in sequence {
                if is_current()
                    && execution.behaviors.iter().any(|behavior| {
                        behavior.enabled() && !matches!(behavior, NativeBehavior::Disabled { .. })
                    })
                {
                    crate::library_usage::record_trigger(
                        &format!("{}:{}", id, execution.input),
                        &execution.sources,
                    );
                }
                for behavior in execution.behaviors {
                    if !is_current() {
                        break;
                    }
                    if !behavior.enabled() {
                        continue;
                    }
                    match behavior {
                        NativeBehavior::Delay { ms, .. } => {
                            let until = Instant::now() + Duration::from_millis(ms.min(300_000));
                            while Instant::now() < until && is_current() {
                                thread::sleep(Duration::from_millis(10));
                            }
                        }
                        NativeBehavior::SwitchProfile {
                            direction, wrap, ..
                        } => {
                            switch_profile(&shared, &id, direction, wrap);
                            break;
                        }
                        _ => {
                            static OUTPUT: Mutex<()> = Mutex::new(());
                            let _output = OUTPUT.lock().unwrap();
                            if !is_current() {
                                break;
                            }
                            #[cfg(target_os = "macos")]
                            if super::InputService::accessibility_granted() {
                                super::macos::execute_behaviors(&[behavior]);
                            }
                            #[cfg(windows)]
                            super::windows::execute_mouse_behavior(&behavior, 10);
                        }
                    }
                }
            }
        }
    });
    tx
}

fn actions_current(shared: &Shared, expected: &Instance, cancel: &AtomicBool) -> bool {
    let (_, app_id) = crate::foreground::context();
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
            .any(|instance| {
                instance.enabled
                    && effective_instance(instance, app_id.as_deref()).as_ref() == expected
            })
}
fn switch_profile(shared: &Shared, id: &str, direction: ProfileDirection, wrap: bool) {
    let Some((device, from, to)) = save_profile_switch(shared, id, direction, wrap) else {
        return;
    };
    if let Some(app) = shared.app.lock().unwrap().as_ref() {
        if let Err(error) = crate::profile_switch_overlay::show(app, device, from, to) {
            log::warn!(target: "axonkey::profile_overlay", "Cannot show device profile notification: {error}");
        }
    }
}

fn save_profile_switch(
    shared: &Shared,
    id: &str,
    direction: ProfileDirection,
    wrap: bool,
) -> Option<(String, String, String)> {
    let app_id = crate::foreground::frontmost_application_id();
    save_profile_switch_for_app(shared, id, direction, wrap, app_id.as_deref())
}

fn save_profile_switch_for_app(
    shared: &Shared,
    id: &str,
    direction: ProfileDirection,
    wrap: bool,
    app_id: Option<&str>,
) -> Option<(String, String, String)> {
    let mut snapshot = shared.snapshot.lock().unwrap();
    let mut next = snapshot.store.clone();
    let Some(instance) = next.instances.iter_mut().find(|i| i.id == id) else {
        return None;
    };
    let effective = effective_instance(instance, app_id);
    let current = instance
        .profiles
        .iter()
        .position(|p| p.id == effective.active_profile_id)
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
        return None;
    }
    let app_binding = application_binding(instance, app_id);
    let names = (
        app_binding
            .map(|index| {
                format!(
                    "{} 的设备配置 · {}",
                    instance.application_profiles[index].application.name, instance.name
                )
            })
            .unwrap_or_else(|| instance.name.clone()),
        instance.profiles[current].name.clone(),
        instance.profiles[target].name.clone(),
    );
    if let Some(index) = app_binding {
        instance.application_profiles[index].profile_id = instance.profiles[target].id.clone();
    } else {
        instance.active_profile_id = instance.profiles[target].id.clone();
    }
    next.revision += 1;
    match save(&shared.path, &next) {
        Ok(()) => {
            snapshot.store = next;
            Some(names)
        }
        Err(error) => {
            snapshot.error = Some(error);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_output_selection_is_ignored_and_removed_on_save() {
        let original = instance("remote", "physical-remote");
        let mut legacy = serde_json::to_value(&original).unwrap();
        legacy["voiceOutputDevice"] = serde_json::json!("speakers");
        let loaded: Instance = serde_json::from_value(legacy).unwrap();
        assert!(loaded == original);
        assert!(serde_json::to_value(loaded)
            .unwrap()
            .get("voiceOutputDevice")
            .is_none());
    }

    pub(super) fn instance(id: &str, binding: &str) -> Instance {
        Instance {
            id: id.into(),
            kind: "xboxBluetooth".into(),
            name: id.into(),
            binding: Some(binding.into()),
            binding_quality: Some("serial".into()),
            binding_pairing_id: None,
            audio_gain_db: 0,
            cmiot_a15_recording_mode: Default::default(),
            voice_target: None,
            quarbor_target: None,
            hide_driver_missing_reminder: None,
            enabled: true,
            profiles: vec![Profile {
                id: "default".into(),
                name: "默认".into(),
                behaviors: serde_json::json!({}),
            }],
            active_profile_id: "default".into(),
            app_profile_switching: false,
            application_profiles: vec![],
        }
    }

    #[test]
    fn stable_profile_ids_use_existing_aliases_and_duplicate_inputs_are_rejected() {
        let mut remote = instance("remote", "physical");
        remote.kind = "rc003".into();
        let descriptor =
            crate::devices::descriptor_registry::descriptor_for_kind(&remote.kind).unwrap();
        let up = descriptor
            .inputs
            .iter()
            .find(|input| crate::devices::descriptor_registry::input_key(input) == "up")
            .unwrap();
        let payload = serde_json::json!({
            "click": [{"id": "keep-action", "type": "key", "key": "A", "enabled": false}],
            "metadata": {"label": "keep", "values": [1, true, null]}
        });
        let back =
            serde_json::json!({"click": [{"type": "key", "key": "B"}], "extra": "unchanged"});
        remote.profiles[0].behaviors = serde_json::json!({
            (up.id.clone()): payload.clone(),
            "back": back.clone()
        });
        let mut store = Store {
            instances: vec![remote],
            ..Default::default()
        };
        validate(&store).unwrap();
        normalize_instance(&mut store.instances[0]);
        let behaviors = &store.instances[0].profiles[0].behaviors;
        assert_eq!(behaviors["up"], payload);
        assert_eq!(behaviors["back"], back);
        assert!(behaviors.get(&up.id).is_none());
        let mappings = active_mappings(&store.instances[0]);
        assert!(mappings.contains_key("up"));
        assert!(mappings.contains_key("back"));
        assert!(!mappings.contains_key(&up.id));
        store.instances[0].profiles[0].behaviors = serde_json::json!({
            (up.id.clone()): {"click": [{"type": "key", "key": "A"}]},
            "up": {"click": [{"type": "key", "key": "B"}]}
        });
        let duplicate = store.instances[0].profiles[0].behaviors.clone();
        assert!(validate(&store).unwrap_err().contains("同一输入重复配置"));
        assert_eq!(store.instances[0].profiles[0].behaviors, duplicate);
    }

    #[test]
    fn load_normalizes_profile_keys_and_preserves_behavior_values_when_saved() {
        let path = std::env::temp_dir().join(format!("axonkey-profile-keys-{}.json", unique_id()));
        let mut remote = instance("remote", "");
        remote.kind = "rc003".into();
        remote.binding = None;
        let descriptor =
            crate::devices::descriptor_registry::descriptor_for_kind(&remote.kind).unwrap();
        let up = descriptor
            .inputs
            .iter()
            .find(|input| crate::devices::descriptor_registry::input_key(input) == "up")
            .unwrap();
        let payload = serde_json::json!({
            "click": [{"type": "key", "key": "A", "libraryItemId": "00000000-0000-0000-0000-000000000001"}],
            "metadata": {"keep": [1, false, "text"]}
        });
        remote.profiles[0].behaviors = serde_json::json!({(up.id.clone()): payload.clone()});
        let store = Store {
            instances: vec![remote],
            ..Default::default()
        };
        std::fs::write(&path, serde_json::to_vec(&store).unwrap()).unwrap();
        let loaded = load(&path).unwrap();
        let behaviors = &loaded.instances[0].profiles[0].behaviors;
        assert_eq!(behaviors["up"], payload);
        assert!(behaviors.get(&up.id).is_none());
        save(&path, &loaded).unwrap();
        let saved: Store = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.instances[0].profiles[0].behaviors, *behaviors);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(path.with_extension("bak")).unwrap();
    }

    #[test]
    fn put_returns_and_persists_normalized_profile_keys() {
        let manager = offline_manager(vec![]);
        let mut remote = instance("remote", "");
        remote.kind = "rc003".into();
        remote.binding = None;
        let descriptor =
            crate::devices::descriptor_registry::descriptor_for_kind(&remote.kind).unwrap();
        let up = descriptor
            .inputs
            .iter()
            .find(|input| crate::devices::descriptor_registry::input_key(input) == "up")
            .unwrap();
        let payload =
            serde_json::json!({"click": [{"type": "key", "key": "A"}], "metadata": [1, true]});
        remote.profiles[0].behaviors = serde_json::json!({(up.id.clone()): payload.clone()});
        let saved = manager.put(0, remote).unwrap();
        assert_eq!(
            saved.store.instances[0].profiles[0].behaviors,
            serde_json::json!({"up": payload})
        );
        assert_eq!(
            load(&manager.shared.path).unwrap().instances[0].profiles[0].behaviors,
            saved.store.instances[0].profiles[0].behaviors
        );
        std::fs::remove_file(&manager.shared.path).unwrap();
        std::fs::remove_file(manager.shared.path.with_extension("bak")).ok();
    }
    #[test]
    fn reorder_instances_persists_the_requested_order() {
        let path = std::env::temp_dir().join(format!("axonkey-reorder-{}.json", unique_id()));
        let manager = DeviceManager::start_with_emitter(path.clone(), Box::new(|_| {}));
        let mut first = instance("one", "");
        first.binding = None;
        let mut second = instance("two", "");
        second.binding = None;
        let mut third = instance("three", "");
        third.binding = None;
        let saved = manager.put(0, first).unwrap();
        let saved = manager.put(saved.store.revision, second).unwrap();
        let saved = manager.put(saved.store.revision, third).unwrap();
        let reordered = manager
            .reorder(
                saved.store.revision,
                &["three".into(), "one".into(), "two".into()],
            )
            .unwrap();
        assert_eq!(
            reordered
                .store
                .instances
                .iter()
                .map(|instance| instance.id.as_str())
                .collect::<Vec<_>>(),
            ["three", "one", "two"]
        );
        assert!(manager
            .reorder(
                reordered.store.revision,
                &["three".into(), "three".into(), "two".into()]
            )
            .is_err());
        manager.shutdown();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("bak"));
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
    #[test]
    fn obe_mappings_accept_projector_buttons_and_reject_a15_inputs() {
        let mut remote = instance("obe", "");
        remote.kind = "obeRcuR5".into();
        remote.binding = None;
        remote.profiles[0].behaviors = serde_json::json!({
            "obeRcuR5.locate": {"click": [{"type": "key", "key": "A"}]},
            "obeRcuR5.voice": {"click": [{"type": "key", "key": "RAlt"}]}
        });
        let mut store = Store {
            instances: vec![remote],
            ..Default::default()
        };
        assert!(validate(&store).is_ok());
        store.instances[0].profiles[0].behaviors = serde_json::json!({
            "cmiotA15.mute": {"click": [{"type": "key", "key": "A"}]}
        });
        assert!(validate(&store).is_err());
    }

    #[test]
    fn xm_bt_29_numeric_and_delete_mappings_validate() {
        let mut remote = instance("xm", "");
        remote.kind = "xmBt29".into();
        remote.binding = None;
        let mut behaviors = serde_json::Map::new();
        for id in [
            "xmBt29.digit0",
            "xmBt29.digit1",
            "xmBt29.digit2",
            "xmBt29.digit3",
            "xmBt29.digit4",
            "xmBt29.digit5",
            "xmBt29.digit6",
            "xmBt29.digit7",
            "xmBt29.digit8",
            "xmBt29.digit9",
            "xmBt29.delete",
            "cmiotA15.power",
        ] {
            behaviors.insert(
                id.into(),
                serde_json::json!({"click": [{"type": "key", "key": "A"}]}),
            );
        }
        remote.profiles[0].behaviors = serde_json::Value::Object(behaviors);
        assert!(validate(&Store {
            instances: vec![remote],
            ..Default::default()
        })
        .is_ok());
    }

    pub(super) fn offline_manager(instances: Vec<Instance>) -> DeviceManager {
        DeviceManager {
            shared: Arc::new(Shared {
                app: Mutex::new(None),
                battery_cache: Mutex::default(),
                information_requests: Mutex::new(HashSet::new()),
                recording_requests: Mutex::new(Vec::new()),
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
                emit: Arc::new(|_| {}),
                legacy_remote: Box::new(|_| true),
                #[cfg(all(windows, not(test)))]
                quarbor: None,
            }),
            worker: Mutex::new(None),
        }
    }

    #[cfg(windows)]
    #[test]
    fn tcl_information_controls_binding_and_saved_driver_targets() {
        for (kind, vendor, product, model, manufacturer, software) in [
            (
                "tclRc802a",
                0x0416,
                0x0301,
                Some("BT_RC802A"),
                Some("TCL"),
                None,
            ),
            (
                "tclRc902n",
                0x0417,
                0x0304,
                None,
                None,
                Some("TCL_RC902N_v1"),
            ),
            (
                "tclRc902v",
                0x0417,
                0x0304,
                None,
                None,
                Some("TCL_RC902V_v1"),
            ),
        ] {
            let devices = vec![crate::quarbor_installer::Device {
                instance_id: format!(
                    r"BTHLEDEVICE\{{00001812-0000-1000-8000-00805F9B34FB}}_DEV_VID&01{vendor:04X}_PID&{product:04X}_AABBCCDDEEFF\instance"
                ),
                hardware_id: String::new(),
                bluetooth_address: None,
                name: "TCL".into(),
                present: true,
                bound: true,
                recovery_active: false,
                inf: String::new(),
                section: String::new(),
            }];
            let mut discovered = vec![];
            merge_driver_devices(&mut discovered, &devices, &HashSet::new(), &HashMap::new());
            assert_eq!(discovered.len(), 1);
            discovered[0].device_info.detected_kind = Some(kind.into());
            let mut remote = instance("remote", &discovered[0].id);
            remote.kind = kind.into();
            remote.quarbor_target = Some(devices[0].instance_id.clone());
            remote.voice_target = discovered[0].bluetooth_address.clone();
            assert!(!device_kind_matches(&discovered[0], kind));
            assert!(driver_target(&remote, &[remote.clone()], &discovered, &devices).is_none());
            let manager = offline_manager(vec![]);
            manager.shared.snapshot.lock().unwrap().discovered = discovered.clone();
            assert!(manager.put(0, remote.clone()).is_err());
            let mut info = device_info::DeviceInformation {
                status: "ready".into(),
                model_number: model.map(str::to_owned),
                manufacturer: manufacturer.map(str::to_owned),
                software_revision: software.map(str::to_owned),
                ..Default::default()
            };
            device_info::apply_information(&manager.shared, &discovered[0], info.clone());
            let snapshot = manager.snapshot();
            assert_eq!(snapshot.discovered[0].kind, kind);
            assert_eq!(
                snapshot.discovered[0].device_info.detected_kind.as_deref(),
                Some(kind)
            );
            assert!(manager.put(0, remote.clone()).is_ok());
            assert_eq!(
                driver_target(&remote, &[remote.clone()], &snapshot.discovered, &devices),
                Some((devices[0].instance_id.clone(), true))
            );
            info.model_number = Some("other".into());
            info.manufacturer = Some("other".into());
            info.software_revision = Some("other".into());
            device_info::apply_information(&manager.shared, &snapshot.discovered[0], info);
            assert!(driver_target(
                &remote,
                &[remote.clone()],
                &manager.snapshot().discovered,
                &devices
            )
            .is_none());
            let _ = std::fs::remove_file(&manager.shared.path);
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
    #[cfg(windows)]
    fn driver_connection_checks_presence_before_installation_or_capture() {
        assert_eq!(driver_connection_state(None, false, false), "offline");
        assert_eq!(driver_connection_state(None, true, true), "offline");
        assert_eq!(
            driver_connection_state(Some("device"), false, false),
            "missing"
        );
        assert_eq!(
            driver_connection_state(Some("device"), true, false),
            "connecting"
        );
        assert_eq!(
            driver_connection_state(Some("device"), true, true),
            "connected"
        );
    }

    #[test]
    #[cfg(windows)]
    fn a15_discovery_and_driver_resolution_stay_with_each_physical_device() {
        let node = |address: &str, bound| crate::quarbor_installer::Device {
            instance_id: format!(
                r"BTHLEDEVICE\{{00001812-0000-1000-8000-00805F9B34FB}}_DEV_VID&010416_PID&0300_REV&0100_{address}\instance"
            ),
            hardware_id: String::new(),
            bluetooth_address: None,
            name: "CMIOT-A15".into(),
            present: true,
            bound,
            recovery_active: false,
            inf: String::new(),
            section: String::new(),
        };
        let devices = vec![node("AABBCCDDEE01", true), node("AABBCCDDEE02", false)];
        let mut discovered = vec![];
        merge_driver_devices(&mut discovered, &devices, &HashSet::new(), &HashMap::new());
        merge_driver_devices(&mut discovered, &devices, &HashSet::new(), &HashMap::new());
        assert_eq!(discovered.len(), 2);
        assert_ne!(discovered[0].id, discovered[1].id);
        assert!(discovered
            .iter()
            .all(|d| d.kind == "cmiotA15" && d.connected));
        let instances: Vec<_> = discovered
            .iter()
            .enumerate()
            .map(|(index, d)| {
                let mut item = instance(&format!("remote-{index}"), &d.id);
                item.kind = "cmiotA15".into();
                item.voice_target = d.bluetooth_address.clone();
                item
            })
            .collect();
        for index in 0..2 {
            assert_eq!(
                driver_target(&instances[index], &instances, &discovered, &devices),
                Some((devices[index].instance_id.clone(), index == 0))
            );
        }
        assert_eq!(
            driver_target(&instances[1], &instances, &[], &devices[..1]),
            None
        );
        let mut unknown = instances[0].clone();
        unknown.voice_target = None;
        assert_eq!(
            driver_target(&unknown, &[unknown.clone()], &[], &devices[..1]),
            None
        );
        let mut wrong_model = instances[0].clone();
        wrong_model.kind = "rc003".into();
        assert_eq!(
            driver_target(&wrong_model, &[wrong_model.clone()], &discovered, &devices),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn obe_pairing_and_driver_resolution_do_not_match_mobile_remotes() {
        let devices = vec![crate::quarbor_installer::Device {
            instance_id: r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&011D5A_PID&C081_REV&0000_C9B5965E4F92\8&30D338AA&0&001F".into(),
            hardware_id: String::new(),
            bluetooth_address: None,
            name: "OBE_RCU_R5".into(),
            present: true,
            bound: true,
            recovery_active: false,
            inf: String::new(),
            section: String::new(),
        }];
        let mut discovered = vec![];
        paired::merge(
            &mut discovered,
            &[paired::Device {
                address: "c9b5965e4f92".into(),
                name: "OBE_RCU_R5".into(),
                vendor_id: 0x1d5a,
                product_id: 0xc081,
            }],
            &HashSet::new(),
            &HashMap::new(),
        );
        merge_driver_devices(&mut discovered, &devices, &HashSet::new(), &HashMap::new());
        assert_eq!(discovered.len(), 1);
        assert!(discovered[0].connected && discovered[0].paired);
        assert_eq!(discovered[0].kind, "obeRcuR5");
        assert!(!device_kind_matches(&discovered[0], "cmiotA15"));
        assert!(!devices[0].matches_kind("rc313"));

        let mut remote = instance("projector", &discovered[0].id);
        remote.kind = "obeRcuR5".into();
        remote.voice_target = discovered[0].bluetooth_address.clone();
        assert_eq!(
            driver_target(&remote, &[remote.clone()], &discovered, &devices),
            Some((devices[0].instance_id.clone(), true))
        );
    }

    #[cfg(windows)]
    #[test]
    fn rc313_pairing_resolves_to_its_live_a15_driver_node() {
        let devices = vec![crate::quarbor_installer::Device {
            instance_id: r"BTHLEDEVICE{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&050416_PID&0300_REV&0505_0CF3CE7F241E\8&11237C06&0&0025".into(),
            hardware_id: String::new(),
            bluetooth_address: None,
            name: "YYYKQ".into(),
            present: true,
            bound: false,
            recovery_active: false,
            inf: String::new(),
            section: String::new(),
        }];
        let mut discovered = vec![];
        paired::merge(
            &mut discovered,
            &[paired::Device {
                address: "0cf3ce7f241e".into(),
                name: "YYYKQ".into(),
                vendor_id: 0x0416,
                product_id: 0x0300,
            }],
            &HashSet::new(),
            &HashMap::new(),
        );
        let mut remote = instance("rc313", &discovered[0].id);
        remote.kind = "cmiotA15".into();
        remote.binding_pairing_id = discovered[0].pairing_id.clone();
        remote.voice_target = discovered[0].bluetooth_address.clone();
        assert!(!discovered[0].connected);

        merge_driver_devices(&mut discovered, &devices, &HashSet::new(), &HashMap::new());
        assert_eq!(discovered.len(), 1);
        assert!(discovered[0].connected && discovered[0].paired);
        assert_eq!(Some(&discovered[0].id), remote.binding.as_ref());
        let (target, installed) =
            driver_target(&remote, &[remote.clone()], &discovered, &devices).unwrap();
        assert_eq!(target, devices[0].instance_id);
        assert_eq!(
            driver_connection_state(Some(&target), installed, false),
            "missing"
        );

        let mut installed_devices = devices.clone();
        installed_devices[0].bound = true;
        assert_eq!(
            driver_target(&remote, &[remote.clone()], &[], &installed_devices),
            Some((target, true))
        );
        assert!(driver_target(&remote, &[remote.clone()], &discovered, &[]).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn xbox_driver_resolution_tracks_each_hid_node_and_installed_bluetooth_parent() {
        let first = crate::quarbor_installer::Device {
            instance_id: r"HID\{00001124-0000-1000-8000-00805F9B34FB}&VID_045E&PID_02E0&IG_00\C&1B61B8A0&0&0000".into(),
            hardware_id: String::new(), bluetooth_address: Some("AABBCCDDEE01".into()),
            present: true, bound: false, recovery_active: false,
            name: "Xbox".into(), inf: String::new(), section: String::new(),
        };
        let mut second = first.clone();
        second.instance_id = second
            .instance_id
            .replace("1B61B8A0", "12345678")
            .replace("&VID_045E&PID_02E0&IG_00", "_VID&0002045E_PID&02E0");
        second.bluetooth_address = Some("AABBCCDDEE02".into());
        second.bound = true;
        let devices = vec![first, second];
        let mut discovered = vec![];
        merge_driver_devices(&mut discovered, &devices, &HashSet::new(), &HashMap::new());
        assert_eq!(discovered.len(), 2);
        let instances: Vec<_> = discovered
            .iter()
            .enumerate()
            .map(|(i, d)| instance(&format!("pad-{i}"), &d.id))
            .collect();
        for i in 0..2 {
            assert_eq!(
                driver_target(&instances[i], &instances, &discovered, &devices),
                Some((devices[i].instance_id.clone(), i == 1))
            );
        }
        discovered[0].hid_instance_id = Some(devices[0].instance_id.to_lowercase());
        discovered[0].bluetooth_address = None;
        assert_eq!(
            driver_target(&instances[0], &instances, &discovered, &devices),
            Some((devices[0].instance_id.clone(), false))
        );
        assert_eq!(
            driver_target(&instances[0], &instances, &discovered, &devices[1..]),
            None
        );
        let mut installed = instances[1].clone();
        installed.quarbor_target = Some(devices[1].instance_id.clone());
        assert_eq!(
            driver_target(&installed, &instances, &[], &devices),
            Some((devices[1].instance_id.clone(), true))
        );
        installed.binding = None;
        assert_eq!(
            driver_target(&installed, &instances, &discovered, &devices),
            None
        );
    }

    #[test]
    fn a15_driver_binding_recording_mode_and_unbind_are_instance_scoped() {
        let mut first = instance("desk", "a15-one");
        first.kind = "cmiotA15".into();
        first.hide_driver_missing_reminder = Some(true);
        let mut second = instance("sofa", "a15-two");
        second.kind = "cmiotA15".into();
        let manager = offline_manager(vec![first.clone(), second]);
        first.cmiot_a15_recording_mode = crate::devices::cmiot_a15::recording::RecordingMode::Hold;
        manager.put(0, first).unwrap();
        manager
            .remember_quarbor_target("desk", "first-target")
            .unwrap();
        manager
            .remember_quarbor_target("sofa", "second-target")
            .unwrap();
        let saved = load(&manager.shared.path).unwrap();
        assert_eq!(
            saved.instances[0].cmiot_a15_recording_mode,
            crate::devices::cmiot_a15::recording::RecordingMode::Hold
        );
        assert_eq!(
            saved.instances[1].cmiot_a15_recording_mode,
            crate::devices::cmiot_a15::recording::RecordingMode::Click
        );
        let unbound = manager.unbind("desk").unwrap();
        assert!(unbound.store.instances[0].binding.is_none());
        assert!(unbound.store.instances[0].quarbor_target.is_none());
        assert!(unbound.store.instances[0]
            .hide_driver_missing_reminder
            .is_none());
        assert_eq!(
            unbound.store.instances[1].quarbor_target.as_deref(),
            Some("second-target")
        );
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }

    #[test]
    fn hold_recording_modes_are_always_saved_as_hold() {
        for kind in ["xmBt29", "rc313", "obeRcuR5", "tclRc802a"] {
            let mut remote = instance(kind, "unused");
            remote.kind = kind.into();
            remote.binding = None;
            remote.cmiot_a15_recording_mode =
                crate::devices::cmiot_a15::recording::RecordingMode::Click;
            let manager = offline_manager(vec![]);
            let saved = manager.put(0, remote).unwrap();
            assert_eq!(
                saved.store.instances[0].cmiot_a15_recording_mode,
                crate::devices::cmiot_a15::recording::RecordingMode::Hold
            );
            let _ = std::fs::remove_file(&manager.shared.path);
            let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
        }
    }

    #[test]
    fn loaded_recording_modes_fix_hold_only_remotes_and_preserve_a15_choices() {
        use crate::devices::cmiot_a15::recording::RecordingMode;
        let remotes = [
            ("xmBt29", RecordingMode::Click),
            ("rc313", RecordingMode::Click),
            ("obeRcuR5", RecordingMode::Click),
            ("tclRc802a", RecordingMode::Click),
            ("cmiotA15", RecordingMode::Click),
            ("cmiotA15", RecordingMode::Hold),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (kind, mode))| {
            let mut remote = instance(&index.to_string(), "unused");
            remote.kind = kind.into();
            remote.binding = None;
            remote.cmiot_a15_recording_mode = mode;
            remote
        })
        .collect();
        let manager = offline_manager(remotes);
        save(&manager.shared.path, &manager.snapshot().store).unwrap();
        let loaded = load(&manager.shared.path).unwrap();
        assert_eq!(
            loaded
                .instances
                .iter()
                .map(|remote| remote.cmiot_a15_recording_mode)
                .collect::<Vec<_>>(),
            [
                RecordingMode::Hold,
                RecordingMode::Hold,
                RecordingMode::Hold,
                RecordingMode::Hold,
                RecordingMode::Click,
                RecordingMode::Hold
            ]
        );
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }

    #[test]
    fn manual_a15_recording_requires_an_enabled_bound_a15_channel() {
        let mut a15 = instance("a15", "physical-a15");
        a15.kind = "cmiotA15".into();
        let manager = offline_manager(vec![a15, instance("controller", "physical-controller")]);
        assert!(manager
            .toggle_recording("missing")
            .unwrap_err()
            .contains("已被移除"));
        assert!(manager
            .toggle_recording("controller")
            .unwrap_err()
            .contains("仅 CMIOT A15"));
        assert!(manager.toggle_recording("a15").is_err());
        manager.set_enabled(true);
        manager.shared.snapshot.lock().unwrap().runtime.insert(
            "a15".into(),
            RuntimeStatus {
                state: "exclusive".into(),
                ..Default::default()
            },
        );
        assert!(manager.validate_recording_target("a15").is_ok());
        manager.shared.snapshot.lock().unwrap().store.instances[0].enabled = false;
        assert!(manager.toggle_recording("a15").is_err());
        manager.shared.snapshot.lock().unwrap().store.instances[0].enabled = true;
        manager.shared.snapshot.lock().unwrap().store.instances[0].binding = None;
        assert!(manager.toggle_recording("a15").is_err());
        assert!(manager.shared.recording_requests.lock().unwrap().is_empty());
    }

    #[test]
    fn rc003_audio_gain_edits_persist_without_changing_other_devices() {
        let mut first = instance("desk", "remote-one");
        first.kind = "rc003".into();
        first.voice_target = Some("C05D39C2CF83".into());
        let mut second = instance("sofa", "remote-two");
        second.kind = "rc003".into();
        second.audio_gain_db = -6;
        let manager = offline_manager(vec![first, second]);
        for gain in [19, -12, 0] {
            let snapshot = manager.snapshot();
            let mut edited = snapshot.store.instances[0].clone();
            edited.audio_gain_db = gain;
            let saved = manager.put(snapshot.store.revision, edited).unwrap();
            assert_eq!(saved.store.instances[0].audio_gain_db, gain);
            let persisted = load(&manager.shared.path).unwrap();
            assert_eq!(persisted.instances[0].audio_gain_db, gain);
            assert_eq!(
                saved.store.instances[0].voice_target.as_deref(),
                Some("C05D39C2CF83")
            );
            assert_eq!(persisted.instances[1].audio_gain_db, -6);
            let target = crate::audio_targets(&saved)
                .into_iter()
                .find(|target| target.instance_id == "desk")
                .unwrap();
            assert_eq!(target.gain_db, gain);
        }
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }

    pub(super) fn information_remote(id: &str, address: &str) -> Discovered {
        Discovered {
            id: id.into(),
            kind: "cmiotA15".into(),
            name: "remote".into(),
            transport: "Bluetooth".into(),
            identity_quality: "serial".into(),
            vendor_id: 0x0416,
            product_id: 0x0300,
            connected: true,
            paired: true,
            pairing_id: None,
            bluetooth_address: Some(address.into()),
            hid_instance_id: None,
            device_info: Default::default(),
        }
    }

    #[test]
    fn information_refresh_queues_only_the_selected_connected_remote() {
        let manager = offline_manager(vec![]);
        let mut devices = [
            information_remote("one", "AA:BB:CC:DD:EE:01"),
            information_remote("two", "AA:BB:CC:DD:EE:02"),
        ];
        for device in &mut devices {
            device.device_info.status = "ready".into();
            device.device_info.battery_level = Some(54);
        }
        manager.shared.snapshot.lock().unwrap().discovered = devices.into();
        let snapshot = manager.refresh_information("one").unwrap();
        assert_eq!(snapshot.discovered[0].device_info.status, "pending");
        assert_eq!(snapshot.discovered[0].device_info.battery_level, Some(54));
        assert_eq!(snapshot.discovered[1].device_info.status, "ready");
        manager.refresh_information("one").unwrap();
        assert_eq!(
            *manager.shared.information_requests.lock().unwrap(),
            HashSet::from(["one".into()])
        );
        assert!(manager.refresh_information("missing").is_err());
        manager.shared.snapshot.lock().unwrap().discovered[1].connected = false;
        assert!(manager.refresh_information("two").is_err());
        assert_eq!(manager.shared.information_requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn last_battery_survives_failed_reads_and_is_restored_on_reconnect_and_restart() {
        let manager = offline_manager(vec![]);
        let remote = information_remote("one", "AA:BB:CC:DD:EE:01");
        let shared = &manager.shared;
        shared.snapshot.lock().unwrap().discovered = vec![remote.clone()];
        device_info::apply_information(
            shared,
            &remote,
            device_info::DeviceInformation {
                battery_level: Some(54),
                ..Default::default()
            },
        );
        device_info::apply_information(
            shared,
            &remote,
            device_info::DeviceInformation {
                status: "retrying".into(),
                error: Some("设备信息读取超时".into()),
                ..Default::default()
            },
        );
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.discovered[0].device_info.battery_level, Some(54));
        assert_eq!(snapshot.discovered[0].device_info.status, "retrying");

        let mut offline = remote.clone();
        offline.connected = false;
        let mut discovered = [offline];
        let cache = shared.battery_cache.lock().unwrap();
        device_info::retain_readings(&mut discovered, &snapshot.discovered, &cache);
        assert_eq!(discovered[0].device_info.battery_level, None);
        let mut reconnected = [remote.clone()];
        device_info::retain_readings(&mut reconnected, &discovered, &cache);
        assert_eq!(reconnected[0].device_info.battery_level, Some(54));
        drop(cache);

        device_info::apply_information(
            shared,
            &remote,
            device_info::DeviceInformation {
                battery_level: Some(0),
                ..Default::default()
            },
        );
        let reloaded = device_info::BatteryCache::load(&shared.path);
        let other = information_remote("two", "AA:BB:CC:DD:EE:02");
        let mut ambiguous = remote.clone();
        ambiguous.identity_quality = "ambiguous".into();
        let mut restarted = [remote, other, ambiguous];
        device_info::retain_readings(&mut restarted, &[], &reloaded);
        assert_eq!(restarted[0].device_info.battery_level, Some(0));
        assert_eq!(restarted[0].device_info.status, "pending");
        assert_eq!(restarted[1].device_info.battery_level, None);
        assert_eq!(restarted[2].device_info.battery_level, None);
        std::fs::remove_file(shared.path.with_extension("battery.json")).unwrap();
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
            device_info: Default::default(),
            pairing_id: None,
            bluetooth_address: None,
            hid_instance_id: None,
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
    fn unbind_clears_physical_identity_and_driver_target() {
        let mut saved_instance = instance("one", "physical-one");
        saved_instance.kind = "rc003".into();
        saved_instance.quarbor_target = Some(r"BTHLEDEVICE\target".into());
        saved_instance.hide_driver_missing_reminder = Some(true);
        let manager = offline_manager(vec![saved_instance]);
        let snapshot = manager.unbind("one").unwrap();
        let cleared = &snapshot.store.instances[0];
        assert!(cleared.binding.is_none());
        assert!(cleared.binding_quality.is_none());
        assert!(cleared.binding_pairing_id.is_none());
        assert!(cleared.voice_target.is_none());
        assert!(cleared.quarbor_target.is_none());
        assert!(cleared.hide_driver_missing_reminder.is_none());
        let persisted = load(&manager.shared.path).unwrap();
        assert!(serde_json::to_value(&persisted.instances[0])
            .unwrap()
            .get("hideDriverMissingReminder")
            .is_none());
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }
    #[test]
    fn hidden_driver_reminder_is_persisted_per_instance() {
        let manager = offline_manager(vec![instance("one", "a"), instance("two", "b")]);
        let mut changed = manager.snapshot().store.instances[0].clone();
        changed.hide_driver_missing_reminder = Some(true);
        let saved = manager.put(0, changed).unwrap();
        let mut renamed = saved.store.instances[0].clone();
        renamed.name = "Desk remote".into();
        manager.put(saved.store.revision, renamed).unwrap();
        let persisted = load(&manager.shared.path).unwrap();
        assert_eq!(
            persisted.instances[0].hide_driver_missing_reminder,
            Some(true)
        );
        assert_eq!(persisted.instances[1].hide_driver_missing_reminder, None);
        let legacy = serde_json::to_value(&persisted.instances[1]).unwrap();
        assert!(legacy.get("hideDriverMissingReminder").is_none());
        assert_eq!(
            serde_json::from_value::<Instance>(legacy)
                .unwrap()
                .hide_driver_missing_reminder,
            None
        );
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
    }
    #[test]
    fn voice_session_edges_keep_hold_and_click_independent_and_close_removed_inputs() {
        let empty = HashMap::new();
        let hold = HashMap::from([("one".to_owned(), "hold".to_owned())]);
        assert_eq!(
            voice_session_changes(&empty, &hold),
            [("one".into(), Some("hold".into()))]
        );
        assert!(voice_session_changes(&hold, &hold).is_empty());
        let click = HashMap::from([("one".to_owned(), "click".to_owned())]);
        assert_eq!(
            voice_session_changes(&hold, &click),
            [("one".into(), None), ("one".into(), Some("click".into()))]
        );
        let both = HashMap::from([
            ("one".to_owned(), "click".to_owned()),
            ("two".to_owned(), "hold".to_owned()),
        ]);
        assert_eq!(
            voice_session_changes(&click, &both),
            [("two".into(), Some("hold".into()))]
        );
        assert_eq!(voice_session_changes(&both, &click), [("two".into(), None)]);
        assert_eq!(
            voice_session_changes(&click, &empty),
            [("one".into(), None)]
        );
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
    fn profile_switch_notification_names_require_a_saved_change() {
        let mut device = instance("one", "physical-one");
        device.profiles.push(Profile {
            id: "game".into(),
            name: "游戏".into(),
            behaviors: serde_json::json!({}),
        });
        let manager = offline_manager(vec![device]);
        let shared = &manager.shared;
        assert_eq!(
            save_profile_switch(shared, "one", ProfileDirection::Next, false),
            Some(("one".into(), "默认".into(), "游戏".into()))
        );
        assert_eq!(
            load(&shared.path).unwrap().instances[0].active_profile_id,
            "game"
        );
        assert_eq!(
            save_profile_switch(shared, "one", ProfileDirection::Next, false),
            None
        );
        assert_eq!(
            save_profile_switch(shared, "missing", ProfileDirection::Next, true),
            None
        );
        assert_eq!(
            save_profile_switch(shared, "one", ProfileDirection::Next, true),
            Some(("one".into(), "游戏".into(), "默认".into()))
        );
        // A directory at the temporary file path makes the actual save fail.
        let temp = shared.path.with_extension("tmp");
        std::fs::create_dir(&temp).unwrap();
        assert_eq!(
            save_profile_switch(shared, "one", ProfileDirection::Next, false),
            None
        );
        assert_eq!(
            shared.snapshot.lock().unwrap().store.instances[0].active_profile_id,
            "default"
        );
        assert!(shared.snapshot.lock().unwrap().error.is_some());
        std::fs::remove_dir(temp).unwrap();
        let _ = std::fs::remove_file(&shared.path);
        let _ = std::fs::remove_file(shared.path.with_extension("bak"));
    }

    #[test]
    fn app_profile_switches_persist_the_app_binding_and_leave_global_and_other_devices_untouched() {
        let mut first = instance("one", "physical-one");
        first.profiles.extend([
            Profile {
                id: "browser".into(),
                name: "浏览器".into(),
                behaviors: serde_json::json!({}),
            },
            Profile {
                id: "editor".into(),
                name: "编辑器".into(),
                behaviors: serde_json::json!({}),
            },
        ]);
        first.app_profile_switching = true;
        for (id, name, profile) in [
            ("chrome", "Chrome", "browser"),
            ("code", "VS Code", "editor"),
        ] {
            first.application_profiles.push(ApplicationProfile {
                application: crate::foreground::Application {
                    id: id.into(),
                    name: name.into(),
                    path: format!("/{name}.app"),
                },
                profile_id: profile.into(),
            });
        }
        let second = instance("two", "physical-two");
        let manager = offline_manager(vec![first, second.clone()]);
        let names = save_profile_switch_for_app(
            &manager.shared,
            "one",
            ProfileDirection::Next,
            true,
            Some("chrome"),
        )
        .unwrap();
        assert_eq!(
            names,
            (
                "Chrome 的设备配置 · one".into(),
                "浏览器".into(),
                "编辑器".into()
            )
        );
        let saved = load(&manager.shared.path).unwrap();
        assert_eq!(saved.instances[0].active_profile_id, "default");
        assert_eq!(
            saved.instances[0].application_profiles[0].profile_id,
            "editor"
        );
        assert!(saved.instances[1] == second);
        assert_eq!(
            effective_instance(&saved.instances[0], Some("chrome")).active_profile_id,
            "editor"
        );
        assert_eq!(
            effective_instance(&saved.instances[0], Some("code")).active_profile_id,
            "editor"
        );
        assert_eq!(
            effective_instance(&saved.instances[0], Some("unknown")).active_profile_id,
            "default"
        );
        save_profile_switch_for_app(
            &manager.shared,
            "one",
            ProfileDirection::Next,
            true,
            Some("unknown"),
        )
        .unwrap();
        let saved = load(&manager.shared.path).unwrap();
        assert_eq!(saved.instances[0].active_profile_id, "browser");
        assert_eq!(
            saved.instances[0].application_profiles[0].profile_id,
            "editor"
        );
        assert_eq!(
            saved.instances[0].application_profiles[1].profile_id,
            "editor"
        );
        let _ = std::fs::remove_file(&manager.shared.path);
        let _ = std::fs::remove_file(manager.shared.path.with_extension("bak"));
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
            device_info: Default::default(),
            pairing_id: Some("pairing-controller".into()),
            bluetooth_address: None,
            hid_instance_id: None,
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
            device_info: Default::default(),
            pairing_id: Some(canonical.clone()),
            bluetooth_address: Some("AA:BB:CC:DD:EE:01".into()),
            hid_instance_id: None,
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

    #[test]
    fn hisense_rcf3b65_direct_pointer_reports_bypass_button_decoding() {
        assert!(accept_direct_pointer_report(
            "hisenseRcf3b65",
            &[0x3f, 0x10, 0x90, 0x63, 0x27, 0x0d, 0x00, 0x00, 0x00]
        ));
        assert!(!accept_direct_pointer_report(
            "hisenseRcf3b65",
            &[0x01, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00]
        ));
        assert!(!accept_direct_pointer_report(
            "tclRc802a",
            &[0x3f, 0x10, 0x90, 0x63, 0x27, 0x0d, 0x00, 0x00, 0x00]
        ));
    }
}
