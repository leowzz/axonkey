use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(crate) mod launch;
pub mod managed;
pub mod mobile;
pub mod mouse;
pub mod ownership;
mod profile_switch;
pub(crate) mod quick_mode;
pub(crate) mod text_output;

#[cfg(windows)]
pub(crate) mod mobile_quarbor;
#[cfg(windows)]
pub(super) mod windows_quarbor;

#[cfg(any(windows, target_os = "macos", test))]
mod remote_actions;

#[derive(Debug, Clone, Default, Serialize)]
pub struct InputServiceStatus {
    pub cmiot_a15_recording: bool,
    pub backend_ready: bool,
    pub device_connected: bool,
    pub hardware_id: Option<String>,
    pub error: Option<String>,
    pub input_monitoring_granted: Option<bool>,
    pub accessibility_granted: Option<bool>,
    pub capture_active: bool,
    #[serde(skip)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) input_monitoring_open_denied: bool,
}

#[derive(Clone, Default, Deserialize)]
pub struct NativeSettings {
    #[serde(rename = "showRecordingOverlay", default = "enabled_by_default")]
    pub(crate) show_recording_overlay: bool,
    #[serde(rename = "cmiotA15RecordingMode", default)]
    pub(super) cmiot_a15_recording_mode: crate::devices::cmiot_a15::recording::RecordingMode,
    #[serde(rename = "mouseEdgeWidth", default = "default_mouse_edge_width")]
    pub(super) mouse_edge_width: u16,
    #[serde(default)]
    pub(super) enabled: bool,
    #[serde(rename = "mouseEnabled", default = "mouse_enabled_by_default")]
    pub(super) mouse_enabled: bool,
    #[serde(rename = "mouseKeyHoldMs", default = "default_mouse_key_hold_ms")]
    pub(super) mouse_key_hold_ms: u64,
    #[serde(
        rename = "mouseHorizontalScrollIntervalMs",
        default = "default_mouse_horizontal_scroll_interval_ms"
    )]
    pub(super) mouse_horizontal_scroll_interval_ms: u64,
    #[serde(
        rename = "mouseVerticalScrollIntervalMs",
        default = "default_mouse_scroll_interval_ms"
    )]
    pub(super) mouse_vertical_scroll_interval_ms: u64,
    #[serde(
        rename = "mouseScrollSensitivity",
        default = "default_scroll_sensitivity"
    )]
    pub(super) mouse_scroll_sensitivity: u16,
    #[serde(
        rename = "mouseIgnoreScrollAcceleration",
        default = "enabled_by_default"
    )]
    pub(super) mouse_ignore_scroll_acceleration: bool,
    #[serde(default, deserialize_with = "deserialize_behaviors")]
    pub(super) behaviors: HashMap<String, TriggerBehaviors>,
    #[serde(
        rename = "quickProfiles",
        default,
        deserialize_with = "deserialize_quick_profiles"
    )]
    pub(super) quick_profiles: HashMap<String, QuickProfileConfig>,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct QuickProfileConfig {
    pub id: String,
    pub name: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub prompt_mode: bool,
    pub behaviors: HashMap<String, TriggerBehaviors>,
    pub raw_behaviors: serde_json::Value,
}

impl NativeSettings {
    pub(super) fn remote_settings_changed(&self, next: &Self) -> bool {
        self.enabled != next.enabled
            || self.cmiot_a15_recording_mode != next.cmiot_a15_recording_mode
            || self.device_behaviors_changed(next, false)
            || self.quick_profiles_changed(next, false)
    }

    pub(super) fn mouse_settings_changed(&self, next: &Self) -> bool {
        self.enabled != next.enabled
            || self.mouse_enabled != next.mouse_enabled
            || self.mouse_edge_width != next.mouse_edge_width
            || self.mouse_key_hold_ms != next.mouse_key_hold_ms
            || self.mouse_horizontal_scroll_interval_ms != next.mouse_horizontal_scroll_interval_ms
            || self.mouse_vertical_scroll_interval_ms != next.mouse_vertical_scroll_interval_ms
            || self.mouse_scroll_sensitivity != next.mouse_scroll_sensitivity
            || self.mouse_ignore_scroll_acceleration != next.mouse_ignore_scroll_acceleration
            || self.device_behaviors_changed(next, true)
            || self.quick_profiles_changed(next, true)
    }

    fn quick_profiles_changed(&self, next: &Self, mouse: bool) -> bool {
        let is_mouse_profile = |p: &QuickProfileConfig| p.device_id.as_deref() == Some("mouse");
        self.quick_profiles
            .keys()
            .chain(next.quick_profiles.keys())
            .any(|id| {
                let left = self
                    .quick_profiles
                    .get(id)
                    .filter(|p| is_mouse_profile(p) == mouse);
                let right = next
                    .quick_profiles
                    .get(id)
                    .filter(|p| is_mouse_profile(p) == mouse);
                left != right
            })
    }

    fn device_behaviors_changed(&self, next: &Self, mouse: bool) -> bool {
        let empty = TriggerBehaviors::default();
        // Both services receive the full runtime map. Only their own input
        // namespace can invalidate held gestures or queued actions.
        self.behaviors
            .keys()
            .chain(next.behaviors.keys())
            .filter(|input| input.starts_with("mouse.") == mouse)
            .any(|input| {
                self.behaviors.get(input).unwrap_or(&empty)
                    != next.behaviors.get(input).unwrap_or(&empty)
            })
    }
}

pub(crate) fn normalize_behavior_map(
    behaviors: HashMap<String, TriggerBehaviors>,
) -> Result<HashMap<String, TriggerBehaviors>, String> {
    use crate::devices::descriptor_registry::{profile_key, registered_kinds};
    let kinds = registered_kinds();
    let mut normalized = HashMap::with_capacity(behaviors.len());
    for (key, triggers) in behaviors {
        let canonical = kinds
            .iter()
            .find_map(|kind| profile_key(kind, &key))
            .unwrap_or(&key);
        if normalized.insert(canonical.to_owned(), triggers).is_some() {
            return Err(format!("duplicate mapping for input '{canonical}'"));
        }
    }
    Ok(normalized)
}

fn deserialize_behaviors<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, TriggerBehaviors>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = HashMap::<String, serde_json::Value>::deserialize(deserializer)?;
    let mut behaviors = HashMap::with_capacity(raw.len());
    for (key, value) in raw {
        let mut triggers = serde_json::from_value::<TriggerBehaviors>(value).unwrap_or_default();
        sanitize_platform_triggers(&mut triggers);
        behaviors.insert(key, triggers);
    }
    normalize_behavior_map(behaviors).map_err(serde::de::Error::custom)
}

pub(crate) fn parse_tolerant_behavior_map(
    raw: &HashMap<String, serde_json::Value>,
) -> HashMap<String, TriggerBehaviors> {
    use crate::devices::descriptor_registry::{profile_key, registered_kinds};
    let kinds = registered_kinds();
    let mut normalized = HashMap::with_capacity(raw.len());
    for (key, value) in raw {
        if !value.is_object() {
            continue;
        }
        let Ok(mut triggers) = serde_json::from_value::<TriggerBehaviors>(value.clone()) else {
            continue;
        };
        sanitize_platform_triggers(&mut triggers);
        let canonical = kinds
            .iter()
            .find_map(|kind| profile_key(kind, key))
            .unwrap_or(key);
        normalized.entry(canonical.to_owned()).or_insert(triggers);
    }
    normalized
}

pub(crate) fn sanitize_platform_triggers(triggers: &mut TriggerBehaviors) {
    let keep = |behavior: &NativeBehavior| {
        if !behavior.enabled() {
            return true;
        }
        match platform_behavior_error(behavior) {
            Some(reason) => {
                log::warn!(
                    target: "axonkey::input",
                    "Skipping invalid runtime behavior: {reason}"
                );
                false
            }
            None => true,
        }
    };
    triggers.click.retain(keep);
    triggers.double_click.retain(keep);
    triggers.long_press.retain(keep);
}

pub(crate) fn platform_behavior_error(behavior: &NativeBehavior) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        return macos::behavior_error(behavior);
    }
    #[cfg(windows)]
    {
        return windows::behavior_error(behavior);
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = behavior;
        None
    }
}

pub(crate) fn inspect_raw_trigger_errors(
    raw: &serde_json::Value,
    valid_quick_profile_ids: Option<&std::collections::HashSet<&str>>,
) -> Option<String> {
    let Some(obj) = raw.as_object() else {
        return Some("映射格式无效".into());
    };
    let mut reasons: Vec<String> = Vec::new();
    let mut push_unique = |msg: String| {
        if !reasons.contains(&msg) {
            reasons.push(msg);
        }
    };

    for field in ["click", "doubleClick", "longPress"] {
        let Some(entry) = obj.get(field) else {
            continue;
        };
        if entry.is_null() {
            continue;
        }
        let Some(items) = entry.as_array() else {
            push_unique("触发序列格式无效".into());
            continue;
        };
        for item in items {
            match serde_json::from_value::<SourcedBehavior>(item.clone()) {
                Err(_) => {
                    if let Some(kind) = item.get("type").and_then(|v| v.as_str()) {
                        push_unique(format!("包含无法识别或无效的动作（{kind}）"));
                    } else {
                        push_unique("包含格式无效的动作".into());
                    }
                }
                Ok(parsed) if parsed.behavior.enabled() => {
                    if let Some(err) = platform_behavior_error(&parsed.behavior) {
                        push_unique(err);
                    } else if let NativeBehavior::QuickOverlay { profile_id, .. } = &parsed.behavior
                    {
                        if valid_quick_profile_ids
                            .is_some_and(|ids| !ids.contains(profile_id.as_str()))
                        {
                            push_unique("关联的快捷交互配置不存在".into());
                        }
                    }
                }
                Ok(_) => {}
            }
        }
    }

    if reasons.is_empty() {
        None
    } else {
        Some(reasons.join("；"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawQuickProfile {
    id: String,
    name: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    device_name: Option<String>,
    #[serde(default)]
    prompt_mode: bool,
    #[serde(default)]
    behaviors: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawQuickProfiles {
    Map(HashMap<String, RawQuickProfile>),
    List(Vec<RawQuickProfile>),
}

fn deserialize_quick_profiles<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, QuickProfileConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let Some(raw) = Option::<RawQuickProfiles>::deserialize(deserializer)? else {
        return Ok(HashMap::new());
    };
    let entries: Vec<RawQuickProfile> = match raw {
        RawQuickProfiles::Map(map) => map.into_values().collect(),
        RawQuickProfiles::List(list) => list,
    };
    let mut out = HashMap::with_capacity(entries.len());
    for entry in entries {
        let id = entry.id.trim().to_owned();
        if id.is_empty() {
            continue;
        }
        let raw_behaviors = if entry.behaviors.is_object() {
            entry.behaviors
        } else {
            serde_json::json!({})
        };
        let raw_map: HashMap<String, serde_json::Value> =
            serde_json::from_value(raw_behaviors.clone()).unwrap_or_default();
        let behaviors = parse_tolerant_behavior_map(&raw_map);
        out.insert(
            id.clone(),
            QuickProfileConfig {
                id,
                name: entry.name,
                device_id: entry.device_id,
                device_name: entry.device_name,
                prompt_mode: entry.prompt_mode,
                behaviors,
                raw_behaviors,
            },
        );
    }
    Ok(out)
}

fn default_mouse_key_hold_ms() -> u64 {
    10
}

fn default_mouse_scroll_interval_ms() -> u64 {
    50
}

fn default_mouse_horizontal_scroll_interval_ms() -> u64 {
    300
}

fn default_mouse_edge_width() -> u16 {
    8
}

fn default_scroll_sensitivity() -> u16 {
    100
}

fn mouse_enabled_by_default() -> bool {
    true
}

#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "SourcedTriggerBehaviors")]
pub(super) struct TriggerBehaviors {
    pub(super) click: Vec<NativeBehavior>,
    pub(super) double_click: Vec<NativeBehavior>,
    pub(super) long_press: Vec<NativeBehavior>,
    pub(super) click_sources: Vec<String>,
    pub(super) double_click_sources: Vec<String>,
    pub(super) long_press_sources: Vec<String>,
}

#[derive(Deserialize)]
struct SourcedBehavior {
    #[serde(flatten)]
    behavior: NativeBehavior,
    #[serde(rename = "libraryItemId")]
    library_item_id: Option<String>,
}

fn deserialize_value_vec<'de, D>(deserializer: D) -> Result<Vec<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Array(items) => items,
        _ => Vec::new(),
    })
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcedTriggerBehaviors {
    #[serde(default, deserialize_with = "deserialize_value_vec")]
    click: Vec<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_value_vec")]
    double_click: Vec<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_value_vec")]
    long_press: Vec<serde_json::Value>,
}

impl From<SourcedTriggerBehaviors> for TriggerBehaviors {
    fn from(raw: SourcedTriggerBehaviors) -> Self {
        fn split(raw_items: Vec<serde_json::Value>) -> (Vec<NativeBehavior>, Vec<String>) {
            let items: Vec<SourcedBehavior> = raw_items
                .into_iter()
                .filter_map(
                    |value| match serde_json::from_value::<SourcedBehavior>(value) {
                        Ok(parsed) => Some(parsed),
                        Err(error) => {
                            log::warn!(
                                target: "axonkey::input",
                                "Ignoring unrecognized or invalid behavior item: {error}"
                            );
                            None
                        }
                    },
                )
                .collect();
            let sources = items
                .iter()
                .filter(|item| {
                    item.behavior.enabled()
                        && !matches!(item.behavior, NativeBehavior::Disabled { .. })
                })
                .filter_map(|item| item.library_item_id.as_ref())
                .filter(|id| valid_library_source(id))
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            (
                items.into_iter().map(|item| item.behavior).collect(),
                sources,
            )
        }
        let (click, click_sources) = split(raw.click);
        let (double_click, double_click_sources) = split(raw.double_click);
        let (long_press, long_press_sources) = split(raw.long_press);
        Self {
            click,
            double_click,
            long_press,
            click_sources,
            double_click_sources,
            long_press_sources,
        }
    }
}

fn valid_library_source(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

impl TriggerBehaviors {
    pub(super) fn iter(&self) -> impl Iterator<Item = &NativeBehavior> {
        self.click
            .iter()
            .chain(&self.double_click)
            .chain(&self.long_press)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum NativeBehavior {
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
    CursorMove {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        direction: WheelDirection,
        #[serde(default = "default_cursor_distance")]
        distance: u32,
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
    TypeText {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        text: String,
    },
    CopyText {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        text: String,
        #[serde(default)]
        title: Option<String>,
    },
    OpenPath {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        path: String,
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
    OpenApp {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        path: String,
    },
    OpenWebsite {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        url: String,
    },
    RunCommand {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        command: String,
        #[serde(default, rename = "workingDirectory")]
        working_directory: Option<String>,
        #[serde(default)]
        title: Option<String>,
    },
    HttpRequest {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        method: String,
        url: String,
        #[serde(default)]
        headers: Option<std::collections::BTreeMap<String, String>>,
        #[serde(default)]
        body: Option<String>,
        #[serde(default)]
        title: Option<String>,
    },
    SwitchProfile {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        direction: ProfileDirection,
        #[serde(default = "enabled_by_default")]
        wrap: bool,
    },
    QuickOverlay {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    ClipboardOverlay {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        action: ClipboardOverlayAction,
    },
    Disabled {
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ClipboardOverlayAction {
    #[default]
    Paste,
    CopyText,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ProfileDirection {
    Previous,
    Next,
}

fn enabled_by_default() -> bool {
    true
}

fn default_cursor_distance() -> u32 {
    50
}

pub(super) fn normalize_cursor_distance(distance: u32) -> u32 {
    if distance == 0 {
        default_cursor_distance()
    } else {
        distance.min(500)
    }
}

pub(super) fn cursor_delta(direction: WheelDirection, distance: u32) -> (i32, i32) {
    let distance = normalize_cursor_distance(distance) as i32;
    match direction {
        WheelDirection::Up => (0, -distance),
        WheelDirection::Down => (0, distance),
        WheelDirection::Left => (-distance, 0),
        WheelDirection::Right => (distance, 0),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RepeatableClick {
    Wheel(WheelDirection),
    CursorMove {
        direction: WheelDirection,
        distance: u32,
    },
}

pub(super) fn repeatable_click(triggers: &TriggerBehaviors) -> Option<RepeatableClick> {
    if triggers.double_click.iter().any(NativeBehavior::enabled)
        || triggers.long_press.iter().any(NativeBehavior::enabled)
    {
        return None;
    }
    let mut enabled = triggers.click.iter().filter(|behavior| behavior.enabled());
    let first = enabled.next()?;
    if enabled.next().is_some() {
        return None;
    }
    match first {
        NativeBehavior::Wheel { direction, .. } => Some(RepeatableClick::Wheel(*direction)),
        NativeBehavior::CursorMove {
            direction,
            distance,
            ..
        } => Some(RepeatableClick::CursorMove {
            direction: *direction,
            distance: normalize_cursor_distance(*distance),
        }),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WheelDirection {
    Up,
    Down,
    Left,
    Right,
}

impl NativeBehavior {
    pub(super) fn enabled(&self) -> bool {
        match self {
            Self::Wheel { enabled, .. }
            | Self::Mouse { enabled, .. }
            | Self::CursorMove { enabled, .. } => *enabled,
            Self::Key { enabled, .. }
            | Self::Shortcut { enabled, .. }
            | Self::TypeText { enabled, .. }
            | Self::CopyText { enabled, .. }
            | Self::OpenPath { enabled, .. }
            | Self::Paste { enabled, .. }
            | Self::Delay { enabled, .. }
            | Self::OpenApp { enabled, .. }
            | Self::OpenWebsite { enabled, .. }
            | Self::RunCommand { enabled, .. }
            | Self::HttpRequest { enabled, .. }
            | Self::SwitchProfile { enabled, .. }
            | Self::QuickOverlay { enabled, .. }
            | Self::ClipboardOverlay { enabled, .. }
            | Self::Disabled { enabled } => *enabled,
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(crate) fn execute_quick_overlay_behavior(behavior: &NativeBehavior) {
    #[cfg(target_os = "macos")]
    macos::execute_behaviors(std::slice::from_ref(behavior));
    #[cfg(windows)]
    windows::execute_mouse_behavior(behavior, 10);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MouseButton {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "windows", test))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) mod windows;

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
    fn descriptor_ids_are_normalized_at_the_settings_boundary() {
        let descriptor = crate::devices::descriptor_registry::descriptor_for_kind("rc003").unwrap();
        let up = descriptor
            .inputs
            .iter()
            .find(|input| crate::devices::descriptor_registry::input_key(input) == "up")
            .unwrap();
        let settings: NativeSettings = serde_json::from_value(serde_json::json!({
            "behaviors": {
                (up.id.clone()): {"click": [{"type": "key", "key": "A"}]},
                "mouse.left": {"click": [{"type": "key", "key": "B"}]}
            }
        }))
        .unwrap();
        assert_eq!(settings.behaviors.len(), 2);
        assert_eq!(settings.behaviors["up"].click.len(), 1);
        assert_eq!(settings.behaviors["mouse.left"].click.len(), 1);

        let duplicate = serde_json::from_value::<NativeSettings>(serde_json::json!({
            "behaviors": {(up.id.clone()): {}, "up": {}}
        }));
        assert!(duplicate
            .err()
            .unwrap()
            .to_string()
            .contains("duplicate mapping"));
    }

    #[test]
    fn library_sources_are_preserved_once_per_enabled_trigger_sequence() {
        let source = "00000000-0000-4000-8000-000000000001";
        let inactive = "00000000-0000-4000-8000-000000000002";
        let settings: NativeSettings =
            serde_json::from_value(serde_json::json!({"behaviors":{"up":{"click":[
                {"type":"key","key":"A","libraryItemId":source},
                {"type":"delay","ms":10,"libraryItemId":source},
                {"type":"key","key":"B","enabled":false,"libraryItemId":inactive},
                {"type":"disabled","libraryItemId":inactive},
                {"type":"key","key":"C","libraryItemId":"invalid"}
            ]}}}))
            .unwrap();
        let triggers = &settings.behaviors["up"];
        assert_eq!(triggers.click.len(), 5);
        assert_eq!(triggers.click_sources, [source]);
        assert!(triggers.double_click_sources.is_empty());
        assert!(triggers.long_press_sources.is_empty());
    }

    #[test]
    fn recording_overlay_defaults_on_without_invalidating_input_settings() {
        let legacy: NativeSettings = serde_json::from_str("{}").unwrap();
        assert!(legacy.show_recording_overlay);
        let hidden: NativeSettings =
            serde_json::from_str(r#"{"showRecordingOverlay":false}"#).unwrap();
        assert!(!hidden.show_recording_overlay);
        assert!(!legacy.remote_settings_changed(&hidden));
        assert!(!legacy.mouse_settings_changed(&hidden));
    }

    #[test]
    fn recording_mode_defaults_to_click_and_invalidates_only_remote_settings() {
        use crate::devices::cmiot_a15::recording::RecordingMode;
        let legacy: NativeSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.cmiot_a15_recording_mode, RecordingMode::Click);
        let hold: NativeSettings =
            serde_json::from_str(r#"{"cmiotA15RecordingMode":"hold"}"#).unwrap();
        assert_eq!(hold.cmiot_a15_recording_mode, RecordingMode::Hold);
        assert!(legacy.remote_settings_changed(&hold));
        assert!(!legacy.mouse_settings_changed(&hold));
        assert!(
            serde_json::from_str::<NativeSettings>(r#"{"cmiotA15RecordingMode":"invalid"}"#)
                .is_err()
        );
    }

    #[test]
    fn mouse_settings_defaults_and_saved_values() {
        let legacy: NativeSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.mouse_key_hold_ms, 10);
        assert_eq!(legacy.mouse_scroll_sensitivity, 100);
        assert!(legacy.mouse_ignore_scroll_acceleration);
        assert_eq!(legacy.mouse_vertical_scroll_interval_ms, 50);
        assert_eq!(legacy.mouse_horizontal_scroll_interval_ms, 300);
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

    #[test]
    fn cursor_move_defaults_distance_and_repeatable_click_rules() {
        let behavior: super::NativeBehavior = serde_json::from_value(serde_json::json!({
            "type": "cursorMove",
            "direction": "left"
        }))
        .unwrap();
        match behavior {
            super::NativeBehavior::CursorMove {
                enabled,
                direction,
                distance,
            } => {
                assert!(enabled);
                assert_eq!(direction, super::WheelDirection::Left);
                assert_eq!(distance, 50);
            }
            _ => panic!("expected cursorMove"),
        }
        let triggers: super::TriggerBehaviors = serde_json::from_value(serde_json::json!({
            "click": [{"type":"cursorMove","direction":"down","distance":0}]
        }))
        .unwrap();
        assert_eq!(
            super::repeatable_click(&triggers),
            Some(super::RepeatableClick::CursorMove {
                direction: super::WheelDirection::Down,
                distance: 50,
            })
        );
        assert_eq!(super::cursor_delta(super::WheelDirection::Up, 20), (0, -20));
        assert_eq!(
            super::cursor_delta(super::WheelDirection::Right, 501),
            (500, 0)
        );
    }

    #[test]
    fn quick_profiles_parse_prompt_mode_and_titled_text_behaviors() {
        let off: NativeSettings = serde_json::from_str(
            r#"{
                "quickProfiles": {
                    "q1": {
                        "id": "q1",
                        "name": "Prompt",
                        "behaviors": {
                            "up": { "click": [{ "type": "paste", "text": "hello", "title": "打招呼" }] }
                        }
                    }
                }
            }"#,
        )
        .unwrap();
        assert!(!off.quick_profiles["q1"].prompt_mode);
        let on: NativeSettings = serde_json::from_str(
            r#"{
                "quickProfiles": {
                    "q1": {
                        "id": "q1",
                        "name": "Prompt",
                        "promptMode": true,
                        "behaviors": {
                            "up": { "click": [{ "type": "paste", "text": "hello", "title": "打招呼" }] }
                        }
                    }
                }
            }"#,
        )
        .unwrap();
        assert!(on.quick_profiles["q1"].prompt_mode);
        assert!(off.remote_settings_changed(&on));
    }
}
