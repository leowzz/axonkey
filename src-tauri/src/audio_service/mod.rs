use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioServiceStatus {
    pub driver_installed: bool,
    pub state: String,
    pub bluetooth_connected: bool,
    pub forwarding: bool,
    pub error: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::AudioService;

#[cfg(not(target_os = "macos"))]
pub struct AudioService;

#[cfg(not(target_os = "macos"))]
impl AudioService {
    pub fn start() -> Self {
        Self
    }

    pub fn refresh(&self) {}

    pub fn status(&self) -> AudioServiceStatus {
        AudioServiceStatus {
            state: "unsupported".into(),
            ..AudioServiceStatus::default()
        }
    }
}
