use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
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
    pub battery_level: Option<u8>,
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

    pub fn set_output_device(&self, _device: Option<String>) {}

    pub fn start_for(_target_identity: Option<String>) -> Self {
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
#[derive(Clone, Debug, Default)]
pub struct AudioTarget {
    pub instance_id: String,
    pub voice_target: Option<String>,
    pub output_device: Option<String>,
    pub gain_db: i16,
    pub enabled: bool,
}

/// Owns one platform audio service per configured RC003 instance.
///
/// The legacy service remains available for the old global setup page and the
/// Windows A15 channel. New RC003 instance UI and commands address a service
/// by `instance_id`.
pub struct AudioServiceManager {
    services: Mutex<BTreeMap<String, Arc<PlatformAudioService>>>,
    target_identities: Mutex<BTreeMap<String, Option<String>>>,
    legacy: Arc<PlatformAudioService>,
}

impl AudioServiceManager {
    pub fn start() -> Self {
        Self {
            services: Mutex::new(BTreeMap::new()),
            target_identities: Mutex::new(BTreeMap::new()),
            legacy: Arc::new(PlatformAudioService::start()),
        }
    }

    fn default_service(&self) -> Arc<PlatformAudioService> {
        self.services
            .lock()
            .ok()
            .and_then(|services| services.values().next().cloned())
            .unwrap_or_else(|| Arc::clone(&self.legacy))
    }

    fn service(&self, instance_id: Option<&str>) -> Option<Arc<PlatformAudioService>> {
        match instance_id {
            Some(id) => self.services.lock().ok()?.get(id).cloned(),
            None => Some(self.default_service()),
        }
    }

    pub fn sync_instances(&self, targets: &[AudioTarget]) {
        let active = targets
            .iter()
            .filter(|target| !target.instance_id.is_empty())
            .map(|target| target.instance_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let stale = if let Ok(mut services) = self.services.lock() {
            let stale = services
                .keys()
                .filter(|id| !active.contains(id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            for id in &stale {
                services.remove(id);
            }
            stale
        } else {
            Vec::new()
        };
        drop(stale);

        if let Ok(mut identities) = self.target_identities.lock() {
            identities.retain(|id, _| active.contains(id.as_str()));
        }

        for target in targets {
            if target.instance_id.is_empty() {
                continue;
            }
            let service = if let (Ok(mut services), Ok(mut identities)) =
                (self.services.lock(), self.target_identities.lock())
            {
                let replace = identities
                    .get(&target.instance_id)
                    .is_some_and(|current| current != &target.voice_target);
                if replace {
                    services.remove(&target.instance_id);
                }
                identities.insert(target.instance_id.clone(), target.voice_target.clone());
                services
                    .entry(target.instance_id.clone())
                    .or_insert_with(|| {
                        Arc::new(PlatformAudioService::start_for(target.voice_target.clone()))
                    })
                    .clone()
            } else {
                continue;
            };
            let output = if target.enabled {
                target.output_device.clone()
            } else {
                None
            };
            service.set_output_device(output);
            let _ = service.set_gain_db(target.gain_db);
        }
    }

    pub fn status(&self, instance_id: Option<&str>) -> AudioServiceStatus {
        self.service(instance_id)
            .map(|service| service.status())
            .unwrap_or_else(|| AudioServiceStatus {
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

    pub fn set_output_device(&self, instance_id: Option<&str>, device: Option<String>) {
        if let Some(service) = self.service(instance_id) {
            service.set_output_device(device);
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

    pub(crate) fn set_a15_recording(&self, active: bool) {
        #[cfg(target_os = "windows")]
        self.legacy.set_a15_recording(active);
        #[cfg(not(target_os = "windows"))]
        let _ = active;
    }

    pub(crate) fn push_a15_pcm(&self, samples: &[i16]) {
        #[cfg(target_os = "windows")]
        self.legacy.push_a15_pcm(samples);
        #[cfg(not(target_os = "windows"))]
        let _ = samples;
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp_gain_db, AUDIO_GAIN_MAX_DB};

    #[test]
    fn gain_is_limited_to_driver_range() {
        assert_eq!(clamp_gain_db(0), 0);
        assert_eq!(clamp_gain_db(-30), -30);
        assert_eq!(clamp_gain_db(AUDIO_GAIN_MAX_DB), 30);
        assert_eq!(clamp_gain_db(i16::MIN), -30);
        assert_eq!(clamp_gain_db(i16::MAX), 30);
    }
}
