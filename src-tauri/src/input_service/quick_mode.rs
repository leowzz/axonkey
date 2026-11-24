//! Ephemeral single-shot profile session shared by all device input backends.
use super::{
    managed::gesture::{Execution, Gestures, TriggerKind},
    ClipboardOverlayAction, NativeBehavior, NativeSettings, QuickProfileConfig, TriggerBehaviors,
};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OverlayTrigger<'a> {
    QuickProfile(&'a str),
    Clipboard(ClipboardOverlayAction),
}

pub(crate) fn find_overlay_trigger(actions: &[NativeBehavior]) -> Option<OverlayTrigger<'_>> {
    actions.iter().find_map(|action| match action {
        NativeBehavior::QuickOverlay {
            enabled: true,
            profile_id,
        } if !profile_id.trim().is_empty() => Some(OverlayTrigger::QuickProfile(profile_id.trim())),
        NativeBehavior::ClipboardOverlay {
            enabled: true,
            action,
        } => Some(OverlayTrigger::Clipboard(*action)),
        _ => None,
    })
}

pub(crate) fn clipboard_target_inputs(device_kind: &str, trigger_input: &str) -> Vec<String> {
    if device_kind == "mouse" {
        const SCOPED_CONTROLS: [&str; 9] = [
            "buttonForward",
            "buttonBack",
            "buttonLeft",
            "buttonRight",
            "up",
            "left",
            "buttonMiddle",
            "right",
            "down",
        ];
        let scope = ["mouse.top.", "mouse.left.", "mouse.right."]
            .into_iter()
            .find(|prefix| trigger_input.starts_with(prefix));
        if let Some(prefix) = scope {
            return SCOPED_CONTROLS
                .into_iter()
                .map(|control| format!("{prefix}{control}"))
                .filter(|id| id != trigger_input)
                .collect();
        }
        return [
            "mouse.global.buttonForward",
            "mouse.global.buttonBack",
            "mouse.global.buttonMiddle",
        ]
        .into_iter()
        .filter(|id| *id != trigger_input)
        .map(str::to_owned)
        .collect();
    }
    crate::devices::descriptor_registry::clipboard_target_inputs(device_kind, trigger_input)
}

pub(crate) fn build_clipboard_profile(
    device_kind: &str,
    device_name: &str,
    trigger_input: &str,
    action: ClipboardOverlayAction,
    entries: &[crate::clipboard_history::ClipboardEntry],
) -> (QuickProfileConfig, Vec<String>) {
    let targets = clipboard_target_inputs(device_kind, trigger_input);
    let mut behaviors = HashMap::new();
    let mut raw_map = serde_json::Map::new();
    let mut clipboard_slots = Vec::new();
    for (idx, (key, entry)) in targets.into_iter().zip(entries.iter()).enumerate() {
        let step = match action {
            ClipboardOverlayAction::Paste => NativeBehavior::Paste {
                enabled: true,
                text: entry.text.clone(),
            },
            ClipboardOverlayAction::CopyText => NativeBehavior::CopyText {
                enabled: true,
                text: entry.text.clone(),
                title: None,
            },
        };
        let raw_step = match action {
            ClipboardOverlayAction::Paste => serde_json::json!({
                "id": format!("clipboard-{idx}"),
                "enabled": true,
                "type": "paste",
                "text": entry.text,
            }),
            ClipboardOverlayAction::CopyText => serde_json::json!({
                "id": format!("clipboard-{idx}"),
                "enabled": true,
                "type": "copyText",
                "text": entry.text,
            }),
        };
        behaviors.insert(
            key.clone(),
            TriggerBehaviors {
                click: vec![step],
                ..TriggerBehaviors::default()
            },
        );
        raw_map.insert(
            key.clone(),
            serde_json::json!({
                "click": [raw_step],
                "doubleClick": [],
                "longPress": [],
            }),
        );
        clipboard_slots.push(key);
    }
    let name = match action {
        ClipboardOverlayAction::Paste => "剪贴板历史",
        ClipboardOverlayAction::CopyText => "剪贴板 · 仅复制",
    };
    (
        QuickProfileConfig {
            id: "__clipboard__".into(),
            name: name.into(),
            device_id: Some(device_kind.to_owned()),
            device_name: Some(device_name.to_owned()),
            prompt_mode: false,
            behaviors,
            raw_behaviors: serde_json::Value::Object(raw_map),
        },
        clipboard_slots,
    )
}

pub(crate) enum Intercept {
    PassThrough,
    Swallow,
    Exited,
    Execute(Vec<Execution>),
}

struct ActiveSession {
    revision: u64,
    profile: Arc<QuickProfileConfig>,
    trigger_input: String,
    ignore_trigger_release: bool,
    gestures: Gestures,
    pressed: BTreeSet<String>,
}

#[derive(Default)]
pub(crate) struct QuickMode {
    session: Option<ActiveSession>,
    swallow_until_release: HashSet<String>,
}

fn has_enabled_triggers(mapping: &TriggerBehaviors) -> bool {
    mapping.click.iter().any(NativeBehavior::enabled)
        || mapping.double_click.iter().any(NativeBehavior::enabled)
        || mapping.long_press.iter().any(NativeBehavior::enabled)
}

impl QuickMode {
    pub fn is_active(&mut self) -> bool {
        self.sync_external_dismissal();
        self.session.is_some()
    }

    pub fn prefers_input(&self, candidate: &str) -> bool {
        self.session.as_ref().is_some_and(|active| {
            active.trigger_input == candidate
                || active
                    .profile
                    .behaviors
                    .get(candidate)
                    .is_some_and(has_enabled_triggers)
        })
    }

    pub fn cancel(&mut self) {
        if let Some(active) = self.session.take() {
            self.swallow_until_release.extend(active.pressed);
            let _ = crate::quick_overlay::close_revision(active.revision);
        }
    }

    pub fn reset(&mut self) {
        self.cancel();
        self.swallow_until_release.clear();
    }

    pub fn active_slot_count(&self) -> usize {
        self.session
            .as_ref()
            .map_or(0, |active| active.profile.behaviors.len())
    }

    pub fn enter_trigger(
        &mut self,
        source_id: &str,
        fallback_kind: &str,
        fallback_name: &str,
        trigger: OverlayTrigger<'_>,
        trigger_input: &str,
        trigger_still_down: bool,
        quick_profiles: &HashMap<String, QuickProfileConfig>,
    ) -> bool {
        match trigger {
            OverlayTrigger::QuickProfile(profile_id) => self.enter_with_profiles(
                source_id,
                fallback_kind,
                fallback_name,
                profile_id,
                trigger_input,
                trigger_still_down,
                quick_profiles,
            ),
            OverlayTrigger::Clipboard(action) => self.enter_clipboard(
                source_id,
                fallback_kind,
                fallback_name,
                action,
                trigger_input,
                trigger_still_down,
            ),
        }
    }

    pub fn enter_clipboard(
        &mut self,
        source_id: &str,
        device_kind: &str,
        device_name: &str,
        action: ClipboardOverlayAction,
        trigger_input: &str,
        trigger_still_down: bool,
    ) -> bool {
        crate::clipboard_history::sync_now();
        let entries = crate::clipboard_history::entries();
        self.enter_clipboard_entries(
            source_id,
            device_kind,
            device_name,
            action,
            trigger_input,
            trigger_still_down,
            &entries,
        )
    }

    pub fn enter_clipboard_entries(
        &mut self,
        source_id: &str,
        device_kind: &str,
        device_name: &str,
        action: ClipboardOverlayAction,
        trigger_input: &str,
        trigger_still_down: bool,
        entries: &[crate::clipboard_history::ClipboardEntry],
    ) -> bool {
        let (profile, clipboard_slots) =
            build_clipboard_profile(device_kind, device_name, trigger_input, action, entries);
        self.activate_session(
            source_id,
            device_kind.to_owned(),
            device_name.to_owned(),
            profile,
            trigger_input,
            trigger_still_down,
            true,
            clipboard_slots,
        );
        true
    }

    pub fn enter_from_settings(
        &mut self,
        source_id: &str,
        fallback_kind: &str,
        fallback_name: &str,
        profile_id: &str,
        trigger_input: &str,
        trigger_still_down: bool,
        settings: &NativeSettings,
    ) -> bool {
        self.enter_with_profiles(
            source_id,
            fallback_kind,
            fallback_name,
            profile_id,
            trigger_input,
            trigger_still_down,
            &settings.quick_profiles,
        )
    }

    pub fn enter_with_profiles(
        &mut self,
        source_id: &str,
        fallback_kind: &str,
        fallback_name: &str,
        profile_id: &str,
        trigger_input: &str,
        trigger_still_down: bool,
        quick_profiles: &HashMap<String, QuickProfileConfig>,
    ) -> bool {
        let Some(profile) = quick_profiles.get(profile_id).cloned() else {
            log::warn!(
                target: "axonkey::quick_overlay",
                "Quick overlay target profile {:?} not found on source {:?}",
                profile_id,
                source_id
            );
            return false;
        };
        let device_kind = profile
            .device_id
            .clone()
            .unwrap_or_else(|| fallback_kind.to_owned());
        let device_name = profile
            .device_name
            .clone()
            .unwrap_or_else(|| fallback_name.to_owned());
        self.activate_session(
            source_id,
            device_kind,
            device_name,
            profile,
            trigger_input,
            trigger_still_down,
            false,
            Vec::new(),
        );
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn activate_session(
        &mut self,
        source_id: &str,
        device_kind: String,
        device_name: String,
        profile: QuickProfileConfig,
        trigger_input: &str,
        trigger_still_down: bool,
        clipboard_mode: bool,
        clipboard_slots: Vec<String>,
    ) {
        let descriptor_svg =
            crate::devices::descriptor_registry::dynamic_svg_for_kind(&device_kind);
        let revision =
            crate::quick_overlay::open_session(crate::quick_overlay::QuickOverlaySession {
                revision: 0,
                source_id: source_id.to_owned(),
                device_kind,
                device_name,
                profile_id: profile.id.clone(),
                profile_name: profile.name.clone(),
                trigger_input: trigger_input.to_owned(),
                behaviors: profile.raw_behaviors.clone(),
                pressed: Vec::new(),
                preview: false,
                prompt_mode: profile.prompt_mode,
                clipboard_mode,
                clipboard_slots,
                descriptor_svg,
            });
        if let Some(previous) = self.session.take() {
            self.swallow_until_release.extend(previous.pressed);
        }
        if trigger_still_down {
            self.swallow_until_release.remove(trigger_input);
        }
        self.session = Some(ActiveSession {
            revision,
            profile: Arc::new(profile),
            trigger_input: trigger_input.to_owned(),
            ignore_trigger_release: trigger_still_down,
            gestures: Gestures::default(),
            pressed: BTreeSet::new(),
        });
    }

    fn sync_external_dismissal(&mut self) {
        let dismissed = self
            .session
            .as_ref()
            .is_some_and(|active| !crate::quick_overlay::is_revision_active(active.revision));
        if dismissed {
            if let Some(active) = self.session.take() {
                self.swallow_until_release.extend(active.pressed);
            }
        }
    }

    pub fn tick(&mut self, now_ms: u64) -> Option<Vec<Execution>> {
        self.sync_external_dismissal();
        let active = self.session.as_mut()?;
        let executions = active.gestures.tick(now_ms, &active.profile.behaviors);
        if executions.is_empty() {
            return None;
        }
        let finished = self.session.take().unwrap();
        self.swallow_until_release.extend(finished.pressed);
        let _ = crate::quick_overlay::close_revision(finished.revision);
        Some(executions)
    }

    pub fn edge(&mut self, input: &str, down: bool, now_ms: u64) -> Intercept {
        self.sync_external_dismissal();
        let Some(active) = self.session.as_mut() else {
            if !down && self.swallow_until_release.remove(input) {
                return Intercept::Swallow;
            }
            if down {
                self.swallow_until_release.remove(input);
            }
            return Intercept::PassThrough;
        };

        if input == active.trigger_input {
            if !down && active.ignore_trigger_release {
                active.ignore_trigger_release = false;
                return Intercept::Swallow;
            }
            if down {
                let finished = self.session.take().unwrap();
                self.swallow_until_release.extend(finished.pressed);
                self.swallow_until_release.insert(input.to_owned());
                let _ = crate::quick_overlay::close_revision(finished.revision);
                return Intercept::Exited;
            }
            return Intercept::Swallow;
        }

        let Some(mapping) = active
            .profile
            .behaviors
            .get(input)
            .filter(|m| has_enabled_triggers(m))
        else {
            if down {
                let finished = self.session.take().unwrap();
                self.swallow_until_release.extend(finished.pressed);
                self.swallow_until_release.insert(input.to_owned());
                let _ = crate::quick_overlay::close_revision(finished.revision);
                return Intercept::Exited;
            }
            return Intercept::Swallow;
        };

        if down {
            active.pressed.insert(input.to_owned());
        } else {
            active.pressed.remove(input);
        }
        crate::quick_overlay::set_pressed(
            active.revision,
            active.pressed.iter().cloned().collect(),
        );

        let executions = active.gestures.edge(input, down, now_ms, mapping);
        if executions.is_empty() {
            return Intercept::Swallow;
        }
        let finished = self.session.take().unwrap();
        self.swallow_until_release.extend(finished.pressed);
        let _ = crate::quick_overlay::close_revision(finished.revision);
        Intercept::Execute(executions)
    }

    /// Discrete inputs without press/release pairs (such as mouse wheel ticks).
    pub fn discrete_edge(&mut self, input: &str) -> Intercept {
        self.sync_external_dismissal();
        let Some(finished) = self.session.take() else {
            return Intercept::PassThrough;
        };
        self.swallow_until_release.extend(finished.pressed);
        let _ = crate::quick_overlay::close_revision(finished.revision);
        if input == finished.trigger_input {
            return Intercept::Exited;
        }
        let Some(mapping) = finished.profile.behaviors.get(input) else {
            return Intercept::Exited;
        };
        if !mapping.click.iter().any(NativeBehavior::enabled) {
            return Intercept::Exited;
        }
        Intercept::Execute(vec![Execution {
            input: input.to_owned(),
            trigger: TriggerKind::Click,
            behaviors: mapping.click.clone(),
            sources: mapping.click_sources.clone(),
        }])
    }
}

impl Drop for QuickMode {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_settings() -> NativeSettings {
        serde_json::from_value(json!({
            "enabled": true,
            "behaviors": {
                "menu": { "click": [{ "type": "quickOverlay", "profileId": "q1" }] },
                "up": { "click": [{ "type": "key", "key": "B" }] }
            },
            "quickProfiles": {
                "q1": {
                    "id": "q1",
                    "name": "AI 提示词",
                    "deviceId": "rc003",
                    "deviceName": "遥控器",
                    "behaviors": {
                        "up": {
                            "click": [{ "type": "paste", "text": "翻译为英文" }],
                            "longPress": [{ "type": "paste", "text": "详细总结" }]
                        },
                        "down": {
                            "doubleClick": [{ "type": "key", "key": "Enter" }]
                        }
                    }
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn pressing_trigger_key_again_exits_without_executing_and_swallows_release() {
        let settings = sample_settings();
        let mut mode = QuickMode::default();
        assert!(mode.enter_from_settings("dev", "rc003", "遥控器", "q1", "menu", false, &settings));
        assert!(mode.is_active());

        assert!(matches!(mode.edge("menu", true, 100), Intercept::Exited));
        assert!(!mode.is_active());
        // Paired release is swallowed so the base profile does not see an orphan key-up.
        assert!(matches!(mode.edge("menu", false, 150), Intercept::Swallow));
        assert!(matches!(
            mode.edge("menu", true, 200),
            Intercept::PassThrough
        ));
    }

    #[test]
    fn entering_from_long_press_ignores_initial_trigger_release_before_accepting_second_press() {
        let settings = sample_settings();
        let mut mode = QuickMode::default();
        assert!(mode.enter_from_settings("dev", "rc003", "遥控器", "q1", "menu", true, &settings));
        assert!(matches!(mode.edge("menu", false, 700), Intercept::Swallow));
        assert!(mode.is_active());

        assert!(matches!(mode.edge("menu", true, 900), Intercept::Exited));
        assert!(!mode.is_active());
    }

    #[test]
    fn pressing_configured_key_exits_and_executes_quick_profile_action() {
        let settings = sample_settings();
        let mut mode = QuickMode::default();
        assert!(mode.enter_from_settings("dev", "rc003", "遥控器", "q1", "menu", false, &settings));

        assert!(matches!(mode.edge("up", true, 10), Intercept::Swallow));
        match mode.edge("up", false, 60) {
            Intercept::Execute(execs) => {
                assert_eq!(execs.len(), 1);
                assert_eq!(execs[0].input, "up");
                assert_eq!(
                    execs[0].behaviors,
                    vec![NativeBehavior::Paste {
                        enabled: true,
                        text: "翻译为英文".into()
                    }]
                );
            }
            _ => panic!("expected quick execution"),
        }
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("up", true, 100), Intercept::PassThrough));
    }

    #[test]
    fn long_press_inside_quick_mode_executes_at_threshold_and_swallows_late_release() {
        let settings = sample_settings();
        let mut mode = QuickMode::default();
        assert!(mode.enter_from_settings("dev", "rc003", "遥控器", "q1", "menu", false, &settings));

        assert!(matches!(mode.edge("up", true, 100), Intercept::Swallow));
        assert!(mode.tick(699).is_none());
        let execs = mode.tick(700).expect("long press fires at 600ms");
        assert_eq!(execs.len(), 1);
        assert_eq!(
            execs[0].behaviors,
            vec![NativeBehavior::Paste {
                enabled: true,
                text: "详细总结".into()
            }]
        );
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("up", false, 850), Intercept::Swallow));
        assert!(matches!(mode.edge("up", true, 900), Intercept::PassThrough));
    }

    #[test]
    fn unconfigured_key_exits_cleanly_without_forwarding_raw_input() {
        let settings = sample_settings();
        let mut mode = QuickMode::default();
        assert!(mode.enter_from_settings("dev", "rc003", "遥控器", "q1", "menu", false, &settings));

        assert!(matches!(mode.edge("back", true, 50), Intercept::Exited));
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("back", false, 90), Intercept::Swallow));
    }

    #[test]
    fn external_dismissal_cancels_pending_gestures_and_resumes_regular_mapping_after_release() {
        let settings = sample_settings();
        let mut mode = QuickMode::default();
        assert!(mode.enter_from_settings("dev", "rc003", "遥控器", "q1", "menu", false, &settings));
        assert!(matches!(mode.edge("up", true, 100), Intercept::Swallow));
        let revision = mode.session.as_ref().unwrap().revision;
        let _ = crate::quick_overlay::close_revision(revision);
        assert!(mode.tick(800).is_none());
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("up", false, 850), Intercept::Swallow));
        assert!(matches!(mode.edge("up", true, 900), Intercept::PassThrough));
    }

    #[test]
    fn clipboard_target_inputs_orders_descriptor_keys_and_excludes_trigger_and_axes() {
        let rc_targets = clipboard_target_inputs("rc003", "menu");
        assert!(!rc_targets.is_empty());
        assert!(!rc_targets.iter().any(|id| id == "menu"));

        let kivo_targets = clipboard_target_inputs("kivoK18Lite", "kivo.k18Lite.k01");
        assert_eq!(kivo_targets.len(), 17);
        assert!(!kivo_targets.iter().any(|id| id == "kivo.k18Lite.k01"));
        assert_eq!(
            kivo_targets.first().map(String::as_str),
            Some("kivo.k18Lite.k02")
        );

        let xbox_targets = clipboard_target_inputs("xboxBluetooth", "xbox.bt.a");
        assert!(!xbox_targets.is_empty());
        assert!(!xbox_targets.iter().any(|id| id == "xbox.bt.a"));
        let xbox_desc = crate::devices::descriptor_registry::descriptor_for_kind("xboxBluetooth")
            .expect("xboxBluetooth descriptor should exist");
        for key in &xbox_targets {
            let input = xbox_desc
                .inputs
                .iter()
                .find(|candidate| {
                    candidate.id == key.as_str()
                        || candidate
                            .legacy_key
                            .as_deref()
                            .is_some_and(|aliases| aliases.split_whitespace().any(|a| a == key))
                })
                .expect("returned clipboard target key must exist in descriptor");
            assert!(!input.pending);
            assert_ne!(input.kind, "axis");
        }

        assert_eq!(
            clipboard_target_inputs("mouse", "mouse.global.buttonMiddle"),
            vec![
                "mouse.global.buttonForward".to_string(),
                "mouse.global.buttonBack".to_string(),
            ]
        );
        let mouse_top_targets = clipboard_target_inputs("mouse", "mouse.top.buttonMiddle");
        assert_eq!(mouse_top_targets.len(), 8);
        assert!(!mouse_top_targets
            .iter()
            .any(|id| id == "mouse.top.buttonMiddle"));
        assert!(mouse_top_targets
            .iter()
            .all(|id| id.starts_with("mouse.top.")));
    }

    #[test]
    fn enter_clipboard_entries_maps_paste_copy_repeat_exit_unmapped_and_empty_history() {
        let targets = clipboard_target_inputs("rc003", "menu");
        assert!(targets.len() >= 2);
        let entries = vec![
            crate::clipboard_history::ClipboardEntry {
                text: "alpha".into(),
                copied_at_ms: 1,
            },
            crate::clipboard_history::ClipboardEntry {
                text: "beta".into(),
                copied_at_ms: 2,
            },
        ];

        // 1. Paste mode maps slots in order, executes and exits, then passes through subsequent presses.
        let mut mode = QuickMode::default();
        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::Paste,
            "menu",
            false,
            &entries,
        ));
        assert!(mode.is_active());
        assert_eq!(mode.active_slot_count(), 2);
        assert!(matches!(
            mode.edge(&targets[0], true, 10),
            Intercept::Swallow
        ));
        match mode.edge(&targets[0], false, 40) {
            Intercept::Execute(execs) => {
                assert_eq!(execs.len(), 1);
                assert_eq!(
                    execs[0].behaviors,
                    vec![NativeBehavior::Paste {
                        enabled: true,
                        text: "alpha".into(),
                    }]
                );
            }
            _ => panic!("expected paste execution"),
        }
        assert!(!mode.is_active());
        assert!(matches!(
            mode.edge(&targets[0], true, 60),
            Intercept::PassThrough
        ));

        // 2. CopyText mode binds CopyText instead of Paste.
        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::CopyText,
            "menu",
            false,
            &entries[..1],
        ));
        assert_eq!(mode.active_slot_count(), 1);
        assert!(matches!(
            mode.edge(&targets[0], true, 100),
            Intercept::Swallow
        ));
        match mode.edge(&targets[0], false, 130) {
            Intercept::Execute(execs) => {
                assert_eq!(
                    execs[0].behaviors,
                    vec![NativeBehavior::CopyText {
                        enabled: true,
                        text: "alpha".into(),
                        title: None,
                    }]
                );
            }
            _ => panic!("expected copyText execution"),
        }
        assert!(!mode.is_active());

        // 3. Pressing trigger key again exits and swallows its paired release.
        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::Paste,
            "menu",
            false,
            &entries,
        ));
        assert!(matches!(mode.edge("menu", true, 150), Intercept::Exited));
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("menu", false, 180), Intercept::Swallow));

        // 4. Pressing an unmapped key (when fewer entries than device keys) exits cleanly.
        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::Paste,
            "menu",
            false,
            &entries[..1],
        ));
        assert!(matches!(
            mode.edge(&targets[1], true, 200),
            Intercept::Exited
        ));
        assert!(!mode.is_active());
        assert!(matches!(
            mode.edge(&targets[1], false, 230),
            Intercept::Swallow
        ));

        // 5. Empty history still activates so empty overlay HUD opens, and trigger exits it.
        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::Paste,
            "menu",
            false,
            &[],
        ));
        assert!(mode.is_active());
        assert_eq!(mode.active_slot_count(), 0);
        assert!(matches!(mode.edge("menu", true, 250), Intercept::Exited));
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("menu", false, 280), Intercept::Swallow));
    }
}
