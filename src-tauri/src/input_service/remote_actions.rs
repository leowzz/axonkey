//! Remote gestures schedule mouse actions and semantic HID keyboard edges.
use super::{
    MouseButton, NativeBehavior, NativeSettings, RepeatableClick, TriggerBehaviors, WheelDirection,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const DOUBLE_CLICK: Duration = Duration::from_millis(350);
const LONG_PRESS: Duration = Duration::from_millis(600);

struct Press {
    started: Instant,
    triggers: TriggerBehaviors,
    second: bool,
    long_fired: bool,
    repeat: Option<RepeatableClick>,
    next_repeat: Instant,
    held: Vec<HidKey>,
}

#[derive(Default)]
struct Button {
    press: Option<Press>,
    pending: Option<(Instant, Vec<NativeBehavior>)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct HidKey {
    pub page: u16,
    pub usage: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Output {
    CursorMove(WheelDirection, u32),
    MouseClick(MouseButton),
    Wheel(WheelDirection),
    Paste(String),
    OpenApp(String),
    OpenWebsite(String),
    Key(HidKey, bool),
    SwitchProfile(super::ProfileDirection, bool),
}

#[derive(Default)]
pub(super) struct RemoteActions {
    revision: u64,
    enabled: bool,
    held: HashMap<HidKey, usize>,
    held_order: Vec<HidKey>,
    releases: Vec<Output>,
    buttons: HashMap<&'static str, Button>,
    scheduled: Vec<(Instant, Output)>,
}

fn enabled(actions: &[NativeBehavior]) -> bool {
    actions.iter().any(NativeBehavior::enabled)
}

fn schedule(queue: &mut Vec<(Instant, Output)>, actions: &[NativeBehavior], now: Instant) {
    let mut due = now;
    for action in actions.iter().filter(|action| action.enabled()) {
        if queue.len() >= 256 {
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
            NativeBehavior::Paste { text, .. } => queue.push((due, Output::Paste(text.clone()))),
            NativeBehavior::OpenApp { path, .. } => {
                queue.push((due, Output::OpenApp(path.clone())))
            }
            NativeBehavior::OpenWebsite { url, .. } => {
                queue.push((due, Output::OpenWebsite(url.clone())))
            }
            NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. } => {
                if let Some(keys) = super::windows::behavior_hid_chord(action) {
                    if queue.len() + keys.len() * 2 <= 256 {
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
            NativeBehavior::Disabled { .. } => {}
        }
    }
}

fn repeat_output(action: RepeatableClick) -> Output {
    match action {
        RepeatableClick::Wheel(direction) => Output::Wheel(direction),
        RepeatableClick::CursorMove {
            direction,
            distance,
        } => Output::CursorMove(direction, distance),
    }
}

fn schedule_click(
    queue: &mut Vec<(Instant, Output)>,
    actions: &[NativeBehavior],
    button: &str,
    now: Instant,
) {
    if enabled(actions) {
        schedule(queue, actions, now);
    } else if queue.len() + 2 <= 256 {
        // Configuring only double/long press must preserve an ordinary click.
        // An explicitly enabled Disabled action suppresses this fallback.
        if let Some(usage) = super::windows::rc003_usage_for_button(button) {
            let key = HidKey { page: 7, usage };
            queue.extend([
                (now, Output::Key(key, true)),
                (now, Output::Key(key, false)),
            ]);
        }
    }
}

impl RemoteActions {
    pub fn cancel(&mut self) {
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
        let defaults = TriggerBehaviors::default();
        let triggers = settings.behaviors.get(button).unwrap_or(&defaults);
        let custom = enabled(&triggers.click)
            || enabled(&triggers.double_click)
            || enabled(&triggers.long_press);
        // A single keyboard click is held for the physical press, just like
        // Windows, rather than our timer, handles keyboard repeat.
        let held = if !settings.enabled || !custom {
            super::windows::rc003_usage_for_button(button)
                .map(|usage| vec![HidKey { page: 7, usage }])
                .unwrap_or_default()
        } else if !enabled(&triggers.double_click) && !enabled(&triggers.long_press) {
            let clicks: Vec<_> = triggers
                .click
                .iter()
                .filter(|action| action.enabled())
                .collect();
            if clicks.len() == 1 {
                super::windows::behavior_hid_chord(clicks[0]).unwrap_or_default()
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
            let second = match state.pending.take() {
                Some((due, actions)) if now >= due => {
                    schedule_click(&mut self.scheduled, &actions, button, now);
                    false
                }
                Some(_) => true,
                None => false,
            };
            let repeat = super::repeatable_click(triggers);
            if let Some(action) = repeat {
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
        } else if let Some(press) = state.press.take() {
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
                schedule(&mut self.scheduled, &press.triggers.long_press, now);
            } else if press.second {
                schedule(&mut self.scheduled, &press.triggers.double_click, now);
            } else if enabled(&press.triggers.double_click) {
                state.pending = Some((now + DOUBLE_CLICK, press.triggers.click));
            } else {
                schedule_click(&mut self.scheduled, &press.triggers.click, button, now);
            }
        }
    }

    pub fn tick(&mut self, now: Instant, mut emit: impl FnMut(Output)) {
        for (button, state) in &mut self.buttons {
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
                        schedule(&mut self.scheduled, &press.triggers.long_press, now);
                        press.long_fired = true;
                        press.next_repeat = now + Duration::from_millis(350);
                    } else if press.long_fired && now >= press.next_repeat {
                        schedule(&mut self.scheduled, &press.triggers.long_press, now);
                        press.next_repeat = now + Duration::from_millis(100);
                    }
                }
            }
            if state.pending.as_ref().is_some_and(|(due, _)| now >= *due) {
                let (_, actions) = state.pending.take().unwrap();
                schedule_click(&mut self.scheduled, &actions, button, now);
            }
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
        actions.tick(now, |event| output.push(event));
        output
    }

    #[test]
    fn all_behavior_types_keep_sequence_order_and_cancel_delayed_side_effects() {
        let config = settings(json!({"click":[
            {"type":"disabled"},
            {"type":"paste","text":"ignored","enabled":false},
            {"type":"delay","ms":300000,"enabled":false},
            {"type":"wheel","direction":"left"},
            {"type":"paste","text":"中文🙂"},
            {"type":"cursorMove","direction":"right","distance":23},
            {"type":"mouse","button":"left"},
            {"type":"key","key":"A"},
            {"type":"shortcut","keys":["Shift","B"]},
            {"type":"delay","ms":100},
            {"type":"openApp","path":"C:\\Example.exe"},
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
            actions.tick(now, |event| events.push(event));
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
}
