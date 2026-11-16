use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Clone, Debug, Serialize)]
pub struct AudioWaveformPoint {
    pub t: u64,
    pub peak: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
    pub peak: f64,
    pub rms: f64,
    pub now_ms: u64,
    pub waveform: Vec<AudioWaveformPoint>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioServiceStatus {
    pub driver_installed: bool,
    pub state: String,
    pub bluetooth_connected: bool,
    pub forwarding: bool,
    pub received_data: bool,
    pub output_ready: bool,
    pub event_version: u64,
    pub error: Option<String>,
}

pub(crate) const AUDIO_GAIN_MIN_DB: i16 = -30;
pub(crate) const AUDIO_GAIN_MAX_DB: i16 = 30;

pub(crate) fn clamp_gain_db(gain: i16) -> i16 {
    gain.clamp(AUDIO_GAIN_MIN_DB, AUDIO_GAIN_MAX_DB)
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(crate) mod diagnostics;
#[cfg(target_os = "macos")]
pub(crate) mod signal_monitor;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use self::AudioService as PlatformAudioService;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::devices::xiaomi_remote::voice::AudioService as PlatformAudioService;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct AudioService;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl AudioService {
    pub fn level(&self) -> AudioLevel {
        AudioLevel::default()
    }

    pub fn start() -> Self {
        log::info!(target: "axonkey::audio", "Audio service is unsupported on this platform");
        Self
    }

    pub fn refresh(&self) {}

    pub fn pause(&self) {}

    pub fn resume(&self) {}

    pub fn set_enabled(&self, _enabled: bool) {}

    pub fn set_recording_mode(&self, _mode: crate::devices::cmiot_a15::recording::RecordingMode) {}

    pub fn start_for(_target_identity: Option<String>) -> Self {
        Self::start()
    }

    pub fn start_rc902(_kind: &str, _target_identity: Option<String>) -> Self {
        Self::start()
    }

    pub fn restart(&self) -> Result<(), String> {
        Err("当前系统暂不支持语音音频服务".into())
    }

    pub fn set_gain_db(&self, _gain: i16) -> Result<(), String> {
        log::warn!(target: "axonkey::audio", "Audio gain requested on an unsupported platform");
        Err("音频增益仅支持 macOS 音频转发".into())
    }

    pub fn status(&self) -> AudioServiceStatus {
        AudioServiceStatus {
            state: "unsupported".into(),
            ..AudioServiceStatus::default()
        }
    }
}

/// A device-scoped audio service configuration. The target identity is kept
/// separate from the user-facing instance ID because Bluetooth transports use
/// platform-specific identities.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioTarget {
    pub instance_id: String,
    pub kind: String,
    pub voice_target: Option<String>,
    pub gain_db: i16,
    pub recording_mode: crate::devices::cmiot_a15::recording::RecordingMode,
    pub enabled: bool,
}

/// Owns one platform audio service per configured voice-capable instance.
///
/// The legacy service remains available for the old global setup page and the
/// unscoped commands. Instance UI and commands address a service
/// by `instance_id`.
pub struct AudioServiceManager {
    instances: Arc<InstanceServices>,
    legacy: Arc<PlatformAudioService>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct InstanceServices {
    services: Mutex<BTreeMap<String, Arc<PlatformAudioService>>>,
    request: Mutex<InstanceSync>,
    changed: Condvar,
}

#[derive(Default)]
struct InstanceSync {
    targets: Vec<AudioTarget>,
    pending: bool,
    stopped: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl AudioServiceManager {
    pub fn start() -> Self {
        Self::spawn(Arc::new(PlatformAudioService::start()))
    }

    fn spawn(legacy: Arc<PlatformAudioService>) -> Self {
        let instances = Arc::new(InstanceServices::default());
        let worker_instances = Arc::clone(&instances);
        let worker = thread::Builder::new()
            .name("Axonkey audio instances".into())
            .spawn(move || reconcile_instances(worker_instances))
            .map_err(|error| {
                log::error!(target: "axonkey::audio", "Cannot start the audio instance worker: {error}");
                instances.request.lock().unwrap().stopped = true;
            })
            .ok();
        Self {
            instances,
            legacy,
            worker,
        }
    }

    fn service(&self, instance_id: Option<&str>) -> Option<Arc<PlatformAudioService>> {
        match instance_id {
            Some(id) => self.instances.services.lock().ok()?.get(id).cloned(),
            None => Some(Arc::clone(&self.legacy)),
        }
    }

    pub fn sync_instances(&self, targets: &[AudioTarget]) {
        let mut request = self.instances.request.lock().unwrap();
        if request.stopped || request.targets == targets {
            return;
        }
        request.targets = targets.to_vec();
        request.pending = true;
        self.instances.changed.notify_one();
    }

    pub fn status(&self, instance_id: Option<&str>) -> AudioServiceStatus {
        self.service(instance_id)
            .map(|service| service.status())
            .unwrap_or_else(|| AudioServiceStatus {
                driver_installed: self.legacy.status().driver_installed,
                state: "stopped".into(),
                ..AudioServiceStatus::default()
            })
    }

    pub fn level(&self, instance_id: Option<&str>) -> AudioLevel {
        self.service(instance_id)
            .map(|service| service.level())
            .unwrap_or_default()
    }

    pub fn refresh(&self, instance_id: Option<&str>) {
        if let Some(service) = self.service(instance_id) {
            service.refresh();
        }
    }

    pub fn pause(&self, instance_id: Option<&str>) {
        if let Some(service) = self.service(instance_id) {
            service.pause();
        }
    }

    pub fn resume(&self, instance_id: Option<&str>) {
        if let Some(service) = self.service(instance_id) {
            service.resume();
        }
    }

    pub fn set_gain_db(&self, instance_id: Option<&str>, gain: i16) -> Result<(), String> {
        self.service(instance_id)
            .ok_or_else(|| "设备音频服务尚未启动".to_string())?
            .set_gain_db(gain)
    }

    pub fn restart(&self, instance_id: Option<&str>) -> Result<(), String> {
        self.service(instance_id)
            .ok_or_else(|| "设备音频服务尚未启动".to_string())?
            .restart()
    }

    pub fn set_stretch_compensation(
        &self,
        instance_id: Option<&str>,
        enabled: bool,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            return self
                .service(instance_id)
                .ok_or_else(|| "设备音频服务尚未启动".to_string())?
                .set_stretch_compensation(enabled);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (instance_id, enabled);
            Err("拉伸补偿实验仅支持 macOS 音频转发".into())
        }
    }

    pub fn signal_snapshot(
        &self,
        instance_id: Option<&str>,
        after: Option<u64>,
        clear: bool,
    ) -> serde_json::Value {
        #[cfg(target_os = "macos")]
        {
            return self
                .service(instance_id)
                .map(|service| service.signal_snapshot(after, clear))
                .unwrap_or_else(|| serde_json::json!({}));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (instance_id, after, clear);
            serde_json::json!({})
        }
    }

    pub fn stop_signal_monitor(&self, instance_id: Option<&str>) {
        #[cfg(target_os = "macos")]
        if let Some(service) = self.service(instance_id) {
            service.stop_signal_monitor();
        }
        #[cfg(not(target_os = "macos"))]
        let _ = instance_id;
    }

    pub(crate) fn set_a15_input_state(
        &self,
        instance_id: Option<&str>,
        connected: bool,
        recording: bool,
    ) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Some(service) = self.service(instance_id) {
            service.set_a15_input_state(connected, recording);
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let _ = (instance_id, connected, recording);
    }

    pub(crate) fn push_a15_pcm(&self, instance_id: Option<&str>, samples: &[i16]) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Some(service) = self.service(instance_id) {
            service.push_a15_pcm(samples);
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let _ = (instance_id, samples);
    }

    pub(crate) fn handle_voice_key_edge(&self, instance_id: Option<&str>, pressed: bool) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Some(service) = self.service(instance_id) {
            service.handle_voice_key_edge(pressed);
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let _ = (instance_id, pressed);
    }
}

impl Drop for AudioServiceManager {
    fn drop(&mut self) {
        self.instances.request.lock().unwrap().stopped = true;
        self.instances.changed.notify_one();
        // macOS bridge cleanup dispatches to the main queue. Joining that worker
        // from a main-thread command would prevent it from finishing.
        self.worker.take();
    }
}

fn reconcile_instances(instances: Arc<InstanceServices>) {
    let mut identities = BTreeMap::new();
    let mut retired = Vec::new();
    loop {
        let mut request = instances.request.lock().unwrap();
        if !request.pending && !request.stopped {
            request = if retired.is_empty() {
                instances.changed.wait(request).unwrap()
            } else {
                instances
                    .changed
                    .wait_timeout(request, Duration::from_millis(25))
                    .unwrap()
                    .0
            };
        }
        if request.stopped {
            drop(request);
            let services = std::mem::take(&mut *instances.services.lock().unwrap());
            for (_, service) in services {
                service.set_enabled(false);
                retired.push(service);
            }
            while !retired.is_empty() {
                release_retired(&mut retired);
                if !retired.is_empty() {
                    thread::sleep(Duration::from_millis(25));
                }
            }
            return;
        }
        let targets = request.pending.then(|| request.targets.clone());
        request.pending = false;
        drop(request);
        if let Some(targets) = targets {
            reconcile_targets(&instances, &targets, &mut identities, &mut retired);
        }
        release_retired(&mut retired);
    }
}

fn reconcile_targets(
    instances: &InstanceServices,
    targets: &[AudioTarget],
    identities: &mut BTreeMap<String, (String, Option<String>)>,
    retired: &mut Vec<Arc<PlatformAudioService>>,
) {
    let active = targets
        .iter()
        .filter(|target| !target.instance_id.is_empty())
        .map(|target| (target.instance_id.clone(), service_identity(target)))
        .collect::<BTreeMap<_, _>>();
    let removed = {
        let mut services = instances.services.lock().unwrap();
        let ids = services
            .keys()
            .filter(|id| {
                active
                    .get(*id)
                    .is_none_or(|target| identities.get(*id) != Some(target))
            })
            .cloned()
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| services.remove(&id))
            .collect::<Vec<_>>()
    };
    for service in removed {
        service.set_enabled(false);
        retired.push(service);
    }
    identities.retain(|id, _| active.contains_key(id));

    for target in targets
        .iter()
        .filter(|target| !target.instance_id.is_empty())
    {
        let existing = instances
            .services
            .lock()
            .unwrap()
            .get(&target.instance_id)
            .cloned();
        let service = existing.unwrap_or_else(|| {
            #[cfg(windows)]
            return Arc::new(PlatformAudioService::start_paused_for(
                &target.kind,
                service_identity(target).1,
            ));
            #[cfg(target_os = "macos")]
            return match crate::devices::descriptor_registry::voice_engine(&target.kind) {
                Some("cmiot-a15.g7221" | "obe-rcu-r5.sbc" | "tcl-rc802a.ico") => {
                    Arc::new(PlatformAudioService::start_a15())
                }
                Some("tcl-rc902v-atvv") => Arc::new(PlatformAudioService::start_rc902(
                    &target.kind,
                    target.voice_target.clone(),
                )),
                _ => Arc::new(PlatformAudioService::start_for(target.voice_target.clone())),
            };
            #[cfg(not(any(windows, target_os = "macos")))]
            if crate::devices::descriptor_registry::voice_engine(&target.kind)
                == Some("tcl-rc902v-atvv")
            {
                Arc::new(PlatformAudioService::start_rc902(
                    &target.kind,
                    target.voice_target.clone(),
                ))
            } else {
                Arc::new(PlatformAudioService::start_for(target.voice_target.clone()))
            }
        });
        service.set_recording_mode(target.recording_mode);
        let _ = service.set_gain_db(target.gain_db);
        service.set_enabled(target.enabled);
        instances
            .services
            .lock()
            .unwrap()
            .insert(target.instance_id.clone(), service);
        identities.insert(target.instance_id.clone(), service_identity(target));
    }
}

fn service_identity(target: &AudioTarget) -> (String, Option<String>) {
    let address = if matches!(
        crate::devices::descriptor_registry::voice_engine(&target.kind),
        Some("rc003-atvv" | "tcl-rc902v-atvv")
    ) {
        target.voice_target.clone()
    } else {
        None
    };
    (target.kind.clone(), address)
}

fn release_retired(retired: &mut Vec<Arc<PlatformAudioService>>) {
    // A status reader may still hold a clone. Keep the final owner here so that
    // the reader never inherits the service's blocking Bluetooth shutdown.
    retired.retain(|service| Arc::strong_count(service) != 1);
}

#[cfg(test)]
mod tests {
    use super::{clamp_gain_db, AUDIO_GAIN_MAX_DB};

    #[cfg(windows)]
    #[test]
    fn a15_pcm_and_recording_are_routed_to_the_requested_instance() {
        use super::*;
        let first = Arc::new(PlatformAudioService::without_workers());
        let second = Arc::new(PlatformAudioService::without_workers());
        let legacy = Arc::new(PlatformAudioService::without_workers());
        let manager = AudioServiceManager {
            instances: Arc::new(InstanceServices {
                services: Mutex::new(BTreeMap::from([
                    ("one".into(), first.clone()),
                    ("two".into(), second.clone()),
                ])),
                ..Default::default()
            }),
            legacy: legacy.clone(),
            worker: None,
        };
        assert!(Arc::ptr_eq(&manager.service(None).unwrap(), &legacy));
        manager.set_a15_input_state(Some("one"), true, true);
        for _ in 0..11 {
            manager.push_a15_pcm(Some("one"), &[4000; 320]);
        }
        assert!(first.status().received_data);
        assert!(!second.status().received_data);
        assert_eq!(legacy.level().peak, 0.0);
        manager.set_a15_input_state(Some("two"), true, true);
        for _ in 0..11 {
            manager.push_a15_pcm(Some("two"), &[8000; 320]);
        }
        assert!(second.level().peak > first.level().peak);
        manager.set_a15_input_state(Some("one"), true, false);
        assert!(first.status().bluetooth_connected);
        assert!(!first.status().received_data);
        assert!(second.status().received_data);
        manager.set_a15_input_state(Some("one"), false, false);
        assert!(!first.status().bluetooth_connected);
        assert!(second.status().bluetooth_connected);
        manager.push_a15_pcm(Some("removed"), &[16000; 320]);
        assert_eq!(legacy.level().peak, 0.0);
    }

    #[cfg(windows)]
    #[test]
    fn missing_instance_reports_the_platform_driver_without_using_legacy_audio() {
        use super::*;
        let legacy = Arc::new(PlatformAudioService::without_workers());
        legacy.set_a15_input_state(true, true);
        for _ in 0..11 {
            legacy.push_a15_pcm(&[5000; 320]);
        }
        let manager = AudioServiceManager::spawn(legacy);
        let legacy_status = manager.status(None);
        assert!(legacy_status.bluetooth_connected && legacy_status.received_data);
        assert!(manager.level(None).peak > 0.0);

        let status = manager.status(Some("unresolved"));
        assert_eq!(status.driver_installed, legacy_status.driver_installed);
        assert_eq!(status.state, "stopped");
        assert!(!status.bluetooth_connected && !status.received_data && !status.forwarding);
        assert!(!status.output_ready);
        assert!(status.error.is_none());
        let level = manager.level(Some("unresolved"));
        assert_eq!(level.peak, 0.0);
        assert!(level.waveform.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_instances_route_audio_without_a_playback_selection_and_honor_disable() {
        use super::*;
        let manager = AudioServiceManager::spawn(Arc::new(PlatformAudioService::without_workers()));
        let mut target = super::AudioTarget {
            instance_id: "a15".into(),
            kind: "cmiotA15".into(),
            enabled: true,
            ..Default::default()
        };
        manager.sync_instances(&[target.clone()]);
        wait_for(|| manager.service(Some("a15")).is_some());
        manager.set_a15_input_state(Some("a15"), true, true);
        manager.push_a15_pcm(Some("a15"), &[4000; 320]);
        assert!(manager.status(Some("a15")).received_data);

        target.enabled = false;
        manager.sync_instances(&[target]);
        wait_for(|| manager.status(Some("a15")).state == "stopped");
        manager.push_a15_pcm(Some("a15"), &[4000; 320]);
        let status = manager.status(Some("a15"));
        assert_eq!(status.state, "stopped");
        assert!(!status.forwarding && !status.received_data);
    }

    #[cfg(windows)]
    #[test]
    fn external_pcm_address_discovery_and_enable_changes_reuse_the_source() {
        use super::*;
        let instances = InstanceServices::default();
        let mut identities = BTreeMap::new();
        let mut retired = Vec::new();
        for kind in crate::devices::descriptor_registry::KINDS
            .iter()
            .copied()
            .filter(|kind| {
                matches!(
                    crate::devices::descriptor_registry::voice_engine(kind),
                    Some("cmiot-a15.g7221" | "obe-rcu-r5.sbc" | "tcl-rc802a.ico")
                )
            })
        {
            let mut target = AudioTarget {
                instance_id: kind.into(),
                kind: kind.into(),
                enabled: true,
                ..Default::default()
            };
            reconcile_targets(&instances, &[target.clone()], &mut identities, &mut retired);
            let first = instances.services.lock().unwrap()[kind].clone();
            first.set_a15_input_state(true, true);
            first.push_a15_pcm(&[2000; 320]);
            assert!(first.status().received_data);

            target.voice_target = Some("AA:BB:CC:DD:EE:FF".into());
            reconcile_targets(&instances, &[target.clone()], &mut identities, &mut retired);
            assert!(Arc::ptr_eq(
                &first,
                &instances.services.lock().unwrap()[kind]
            ));
            assert!(first.status().received_data);
            assert!(retired.is_empty());

            target.enabled = false;
            reconcile_targets(&instances, &[target.clone()], &mut identities, &mut retired);
            assert!(Arc::ptr_eq(
                &first,
                &instances.services.lock().unwrap()[kind]
            ));
            assert_eq!(first.status().state, "stopped");
            target.enabled = true;
            reconcile_targets(&instances, &[target], &mut identities, &mut retired);
            assert!(Arc::ptr_eq(
                &first,
                &instances.services.lock().unwrap()[kind]
            ));
            first.set_a15_input_state(true, true);
            first.push_a15_pcm(&[3000; 320]);
            assert!(first.status().received_data);
            drop(first);
            reconcile_targets(&instances, &[], &mut identities, &mut retired);
            release_retired(&mut retired);
            assert!(retired.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn disabled_rc003_reconciliation_preserves_the_instance_and_legacy_service() {
        use super::*;
        let legacy = Arc::new(PlatformAudioService::without_workers());
        let instances = InstanceServices::default();
        let service = Arc::new(PlatformAudioService::without_workers());
        instances
            .services
            .lock()
            .unwrap()
            .insert("remote".into(), service.clone());
        let mut target = AudioTarget {
            instance_id: "remote".into(),
            kind: "rc003".into(),
            voice_target: Some("AA:BB:CC:DD:EE:01".into()),
            enabled: false,
            ..Default::default()
        };
        let mut identities = BTreeMap::from([("remote".into(), service_identity(&target))]);
        let mut retired = Vec::new();
        reconcile_targets(&instances, &[target.clone()], &mut identities, &mut retired);
        assert_eq!(service.status().state, "stopped");
        assert!(Arc::ptr_eq(
            &service,
            &instances.services.lock().unwrap()["remote"]
        ));
        target.enabled = true;
        reconcile_targets(&instances, &[target], &mut identities, &mut retired);
        assert!(Arc::ptr_eq(
            &service,
            &instances.services.lock().unwrap()["remote"]
        ));
        service.set_a15_input_state(true, true);
        service.push_a15_pcm(&[1000; 320]);
        assert!(service.status().received_data);
        assert!(retired.is_empty());
        let manager = AudioServiceManager {
            instances: Arc::new(instances),
            legacy: legacy.clone(),
            worker: None,
        };
        assert!(Arc::ptr_eq(&manager.service(None).unwrap(), &legacy));
        assert!(!legacy.status().bluetooth_connected);
    }

    #[cfg(windows)]
    fn wait_for(mut ready: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !ready() {
            assert!(
                std::time::Instant::now() < deadline,
                "audio worker did not finish"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[cfg(windows)]
    #[test]
    fn slow_bluetooth_shutdown_keeps_status_and_latest_sync_available() {
        use super::*;
        let (release, released) = std::sync::mpsc::channel();
        let service = Arc::new(PlatformAudioService::with_worker(thread::spawn(
            move || {
                let _ = released.recv();
            },
        )));
        let old = Arc::downgrade(&service);
        let manager = AudioServiceManager::spawn(Arc::new(PlatformAudioService::without_workers()));
        manager
            .instances
            .services
            .lock()
            .unwrap()
            .insert("old".into(), service);
        let mut target = AudioTarget {
            instance_id: "a15".into(),
            kind: "cmiotA15".into(),
            enabled: true,
            ..Default::default()
        };
        manager.sync_instances(&[target.clone()]);
        wait_for(|| old.strong_count() == 0);

        let (finished, result) = std::sync::mpsc::channel();
        let manager = Arc::new(manager);
        let querying = Arc::clone(&manager);
        target.gain_db = 7;
        let latest = AudioTarget {
            enabled: false,
            gain_db: 12,
            ..target.clone()
        };
        let expected = latest.clone();
        let query = thread::spawn(move || {
            let status = querying.status(Some("a15"));
            querying.sync_instances(&[target]);
            querying.sync_instances(&[latest]);
            let _ = finished.send(status);
        });
        let status = result.recv_timeout(Duration::from_secs(1));
        let _ = release.send(());
        query.join().unwrap();
        assert!(
            status.is_ok(),
            "status or sync waited for Bluetooth shutdown"
        );
        assert_eq!(
            manager.instances.request.lock().unwrap().targets,
            vec![expected]
        );
        wait_for(|| manager.status(Some("a15")).state == "stopped");
    }

    #[cfg(windows)]
    #[test]
    fn retired_service_keeps_its_final_owner_on_the_worker_and_worker_exits() {
        use super::*;
        let mut manager =
            AudioServiceManager::spawn(Arc::new(PlatformAudioService::without_workers()));
        let borrowed = Arc::new(PlatformAudioService::without_workers());
        let retired = Arc::downgrade(&borrowed);
        manager
            .instances
            .services
            .lock()
            .unwrap()
            .insert("old".into(), borrowed.clone());
        manager.sync_instances(&[AudioTarget {
            instance_id: "new".into(),
            kind: "cmiotA15".into(),
            ..Default::default()
        }]);
        wait_for(|| {
            !manager
                .instances
                .services
                .lock()
                .unwrap()
                .contains_key("old")
        });
        assert_eq!(Arc::strong_count(&borrowed), 2);
        let worker = manager.worker.take().unwrap();
        drop(manager);
        assert_eq!(retired.strong_count(), 2);
        drop(borrowed);
        worker.join().unwrap();
        assert_eq!(retired.strong_count(), 0);
    }

    #[test]
    fn gain_is_limited_to_driver_range() {
        assert_eq!(clamp_gain_db(0), 0);
        assert_eq!(clamp_gain_db(-30), -30);
        assert_eq!(clamp_gain_db(AUDIO_GAIN_MAX_DB), 30);
        assert_eq!(clamp_gain_db(i16::MIN), -30);
        assert_eq!(clamp_gain_db(i16::MAX), 30);
    }
}
