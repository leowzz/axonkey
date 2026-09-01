use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioServiceStatus {
    pub driver_installed: bool,
    pub state: String,
    pub bluetooth_connected: bool,
    pub forwarding: bool,
    pub battery_level: Option<u8>,
    pub error: Option<String>,
}

pub(crate) const AUDIO_GAIN_MIN_DB: i16 = -30;
pub(crate) const AUDIO_GAIN_MAX_DB: i16 = 30;

pub(crate) fn clamp_gain_db(gain: i16) -> i16 {
    gain.clamp(AUDIO_GAIN_MIN_DB, AUDIO_GAIN_MAX_DB)
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
mod atvv;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::AudioService;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use windows::AudioService;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct AudioService;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl AudioService {
    pub fn start() -> Self {
        log::info!(target: "axonkey::audio", "Audio service is unsupported on this platform");
        Self
    }

    pub fn refresh(&self) {}

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
