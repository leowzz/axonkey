//! Opt-in integration coverage for the real WASAPI output actor, without BLE.

use super::*;
use std::{
    fs::{self, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    panic::{catch_unwind, AssertUnwindSafe},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const ACTOR_TIMEOUT: Duration = Duration::from_secs(15);

struct OutputActor {
    shared: Arc<Shared>,
    commands: Option<Sender<OutputCommand>>,
    finished: Receiver<()>,
    worker: Option<JoinHandle<()>>,
    directory: PathBuf,
    config: PathBuf,
}

impl OutputActor {
    fn start(initial_config: Option<&[u8]>) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "axonkey-output-actor-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create isolated test directory");
        let config = directory.join("windows-audio-output.json");
        if let Some(bytes) = initial_config {
            fs::write(&config, bytes).expect("write isolated startup configuration");
        }

        let shared = Arc::new(Shared::new());
        let (commands, finished, worker) = Self::spawn_worker(&shared, &config);
        Self {
            shared,
            commands: Some(commands),
            finished,
            worker: Some(worker),
            directory,
            config,
        }
    }

    fn spawn_worker(
        shared: &Arc<Shared>,
        config: &Path,
    ) -> (Sender<OutputCommand>, Receiver<()>, JoinHandle<()>) {
        let audio_shared = Arc::clone(shared);
        let audio_config = config.to_path_buf();
        let (commands, requests) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("Axonkey output integration test".into())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    audio_output_loop(audio_shared, audio_config, requests)
                }));
                let _ = done.send(());
                if let Err(panic) = result {
                    std::panic::resume_unwind(panic);
                }
            })
            .expect("spawn isolated audio output actor");
        (commands, finished, worker)
    }

    fn restart(&mut self) {
        self.stop()
            .expect("stop before restarting the output actor");
        self.shared = Arc::new(Shared::new());
        let (commands, finished, worker) = Self::spawn_worker(&self.shared, &self.config);
        self.commands = Some(commands);
        self.finished = finished;
        self.worker = Some(worker);
    }

    fn wait_for_state(&self, expected: &str) {
        let started = Instant::now();
        loop {
            let output = self
                .shared
                .status
                .lock()
                .expect("audio status")
                .output
                .clone()
                .expect("Windows output status");
            if output.state == expected {
                return;
            }
            assert!(
                started.elapsed() < ACTOR_TIMEOUT,
                "output actor did not reach {expected} within 15 seconds: {output:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn refresh_and_wait_for_state(&self, expected: &str) {
        // A sentinel distinguishes a completed probe from the status left by
        // the previous one. This changes only the isolated test actor's UI
        // snapshot, not the configuration or endpoint-selection policy.
        self.shared
            .status
            .lock()
            .unwrap()
            .output
            .as_mut()
            .unwrap()
            .state = "testRefreshing".into();
        self.shared.audio_refresh.store(true, Ordering::Release);
        self.wait_for_state(expected);
    }

    fn select(&self, render_id: &str) -> Result<(), String> {
        let (reply, response) = mpsc::channel();
        self.commands
            .as_ref()
            .expect("actor running")
            .send(OutputCommand::Select {
                render_id: render_id.into(),
                capture_id: None,
                reply,
            })
            .expect("send explicit endpoint selection");
        response
            .recv_timeout(ACTOR_TIMEOUT)
            .expect("endpoint selection must finish within 15 seconds")
    }

    fn clear(&self) -> Result<(), String> {
        let (reply, response) = mpsc::channel();
        self.commands
            .as_ref()
            .expect("actor running")
            .send(OutputCommand::Clear { reply })
            .expect("send clear selection");
        response
            .recv_timeout(ACTOR_TIMEOUT)
            .expect("clearing selection must finish within 15 seconds")
    }

    fn assert_ready(&self, render_id: &str) {
        let status = self.shared.status.lock().expect("audio status");
        assert!(
            status.output_ready,
            "WASAPI callback must acknowledge startup"
        );
        let output = status.output.as_ref().expect("Windows output status");
        assert_eq!(output.state, "ready");
        assert_eq!(output.selected_endpoint_id.as_deref(), Some(render_id));
        assert!(output.error.is_none(), "{output:?}");
        assert!(
            !status.bluetooth_connected,
            "test must not start the BLE worker"
        );
    }

    fn stop(&mut self) -> Result<(), String> {
        if self.worker.is_none() {
            return Ok(());
        }
        self.shared.stop.store(true, Ordering::Release);
        // Dropping the last command sender also wakes recv_timeout immediately.
        self.commands.take();
        self.finished
            .recv_timeout(ACTOR_TIMEOUT)
            .map_err(|error| format!("audio actor did not stop within 15 seconds: {error}"))?;
        self.worker
            .take()
            .expect("running worker")
            .join()
            .map_err(|_| "audio output actor panicked".to_string())
    }
}

impl Drop for OutputActor {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            // Do not block indefinitely or remove files still owned by a stuck
            // worker. Surface its isolated directory for failure diagnostics.
            eprintln!("{error}; preserving {}", self.directory.display());
            return;
        }
        let _ = fs::remove_file(&self.config);
        // No recursive deletion: only our file and empty, uniquely created dir.
        if let Err(error) = fs::remove_dir(&self.directory) {
            eprintln!("cannot clean {}: {error}", self.directory.display());
        }
    }
}

fn explicit_test_endpoint() -> (String, Vec<AudioEndpoint>) {
    let render_id = std::env::var("AXONKEY_TEST_RENDER_ID")
        .expect("set AXONKEY_TEST_RENDER_ID to an explicitly chosen raw MMDevice render ID");
    assert!(!render_id.is_empty(), "an explicit endpoint ID is required");
    let endpoints = enumerate_endpoints().expect("enumerate supported endpoints");
    assert!(
        endpoints.iter().any(|endpoint| endpoint.id == render_id
            && endpoint.direction == "render"
            && endpoint.state == "active"),
        "AXONKEY_TEST_RENDER_ID must identify an active, hardware-verified VB-CABLE render endpoint"
    );
    (render_id, endpoints)
}

#[test]
#[ignore = "requires AXONKEY_TEST_RENDER_ID, an auto-selectable VB-CABLE and one active capture; no BLE"]
fn output_actor_migrates_missing_binding_and_restores_it_on_restart() {
    let (render_id, endpoints) = explicit_test_endpoint();
    // Prove the migration policy would select the explicitly approved device
    // before any actor or WASAPI stream starts. All configuration stays in a
    // unique temporary directory; this never loads the real application's file.
    let selected = select_render_endpoint(&endpoints, None)
        .expect("this host must have an unambiguous automatic migration candidate");
    assert_eq!(
        selected.id, render_id,
        "automatic migration must target only AXONKEY_TEST_RENDER_ID"
    );
    let captures: Vec<_> = endpoints
        .iter()
        .filter(|endpoint| {
            endpoint.direction == "capture"
                && endpoint.state == "active"
                && endpoint.adapter_id == selected.adapter_id
        })
        .collect();
    assert_eq!(
        captures.len(),
        1,
        "this hardware test requires one active capture on the selected adapter"
    );
    let expected = EndpointBinding {
        schema_version: 1,
        render_endpoint_id: render_id.clone(),
        capture_endpoint_id: Some(captures[0].id.clone()),
        adapter_instance_id: selected.adapter_id,
    };

    let mut actor = OutputActor::start(None);
    actor.wait_for_state("ready");
    actor.assert_ready(&render_id);
    assert_eq!(
        endpoint_config::load(&actor.config).expect("load migrated binding"),
        Some(expected.clone()),
        "successful automatic startup must persist the render and associated capture"
    );
    assert_eq!(
        *actor.shared.binding.lock().unwrap(),
        Some(expected.clone())
    );
    assert_eq!(
        actor
            .shared
            .status
            .lock()
            .unwrap()
            .output
            .as_ref()
            .unwrap()
            .capture_endpoint_id,
        expected.capture_endpoint_id
    );
    let saved_bytes = fs::read(&actor.config).expect("read migrated binding bytes");

    actor.restart();
    actor.wait_for_state("ready");
    actor.assert_ready(&render_id);
    assert_eq!(*actor.shared.binding.lock().unwrap(), Some(expected));
    assert_eq!(
        fs::read(&actor.config).expect("read binding after restart"),
        saved_bytes,
        "restoring the saved binding must not rewrite it"
    );
    actor
        .stop()
        .expect("stop the output actor within 15 seconds");
}

#[test]
#[ignore = "requires AXONKEY_TEST_RENDER_ID and a real VB-CABLE WASAPI output; no BLE"]
fn output_actor_restores_stream_when_binding_replacement_fails() {
    let (render_id, _) = explicit_test_endpoint();

    // Invalid existing configuration must require explicit repair, even when
    // a fresh installation on this host can select a device automatically.
    let mut actor = OutputActor::start(Some(b"{}"));
    actor.wait_for_state("configError");
    actor.refresh_and_wait_for_state("configError");
    assert!(!actor.shared.status.lock().unwrap().output_ready);
    assert!(actor.shared.binding.lock().unwrap().is_none());
    assert_eq!(fs::read(&actor.config).unwrap(), b"{}");
    actor
        .select(&render_id)
        .expect("open explicit output and save binding");
    actor.assert_ready(&render_id);
    let saved = endpoint_config::load(&actor.config)
        .expect("read saved binding")
        .expect("successful Select must persist a binding");
    assert_eq!(saved.render_endpoint_id, render_id);
    assert_eq!(*actor.shared.binding.lock().unwrap(), Some(saved.clone()));
    let saved_bytes = fs::read(&actor.config).expect("read original binding bytes");

    // FILE_SHARE_READ permits verification reads but excludes DELETE sharing,
    // so MoveFileExW cannot replace this file after opening the new stream.
    let file_lock = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&actor.config)
        .expect("lock only the isolated binding against replacement");
    let generation = actor.shared.output_generation.load(Ordering::Acquire);
    let error = actor
        .select(&render_id)
        .expect_err("locked binding replacement must fail");
    assert!(error.contains("无法替换音频端点配置"), "{error}");
    actor.assert_ready(&render_id);
    assert!(
        actor.shared.output_generation.load(Ordering::Acquire) >= generation + 2,
        "selection failure must stop the trial stream and restore the previous output"
    );
    assert_eq!(fs::read(&actor.config).unwrap(), saved_bytes);
    assert_eq!(
        endpoint_config::load(&actor.config).unwrap(),
        Some(saved.clone())
    );
    assert_eq!(*actor.shared.binding.lock().unwrap(), Some(saved));
    drop(file_lock);

    actor
        .clear()
        .expect("clear the isolated selection after unlocking");
    actor.refresh_and_wait_for_state("selectionRequired");
    assert!(!actor.config.exists(), "Clear must remove the binding file");
    assert!(actor.shared.binding.lock().unwrap().is_none());
    {
        let status = actor.shared.status.lock().unwrap();
        assert!(!status.output_ready);
        let output = status.output.as_ref().unwrap();
        assert_eq!(output.state, "selectionRequired");
        assert!(output.selected_endpoint_id.is_none());
    }
    assert_eq!(
        fs::read_dir(&actor.directory).unwrap().count(),
        0,
        "failed save must remove its temporary file"
    );
    actor
        .stop()
        .expect("stop the output actor within 15 seconds");
}
