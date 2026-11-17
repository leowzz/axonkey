//! Shared remote gestures; each platform supplies its keyboard representation.
use super::{
    MouseButton, NativeBehavior, NativeSettings, RepeatableClick, TriggerBehaviors, WheelDirection,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const DOUBLE_CLICK: Duration = Duration::from_millis(350);
const LONG_PRESS: Duration = Duration::from_millis(600);

struct Press<K> {
    started: Instant,
    triggers: TriggerBehaviors,
    second: bool,
    long_fired: bool,
    repeat: Option<RepeatableClick>,
    next_repeat: Instant,
    held: Vec<K>,
}

#[derive(Default)]
struct Button<K> {
    press: Option<Press<K>>,
    pending: Option<(Instant, Vec<NativeBehavior>, Vec<String>)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub(super) struct HidKey {
    pub page: u16,
    pub usage: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Output<K = HidKey> {
    LibraryTrigger(&'static str, Vec<String>),
    CursorMove(WheelDirection, u32),
    MouseClick(MouseButton),
    Wheel(WheelDirection),
    TypeText(String),
    OpenPath(String),
    Paste(String),
    OpenApp(String),
    OpenWebsite(String),
    Key(K, bool),
    SwitchProfile(super::ProfileDirection, bool),
}

#[derive(Default)]
pub(super) struct RemoteActions<K = HidKey> {
    revision: u64,
    enabled: bool,
    source_id: String,
    device_kind: String,
    device_name: String,
    epoch: Option<Instant>,
    quick_profiles: std::sync::Arc<HashMap<String, super::QuickProfileConfig>>,
    quick_mode: super::quick_mode::QuickMode,
    button_refs: HashMap<String, &'static str>,
    held: HashMap<K, usize>,
    held_order: Vec<K>,
    releases: Vec<Output<K>>,
    buttons: HashMap<&'static str, Button<K>>,
    scheduled: Vec<(Instant, Output<K>)>,
}

pub(super) trait RemoteKey: Copy + Eq + std::hash::Hash + Default {
    fn chord(behavior: &NativeBehavior) -> Option<Vec<Self>>;
    fn original(button: &str) -> Option<Self>;
}

#[cfg(any(windows, test))]
impl RemoteKey for HidKey {
    fn chord(behavior: &NativeBehavior) -> Option<Vec<Self>> {
        super::windows::behavior_hid_chord(behavior)
    }
    fn original(button: &str) -> Option<Self> {
        super::windows::original_key_for_button(button)
    }
}

fn enabled(actions: &[NativeBehavior]) -> bool {
    actions.iter().any(NativeBehavior::enabled)
}

fn queued_actions<K>(queue: &[(Instant, Output<K>)]) -> usize {
    queue
        .iter()
        .filter(|(_, output)| !matches!(output, Output::LibraryTrigger(..)))
        .count()
}

fn schedule<K: RemoteKey>(
    queue: &mut Vec<(Instant, Output<K>)>,
    actions: &[NativeBehavior],
    sources: Option<&[String]>,
    input: &'static str,
    now: Instant,
) {
    if let Some(sources) = sources.filter(|_| {
        actions
            .iter()
            .any(|action| action.enabled() && !matches!(action, NativeBehavior::Disabled { .. }))
    }) {
        if queued_actions(queue) < 256 {
            queue.push((now, Output::LibraryTrigger(input, sources.to_vec())));
        }
    }
    let mut due = now;
    for action in actions.iter().filter(|action| action.enabled()) {
        if queued_actions(queue) >= 256 {
            break;
        }
        match action {
            NativeBehavior::Delay { ms, .. } => due += Duration::from_millis((*ms).min(300_000)),
            NativeBehavior::CursorMove {
                direction,
                distance,
                ..
            } => {
                queue.push((due, Output::CursorMove(*direction, *distance)));
            }
            NativeBehavior::Mouse { button, .. } => {
                queue.push((due, Output::MouseClick(*button)));
            }
            NativeBehavior::Wheel { direction, .. } => queue.push((due, Output::Wheel(*direction))),
            NativeBehavior::TypeText { text, .. } => {
                queue.push((due, Output::TypeText(text.clone())))
            }
            NativeBehavior::OpenPath { path, .. } => {
                queue.push((due, Output::OpenPath(path.clone())))
            }
            NativeBehavior::Paste { text, .. } => queue.push((due, Output::Paste(text.clone()))),
            NativeBehavior::OpenApp { path, .. } => {
                queue.push((due, Output::OpenApp(path.clone())))
            }
            NativeBehavior::OpenWebsite { url, .. } => {
                queue.push((due, Output::OpenWebsite(url.clone())))
            }
            NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. } => {
                if let Some(keys) = K::chord(action) {
                    if queued_actions(queue) + keys.len() * 2 <= 256 {
                        queue.extend(keys.iter().map(|key| (due, Output::Key(*key, true))));
                        queue.extend(keys.iter().rev().map(|key| (due, Output::Key(*key, false))));
                    }
                }
            }
            NativeBehavior::SwitchProfile {
                direction, wrap, ..
            } => {
                queue.push((due, Output::SwitchProfile(*direction, *wrap)));
            }
            NativeBehavior::QuickOverlay { .. } | NativeBehavior::Disabled { .. } => {}
        }
    }
}

fn find_quick_overlay_profile_id(actions: &[NativeBehavior]) -> Option<&str> {
    actions.iter().find_map(|action| match action {
        NativeBehavior::QuickOverlay {
            enabled: true,
            profile_id,
        } if !profile_id.trim().is_empty() => Some(profile_id.trim()),
        _ => None,
    })
}

fn repeat_output<K>(action: RepeatableClick) -> Output<K> {
    match action {
        RepeatableClick::Wheel(direction) => Output::Wheel(direction),
        RepeatableClick::CursorMove {
            direction,
            distance,
        } => Output::CursorMove(direction, distance),
    }
}

fn schedule_click<K: RemoteKey>(
    queue: &mut Vec<(Instant, Output<K>)>,
    actions: &[NativeBehavior],
    button: &'static str,
    sources: &[String],
    now: Instant,
) {
    if enabled(actions) {
        schedule(queue, actions, Some(sources), button, now);
    } else if queued_actions(queue) + 2 <= 256 {
        // Configuring only double/long press must preserve an ordinary click.
        // An explicitly enabled Disabled action suppresses this fallback.
        if let Some(key) = K::original(button) {
            queue.extend([
                (now, Output::Key(key, true)),
                (now, Output::Key(key, false)),
            ]);
        }
    }
}

impl<K: RemoteKey> RemoteActions<K> {
    pub fn set_source(
        &mut self,
        source_id: impl Into<String>,
        device_kind: impl Into<String>,
        device_name: impl Into<String>,
    ) {
        self.source_id = source_id.into();
        self.device_kind = device_kind.into();
        self.device_name = device_name.into();
    }

    fn elapsed_ms(&mut self, now: Instant) -> u64 {
        let base = *self.epoch.get_or_insert(now);
        now.saturating_duration_since(base).as_millis() as u64
    }

    fn source_meta(&self) -> (&str, &str, &str) {
        let id = if self.source_id.is_empty() {
            "legacy-rc003"
        } else {
            &self.source_id
        };
        let kind = if self.device_kind.is_empty() {
            "rc003"
        } else {
            &self.device_kind
        };
        let name = if self.device_name.is_empty() {
            "遥控器"
        } else {
            &self.device_name
        };
        (id, kind, name)
    }

    fn try_enter_quick_overlay(
        &mut self,
        actions: &[NativeBehavior],
        button: &'static str,
        still_down: bool,
    ) -> bool {
        let Some(profile_id) = find_quick_overlay_profile_id(actions) else {
            return false;
        };
        let (id, kind, name) = (
            self.source_meta().0.to_owned(),
            self.source_meta().1.to_owned(),
            self.source_meta().2.to_owned(),
        );
        self.quick_mode.enter_with_profiles(
            &id,
            &kind,
            &name,
            profile_id,
            button,
            still_down,
            &self.quick_profiles,
        )
    }

    fn apply_quick_executions(
        &mut self,
        executions: Vec<super::managed::gesture::Execution>,
        now: Instant,
    ) {
        for exec in executions {
            let button = self
                .button_refs
                .get(&exec.input)
                .copied()
                .unwrap_or("unknown");
            let still_down = self
                .buttons
                .get(button)
                .and_then(|s| s.press.as_ref())
                .is_some();
            if self.try_enter_quick_overlay(&exec.behaviors, button, still_down) {
                continue;
            }
            schedule(
                &mut self.scheduled,
                &exec.behaviors,
                Some(&exec.sources),
                button,
                now,
            );
        }
    }

    pub fn cancel(&mut self) {
        self.quick_mode.reset();
        self.releases.extend(
            self.held_order
                .drain(..)
                .rev()
                .map(|key| Output::Key(key, false)),
        );
        self.held.clear();
        self.buttons.clear();
        self.scheduled.clear();
    }

    pub fn synchronize(&mut self, revision: u64, enabled: bool) {
        if revision != self.revision || enabled != self.enabled {
            self.cancel();
            self.revision = revision;
            self.enabled = enabled;
        }
    }

    pub fn edge(
        &mut self,
        button: &'static str,
        down: bool,
        settings: &NativeSettings,
        now: Instant,
    ) {
        self.button_refs.entry(button.to_owned()).or_insert(button);
        if self.quick_profiles.as_ref() != &settings.quick_profiles {
            self.quick_profiles = std::sync::Arc::new(settings.quick_profiles.clone());
        }
        if settings.enabled {
            let now_ms = self.elapsed_ms(now);
            match self.quick_mode.edge(button, down, now_ms) {
                super::quick_mode::Intercept::PassThrough => {}
                super::quick_mode::Intercept::Swallow | super::quick_mode::Intercept::Exited => {
                    return;
                }
                super::quick_mode::Intercept::Execute(executions) => {
                    self.apply_quick_executions(executions, now);
                    return;
                }
            }
        } else {
            self.quick_mode.reset();
        }
        let defaults = TriggerBehaviors::default();
        let triggers = settings.behaviors.get(button).unwrap_or(&defaults);
        let custom = enabled(&triggers.click)
            || enabled(&triggers.double_click)
            || enabled(&triggers.long_press);
        // A single keyboard click follows the physical press. The platform
        // output adapter owns keyboard repeat.
        let held = if !settings.enabled || !custom {
            K::original(button).map(|key| vec![key]).unwrap_or_default()
        } else if !enabled(&triggers.double_click) && !enabled(&triggers.long_press) {
            let clicks: Vec<_> = triggers
                .click
                .iter()
                .filter(|action| action.enabled())
                .collect();
            if clicks.len() == 1 {
                K::chord(clicks[0]).unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        let state = self.buttons.entry(button).or_default();
        if down {
            if state.press.is_some() {
                return;
            }
            if !held.is_empty() {
                if settings.enabled && custom {
                    self.scheduled.push((
                        now,
                        Output::LibraryTrigger(button, triggers.click_sources.clone()),
                    ));
                }
                self.scheduled
                    .extend(held.iter().map(|key| (now, Output::Key(*key, true))));
                state.press = Some(Press {
                    started: now,
                    triggers: triggers.clone(),
                    second: false,
                    long_fired: false,
                    repeat: None,
                    next_repeat: now,
                    held,
                });
                return;
            }
            let mut pending_due_actions = None;
            let second = match state.pending.take() {
                Some((due, actions, sources)) if now >= due => {
                    pending_due_actions = Some((actions, sources));
                    false
                }
                Some(_) => true,
                None => false,
            };
            let repeat = super::repeatable_click(triggers);
            if let Some(action) = repeat {
                {
                    self.scheduled.push((
                        now,
                        Output::LibraryTrigger(button, triggers.click_sources.clone()),
                    ));
                }
                self.scheduled.push((now, repeat_output(action)));
            }
            state.press = Some(Press {
                started: now,
                triggers: triggers.clone(),
                second,
                long_fired: false,
                repeat,
                next_repeat: now + Duration::from_millis(400),
                held: Vec::new(),
            });
            if let Some((actions, sources)) = pending_due_actions {
                if self.try_enter_quick_overlay(&actions, button, true) {
                    self.buttons.remove(button);
                } else {
                    schedule_click(&mut self.scheduled, &actions, button, &sources, now);
                }
            }
        } else if let Some(press) = self.buttons.get_mut(button).and_then(|s| s.press.take()) {
            if !press.held.is_empty() {
                self.scheduled.extend(
                    press
                        .held
                        .iter()
                        .rev()
                        .map(|key| (now, Output::Key(*key, false))),
                );
                return;
            }
            if press.repeat.is_some() || press.long_fired {
                return;
            }
            // A release may arrive just before the next timer tick.
            if enabled(&press.triggers.long_press)
                && now.duration_since(press.started) >= LONG_PRESS
            {
                if !self.try_enter_quick_overlay(&press.triggers.long_press, button, false) {
                    schedule(
                        &mut self.scheduled,
                        &press.triggers.long_press,
                        Some(&press.triggers.long_press_sources),
                        button,
                        now,
                    );
                }
            } else if press.second {
                if !self.try_enter_quick_overlay(&press.triggers.double_click, button, false) {
                    schedule(
                        &mut self.scheduled,
                        &press.triggers.double_click,
                        Some(&press.triggers.double_click_sources),
                        button,
                        now,
                    );
                }
            } else if enabled(&press.triggers.double_click) {
                self.buttons.entry(button).or_default().pending = Some((
                    now + DOUBLE_CLICK,
                    press.triggers.click,
                    press.triggers.click_sources,
                ));
            } else if !self.try_enter_quick_overlay(&press.triggers.click, button, false) {
                schedule_click(
                    &mut self.scheduled,
                    &press.triggers.click,
                    button,
                    &press.triggers.click_sources,
                    now,
                );
            }
        }
    }

    pub fn tick(&mut self, now: Instant, mut emit: impl FnMut(Output<K>)) {
        let now_ms = self.elapsed_ms(now);
        if let Some(executions) = self.quick_mode.tick(now_ms) {
            self.apply_quick_executions(executions, now);
        }
        let mut quick_entries: Vec<(&'static str, String, bool)> = Vec::new();
        for (&button, state) in &mut self.buttons {
            if let Some(press) = state.press.as_mut() {
                if !press.held.is_empty() {
                    continue;
                }
                if let Some(action) = press.repeat {
                    if now >= press.next_repeat {
                        self.scheduled.push((now, repeat_output(action)));
                        press.next_repeat = now + Duration::from_millis(80);
                    }
                } else if enabled(&press.triggers.long_press) {
                    if !press.long_fired && now.duration_since(press.started) >= LONG_PRESS {
                        if let Some(profile_id) =
                            find_quick_overlay_profile_id(&press.triggers.long_press)
                        {
                            press.long_fired = true;
                            quick_entries.push((button, profile_id.to_owned(), true));
                        } else {
                            schedule(
                                &mut self.scheduled,
                                &press.triggers.long_press,
                                Some(&press.triggers.long_press_sources),
                                button,
                                now,
                            );
                            press.long_fired = true;
                            press.next_repeat = now + Duration::from_millis(350);
                        }
                    } else if press.long_fired
                        && find_quick_overlay_profile_id(&press.triggers.long_press).is_none()
                        && now >= press.next_repeat
                    {
                        schedule(
                            &mut self.scheduled,
                            &press.triggers.long_press,
                            None,
                            button,
                            now,
                        );
                        press.next_repeat = now + Duration::from_millis(100);
                    }
                }
            }
            if state
                .pending
                .as_ref()
                .is_some_and(|(due, _, _)| now >= *due)
            {
                let (_, actions, sources) = state.pending.take().unwrap();
                if let Some(profile_id) = find_quick_overlay_profile_id(&actions) {
                    quick_entries.push((button, profile_id.to_owned(), false));
                } else {
                    schedule_click(&mut self.scheduled, &actions, button, &sources, now);
                }
            }
        }
        for (button, profile_id, still_down) in quick_entries {
            let (id, kind, name) = (
                self.source_meta().0.to_owned(),
                self.source_meta().1.to_owned(),
                self.source_meta().2.to_owned(),
            );
            let _ = self.quick_mode.enter_with_profiles(
                &id,
                &kind,
                &name,
                &profile_id,
                button,
                still_down,
                &self.quick_profiles,
            );
        }
        for release in self.releases.drain(..) {
            emit(release);
        }
        // Stable order preserves modifier down / key down / key up / modifier up.
        self.scheduled.sort_by_key(|(due, _)| *due);
        let ready = self.scheduled.partition_point(|(due, _)| *due <= now);
        for (_, output) in self.scheduled.drain(..ready) {
            match output {
                Output::Key(key, true) => {
                    let count = self.held.entry(key).or_default();
                    *count += 1;
                    if *count == 1 {
                        self.held_order.push(key);
                        emit(output);
                    }
                }
                Output::Key(key, false) => {
                    if let Some(count) = self.held.get_mut(&key) {
                        *count -= 1;
                        if *count == 0 {
                            self.held.remove(&key);
                            self.held_order.retain(|held| *held != key);
                            emit(output);
                        }
                    }
                }
                _ => emit(output),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(triggers: serde_json::Value) -> NativeSettings {
        serde_json::from_value(json!({"enabled": true, "behaviors": {"up": triggers}})).unwrap()
    }

    #[test]
    fn a15_uses_its_own_bindings_and_preserves_consumer_usage_page() {
        let settings: NativeSettings = serde_json::from_value(json!({
            "enabled": true,
            "behaviors": {
                "confirm": {"click": [{"type": "key", "key": "B"}]},
                "cmiotA15.confirm": {"click": [{"type": "key", "key": "A"}]}
            }
        }))
        .unwrap();
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.edge("cmiotA15.confirm", true, &settings, now);
        assert_eq!(keys(&mut actions, now), vec![(7, 4, true)]);
        actions.edge("cmiotA15.confirm", false, &settings, now);
        assert_eq!(keys(&mut actions, now), vec![(7, 4, false)]);
        actions.edge("cmiotA15.volumeUp", true, &settings, now);
        assert_eq!(keys(&mut actions, now), vec![(12, 0xe9, true)]);
        actions.cancel();
        assert_eq!(keys(&mut actions, now), vec![(12, 0xe9, false)]);
    }

    fn moves(cursor: &mut RemoteActions, now: Instant) -> Vec<(i32, i32)> {
        let mut output = Vec::new();
        cursor.tick(now, |event| {
            if let Output::CursorMove(direction, distance) = event {
                output.push(super::super::cursor_delta(direction, distance))
            }
        });
        output
    }

    fn keys(actions: &mut RemoteActions, now: Instant) -> Vec<(u16, u16, bool)> {
        let mut output = Vec::new();
        actions.tick(now, |event| {
            if let Output::Key(key, down) = event {
                output.push((key.page, key.usage, down));
            }
        });
        output
    }

    fn outputs(actions: &mut RemoteActions, now: Instant) -> Vec<Output> {
        let mut output = Vec::new();
        actions.tick(now, |event| {
            if !matches!(event, Output::LibraryTrigger(..)) {
                output.push(event);
            }
        });
        output
    }

    #[test]
    fn library_sequence_counts_once_and_long_repeat_never_counts_again() {
        let source = "00000000-0000-4000-8000-000000000001";
        let config = settings(json!({"longPress":[
            {"type":"key","key":"A","libraryItemId":source},
            {"type":"key","key":"B","libraryItemId":source}
        ]}));
        let now = Instant::now();
        let mut actions = RemoteActions::<HidKey>::default();
        actions.edge("up", true, &config, now);
        let mut markers = vec![];
        actions.tick(now + LONG_PRESS, |event| {
            if let Output::LibraryTrigger(input, sources) = event {
                markers.push((input, sources));
            }
        });
        assert_eq!(markers, vec![("up", vec![source.to_owned()])]);
        markers.clear();
        for offset in [950, 1050, 1200] {
            actions.tick(now + Duration::from_millis(offset), |event| {
                if let Output::LibraryTrigger(input, sources) = event {
                    markers.push((input, sources));
                }
            });
        }
        assert!(markers.is_empty());
        actions.edge("up", false, &config, now + Duration::from_secs(2));
        actions.edge("up", true, &config, now + Duration::from_secs(3));
        actions.tick(now + Duration::from_millis(3600), |event| {
            if let Output::LibraryTrigger(input, sources) = event {
                markers.push((input, sources));
            }
        });
        assert_eq!(markers.len(), 1);
    }

    #[test]
    fn usage_markers_do_not_reduce_the_output_queue_capacity() {
        let now = Instant::now();
        let mut queue = vec![(now, Output::<HidKey>::Wheel(WheelDirection::Up)); 254];
        let actions = vec![NativeBehavior::Key {
            enabled: true,
            key: "A".into(),
        }];
        schedule(&mut queue, &actions, Some(&[]), "up", now);
        assert_eq!(queued_actions(&queue), 256);
        assert_eq!(queue.len(), 257);
    }

    #[test]
    fn all_behavior_types_keep_sequence_order_and_cancel_delayed_side_effects() {
        let config = settings(json!({"click":[
            {"type":"disabled"},
            {"type":"paste","text":"ignored","enabled":false},
            {"type":"delay","ms":300000,"enabled":false},
            {"type":"wheel","direction":"left"},
            {"type":"paste","text":"中文🙂"},
            {"type":"typeText","text":"输入🙂"},
            {"type":"typeText","text":"ignored","enabled":false},
            {"type":"cursorMove","direction":"right","distance":23},
            {"type":"mouse","button":"left"},
            {"type":"key","key":"A"},
            {"type":"shortcut","keys":["Shift","B"]},
            {"type":"delay","ms":100},
            {"type":"openApp","path":"C:\\Example.exe"},
            {"type":"openPath","path":"C:\\文档 & 文件夹"},
            {"type":"openWebsite","url":"https://example.com/"}
        ]}));
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.synchronize(1, true);
        actions.edge("up", true, &config, now);
        assert!(outputs(&mut actions, now).is_empty());
        actions.edge("up", false, &config, now);
        let key = |usage, down| Output::Key(HidKey { page: 7, usage }, down);
        assert_eq!(
            outputs(&mut actions, now),
            [
                Output::Wheel(WheelDirection::Left),
                Output::Paste("中文🙂".into()),
                Output::TypeText("输入🙂".into()),
                Output::CursorMove(WheelDirection::Right, 23),
                Output::MouseClick(MouseButton::Left),
                key(4, true),
                key(4, false),
                key(0xe1, true),
                key(5, true),
                key(5, false),
                key(0xe1, false),
            ]
        );
        assert!(outputs(&mut actions, now + Duration::from_millis(99)).is_empty());
        assert_eq!(
            outputs(&mut actions, now + Duration::from_millis(100)),
            [
                Output::OpenApp("C:\\Example.exe".into()),
                Output::OpenPath("C:\\文档 & 文件夹".into()),
                Output::OpenWebsite("https://example.com/".into())
            ]
        );
        actions.edge("up", true, &config, now + Duration::from_secs(1));
        actions.edge("up", false, &config, now + Duration::from_secs(1));
        outputs(&mut actions, now + Duration::from_secs(1));
        actions.synchronize(2, true);
        assert!(outputs(&mut actions, now + Duration::from_secs(2)).is_empty());
    }

    #[test]
    fn wheel_holds_repeat_on_both_axes_and_stop_on_release_or_input_loss() {
        for direction in ["up", "down", "left", "right"] {
            let config = settings(json!({"click":[{"type":"wheel","direction":direction}]}));
            let now = Instant::now();
            let mut actions = RemoteActions::default();
            actions.edge("up", true, &config, now);
            let first = outputs(&mut actions, now);
            assert!(matches!(first.as_slice(), [Output::Wheel(_)]));
            actions.edge("up", true, &config, now + Duration::from_millis(100));
            assert!(outputs(&mut actions, now + Duration::from_millis(399)).is_empty());
            assert_eq!(
                outputs(&mut actions, now + Duration::from_millis(400)),
                first
            );
            assert!(outputs(&mut actions, now + Duration::from_millis(479)).is_empty());
            assert_eq!(
                outputs(&mut actions, now + Duration::from_millis(480)),
                first
            );
            actions.edge("up", false, &config, now + Duration::from_millis(490));
            assert!(outputs(&mut actions, now + Duration::from_secs(1)).is_empty());
            actions.edge("up", true, &config, now + Duration::from_secs(2));
            actions.cancel();
            assert!(outputs(&mut actions, now + Duration::from_secs(3)).is_empty());
        }
    }

    #[test]
    fn wheel_respects_gestures_and_missing_single_click_preserves_original() {
        let config = settings(json!({
            "doubleClick":[{"type":"wheel","direction":"down"}],
            "longPress":[{"type":"wheel","direction":"up"}]
        }));
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.edge("up", true, &config, now);
        assert!(outputs(&mut actions, now).is_empty());
        actions.edge("up", false, &config, now);
        assert!(outputs(&mut actions, now + Duration::from_millis(349)).is_empty());
        assert_eq!(
            keys(&mut actions, now + Duration::from_millis(350)),
            [(7, 0x52, true), (7, 0x52, false)]
        );
        actions.edge("up", true, &config, now + Duration::from_secs(1));
        actions.edge("up", false, &config, now + Duration::from_secs(1));
        actions.edge("up", true, &config, now + Duration::from_millis(1100));
        actions.edge("up", false, &config, now + Duration::from_millis(1110));
        assert_eq!(
            outputs(&mut actions, now + Duration::from_millis(1110)),
            [Output::Wheel(WheelDirection::Down)]
        );
        actions.edge("up", true, &config, now + Duration::from_secs(2));
        assert!(outputs(&mut actions, now + Duration::from_millis(2599)).is_empty());
        assert_eq!(
            outputs(&mut actions, now + Duration::from_millis(2600)),
            [Output::Wheel(WheelDirection::Up)]
        );
        actions.edge("up", false, &config, now + Duration::from_millis(2610));
        assert!(outputs(&mut actions, now + Duration::from_secs(3)).is_empty());
        let config = settings(json!({
            "click":[{"type":"disabled"}],
            "doubleClick":[{"type":"wheel","direction":"down"}]
        }));
        actions.edge("up", true, &config, now + Duration::from_secs(4));
        actions.edge("up", false, &config, now + Duration::from_secs(4));
        assert!(outputs(&mut actions, now + Duration::from_secs(5)).is_empty());
    }

    #[test]
    fn mouse_clicks_follow_single_double_and_long_press_gestures() {
        let config = settings(json!({
            "click": [{"type":"mouse", "button":"left"},
                {"type":"mouse", "button":"forward", "enabled":false}],
            "doubleClick": [{"type":"mouse", "button":"right"}],
            "longPress": [{"type":"mouse", "button":"left"}]
        }));
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        let output = |actions: &mut RemoteActions, now| {
            let mut events = Vec::new();
            actions.tick(now, |event| {
                if !matches!(event, Output::LibraryTrigger(..)) {
                    events.push(event);
                }
            });
            events
        };
        actions.edge("up", true, &config, now);
        actions.edge("up", false, &config, now);
        assert!(output(&mut actions, now + Duration::from_millis(349)).is_empty());
        assert_eq!(
            output(&mut actions, now + Duration::from_millis(350)),
            [Output::MouseClick(MouseButton::Left)]
        );
        actions.edge("up", true, &config, now + Duration::from_secs(1));
        actions.edge("up", false, &config, now + Duration::from_secs(1));
        actions.edge("up", true, &config, now + Duration::from_millis(1100));
        actions.edge("up", false, &config, now + Duration::from_millis(1110));
        assert_eq!(
            output(&mut actions, now + Duration::from_millis(1110)),
            [Output::MouseClick(MouseButton::Right)]
        );
        assert!(output(&mut actions, now + Duration::from_secs(2)).is_empty());
        actions.edge("up", true, &config, now + Duration::from_secs(3));
        assert!(output(&mut actions, now + Duration::from_millis(3599)).is_empty());
        assert_eq!(
            output(&mut actions, now + Duration::from_millis(3600)),
            [Output::MouseClick(MouseButton::Left)]
        );
        actions.edge("up", false, &config, now + Duration::from_millis(3610));
        assert!(output(&mut actions, now + Duration::from_secs(4)).is_empty());
    }

    #[test]
    fn overlapping_chords_keep_shared_shift_down_until_last_release() {
        let config: NativeSettings = serde_json::from_value(json!({"enabled":true,"behaviors":{
            "up":{"click":[{"type":"shortcut","keys":["Shift","A"]}]},
            "down":{"click":[{"type":"shortcut","keys":["LShift","B"]}]}
        }}))
        .unwrap();
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.edge("up", true, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 0xe1, true), (7, 4, true)]);
        actions.edge("down", true, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 5, true)]);
        actions.edge("up", false, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 4, false)]);
        actions.edge("down", false, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 5, false), (7, 0xe1, false)]);
    }

    #[test]
    fn keyboard_gestures_and_mixed_sequences_preserve_delays_and_key_order() {
        let config = settings(json!({
            "click":[{"type":"key","key":"A"}],
            "doubleClick":[{"type":"shortcut","keys":["Shift","B"]},
                {"type":"delay","ms":100},{"type":"key","key":"C"}],
            "longPress":[{"type":"key","key":"RAlt"}]
        }));
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.edge("up", true, &config, now);
        actions.edge("up", false, &config, now);
        assert!(keys(&mut actions, now).is_empty());
        actions.edge("up", true, &config, now + Duration::from_millis(100));
        actions.edge("up", false, &config, now + Duration::from_millis(110));
        assert_eq!(
            keys(&mut actions, now + Duration::from_millis(110)),
            [
                (7, 0xe1, true),
                (7, 5, true),
                (7, 5, false),
                (7, 0xe1, false)
            ]
        );
        assert!(keys(&mut actions, now + Duration::from_millis(209)).is_empty());
        assert_eq!(
            keys(&mut actions, now + Duration::from_millis(210)),
            [(7, 6, true), (7, 6, false)]
        );
        actions.edge("up", true, &config, now + Duration::from_secs(1));
        assert!(keys(&mut actions, now + Duration::from_millis(1599)).is_empty());
        assert_eq!(
            keys(&mut actions, now + Duration::from_millis(1600)),
            [(7, 0xe6, true), (7, 0xe6, false)]
        );
        actions.edge("up", false, &config, now + Duration::from_millis(1700));
        assert!(keys(&mut actions, now + Duration::from_secs(2)).is_empty());
        actions.edge("up", true, &config, now + Duration::from_secs(3));
        actions.edge("up", false, &config, now + Duration::from_secs(3));
        assert_eq!(
            keys(&mut actions, now + Duration::from_millis(3350)),
            [(7, 4, true), (7, 4, false)]
        );
    }

    #[test]
    fn reconfiguration_and_input_loss_release_chords_and_cancel_delayed_keys() {
        let config = settings(json!({"click":[{"type":"shortcut","keys":["Ctrl","A"]}]}));
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.synchronize(1, true);
        actions.edge("up", true, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 0xe0, true), (7, 4, true)]);
        actions.synchronize(2, true);
        assert_eq!(keys(&mut actions, now), [(7, 4, false), (7, 0xe0, false)]);
        actions.edge("up", false, &config, now);
        assert!(keys(&mut actions, now).is_empty());
        actions.edge("up", true, &config, now);
        keys(&mut actions, now);
        actions.cancel();
        actions.cancel();
        assert_eq!(keys(&mut actions, now), [(7, 4, false), (7, 0xe0, false)]);
        let config =
            settings(json!({"click":[{"type":"delay","ms":100},{"type":"key","key":"B"}]}));
        actions.edge("up", true, &config, now);
        actions.edge("up", false, &config, now);
        actions.cancel();
        assert!(keys(&mut actions, now + Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn unmapped_or_disabled_remote_forwards_original_hid_edges() {
        let config = settings(json!({"click":[{"type":"key","key":"A"}]}));
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.edge("voice", true, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 0x3e, true)]);
        actions.edge("voice", false, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 0x3e, false)]);
        let config = NativeSettings {
            enabled: false,
            ..config
        };
        actions.edge("up", true, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 0x52, true)]);
        actions.edge("up", false, &config, now);
        assert_eq!(keys(&mut actions, now), [(7, 0x52, false)]);
    }

    #[test]
    fn click_moves_immediately_repeats_and_stops_after_release_or_configuration_change() {
        let config =
            settings(json!({"click": [{"type":"cursorMove", "direction":"right", "distance":23}]}));
        let now = Instant::now();
        let mut cursor = RemoteActions::default();
        cursor.synchronize(1, true);
        cursor.edge("up", true, &config, now);
        assert_eq!(moves(&mut cursor, now), [(23, 0)]);
        cursor.edge("up", true, &config, now + Duration::from_millis(100));
        assert!(moves(&mut cursor, now + Duration::from_millis(100)).is_empty());
        assert_eq!(
            moves(&mut cursor, now + Duration::from_millis(400)),
            [(23, 0)]
        );
        cursor.edge("up", false, &config, now + Duration::from_millis(410));
        assert!(moves(&mut cursor, now + Duration::from_secs(1)).is_empty());
        cursor.edge("up", true, &config, now + Duration::from_secs(2));
        cursor.synchronize(2, true);
        assert!(moves(&mut cursor, now + Duration::from_secs(3)).is_empty());
        cursor.edge("up", false, &config, now + Duration::from_secs(3));
        assert!(moves(&mut cursor, now + Duration::from_secs(4)).is_empty());
        cursor.edge("up", true, &config, now + Duration::from_secs(5));
        cursor.synchronize(2, false);
        assert!(moves(&mut cursor, now + Duration::from_secs(6)).is_empty());
    }

    #[test]
    fn double_click_suppresses_single_and_single_waits_for_second_click() {
        let config = settings(json!({
            "click": [{"type":"cursorMove", "direction":"up", "distance":10}],
            "doubleClick": [{"type":"cursorMove", "direction":"down", "distance":20}]
        }));
        let now = Instant::now();
        let mut cursor = RemoteActions::default();
        cursor.edge("up", true, &config, now);
        cursor.edge("up", false, &config, now + Duration::from_millis(10));
        assert!(moves(&mut cursor, now + Duration::from_millis(200)).is_empty());
        cursor.edge("up", true, &config, now + Duration::from_millis(210));
        cursor.edge("up", false, &config, now + Duration::from_millis(220));
        assert_eq!(
            moves(&mut cursor, now + Duration::from_millis(220)),
            [(0, 20)]
        );
        assert!(moves(&mut cursor, now + Duration::from_secs(1)).is_empty());
        cursor.edge("up", true, &config, now + Duration::from_secs(2));
        cursor.edge("up", false, &config, now + Duration::from_millis(2010));
        assert_eq!(
            moves(&mut cursor, now + Duration::from_millis(2360)),
            [(0, -10)]
        );
    }

    #[test]
    fn long_press_has_threshold_and_repeat_and_never_emits_single_on_release() {
        let config = settings(json!({
            "click": [{"type":"cursorMove", "direction":"left", "distance":10}],
            "longPress": [{"type":"cursorMove", "direction":"right", "distance":30}]
        }));
        let now = Instant::now();
        let mut cursor = RemoteActions::default();
        cursor.edge("up", true, &config, now);
        assert!(moves(&mut cursor, now + Duration::from_millis(599)).is_empty());
        assert_eq!(
            moves(&mut cursor, now + Duration::from_millis(600)),
            [(30, 0)]
        );
        assert_eq!(
            moves(&mut cursor, now + Duration::from_millis(950)),
            [(30, 0)]
        );
        cursor.edge("up", false, &config, now + Duration::from_millis(960));
        assert!(moves(&mut cursor, now + Duration::from_secs(2)).is_empty());
        // Release arriving before a timer tick still recognizes a long press.
        cursor.edge("up", true, &config, now + Duration::from_secs(3));
        cursor.edge("up", false, &config, now + Duration::from_millis(3650));
        assert_eq!(
            moves(&mut cursor, now + Duration::from_millis(3650)),
            [(30, 0)]
        );
    }

    #[test]
    fn cursor_sequences_honor_delays_without_blocking_and_cancel_queued_moves() {
        let config = settings(json!({"click": [
            {"type":"cursorMove", "direction":"left", "distance":12},
            {"type":"delay", "ms":100},
            {"type":"cursorMove", "direction":"down", "distance":15}
        ]}));
        let now = Instant::now();
        let mut cursor = RemoteActions::default();
        cursor.edge("up", true, &config, now);
        cursor.edge("up", false, &config, now);
        assert_eq!(moves(&mut cursor, now), [(-12, 0)]);
        assert!(moves(&mut cursor, now + Duration::from_millis(99)).is_empty());
        assert_eq!(
            moves(&mut cursor, now + Duration::from_millis(100)),
            [(0, 15)]
        );
        cursor.edge("up", true, &config, now + Duration::from_secs(1));
        cursor.edge("up", false, &config, now + Duration::from_secs(1));
        cursor.cancel();
        assert!(moves(&mut cursor, now + Duration::from_secs(2)).is_empty());
    }
    #[test]
    fn profile_switches_keep_order_delays_flags_and_cancel_on_reconfiguration() {
        let config = settings(json!({"click":[
            {"type":"switchProfile","direction":"next"},
            {"type":"delay","ms":100},
            {"type":"switchProfile","direction":"next","enabled":false,"wrap":true},
            {"type":"switchProfile","direction":"previous","wrap":true}
        ]}));
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.synchronize(1, true);
        actions.edge("up", true, &config, now);
        actions.edge("up", false, &config, now);
        assert_eq!(
            outputs(&mut actions, now),
            [Output::SwitchProfile(
                super::super::ProfileDirection::Next,
                true
            )]
        );
        assert!(outputs(&mut actions, now + Duration::from_millis(99)).is_empty());
        assert_eq!(
            outputs(&mut actions, now + Duration::from_millis(100)),
            [Output::SwitchProfile(
                super::super::ProfileDirection::Previous,
                true
            )]
        );
        actions.edge("up", true, &config, now + Duration::from_secs(1));
        actions.edge("up", false, &config, now + Duration::from_secs(1));
        actions.synchronize(2, true);
        assert!(outputs(&mut actions, now + Duration::from_secs(2)).is_empty());
    }

    #[test]
    fn quick_overlay_switches_remote_actions_to_independent_profile_and_exits_after_one_use_or_repeat_trigger(
    ) {
        let config: NativeSettings = serde_json::from_value(json!({
            "enabled": true,
            "behaviors": {
                "menu": { "click": [{ "type": "quickOverlay", "profileId": "q-prompts" }] },
                "up": { "click": [{ "type": "key", "key": "B" }] }
            },
            "quickProfiles": {
                "q-prompts": {
                    "id": "q-prompts",
                    "name": "语音提示词",
                    "deviceId": "rc003",
                    "deviceName": "遥控器",
                    "behaviors": {
                        "up": { "click": [{ "type": "paste", "text": "润色这段文字" }] }
                    }
                }
            }
        }))
        .unwrap();
        let now = Instant::now();
        let mut actions = RemoteActions::default();
        actions.set_source("rc-1", "rc003", "客厅遥控器");
        actions.synchronize(1, true);

        // 1. Tap `menu` -> enters Quick Mode without emitting any output.
        actions.edge("menu", true, &config, now);
        actions.edge("menu", false, &config, now + Duration::from_millis(20));
        assert!(outputs(&mut actions, now + Duration::from_millis(20)).is_empty());

        // 2. Press `menu` again -> exits Quick Mode cleanly without executing anything.
        actions.edge("menu", true, &config, now + Duration::from_millis(50));
        actions.edge("menu", false, &config, now + Duration::from_millis(70));
        assert!(outputs(&mut actions, now + Duration::from_millis(70)).is_empty());

        // 3. Tap `menu` to re-enter, then tap `up` -> executes Quick Profile paste and exits back to base profile!
        actions.edge("menu", true, &config, now + Duration::from_millis(100));
        actions.edge("menu", false, &config, now + Duration::from_millis(120));
        actions.edge("up", true, &config, now + Duration::from_millis(150));
        actions.edge("up", false, &config, now + Duration::from_millis(170));
        assert_eq!(
            outputs(&mut actions, now + Duration::from_millis(170)),
            [Output::Paste("润色这段文字".into())]
        );

        // 4. Subsequent `up` press runs the base profile (`Key("B")`, usage 0x05 on page 0x07).
        actions.edge("up", true, &config, now + Duration::from_millis(220));
        assert_eq!(
            keys(&mut actions, now + Duration::from_millis(220)),
            vec![(7, 5, true)]
        );
    }
}
