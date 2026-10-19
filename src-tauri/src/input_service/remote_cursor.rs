//! Cursor mappings consume observed edges; they never write to the HID device.
use super::{NativeBehavior, NativeSettings, TriggerBehaviors, WheelDirection};
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
    repeat: Option<(WheelDirection, u32)>,
    next_repeat: Instant,
}

#[derive(Default)]
struct Button {
    press: Option<Press>,
    pending: Option<(Instant, Vec<NativeBehavior>)>,
}

#[derive(Default)]
pub(super) struct CursorMappings {
    revision: u64,
    buttons: HashMap<&'static str, Button>,
    scheduled: Vec<(Instant, WheelDirection, u32)>,
}

fn enabled(actions: &[NativeBehavior]) -> bool {
    actions.iter().any(NativeBehavior::enabled)
}

fn schedule(
    queue: &mut Vec<(Instant, WheelDirection, u32)>,
    actions: &[NativeBehavior],
    now: Instant,
) {
    let mut due = now;
    for action in actions.iter().filter(|action| action.enabled()) {
        match action {
            NativeBehavior::Delay { ms, .. } => due += Duration::from_millis((*ms).min(300_000)),
            NativeBehavior::CursorMove {
                direction,
                distance,
                ..
            } if queue.len() < 256 => {
                queue.push((due, *direction, *distance));
            }
            _ => {}
        }
    }
}

impl CursorMappings {
    pub fn cancel(&mut self) {
        self.buttons.clear();
        self.scheduled.clear();
    }

    pub fn synchronize(&mut self, revision: u64, enabled: bool) {
        if revision != self.revision || !enabled {
            self.cancel();
            self.revision = revision;
        }
    }

    pub fn edge(
        &mut self,
        button: &'static str,
        down: bool,
        settings: &NativeSettings,
        now: Instant,
    ) {
        if !settings.enabled {
            return;
        }
        let Some(triggers) = settings.behaviors.get(button) else {
            return;
        };
        // Replacement has its own driver output contract, outside this stage.
        if enabled(&triggers.replace) {
            return;
        }
        let state = self.buttons.entry(button).or_default();
        if down {
            if state.press.is_some() {
                return;
            }
            let second = match state.pending.take() {
                Some((due, actions)) if now >= due => {
                    schedule(&mut self.scheduled, &actions, now);
                    false
                }
                Some(_) => true,
                None => false,
            };
            let repeat = match super::repeatable_click(triggers) {
                Some(super::RepeatableClick::CursorMove {
                    direction,
                    distance,
                }) => Some((direction, distance)),
                _ => None,
            };
            if let Some((direction, distance)) = repeat {
                self.scheduled.push((now, direction, distance));
            }
            state.press = Some(Press {
                started: now,
                triggers: triggers.clone(),
                second,
                long_fired: false,
                repeat,
                next_repeat: now + Duration::from_millis(400),
            });
        } else if let Some(press) = state.press.take() {
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
                schedule(&mut self.scheduled, &press.triggers.click, now);
            }
        }
    }

    pub fn tick(&mut self, now: Instant, mut move_cursor: impl FnMut(WheelDirection, u32)) {
        for state in self.buttons.values_mut() {
            if let Some(press) = state.press.as_mut() {
                if let Some((direction, distance)) = press.repeat {
                    if now >= press.next_repeat {
                        self.scheduled.push((now, direction, distance));
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
                schedule(&mut self.scheduled, &actions, now);
            }
        }
        // Keep sequence order when several delayed moves become due together.
        self.scheduled.sort_by_key(|(due, _, _)| *due);
        self.scheduled.retain(|(due, direction, distance)| {
            if now >= *due {
                move_cursor(*direction, *distance);
                false
            } else {
                true
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(triggers: serde_json::Value) -> NativeSettings {
        serde_json::from_value(json!({"enabled": true, "behaviors": {"up": triggers}})).unwrap()
    }

    fn moves(cursor: &mut CursorMappings, now: Instant) -> Vec<(i32, i32)> {
        let mut output = Vec::new();
        cursor.tick(now, |direction, distance| {
            output.push(super::super::cursor_delta(direction, distance))
        });
        output
    }

    #[test]
    fn click_moves_immediately_repeats_and_stops_after_release_or_configuration_change() {
        let config =
            settings(json!({"click": [{"type":"cursorMove", "direction":"right", "distance":23}]}));
        let now = Instant::now();
        let mut cursor = CursorMappings::default();
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
        let mut cursor = CursorMappings::default();
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
        let mut cursor = CursorMappings::default();
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
        let mut cursor = CursorMappings::default();
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
}
