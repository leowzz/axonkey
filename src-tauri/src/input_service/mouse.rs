//! Mouse input is independent of RC003 discovery and the Interception driver.
//! Capture callbacks only classify and enqueue; actions run off the hook thread.
use super::{NativeBehavior, NativeSettings};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[cfg(windows)]
#[path = "mouse_windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "mouse_macos.rs"]
mod platform;

const INPUTS: [&str; 8] = [
    "mouse.top.up",
    "mouse.top.down",
    "mouse.top.left",
    "mouse.top.right",
    "mouse.left.up",
    "mouse.left.down",
    "mouse.right.up",
    "mouse.right.down",
];
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
                                platform::execute(behavior);
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
        let active = settings.enabled
            && INPUTS.iter().any(|id| {
                settings
                    .behaviors
                    .get(*id)
                    .is_some_and(|triggers| triggers.click.iter().any(NativeBehavior::enabled))
            });
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
            .is_ok_and(|config| config.revision == revision && config.settings.enabled)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Edge {
    Top,
    Left,
    Right,
}
impl Edge {
    fn input(self, direction: usize) -> Option<usize> {
        match (self, direction) {
            (Self::Top, 0..=3) => Some(direction),
            (Self::Left, 0..=1) => Some(4 + direction),
            (Self::Right, 0..=1) => Some(6 + direction),
            _ => None,
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
    key: Option<(usize, u64)>,
    remainder: f64,
}

impl ScrollAccumulator {
    fn enter(&mut self, edge: Edge) {
        if self.edge != Some(edge) {
            self.reset();
            self.edge = Some(edge);
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
        if !amount.is_finite() || amount <= 0.0 || direction >= INPUTS.len() {
            return false;
        }
        let Ok(config) = shared.configuration.try_lock() else {
            return false;
        };
        let actions = config
            .settings
            .behaviors
            .get(INPUTS[direction])
            .map(|item| &item.click);
        let Some(actions) = actions.filter(|actions| {
            config.settings.enabled && actions.iter().any(NativeBehavior::enabled)
        }) else {
            self.reset();
            return false;
        };
        let key = (direction, config.revision);
        if self.key != Some(key) {
            self.remainder = 0.0;
            self.key = Some(key);
        }
        let total = self.remainder + amount;
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
        assert_eq!(Edge::Left.input(0), Some(4));
        assert_eq!(Edge::Left.input(1), Some(5));
        assert_eq!(Edge::Right.input(0), Some(6));
        assert_eq!(Edge::Right.input(1), Some(7));
        assert_eq!(Edge::Left.input(2), None);
        assert_eq!(Edge::Right.input(3), None);
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
}
