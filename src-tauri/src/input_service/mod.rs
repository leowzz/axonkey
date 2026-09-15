use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod mouse;

#[cfg(any(windows, test))]
mod extra_keys_protocol;
#[cfg(windows)]
mod extra_keys_winapi;
#[cfg(windows)]
pub mod windows_extra_keys;

#[derive(Debug, Clone, Default, Serialize)]
pub struct InputServiceStatus {
    pub backend_ready: bool,
    pub device_connected: bool,
    pub hardware_id: Option<String>,
    pub error: Option<String>,
    pub input_monitoring_granted: Option<bool>,
    pub accessibility_granted: Option<bool>,
    pub capture_active: bool,
    #[serde(skip)]
    pub(crate) input_monitoring_open_denied: bool,
}

#[derive(Clone, Default, Deserialize)]
pub struct NativeSettings {
    #[serde(rename = "mouseEdgeWidth", default = "default_mouse_edge_width")]
    pub(super) mouse_edge_width: u16,
    #[serde(default)]
    pub(super) enabled: bool,
    #[serde(rename = "mouseEnabled", default = "mouse_enabled_by_default")]
    pub(super) mouse_enabled: bool,
    #[serde(rename = "mouseKeyHoldMs", default = "default_mouse_key_hold_ms")]
    pub(super) mouse_key_hold_ms: u64,
    #[serde(rename = "mouseHorizontalScrollIntervalMs", default = "default_mouse_scroll_interval_ms")]
    pub(super) mouse_horizontal_scroll_interval_ms: u64,
    #[serde(rename = "mouseVerticalScrollIntervalMs", default = "default_mouse_scroll_interval_ms")]
    pub(super) mouse_vertical_scroll_interval_ms: u64,
    #[serde(rename = "mouseScrollSensitivity", default = "default_scroll_sensitivity")]
    pub(super) mouse_scroll_sensitivity: u16,
    #[serde(rename = "mouseIgnoreScrollAcceleration", default = "enabled_by_default")]
    pub(super) mouse_ignore_scroll_acceleration: bool,
    #[serde(default)]
    pub(super) behaviors: HashMap<String, TriggerBehaviors>,
}

fn default_mouse_key_hold_ms() -> u64 { 10 }

fn default_mouse_scroll_interval_ms() -> u64 { 50 }

fn default_mouse_edge_width() -> u16 { 8 }

fn default_scroll_sensitivity() -> u16 { 100 }

fn mouse_enabled_by_default() -> bool { true }

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
    Wheel {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        direction: WheelDirection,
    },
    Mouse {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        button: MouseButton,
    },
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum WheelDirection {
    Up,
    Down,
    Left,
    Right,
}

impl NativeBehavior {
    pub(super) fn enabled(&self) -> bool {
        match self {
            Self::Wheel { enabled, .. } | Self::Mouse { enabled, .. } => *enabled,
            Self::Key { enabled, .. }
            | Self::Shortcut { enabled, .. }
            | Self::Paste { enabled, .. }
            | Self::Delay { enabled, .. }
            | Self::Disabled { enabled } => *enabled,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum MouseButton {
    Left,
    Middle,
    Right,
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
            log::info!(target: "axonkey::input", "Input service is unsupported on this platform");
            Self
        }

        pub fn update_settings(&self, _settings: NativeSettings) -> Result<(), String> {
            log::warn!(target: "axonkey::input", "Input settings requested on an unsupported platform");
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

#[cfg(test)]
mod settings_tests {
    use super::NativeSettings;

    #[test]
    fn mouse_settings_defaults_and_saved_values() {
        let legacy: NativeSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.mouse_key_hold_ms, 10);
        assert_eq!(legacy.mouse_scroll_sensitivity, 100);
        assert!(legacy.mouse_ignore_scroll_acceleration);
        assert_eq!(legacy.mouse_vertical_scroll_interval_ms, 50);
        assert_eq!(legacy.mouse_horizontal_scroll_interval_ms, 50);
        let saved: NativeSettings = serde_json::from_str(r#"{"mouseKeyHoldMs":50,"mouseScrollSensitivity":200,"mouseIgnoreScrollAcceleration":true,"mouseVerticalScrollIntervalMs":100,"mouseHorizontalScrollIntervalMs":200}"#).unwrap();
        assert_eq!(saved.mouse_key_hold_ms, 50);
        assert_eq!(saved.mouse_scroll_sensitivity, 200);
        assert!(saved.mouse_ignore_scroll_acceleration);
        assert_eq!(saved.mouse_vertical_scroll_interval_ms, 100);
        assert_eq!(saved.mouse_horizontal_scroll_interval_ms, 200);
        let explicit: NativeSettings = serde_json::from_str(r#"{"mouseKeyHoldMs":0,"mouseIgnoreScrollAcceleration":false,"mouseVerticalScrollIntervalMs":0,"mouseHorizontalScrollIntervalMs":0}"#).unwrap();
        assert_eq!(explicit.mouse_key_hold_ms, 0);
        assert!(!explicit.mouse_ignore_scroll_acceleration);
        assert_eq!(explicit.mouse_vertical_scroll_interval_ms, 0);
        assert_eq!(explicit.mouse_horizontal_scroll_interval_ms, 0);
    }
}
