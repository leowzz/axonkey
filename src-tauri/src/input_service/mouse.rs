//! Mouse input is independent of RC003 discovery and the Interception driver.
//! Capture callbacks only classify and enqueue; actions run off the hook thread.
use super::{MouseButton, NativeBehavior, NativeSettings, TriggerBehaviors};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(windows)]
#[path = "mouse_windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "mouse_macos.rs"]
mod platform;

const WHEEL_INPUTS: [[&str; 4]; 4] = [
    [
        "mouse.global.up",
        "mouse.global.down",
        "mouse.global.left",
        "mouse.global.right",
    ],
    [
        "mouse.top.up",
        "mouse.top.down",
        "mouse.top.left",
        "mouse.top.right",
    ],
    [
        "mouse.left.up",
        "mouse.left.down",
        "mouse.left.left",
        "mouse.left.right",
    ],
    [
        "mouse.right.up",
        "mouse.right.down",
        "mouse.right.left",
        "mouse.right.right",
    ],
];
const BUTTON_INPUTS: [[&str; 2]; 3] = [
    ["mouse.top.buttonLeft", "mouse.top.buttonRight"],
    ["mouse.left.buttonLeft", "mouse.left.buttonRight"],
    ["mouse.right.buttonLeft", "mouse.right.buttonRight"],
];
const DOUBLE_CLICK: Duration = Duration::from_millis(350);
const LONG_PRESS: Duration = Duration::from_millis(600);
fn has_actions(actions: &[NativeBehavior]) -> bool {
    actions.iter().any(NativeBehavior::enabled)
}
fn has_triggers(triggers: &TriggerBehaviors) -> bool {
    has_actions(&triggers.click)
        || has_actions(&triggers.double_click)
        || has_actions(&triggers.long_press)
}
const EDGE_WIDTH: f64 = 8.0;

struct Configuration {
    settings: NativeSettings,
    revision: u64,
}

struct Job {
    behaviors: Vec<NativeBehavior>,
    revision: u64,
    repeats: usize,
}

struct Shared {
    configuration: Mutex<Configuration>,
    stop: AtomicBool,
    ready: AtomicBool,
    active: AtomicBool,
    sender: SyncSender<Job>,
}

pub struct MouseService {
    shared: Arc<Shared>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl MouseService {
    pub fn start() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Job>(32);
        let shared = Arc::new(Shared {
            configuration: Mutex::new(Configuration {
                settings: NativeSettings::default(),
                revision: 0,
            }),
            stop: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            active: AtomicBool::new(false),
            sender,
        });
        let mut workers = Vec::new();
        #[cfg(any(windows, target_os = "macos"))]
        {
            let state = Arc::clone(&shared);
            match thread::Builder::new()
                .name("Axonkey mouse capture".into())
                .spawn(move || platform::run(state))
            {
                Ok(worker) => workers.push(worker),
                Err(error) => log::error!("Cannot start mouse capture: {error}"),
            }
        }
        let state = Arc::clone(&shared);
        if let Ok(worker) = thread::Builder::new()
            .name("Axonkey mouse actions".into())
            .spawn(move || {
                while !state.stop.load(Ordering::Acquire) {
                    let Ok(job) = receiver.recv_timeout(Duration::from_millis(50)) else {
                        continue;
                    };
                    for _ in 0..job.repeats {
                        for behavior in job.behaviors.iter().filter(|item| item.enabled()) {
                            if !current_job(&state, job.revision) {
                                break;
                            }
                            if let NativeBehavior::Delay { ms, .. } = behavior {
                                let mut remaining = (*ms).min(300_000);
                                while remaining > 0 && current_job(&state, job.revision) {
                                    let step = remaining.min(10);
                                    thread::sleep(Duration::from_millis(step));
                                    remaining -= step;
                                }
                            } else {
                                #[cfg(any(windows, target_os = "macos"))]
                                {
                                    let hold_ms = state.configuration.lock()
                                        .map(|config| config.settings.mouse_key_hold_ms.min(1000))
                                        .unwrap_or(0);
                                    platform::execute(behavior, hold_ms);
                                }
                            }
                        }
                        if !current_job(&state, job.revision) {
                            break;
                        }
                    }
                }
            })
        {
            workers.push(worker);
        }
        Self {
            shared,
            workers: Mutex::new(workers),
        }
    }

    pub fn update_settings(&self, settings: &NativeSettings) -> Result<(), String> {
        let mut configuration = self
            .shared
            .configuration
            .lock()
            .map_err(|_| "Mouse settings lock is unavailable")?;
        configuration.revision = configuration.revision.wrapping_add(1);
        configuration.settings = settings.clone();
        let active = settings.enabled && settings.mouse_enabled
            && (WHEEL_INPUTS.iter().flatten().any(|id| {
                settings
                    .behaviors
                    .get(*id)
                    .is_some_and(|t| has_actions(&t.click))
            }) || BUTTON_INPUTS
                .iter()
                .flatten()
                .any(|id| settings.behaviors.get(*id).is_some_and(has_triggers)));
        self.shared.active.store(active, Ordering::Release);
        if active && !self.shared.ready.load(Ordering::Acquire) {
            return Err("鼠标监听尚未就绪；macOS 请检查输入监控与辅助功能权限，然后重试".into());
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Ok(mut workers) = self.workers.lock() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for MouseService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn current_job(shared: &Shared, revision: u64) -> bool {
    !shared.stop.load(Ordering::Acquire)
        && shared
            .configuration
            .lock()
            .is_ok_and(|config| config.revision == revision && config.settings.enabled && config.settings.mouse_enabled)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Edge {
    Top,
    Left,
    Right,
}
impl Edge {
    fn scope(self) -> usize {
        match self {
            Self::Top => 1,
            Self::Left => 2,
            Self::Right => 3,
        }
    }
}

/// Screen bounds, not the work area; corners consistently belong to the top.
fn screen_edge(x: f64, y: f64, left: f64, top: f64, right: f64, bottom: f64) -> Option<Edge> {
    if !(x >= left && x < right && y >= top && y < bottom) {
        return None;
    }
    if y < top + EDGE_WIDTH {
        Some(Edge::Top)
    } else if x < left + EDGE_WIDTH {
        Some(Edge::Left)
    } else if x >= right - EDGE_WIDTH {
        Some(Edge::Right)
    } else {
        None
    }
}

#[derive(Default)]
struct ScrollAccumulator {
    edge: Option<Edge>,
    key: Option<(&'static str, u64)>,
    remainder: f64,
}

impl ScrollAccumulator {
    fn enter(&mut self, edge: Option<Edge>) {
        if self.edge != edge {
            self.reset();
            self.edge = edge;
        }
    }

    fn reset(&mut self) {
        self.edge = None;
        self.key = None;
        self.remainder = 0.0;
    }

    /// True only when an enabled mapping owns this input. Disabled actions count
    /// as mappings, while an empty list / all paused steps preserve native scroll.
    fn scroll(&mut self, shared: &Shared, direction: usize, amount: f64) -> bool {
        if !amount.is_finite() || amount <= 0.0 || direction >= 4 {
            return false;
        }
        let Ok(config) = shared.configuration.try_lock() else {
            return false;
        };
        let global_id = WHEEL_INPUTS[0][direction];
        let scoped_id = WHEEL_INPUTS[self.edge.map_or(0, Edge::scope)][direction];
        let scoped = config
            .settings
            .behaviors
            .get(scoped_id)
            .map(|item| &item.click);
        let (id, actions) = if scoped.is_some_and(|a| has_actions(a)) {
            (scoped_id, scoped)
        } else {
            (
                global_id,
                config
                    .settings
                    .behaviors
                    .get(global_id)
                    .map(|item| &item.click),
            )
        };
        let Some(actions) = actions.filter(|a| config.settings.enabled && config.settings.mouse_enabled && has_actions(a)) else {
            self.key = None;
            self.remainder = 0.0;
            return false;
        };
        let key = (id, config.revision);
        if self.key != Some(key) {
            self.remainder = 0.0;
            self.key = Some(key);
        }
        // Derived NativeSettings::default() uses zero; treat it like legacy settings.
        let sensitivity = match config.settings.mouse_scroll_sensitivity {
            0 => 100,
            value => value.clamp(25, 400),
        };
        let total = self.remainder + amount * f64::from(sensitivity) / 100.0;
        let repeats = total.floor() as usize;
        if repeats == 0 {
            self.remainder = total;
            return true;
        }
        let job = Job {
            behaviors: actions.clone(),
            revision: config.revision,
            repeats: repeats.min(32),
        };
        if shared.sender.try_send(job).is_ok() {
            self.remainder = total.fract();
            true
        } else {
            self.reset();
            false
        }
    }
}

// Button ownership is latched on physical down. A settings change must still
// consume its matching up, but never swallow an up whose down passed through.
#[derive(Default)]
struct ButtonTracker {
    pressed: [Option<Press>; 2],
    pending: [Option<PendingClick>; 2],
}
struct Press {
    input: &'static str,
    triggers: TriggerBehaviors,
    revision: u64,
    started: Instant,
    position: (f64, f64),
    long_fired: bool,
    second: bool,
}
struct PendingClick {
    input: &'static str,
    actions: Vec<NativeBehavior>,
    revision: u64,
    released: Instant,
    position: (f64, f64),
}
fn enqueue(shared: &Shared, actions: Vec<NativeBehavior>, revision: u64) {
    if !actions.is_empty() && current_job(shared, revision) {
        let _ = shared.sender.try_send(Job {
            behaviors: actions,
            revision,
            repeats: 1,
        });
    }
}
fn button_rule(
    config: &Configuration,
    edge: Option<Edge>,
    button: usize,
) -> Option<(&'static str, TriggerBehaviors)> {
    if !config.settings.enabled || !config.settings.mouse_enabled {
        return None;
    }
    // Mouse buttons are edge-only. Never inherit legacy global button rules,
    // including settings sent directly to the native service by an older UI.
    let edge = edge?;
    let input = BUTTON_INPUTS[edge.scope() - 1].get(button)?;
    let triggers = config.settings.behaviors.get(*input)?;
    has_triggers(triggers).then(|| (*input, triggers.clone()))
}
impl ButtonTracker {
    fn tick(&mut self, shared: &Shared, now: Instant) {
        for index in 0..2 {
            if let Some(press) = self.pressed[index].as_mut() {
                if !press.long_fired
                    && has_actions(&press.triggers.long_press)
                    && now.duration_since(press.started) >= LONG_PRESS
                {
                    press.long_fired = true;
                    enqueue(shared, press.triggers.long_press.clone(), press.revision);
                }
            }
            if self.pending[index].as_ref().is_some_and(|p| {
                !current_job(shared, p.revision) || now.duration_since(p.released) >= DOUBLE_CLICK
            }) {
                let pending = self.pending[index].take().unwrap();
                enqueue(shared, pending.actions, pending.revision);
            }
        }
    }
    fn event(
        &mut self,
        shared: &Shared,
        button: usize,
        down: bool,
        edge: Option<Edge>,
        position: (f64, f64),
        now: Instant,
    ) -> bool {
        if button >= 2 {
            return false;
        }
        self.tick(shared, now);
        if down {
            if self.pressed[button].is_some() {
                return true;
            }
            let Ok(config) = shared.configuration.try_lock() else {
                return false;
            };
            let Some((input, triggers)) = button_rule(&config, edge, button) else {
                return false;
            };
            let revision = config.revision;
            drop(config);
            let second = if let Some(pending) = self.pending[button].take() {
                let matches = pending.input == input
                    && pending.revision == revision
                    && (pending.position.0 - position.0).abs() <= 4.0
                    && (pending.position.1 - position.1).abs() <= 4.0;
                if !matches {
                    enqueue(shared, pending.actions, pending.revision);
                }
                matches
            } else {
                false
            };
            self.pressed[button] = Some(Press {
                input,
                triggers,
                revision,
                started: now,
                position,
                long_fired: false,
                second,
            });
            true
        } else {
            let Some(press) = self.pressed[button].take() else {
                return false;
            };
            if !current_job(shared, press.revision) || press.long_fired {
                return true;
            }
            if press.second {
                enqueue(shared, press.triggers.double_click, press.revision);
            } else {
                let actions = if has_actions(&press.triggers.click) {
                    press.triggers.click
                } else {
                    vec![NativeBehavior::Mouse {
                        enabled: true,
                        button: if button == 0 {
                            MouseButton::Left
                        } else {
                            MouseButton::Right
                        },
                    }]
                };
                if has_actions(&press.triggers.double_click) {
                    self.pending[button] = Some(PendingClick {
                        input: press.input,
                        actions,
                        revision: press.revision,
                        released: now,
                        position: press.position,
                    });
                } else {
                    enqueue(shared, actions, press.revision);
                }
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_detection_handles_offset_displays_and_excludes_work_area() {
        assert_eq!(
            screen_edge(-100.0, -1079.0, -1920.0, -1080.0, 0.0, 0.0),
            Some(Edge::Top)
        );
        assert_eq!(
            screen_edge(-100.0, -1072.0, -1920.0, -1080.0, 0.0, 0.0),
            None
        );
        assert_eq!(screen_edge(0.0, -1080.0, -1920.0, -1080.0, 0.0, 0.0), None);
        assert_eq!(screen_edge(10.0, 30.0, 0.0, 0.0, 1920.0, 1080.0), None);
        assert_eq!(
            screen_edge(-1919.0, -500.0, -1920.0, -1080.0, 0.0, 0.0),
            Some(Edge::Left)
        );
        assert_eq!(
            screen_edge(-1.0, -500.0, -1920.0, -1080.0, 0.0, 0.0),
            Some(Edge::Right)
        );
        assert_eq!(
            screen_edge(-1919.0, -1080.0, -1920.0, -1080.0, 0.0, 0.0),
            Some(Edge::Top)
        );
    }

    #[test]
    fn mappings_pass_through_accumulate_cancel_and_do_not_cross_devices() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let settings: NativeSettings =
            serde_json::from_value(serde_json::json!({"enabled":true,"behaviors":{
                "mouse.top.up":{"click":[{"type":"key","key":"A"}]},
                "mouse.top.down":{"click":[{"type":"disabled"}]},
                "mouse.top.left":{"click":[{"type":"key","key":"B","enabled":false}]},
                "voice":{"click":[{"type":"key","key":"RAlt"}]}
            }}))
            .unwrap();
        let shared = Shared {
            configuration: Mutex::new(Configuration {
                settings,
                revision: 1,
            }),
            stop: AtomicBool::new(false),
            ready: AtomicBool::new(true),
            active: AtomicBool::new(true),
            sender,
        };
        let mut scroll = ScrollAccumulator::default();
        scroll.enter(Some(Edge::Top));
        assert!(!scroll.scroll(&shared, 2, 1.0));
        assert!(!scroll.scroll(&shared, 3, 1.0));
        assert!(scroll.scroll(&shared, 0, 0.5));
        assert!(receiver.try_recv().is_err());
        assert!(scroll.scroll(&shared, 0, 0.5));
        let job = receiver.try_recv().unwrap();
        assert_eq!(job.repeats, 1);
        assert!(matches!(&job.behaviors[0], NativeBehavior::Key { key, .. } if key == "A"));
        assert!(current_job(&shared, job.revision));
        assert!(scroll.scroll(&shared, 1, 1.0));
        assert!(!scroll.scroll(&shared, 0, 1.0)); // full queue preserves input
        shared.configuration.lock().unwrap().revision += 1;
        assert!(!current_job(&shared, job.revision));
        shared.configuration.lock().unwrap().settings.enabled = false;
        assert!(!scroll.scroll(&shared, 0, 1.0));
    }
    #[test]
    fn side_edges_trigger_each_discrete_tick_from_the_first_tick() {
        let (shared, receiver) = fixture(serde_json::json!({
            "mouse.left.up": {"click":[{"type":"key","key":"VolumeUp"}]},
            "mouse.left.down": {"click":[{"type":"key","key":"VolumeDown"}]},
            "mouse.right.up": {"click":[{"type":"key","key":"VolumeUp"}]},
            "mouse.right.down": {"click":[{"type":"key","key":"VolumeDown"}]}
        }));
        let mut scroll = ScrollAccumulator::default();
        for edge in [Edge::Left, Edge::Right] {
            scroll.enter(Some(edge));
            for direction in [0, 1] {
                for _ in 0..4 {
                    assert!(scroll.scroll(&shared, direction, 1.0));
                    assert_eq!(receiver.try_recv().unwrap().repeats, 1);
                    assert!(receiver.try_recv().is_err());
                }
            }
        }
    }

    #[test]
    fn scroll_sensitivity_scales_threshold_and_repeat_count() {
        for (sensitivity, amount, events, repeats) in [
            (100, 0.25, 4, 1),
            (400, 0.25, 1, 1),
            (25, 1.0, 4, 1),
            (200, 1.0, 1, 2),
            (0, 1.0, 1, 1),
            (1, 1.0, 4, 1),
            (1000, 0.25, 1, 1),
        ] {
            let (shared, receiver) = fixture(serde_json::json!({
                "mouse.left.up": {"click":[{"type":"key","key":"VolumeUp"}]}
            }));
            shared.configuration.lock().unwrap().settings.mouse_scroll_sensitivity = sensitivity;
            let mut scroll = ScrollAccumulator::default();
            scroll.enter(Some(Edge::Left));
            for _ in 1..events {
                assert!(scroll.scroll(&shared, 0, amount));
                assert!(receiver.try_recv().is_err());
            }
            assert!(scroll.scroll(&shared, 0, amount));
            assert_eq!(receiver.try_recv().unwrap().repeats, repeats);
            assert!(receiver.try_recv().is_err());
        }
    }

    fn fixture(behaviors: serde_json::Value) -> (Shared, mpsc::Receiver<Job>) {
        let (sender, receiver) = mpsc::sync_channel(32);
        let settings =
            serde_json::from_value(serde_json::json!({ "enabled": true, "behaviors": behaviors }))
                .unwrap();
        (
            Shared {
                configuration: Mutex::new(Configuration {
                    settings,
                    revision: 1,
                }),
                stop: AtomicBool::new(false),
                ready: AtomicBool::new(true),
                active: AtomicBool::new(true),
                sender,
            },
            receiver,
        )
    }
    fn assert_key(job: Job, expected: &str) {
        assert!(matches!(&job.behaviors[0], NativeBehavior::Key { key, .. } if key == expected));
    }
    #[test]
    fn wheel_rules_fall_back_per_direction_and_edge_rules_can_disable_global() {
        let (shared, receiver) = fixture(serde_json::json!({
            "mouse.global.up": {"click":[{"type":"key","key":"G"}]},
            "mouse.global.left": {"click":[{"type":"key","key":"H"}]},
            "mouse.top.up": {"click":[{"type":"key","key":"T"}]},
            "mouse.left.up": {"click":[{"type":"disabled"}]},
            "mouse.right.up": {"click":[{"type":"key","key":"R","enabled":false}]}
        }));
        let mut scroll = ScrollAccumulator::default();
        assert!(scroll.scroll(&shared, 0, 1.0));
        assert_key(receiver.try_recv().unwrap(), "G");
        scroll.enter(Some(Edge::Top));
        assert!(scroll.scroll(&shared, 0, 1.0));
        assert_key(receiver.try_recv().unwrap(), "T");
        scroll.enter(Some(Edge::Left));
        assert!(scroll.scroll(&shared, 0, 1.0));
        assert!(matches!(
            receiver.try_recv().unwrap().behaviors[0],
            NativeBehavior::Disabled { .. }
        ));
        assert!(scroll.scroll(&shared, 2, 1.0));
        assert_key(receiver.try_recv().unwrap(), "H");
        scroll.enter(Some(Edge::Right));
        assert!(scroll.scroll(&shared, 0, 1.0));
        assert_key(receiver.try_recv().unwrap(), "G");
        assert!(scroll.scroll(&shared, 0, 0.5));
        scroll.enter(None);
        assert!(scroll.scroll(&shared, 0, 0.5));
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn button_clicks_latch_scope_and_keep_left_right_independent() {
        let (shared, receiver) = fixture(serde_json::json!({
            "mouse.global.buttonLeft": {"click":[{"type":"key","key":"G"}]},
            "mouse.top.buttonLeft": {"click":[{"type":"key","key":"T"}]},
            "mouse.left.buttonRight": {"click":[{"type":"key","key":"R"}]}
        }));
        let mut buttons = ButtonTracker::default();
        let now = Instant::now();
        assert!(buttons.event(&shared, 0, true, Some(Edge::Top), (20.0, 0.0), now));
        assert!(buttons.event(&shared, 1, true, Some(Edge::Left), (20.0, 50.0), now));
        assert!(receiver.try_recv().is_err());
        assert!(buttons.event(&shared, 0, false, None, (20.0, 50.0), now));
        assert_key(receiver.try_recv().unwrap(), "T");
        assert!(buttons.event(&shared, 1, false, Some(Edge::Top), (20.0, 0.0), now));
        assert_key(receiver.try_recv().unwrap(), "R");
    }
    #[test]
    fn double_click_suppresses_singles_and_long_press_fires_once() {
        let (shared, receiver) = fixture(serde_json::json!({
            "mouse.top.buttonLeft": {
                "click":[{"type":"key","key":"C"}],
                "doubleClick":[{"type":"key","key":"D"}],
                "longPress":[{"type":"key","key":"L"}]
            }
        }));
        let mut buttons = ButtonTracker::default();
        let start = Instant::now();
        let mut event = |down, ms| {
            buttons.event(
                &shared,
                0,
                down,
                Some(Edge::Top),
                (50.0, 50.0),
                start + Duration::from_millis(ms),
            )
        };
        assert!(event(true, 0));
        assert!(event(false, 30));
        assert!(receiver.try_recv().is_err());
        assert!(event(true, 200));
        assert!(event(false, 400));
        assert_key(receiver.try_recv().unwrap(), "D");
        buttons.tick(&shared, start + Duration::from_millis(1000));
        assert!(receiver.try_recv().is_err());
        assert!(buttons.event(
            &shared,
            0,
            true,
            Some(Edge::Top),
            (50.0, 50.0),
            start + Duration::from_millis(1100)
        ));
        buttons.tick(&shared, start + Duration::from_millis(1699));
        assert!(receiver.try_recv().is_err());
        buttons.tick(&shared, start + Duration::from_millis(1700));
        assert_key(receiver.try_recv().unwrap(), "L");
        buttons.tick(&shared, start + Duration::from_millis(1800));
        assert!(buttons.event(
            &shared,
            0,
            false,
            Some(Edge::Top),
            (50.0, 50.0),
            start + Duration::from_millis(1900)
        ));
        assert!(receiver.try_recv().is_err());
        assert!(buttons.event(
            &shared,
            0,
            true,
            Some(Edge::Top),
            (50.0, 50.0),
            start + Duration::from_millis(2000)
        ));
        assert!(buttons.event(
            &shared,
            0,
            false,
            Some(Edge::Top),
            (50.0, 50.0),
            start + Duration::from_millis(2050)
        ));
        buttons.tick(&shared, start + Duration::from_millis(2400));
        assert_key(receiver.try_recv().unwrap(), "C");
    }
    #[test]
    fn edge_button_rules_ignore_global_triggers_and_restore_unmapped_taps() {
        let (shared, receiver) = fixture(serde_json::json!({
            "mouse.global.buttonLeft": {"doubleClick":[{"type":"key","key":"D"}]},
            "mouse.top.buttonLeft": {"longPress":[{"type":"key","key":"L"}]}
        }));
        let (_, rule) =
            button_rule(&shared.configuration.lock().unwrap(), Some(Edge::Top), 0).unwrap();
        assert!(!has_actions(&rule.double_click));
        assert!(has_actions(&rule.long_press));
        assert!(!has_actions(&rule.click));
        let mut buttons = ButtonTracker::default();
        let start = Instant::now();
        assert!(buttons.event(&shared, 0, true, Some(Edge::Top), (50.0, 0.0), start));
        assert!(buttons.event(&shared, 0, false, Some(Edge::Top), (50.0, 0.0), start));
        assert!(matches!(
            receiver.try_recv().unwrap().behaviors[0],
            NativeBehavior::Mouse {
                button: MouseButton::Left,
                ..
            }
        ));
    }
    #[test]
    fn settings_changes_cancel_jobs_without_orphaning_button_releases() {
        let (shared, receiver) = fixture(serde_json::json!({
            "mouse.top.buttonLeft": {"click":[{"type":"key","key":"C"}],"doubleClick":[{"type":"key","key":"D"}]}
        }));
        let mut buttons = ButtonTracker::default();
        let now = Instant::now();
        shared.configuration.lock().unwrap().settings.enabled = false;
        assert!(!buttons.event(&shared, 0, true, Some(Edge::Top), (50.0, 0.0), now));
        shared.configuration.lock().unwrap().settings.enabled = true;
        assert!(!buttons.event(&shared, 0, false, Some(Edge::Top), (50.0, 0.0), now));
        assert!(buttons.event(&shared, 0, true, Some(Edge::Top), (50.0, 0.0), now));
        shared.configuration.lock().unwrap().revision += 1;
        assert!(buttons.event(&shared, 0, false, Some(Edge::Top), (50.0, 0.0), now));
        assert!(receiver.try_recv().is_err());
        assert!(buttons.event(&shared, 0, true, Some(Edge::Top), (50.0, 0.0), now));
        assert!(buttons.event(&shared, 0, false, Some(Edge::Top), (50.0, 0.0), now));
        shared.configuration.lock().unwrap().settings.enabled = false;
        buttons.tick(&shared, now + DOUBLE_CLICK);
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn legacy_global_mouse_buttons_never_capture_anywhere_or_inherit_at_edges() {
        let (shared, receiver) = fixture(serde_json::json!({
            "mouse.global.buttonLeft": {"click":[{"type":"disabled"}], "doubleClick":[{"type":"key","key":"D"}], "longPress":[{"type":"key","key":"L"}]},
            "mouse.global.buttonRight": {"click":[{"type":"key","key":"R"}]},
            "mouse.top.buttonLeft": {"click":[{"type":"key","key":"T"}]}
        }));
        let mut buttons = ButtonTracker::default();
        let now = Instant::now();
        for button in 0..2 {
            for edge in [None, Some(Edge::Left), Some(Edge::Right)] {
                assert!(!buttons.event(&shared, button, true, edge, (50.0, 50.0), now));
                buttons.tick(&shared, now + LONG_PRESS);
                assert!(!buttons.event(
                    &shared,
                    button,
                    false,
                    edge,
                    (50.0, 50.0),
                    now + LONG_PRESS
                ));
            }
        }
        assert!(receiver.try_recv().is_err());
        assert!(buttons.event(&shared, 0, true, Some(Edge::Top), (50.0, 0.0), now));
        assert!(buttons.event(&shared, 0, false, Some(Edge::Top), (50.0, 0.0), now));
        assert_key(receiver.try_recv().unwrap(), "T");
    }
}
