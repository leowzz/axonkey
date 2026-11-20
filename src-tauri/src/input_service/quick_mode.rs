//! Ephemeral single-shot profile session shared by all device input backends.
use super::{
    managed::gesture::{Execution, Gestures, TriggerKind},
    NativeBehavior, NativeSettings, QuickProfileConfig, TriggerBehaviors,
};
use std::{
    collections::{BTreeSet, HashSet},
    sync::Arc,
};

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
        quick_profiles: &std::collections::HashMap<String, QuickProfileConfig>,
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
        let revision = crate::quick_overlay::open(
            source_id.to_owned(),
            device_kind,
            device_name,
            profile.id.clone(),
            profile.name.clone(),
            trigger_input.to_owned(),
            profile.raw_behaviors.clone(),
            false,
            profile.prompt_mode,
        );
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
        true
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
}
