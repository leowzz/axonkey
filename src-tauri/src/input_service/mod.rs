use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize)]
pub struct InputServiceStatus {
    pub backend_ready: bool,
    pub device_connected: bool,
    pub hardware_id: Option<String>,
    pub error: Option<String>,
    pub input_monitoring_granted: Option<bool>,
    pub accessibility_granted: Option<bool>,
    pub capture_active: bool,
}

#[derive(Clone, Default, Deserialize)]
pub struct NativeSettings {
    #[serde(default)]
    pub(super) enabled: bool,
    #[serde(default)]
    pub(super) behaviors: HashMap<String, TriggerBehaviors>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TriggerBehaviors {
    #[serde(default)]
    pub(super) click: Vec<NativeBehavior>,
    #[serde(default)]
    pub(super) double_click: Vec<NativeBehavior>,
    #[serde(default)]
    pub(super) long_press: Vec<NativeBehavior>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum NativeBehavior {
    Key {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        key: String,
    },
    Shortcut {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        keys: Vec<String>,
    },
    Paste {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        text: String,
    },
    Delay {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        ms: u64,
    },
    Disabled {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
}

fn enabled_by_default() -> bool {
    true
}

impl NativeBehavior {
    pub(super) fn enabled(&self) -> bool {
        match self {
            Self::Key { enabled, .. }
            | Self::Shortcut { enabled, .. }
            | Self::Paste { enabled, .. }
            | Self::Delay { enabled, .. }
            | Self::Disabled { enabled } => *enabled,
        }
    }
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "windows", test))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::InputService;
#[cfg(target_os = "windows")]
pub use windows::InputService;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod unsupported {
    use super::{InputServiceStatus, NativeSettings};

    pub struct InputService;

    impl InputService {
        pub fn start() -> Self {
            Self
        }

        pub fn update_settings(&self, _settings: NativeSettings) -> Result<(), String> {
            Err("Axonkey input mapping is only supported on Windows and macOS".into())
        }

        pub fn status(&self) -> InputServiceStatus {
            InputServiceStatus {
                error: Some("Axonkey input mapping is not supported on this platform".into()),
                ..InputServiceStatus::default()
            }
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub use unsupported::InputService;
