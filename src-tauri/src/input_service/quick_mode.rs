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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClipboardNavDirection {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClipboardNav {
    Up,
    Down,
    Confirm,
    Cancel,
}

pub(crate) fn classify_clipboard_nav(device_kind: &str, input: &str) -> Option<ClipboardNav> {
    if device_kind == "mouse" {
        if input == "mouse.global.buttonForward" || input.ends_with(".up") {
            return Some(ClipboardNav::Up);
        }
        if input == "mouse.global.buttonBack" || input.ends_with(".down") {
            return Some(ClipboardNav::Down);
        }
        if input == "mouse.global.buttonMiddle" || input.ends_with(".buttonMiddle") {
            return Some(ClipboardNav::Confirm);
        }
        return None;
    }
    let meta = crate::devices::descriptor_registry::input_icon_and_kind(device_kind, input);
    if matches!(meta, Some((_, "axis"))) {
        return None;
    }
    let icon = meta.and_then(|(icon, _)| icon);
    let token = input
        .rsplit('.')
        .next()
        .unwrap_or(input)
        .to_ascii_lowercase();
    if matches!(token.as_str(), "confirm" | "ok" | "enter" | "select")
        || (device_kind == "xboxBluetooth" && token == "a")
        || input == "xbox.a"
    {
        return Some(ClipboardNav::Confirm);
    }
    if matches!(token.as_str(), "back" | "cancel" | "escape" | "esc")
        || (device_kind == "xboxBluetooth" && token == "b")
        || input == "xbox.b"
        || icon == Some("back")
    {
        return Some(ClipboardNav::Cancel);
    }
    if matches!(
        token.as_str(),
        "up" | "swipeup" | "channelup" | "pageup" | "prev" | "previous"
    ) || icon == Some("up")
    {
        return Some(ClipboardNav::Up);
    }
    if matches!(
        token.as_str(),
        "down" | "swipedown" | "channeldown" | "pagedown" | "next"
    ) || icon == Some("down")
    {
        return Some(ClipboardNav::Down);
    }
    None
}

fn step_clipboard_selection(len: usize, current: usize, direction: ClipboardNavDirection) -> usize {
    if len == 0 {
        return 0;
    }
    match direction {
        ClipboardNavDirection::Up => current.saturating_sub(1),
        ClipboardNavDirection::Down => (current + 1).min(len - 1),
    }
}

fn clipboard_execution(
    input: &str,
    action: ClipboardOverlayAction,
    entry: &crate::clipboard_history::ClipboardEntry,
) -> Execution {
    let behavior = match action {
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
    Execution {
        input: input.to_owned(),
        trigger: TriggerKind::Click,
        behaviors: vec![behavior],
        sources: Vec::new(),
    }
}

pub(crate) enum Intercept {
    PassThrough,
    Swallow,
    Exited,
    Execute(Vec<Execution>),
}

struct HeldClipboardNav {
    input: String,
    direction: ClipboardNavDirection,
    next_repeat_ms: u64,
}

enum SessionKind {
    QuickProfile {
        profile: Arc<QuickProfileConfig>,
        gestures: Gestures,
    },
    Clipboard {
        device_kind: String,
        action: ClipboardOverlayAction,
        entries: Vec<crate::clipboard_history::ClipboardEntry>,
        selected_index: usize,
        held_nav: Option<HeldClipboardNav>,
    },
}

struct ActiveSession {
    revision: u64,
    trigger_input: String,
    ignore_trigger_release: bool,
    pressed: BTreeSet<String>,
    kind: SessionKind,
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
            if active.trigger_input == candidate {
                return true;
            }
            match &active.kind {
                SessionKind::QuickProfile { profile, .. } => profile
                    .behaviors
                    .get(candidate)
                    .is_some_and(has_enabled_triggers),
                SessionKind::Clipboard { device_kind, .. } => {
                    classify_clipboard_nav(device_kind, candidate).is_some()
                }
            }
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
            .map_or(0, |active| match &active.kind {
                SessionKind::QuickProfile { profile, .. } => profile.behaviors.len(),
                SessionKind::Clipboard { entries, .. } => entries.len(),
            })
    }

    #[cfg(test)]
    pub fn active_clipboard_selected(&self) -> Option<usize> {
        self.session.as_ref().and_then(|active| match &active.kind {
            SessionKind::Clipboard { selected_index, .. } => Some(*selected_index),
            SessionKind::QuickProfile { .. } => None,
        })
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
        let entry_list = entries.to_vec();
        let revision =
            crate::quick_overlay::open_session(crate::quick_overlay::QuickOverlaySession {
                revision: 0,
                source_id: source_id.to_owned(),
                device_kind: device_kind.to_owned(),
                device_name: device_name.to_owned(),
                profile_id: "__clipboard__".into(),
                profile_name: "剪贴板".into(),
                trigger_input: trigger_input.to_owned(),
                behaviors: serde_json::json!({}),
                pressed: Vec::new(),
                preview: false,
                prompt_mode: false,
                clipboard: Some(crate::quick_overlay::ClipboardOverlayState {
                    action,
                    entries: entry_list.clone(),
                    selected_index: 0,
                }),
                descriptor_svg: None,
            });
        self.store_session(
            revision,
            trigger_input,
            trigger_still_down,
            SessionKind::Clipboard {
                device_kind: device_kind.to_owned(),
                action,
                entries: entry_list,
                selected_index: 0,
                held_nav: None,
            },
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
                clipboard: None,
                descriptor_svg,
            });
        self.store_session(
            revision,
            trigger_input,
            trigger_still_down,
            SessionKind::QuickProfile {
                profile: Arc::new(profile),
                gestures: Gestures::default(),
            },
        );
    }

    fn store_session(
        &mut self,
        revision: u64,
        trigger_input: &str,
        trigger_still_down: bool,
        kind: SessionKind,
    ) {
        if let Some(previous) = self.session.take() {
            self.swallow_until_release.extend(previous.pressed);
        }
        if trigger_still_down {
            self.swallow_until_release.remove(trigger_input);
        }
        self.session = Some(ActiveSession {
            revision,
            trigger_input: trigger_input.to_owned(),
            ignore_trigger_release: trigger_still_down,
            pressed: BTreeSet::new(),
            kind,
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
        let revision = active.revision;
        match &mut active.kind {
            SessionKind::QuickProfile { profile, gestures } => {
                let executions = gestures.tick(now_ms, &profile.behaviors);
                if executions.is_empty() {
                    return None;
                }
                let finished = self.session.take().unwrap();
                self.swallow_until_release.extend(finished.pressed);
                let _ = crate::quick_overlay::close_revision(finished.revision);
                Some(executions)
            }
            SessionKind::Clipboard {
                entries,
                selected_index,
                held_nav,
                ..
            } => {
                if let Some(held) = held_nav.as_mut() {
                    if now_ms >= held.next_repeat_ms {
                        held.next_repeat_ms = now_ms.saturating_add(110);
                        let next = step_clipboard_selection(
                            entries.len(),
                            *selected_index,
                            held.direction,
                        );
                        if next != *selected_index {
                            *selected_index = next;
                            crate::quick_overlay::set_clipboard_selected(revision, next);
                        }
                    }
                }
                None
            }
        }
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

        let revision = active.revision;
        match &mut active.kind {
            SessionKind::QuickProfile { profile, gestures } => {
                let Some(mapping) = profile
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
                    revision,
                    active.pressed.iter().cloned().collect(),
                );

                let executions = gestures.edge(input, down, now_ms, mapping);
                if executions.is_empty() {
                    return Intercept::Swallow;
                }
                let finished = self.session.take().unwrap();
                self.swallow_until_release.extend(finished.pressed);
                let _ = crate::quick_overlay::close_revision(finished.revision);
                Intercept::Execute(executions)
            }
            SessionKind::Clipboard {
                device_kind,
                action,
                entries,
                selected_index,
                held_nav,
            } => match classify_clipboard_nav(device_kind, input) {
                Some(ClipboardNav::Cancel) => {
                    if down {
                        let finished = self.session.take().unwrap();
                        self.swallow_until_release.extend(finished.pressed);
                        self.swallow_until_release.insert(input.to_owned());
                        let _ = crate::quick_overlay::close_revision(finished.revision);
                        Intercept::Exited
                    } else {
                        active.pressed.remove(input);
                        Intercept::Swallow
                    }
                }
                Some(ClipboardNav::Confirm) => {
                    if down {
                        let exec = entries
                            .get(*selected_index)
                            .map(|entry| clipboard_execution(input, *action, entry));
                        let finished = self.session.take().unwrap();
                        self.swallow_until_release.extend(finished.pressed);
                        self.swallow_until_release.insert(input.to_owned());
                        let _ = crate::quick_overlay::close_revision(finished.revision);
                        match exec {
                            Some(execution) => Intercept::Execute(vec![execution]),
                            None => Intercept::Exited,
                        }
                    } else {
                        active.pressed.remove(input);
                        Intercept::Swallow
                    }
                }
                Some(nav @ (ClipboardNav::Up | ClipboardNav::Down)) => {
                    let direction = if nav == ClipboardNav::Up {
                        ClipboardNavDirection::Up
                    } else {
                        ClipboardNavDirection::Down
                    };
                    if down {
                        active.pressed.insert(input.to_owned());
                        let next =
                            step_clipboard_selection(entries.len(), *selected_index, direction);
                        if next != *selected_index {
                            *selected_index = next;
                            crate::quick_overlay::set_clipboard_selected(revision, next);
                        }
                        *held_nav = Some(HeldClipboardNav {
                            input: input.to_owned(),
                            direction,
                            next_repeat_ms: now_ms.saturating_add(400),
                        });
                    } else {
                        active.pressed.remove(input);
                        if held_nav.as_ref().is_some_and(|held| held.input == input) {
                            *held_nav = None;
                        }
                    }
                    Intercept::Swallow
                }
                None => {
                    if device_kind == "mouse" {
                        Intercept::PassThrough
                    } else {
                        if down {
                            active.pressed.insert(input.to_owned());
                        } else {
                            active.pressed.remove(input);
                        }
                        Intercept::Swallow
                    }
                }
            },
        }
    }

    /// Discrete inputs without press/release pairs (such as mouse wheel ticks).
    pub fn discrete_edge(&mut self, input: &str) -> Intercept {
        self.sync_external_dismissal();
        if matches!(
            self.session.as_ref().map(|active| &active.kind),
            Some(SessionKind::Clipboard { .. })
        ) {
            let active = self.session.as_mut().unwrap();
            if input == active.trigger_input {
                let finished = self.session.take().unwrap();
                self.swallow_until_release.extend(finished.pressed);
                let _ = crate::quick_overlay::close_revision(finished.revision);
                return Intercept::Exited;
            }
            let revision = active.revision;
            let SessionKind::Clipboard {
                device_kind,
                action,
                entries,
                selected_index,
                ..
            } = &mut active.kind
            else {
                unreachable!();
            };
            return match classify_clipboard_nav(device_kind, input) {
                Some(ClipboardNav::Up) => {
                    let next = step_clipboard_selection(
                        entries.len(),
                        *selected_index,
                        ClipboardNavDirection::Up,
                    );
                    if next != *selected_index {
                        *selected_index = next;
                        crate::quick_overlay::set_clipboard_selected(revision, next);
                    }
                    Intercept::Swallow
                }
                Some(ClipboardNav::Down) => {
                    let next = step_clipboard_selection(
                        entries.len(),
                        *selected_index,
                        ClipboardNavDirection::Down,
                    );
                    if next != *selected_index {
                        *selected_index = next;
                        crate::quick_overlay::set_clipboard_selected(revision, next);
                    }
                    Intercept::Swallow
                }
                Some(ClipboardNav::Confirm) => {
                    let exec = entries
                        .get(*selected_index)
                        .map(|entry| clipboard_execution(input, *action, entry));
                    let finished = self.session.take().unwrap();
                    self.swallow_until_release.extend(finished.pressed);
                    let _ = crate::quick_overlay::close_revision(finished.revision);
                    match exec {
                        Some(execution) => Intercept::Execute(vec![execution]),
                        None => Intercept::Exited,
                    }
                }
                Some(ClipboardNav::Cancel) => {
                    let finished = self.session.take().unwrap();
                    self.swallow_until_release.extend(finished.pressed);
                    let _ = crate::quick_overlay::close_revision(finished.revision);
                    Intercept::Exited
                }
                None => Intercept::Swallow,
            };
        }
        let Some(finished) = self.session.take() else {
            return Intercept::PassThrough;
        };
        self.swallow_until_release.extend(finished.pressed);
        let _ = crate::quick_overlay::close_revision(finished.revision);
        if input == finished.trigger_input {
            return Intercept::Exited;
        }
        let SessionKind::QuickProfile { profile, .. } = &finished.kind else {
            return Intercept::Exited;
        };
        let Some(mapping) = profile.behaviors.get(input) else {
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
    fn classify_clipboard_nav_recognizes_directions_confirm_cancel_and_skips_axes() {
        assert_eq!(
            classify_clipboard_nav("rc003", "up"),
            Some(ClipboardNav::Up)
        );
        assert_eq!(
            classify_clipboard_nav("rc003", "down"),
            Some(ClipboardNav::Down)
        );
        assert_eq!(
            classify_clipboard_nav("rc003", "confirm"),
            Some(ClipboardNav::Confirm)
        );
        assert_eq!(
            classify_clipboard_nav("rc003", "back"),
            Some(ClipboardNav::Cancel)
        );
        assert_eq!(classify_clipboard_nav("rc003", "menu"), None);
        assert_eq!(classify_clipboard_nav("rc003", "power"), None);

        assert_eq!(
            classify_clipboard_nav("tclRc802a", "tcl-rc802a.up"),
            Some(ClipboardNav::Up)
        );
        assert_eq!(
            classify_clipboard_nav("tclRc802a", "tcl-rc802a.down"),
            Some(ClipboardNav::Down)
        );
        assert_eq!(
            classify_clipboard_nav("tclRc802a", "tcl-rc802a.confirm"),
            Some(ClipboardNav::Confirm)
        );
        assert_eq!(
            classify_clipboard_nav("tclRc802a", "tcl-rc802a.back"),
            Some(ClipboardNav::Cancel)
        );

        assert_eq!(
            classify_clipboard_nav("xboxBluetooth", "xbox.dpad.up"),
            Some(ClipboardNav::Up)
        );
        assert_eq!(
            classify_clipboard_nav("xboxBluetooth", "xbox.dpad.down"),
            Some(ClipboardNav::Down)
        );
        assert_eq!(
            classify_clipboard_nav("xboxBluetooth", "xbox.bt.a"),
            Some(ClipboardNav::Confirm)
        );
        assert_eq!(
            classify_clipboard_nav("xboxBluetooth", "xbox.bt.b"),
            Some(ClipboardNav::Cancel)
        );
        assert_eq!(classify_clipboard_nav("xboxBluetooth", "xbox.ls.up"), None);

        assert_eq!(
            classify_clipboard_nav("mouse", "mouse.global.buttonForward"),
            Some(ClipboardNav::Up)
        );
        assert_eq!(
            classify_clipboard_nav("mouse", "mouse.top.up"),
            Some(ClipboardNav::Up)
        );
        assert_eq!(
            classify_clipboard_nav("mouse", "mouse.global.buttonBack"),
            Some(ClipboardNav::Down)
        );
        assert_eq!(
            classify_clipboard_nav("mouse", "mouse.top.down"),
            Some(ClipboardNav::Down)
        );
        assert_eq!(
            classify_clipboard_nav("mouse", "mouse.global.buttonMiddle"),
            Some(ClipboardNav::Confirm)
        );
        assert_eq!(
            classify_clipboard_nav("mouse", "mouse.top.buttonLeft"),
            None
        );
    }

    #[test]
    fn clipboard_list_navigation_paste_copy_repeat_hold_cancel_and_empty_history() {
        let entries = vec![
            crate::clipboard_history::ClipboardEntry {
                text: "newest".into(),
                copied_at_ms: 300,
            },
            crate::clipboard_history::ClipboardEntry {
                text: "middle".into(),
                copied_at_ms: 200,
            },
            crate::clipboard_history::ClipboardEntry {
                text: "oldest".into(),
                copied_at_ms: 100,
            },
        ];

        // 1. Enter Paste list HUD, clamp Up at 0, step Down + hold-repeat, step Up, Confirm executes selected.
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
        assert_eq!(mode.active_slot_count(), 3);
        assert_eq!(mode.active_clipboard_selected(), Some(0));

        assert!(matches!(mode.edge("up", true, 10), Intercept::Swallow));
        assert!(matches!(mode.edge("up", false, 20), Intercept::Swallow));
        assert_eq!(mode.active_clipboard_selected(), Some(0));

        assert!(matches!(mode.edge("down", true, 100), Intercept::Swallow));
        assert_eq!(mode.active_clipboard_selected(), Some(1));
        assert!(mode.tick(499).is_none());
        assert_eq!(mode.active_clipboard_selected(), Some(1));
        assert!(mode.tick(500).is_none());
        assert_eq!(mode.active_clipboard_selected(), Some(2));
        assert!(mode.tick(610).is_none());
        assert_eq!(mode.active_clipboard_selected(), Some(2));
        assert!(matches!(mode.edge("down", false, 650), Intercept::Swallow));
        assert!(mode.tick(800).is_none());
        assert_eq!(mode.active_clipboard_selected(), Some(2));

        assert!(matches!(mode.edge("up", true, 820), Intercept::Swallow));
        assert!(matches!(mode.edge("up", false, 840), Intercept::Swallow));
        assert_eq!(mode.active_clipboard_selected(), Some(1));

        match mode.edge("confirm", true, 900) {
            Intercept::Execute(execs) => {
                assert_eq!(execs.len(), 1);
                assert_eq!(
                    execs[0].behaviors,
                    vec![NativeBehavior::Paste {
                        enabled: true,
                        text: "middle".into(),
                    }]
                );
            }
            _ => panic!("expected paste execution on confirm"),
        }
        assert!(!mode.is_active());
        assert!(matches!(
            mode.edge("confirm", false, 930),
            Intercept::Swallow
        ));
        assert!(matches!(
            mode.edge("confirm", true, 960),
            Intercept::PassThrough
        ));

        // 2. CopyText mode confirms with CopyText.
        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::CopyText,
            "menu",
            false,
            &entries[..2],
        ));
        match mode.edge("confirm", true, 1000) {
            Intercept::Execute(execs) => {
                assert_eq!(
                    execs[0].behaviors,
                    vec![NativeBehavior::CopyText {
                        enabled: true,
                        text: "newest".into(),
                        title: None,
                    }]
                );
            }
            _ => panic!("expected copyText execution on confirm"),
        }
        assert!(!mode.is_active());
        assert!(matches!(
            mode.edge("confirm", false, 1020),
            Intercept::Swallow
        ));

        // 3. Unmapped keys keep HUD open; Cancel (`back`) and repeat trigger (`menu`) exit cleanly.
        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::Paste,
            "menu",
            false,
            &entries,
        ));
        assert!(matches!(mode.edge("power", true, 1100), Intercept::Swallow));
        assert!(matches!(
            mode.edge("power", false, 1120),
            Intercept::Swallow
        ));
        assert!(mode.is_active());
        assert!(matches!(mode.edge("back", true, 1150), Intercept::Exited));
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("back", false, 1180), Intercept::Swallow));

        assert!(mode.enter_clipboard_entries(
            "dev",
            "rc003",
            "遥控器",
            ClipboardOverlayAction::Paste,
            "menu",
            false,
            &entries,
        ));
        assert!(matches!(mode.edge("menu", true, 1200), Intercept::Exited));
        assert!(!mode.is_active());
        assert!(matches!(mode.edge("menu", false, 1220), Intercept::Swallow));

        // 4. Empty history stays safe on Up/Down and exits cleanly on Confirm.
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
        assert!(matches!(mode.edge("up", true, 1300), Intercept::Swallow));
        assert!(matches!(mode.edge("down", true, 1310), Intercept::Swallow));
        assert_eq!(mode.active_clipboard_selected(), Some(0));
        assert!(matches!(
            mode.edge("confirm", true, 1320),
            Intercept::Exited
        ));
        assert!(!mode.is_active());
        assert!(matches!(
            mode.edge("confirm", false, 1340),
            Intercept::Swallow
        ));
    }
}
