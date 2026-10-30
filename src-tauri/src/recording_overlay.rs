//! Event-driven recording indicator shared by the native desktop backends.
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        LazyLock, Mutex, OnceLock,
    },
};
use tauri::Manager;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

const WIDTH: i32 = 160;
const HEIGHT: i32 = 36;
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static ON_CLICK: OnceLock<fn()> = OnceLock::new();
static ACTIVE: LazyLock<Mutex<ActiveRecordings>> =
    LazyLock::new(|| Mutex::new(ActiveRecordings::default()));
#[derive(Default)]
struct ActiveRecordings {
    sources: HashSet<u64>,
}

impl ActiveRecordings {
    fn update(&mut self, id: u64, recording: bool) -> Option<bool> {
        let before = self.visible();
        if recording {
            self.sources.insert(id);
        } else {
            self.sources.remove(&id);
        }
        let after = self.visible();
        (before != after).then_some(after)
    }

    fn visible(&self) -> bool {
        !self.sources.is_empty()
    }
}

pub fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
    let _ = ON_CLICK.set(stop_active_recording);
}

pub(crate) struct RecordingSource {
    id: u64,
    active: AtomicBool,
}

impl Default for RecordingSource {
    fn default() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            active: AtomicBool::new(false),
        }
    }
}

impl RecordingSource {
    pub(crate) fn set(&self, active: bool) {
        if self.active.swap(active, Ordering::AcqRel) == active {
            return;
        }
        let Some(app) = APP.get() else { return };
        if ACTIVE.lock().unwrap().update(self.id, active).is_none() {
            return;
        }
        if let Err(error) = app.run_on_main_thread(refresh_window) {
            log::warn!(target: "axonkey::recording", "Cannot schedule recording indicator: {error}");
        }
    }

    #[cfg(test)]
    pub(crate) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}

impl Drop for RecordingSource {
    fn drop(&mut self) {
        self.set(false);
    }
}

fn refresh_window() {
    let visible = ACTIVE.lock().unwrap().visible();
    #[cfg(windows)]
    windows::refresh_window(visible);
    #[cfg(target_os = "macos")]
    macos::refresh_window(visible);
}

fn recording_a15_instances(snapshot: &crate::input_service::managed::Snapshot) -> Vec<String> {
    snapshot
        .store
        .instances
        .iter()
        .filter(|instance| {
            instance.kind == "cmiotA15"
                && snapshot
                    .runtime
                    .get(&instance.id)
                    .is_some_and(|status| status.recording)
        })
        .map(|instance| instance.id.clone())
        .collect()
}

fn stop_active_recording() {
    let Some(app) = APP.get() else { return };
    let Some(manager) = app.try_state::<crate::DeviceManager>() else {
        return;
    };
    let instances = recording_a15_instances(&manager.snapshot());
    if instances.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<crate::DeviceManager>();
        for id in instances {
            if let Err(error) = manager.stop_recording(&id) {
                log::warn!(target: "axonkey::recording", "Cannot stop A15 {id}: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_targets_only_recording_a15_instances() {
        use crate::input_service::managed::{RuntimeStatus, Snapshot, Store};
        let mut snapshot = Snapshot {
            store: Store::default(),
            discovered: vec![],
            runtime: Default::default(),
            error: None,
            scan_error: None,
            scanning: false,
        };
        for (id, kind, recording) in [
            ("a15-one", "cmiotA15", true),
            ("xiaomi", "rc003", true),
            ("a15-idle", "cmiotA15", false),
            ("a15-two", "cmiotA15", true),
        ] {
            snapshot.store.instances.push(
                serde_json::from_value(serde_json::json!({
                    "id": id, "kind": kind, "name": id, "binding": id,
                    "enabled": true, "profiles": [], "activeProfileId": "default",
                }))
                .unwrap(),
            );
            snapshot.runtime.insert(
                id.into(),
                RuntimeStatus {
                    recording,
                    ..Default::default()
                },
            );
        }
        assert_eq!(recording_a15_instances(&snapshot), ["a15-one", "a15-two"]);
    }

    #[test]
    fn remains_visible_until_the_last_recording_stops() {
        let mut active = ActiveRecordings::default();
        assert_eq!(active.update(1, true), Some(true));
        assert_eq!(active.update(1, true), None);
        assert_eq!(active.update(2, true), None);
        assert_eq!(active.update(1, false), None);
        assert!(active.visible());
        assert_eq!(active.update(2, false), Some(false));
        assert_eq!(active.update(2, false), None);
        assert!(!active.visible());
    }
}
