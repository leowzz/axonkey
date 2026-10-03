// SPDX-License-Identifier: GPL-3.0-only
//! Optional, explicitly elevated HID acquisition. Mapping stays in the normal input worker.
use super::extra_keys_protocol::{decode, ExtraKeyStream, EXTRA_KEYS};
use super::extra_keys_winapi as os;
use super::windows_pipe::{diagnostic, valid_app_pipe, PipeListener, PipeStream, APP_PIPE_PREFIX};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const SCRIPT: &str = include_str!("../../native/windows/rc003_hid_gadget.js");
const DLL: &[u8] = include_bytes!("../../../vendor/frida/frida-gadget.dll");
const DLL_SHA: &str = "6fca4007b2284c765a6c15c967a741f536b5865bf83867326a54029a3b752748";
const POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraKeysStatus {
    pub state: String,
    pub message: String,
    pub step: usize,
}
impl Default for ExtraKeysStatus {
    fn default() -> Self {
        Self {
            state: "disabled".into(),
            message: "开启返回键与音量键支持需要管理员权限。".into(),
            step: 0,
        }
    }
}
#[derive(Default)]
struct State {
    generation: u64,
    startup_attempted: bool,
    status: ExtraKeysStatus,
    connection: Option<PipeStream>,
    events: VecDeque<(u16, bool)>,
}
impl State {
    fn begin(&mut self, automatic: bool) -> Option<u64> {
        if automatic && self.startup_attempted {
            return None;
        }
        self.startup_attempted = true;
        if !["disabled", "error"].contains(&self.status.state.as_str()) {
            return None;
        }
        self.generation += 1;
        self.status = status(
            "authorizing",
            "请在 Windows 授权窗口中选择“是”，允许读取这三个按键。",
            0,
        );
        Some(self.generation)
    }
}
#[derive(Default)]
pub struct ExtraKeysService {
    inner: Mutex<State>,
}
impl ExtraKeysService {
    pub fn status(&self) -> ExtraKeysStatus {
        self.inner.lock().unwrap().status.clone()
    }
    pub fn drain(&self) -> (u64, Vec<(u16, bool)>) {
        let mut state = self.inner.lock().unwrap();
        (state.generation, state.events.drain(..).collect())
    }
    pub fn is_ready(&self) -> bool {
        self.inner.lock().unwrap().status.state == "ready"
    }
    pub fn stop(&self) {
        let mut state = self.inner.lock().unwrap();
        state.startup_attempted = true;
        state.generation += 1;
        if let Some(stream) = state.connection.take() {
            stream.shutdown();
        }
        state.events.clear();
        state.status = ExtraKeysStatus::default();
    }
    fn current(&self, generation: u64) -> bool {
        self.inner.lock().unwrap().generation == generation
    }
    fn status_for(&self, generation: u64, status: ExtraKeysStatus) {
        let mut state = self.inner.lock().unwrap();
        if state.generation == generation {
            if state.status.state != status.state || state.status.step != status.step {
                log::info!(target: "axonkey::input", "Extra keys: state={}, step={}, message={}", status.state, status.step, status.message);
            }
            state.status = status;
        }
    }
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        self.start_with_mode(false)
    }
    pub fn start_automatically(self: &Arc<Self>) -> Result<(), String> {
        self.start_with_mode(true)
    }
    fn start_with_mode(self: &Arc<Self>, automatic: bool) -> Result<(), String> {
        let generation = {
            let mut state = self.inner.lock().unwrap();
            let Some(generation) = state.begin(automatic) else {
                return Ok(());
            };
            generation
        };
        let service = self.clone();
        thread::Builder::new()
            .name("Axonkey extra keys authorization".into())
            .spawn(move || {
                if let Err(error) = service.connect(generation) {
                    log::warn!(target: "axonkey::input", "Extra key helper stopped: {error}");
                    let mut state = service.inner.lock().unwrap();
                    if state.generation == generation {
                        state.generation += 1; // force-release held outputs without firing a click
                        state.events.clear();
                        state.connection = None;
                        state.status = status("error", &error, 0);
                    }
                }
            })
            .map_err(|e| {
                self.status_for(generation, status("error", &e.to_string(), 0));
                e.to_string()
            })?;
        Ok(())
    }
    fn connect(&self, generation: u64) -> Result<(), String> {
        let pipe_name = format!("{APP_PIPE_PREFIX}{}", os::random_token()?);
        let mut listener = PipeListener::bind(&pipe_name)
            .map_err(|e| diagnostic("创建应用管道", &pipe_name, &e))?;
        let token = os::random_token()?;
        let args = format!(
            "--extra-keys-helper {} {} {}",
            pipe_name,
            std::process::id(),
            token
        );
        let process = os::elevate(&args)?;
        if !self.current(generation) {
            return Ok(());
        }
        let pid = os::process_id(&process);
        self.status_for(
            generation,
            status("starting", "授权成功，正在连接按键服务。", 0),
        );
        let began = Instant::now();
        let mut stream = loop {
            if !self.current(generation) {
                return Ok(());
            }
            if !os::alive(&process) {
                return Err("按键辅助进程未能启动，请重新授权。".into());
            }
            if began.elapsed() > Duration::from_secs(30) {
                return Err("按键辅助进程连接超时，请重试。".into());
            }
            match listener.accept() {
                Ok(client) if client.peer_pid() == Some(pid) => break client,
                Ok(client) => {
                    client.shutdown();
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(diagnostic("接受辅助进程连接", &pipe_name, &e)),
            }
        };
        {
            let mut state = self.inner.lock().unwrap();
            if state.generation != generation {
                return Ok(());
            }
            state.connection = Some(stream.clone());
        }
        let mut framed = Frames::default();
        let mut authenticated = false;
        let mut last = os::awake_ticks();
        let mut waiting_status = None;
        while self.current(generation) {
            if !os::alive(&process) {
                return Err("按键辅助进程已退出，请重新授权。".into());
            }
            if os::awake_ticks().saturating_sub(last) > 35 * 10_000_000
                && waiting_status.is_none()
            {
                if !authenticated {
                    return Err("按键服务身份验证超时，请重新授权。".into());
                }
                // Modern Standby can suspend the helper independently of the app.
                // Keep its authorized process/pipe alive and release stale holds.
                let mut state = self.inner.lock().unwrap();
                if state.generation != generation {
                    return Ok(());
                }
                waiting_status = Some(state.status.clone());
                state.events.clear();
                state.events.push_back((0, false));
                state.status = status("starting", "正在等待按键服务恢复，无需重新授权。", 0);
                log::warn!(target: "axonkey::input", "Extra key helper heartbeat paused; retaining authorized session");
            }
            for message in framed.read(&mut stream)? {
                last = os::awake_ticks();
                if !authenticated {
                    if message["kind"] != "hello" || message["token"].as_str() != Some(&token) {
                        return Err("按键辅助进程身份验证失败。".into());
                    }
                    authenticated = true;
                    send(&mut stream, &json!({"kind":"start"}))?;
                    continue;
                }
                match message["kind"].as_str() {
                    Some("heartbeat") => {
                        if let Some(previous) = waiting_status.take() {
                            self.status_for(generation, previous);
                        }
                    }
                    Some("status") => {
                        waiting_status = None;
                        let mode = message["state"].as_str().unwrap_or("error");
                        if !["waitingDevice", "starting", "ready", "error"].contains(&mode) {
                            return Err("按键服务状态无效。".into());
                        }
                        let msg = message["message"].as_str().unwrap_or("按键服务出错。");
                        self.status_for(
                            generation,
                            status(
                                mode,
                                msg,
                                message["step"].as_u64().unwrap_or(0).min(3) as usize,
                            ),
                        );
                        if mode == "error" {
                            return Err(msg.into());
                        }
                    }
                    Some("key") => {
                        let Some(usage) = message["usage"]
                            .as_u64()
                            .and_then(|u| u16::try_from(u).ok())
                        else {
                            continue;
                        };
                        let Some(pressed) = message["pressed"].as_bool() else {
                            continue;
                        };
                        if !EXTRA_KEYS.iter().any(|k| k.0 == usage) {
                            continue;
                        }
                        let mut state = self.inner.lock().unwrap();
                        if state.generation == generation && state.status.state == "ready" {
                            if state.events.len() >= 128 {
                                return Err("按键事件处理超时，请重新开启支持。".into());
                            }
                            state.events.push_back((usage, pressed));
                        }
                    }
                    Some("reset") => {
                        // Use a queue marker to reset the input worker while keeping this session alive.
                        let mut state = self.inner.lock().unwrap();
                        state.events.clear();
                        state.events.push_back((0, false));
                    }
                    _ => {}
                }
            }
        }
        stream.shutdown();
        Ok(())
    }
}

fn status(state: &str, message: &str, step: usize) -> ExtraKeysStatus {
    ExtraKeysStatus {
        state: state.into(),
        message: message.into(),
        step,
    }
}

#[cfg(test)]
mod authorization_tests {
    use super::*;

    #[test]
    fn cancellation_survives_frontend_remount_but_allows_manual_retry() {
        let mut state = State::default();
        let first = state.begin(true).unwrap();
        state.status = status("error", "已取消管理员授权", 0);
        for _ in 0..3 {
            assert_eq!(state.begin(true), None);
            assert_eq!(state.status.message, "已取消管理员授权");
            assert_eq!(state.generation, first);
        }
        assert!(state.begin(false).unwrap() > first);
        assert_eq!(state.status.state, "authorizing");
        assert_eq!(
            state.begin(false),
            None,
            "pending requests cannot open another dialog"
        );
        assert!(
            State::default().begin(true).is_some(),
            "a new app process can request again"
        );
    }

    #[test]
    fn disabling_support_does_not_rearm_automatic_authorization() {
        let service = ExtraKeysService::default();
        service.inner.lock().unwrap().begin(true);
        service.stop();
        let mut state = service.inner.lock().unwrap();
        assert_eq!(state.begin(true), None);
        assert_eq!(state.status.state, "disabled");
        assert!(state.begin(false).is_some());
    }
}
fn send(stream: &mut PipeStream, message: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())
}
fn report(stream: &mut PipeStream, state: &str, message: &str, step: usize) -> Result<(), String> {
    send(
        stream,
        &json!({"kind":"status", "state":state, "message":message, "step":step}),
    )
}
#[derive(Default)]
struct Frames {
    bytes: Vec<u8>,
}
impl Frames {
    fn read(&mut self, stream: &mut PipeStream) -> Result<Vec<Value>, String> {
        let mut chunk = [0u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) => return Err("按键服务连接已关闭。".into()),
            Ok(n) => self.bytes.extend_from_slice(&chunk[..n]),
            Err(e)
                if [std::io::ErrorKind::TimedOut, std::io::ErrorKind::WouldBlock]
                    .contains(&e.kind()) =>
            {
                return Ok(vec![])
            }
            Err(e) => return Err(e.to_string()),
        }
        if self.bytes.len() > 65536 {
            return Err("按键服务报告过大。".into());
        }
        let mut messages = Vec::new();
        while let Some(end) = self.bytes.iter().position(|c| *c == b'\n') {
            messages.push(serde_json::from_slice(&self.bytes[..end]).map_err(|e| e.to_string())?);
            self.bytes.drain(..=end);
        }
        Ok(messages)
    }
}

fn script_id() -> String {
    format!("{:x}", Sha256::digest(SCRIPT.as_bytes()))[..12].into()
}

#[cfg(test)]
mod transport_tests {
    use super::*;

    fn pair() -> (PipeStream, PipeStream) {
        let name = format!("{APP_PIPE_PREFIX}{}", os::random_token().unwrap());
        let mut listener = PipeListener::bind(&name).unwrap();
        let sender = PipeStream::connect(&name, Duration::from_secs(1)).unwrap();
        let receiver = listener.accept().unwrap();
        assert_eq!(sender.peer_pid(), Some(std::process::id()));
        assert_eq!(receiver.peer_pid(), Some(std::process::id()));
        (sender, receiver)
    }

    fn drain_frames(stream: &mut PipeStream) -> Vec<Value> {
        let mut frames = Frames::default();
        let mut messages = Vec::new();
        loop {
            let batch = frames.read(stream).unwrap();
            if batch.is_empty() {
                return messages;
            }
            messages.extend(batch);
        }
    }

    #[test]
    fn heartbeat_timeout_reconnects_and_forwards_first_press_on_same_parent_pipe() {
        let (mut parent, mut app) = pair();
        let pipe_name = format!("{APP_PIPE_PREFIX}{}", os::random_token().unwrap());
        let mut listener = PipeListener::bind(&pipe_name).unwrap();
        let names = vec![r"\device\rc003".to_owned()];
        let stop = AtomicBool::new(false);
        for attempt in 0..2 {
            let mut gadget = PipeStream::connect(&pipe_name, Duration::from_secs(1)).unwrap();
            let mut client = listener.accept().unwrap();
            send(&mut gadget, &json!({
                "kind":"ready", "protocol_id":script_id(), "hook_installed":true
            })).unwrap();
            // The first session loses key-up while suspended. The replacement
            // session must accept that key's first down and up without a restart.
            for raw in if attempt == 0 {
                vec!["010000f10000000000"]
            } else {
                vec!["010000f10000000000", "010000000000000000"]
            } {
                send(&mut gadget, &json!({
                    "kind":"gatt_read", "protocol_id":script_id(), "scope":"RC003",
                    "device":names[0], "stream":format!("{}:1", names[0]), "raw":raw
                })).unwrap();
            }
            let result = capture_session(
                &mut parent, &mut client, &names, &stop, || Ok(true),
                Duration::from_millis(250),
            );
            assert!(matches!(result, Err(CaptureFailure::Reconnect(_))));
            finish_capture_session(&mut parent, &mut client, result).unwrap();
            let messages = drain_frames(&mut app);
            assert_eq!(messages[0]["state"], "ready");
            let keys: Vec<_> = messages.iter().filter(|m| m["kind"] == "key").collect();
            assert_eq!(keys.len(), if attempt == 0 { 1 } else { 2 });
            assert_eq!(keys[0]["usage"], 0xf1);
            assert_eq!(keys[0]["pressed"], true);
            if attempt == 1 {
                assert_eq!(keys[1]["pressed"], false);
            }
            assert_eq!(messages[messages.len() - 2]["kind"], "reset");
            assert_eq!(messages.last().unwrap()["state"], "starting");
        }
    }

    #[test]
    fn capture_pipe_closure_retries_but_protocol_mismatch_remains_fatal() {
        let (mut parent, _app) = pair();
        let (gadget, mut client) = pair();
        gadget.shutdown();
        let stop = AtomicBool::new(false);
        let result = capture_session(&mut parent, &mut client, &[], &stop,
            || Ok(true), Duration::from_secs(1));
        assert!(matches!(result, Err(CaptureFailure::Reconnect(_))));
        finish_capture_session(&mut parent, &mut client, result).unwrap();

        let (mut gadget, mut client) = pair();
        send(&mut gadget, &json!({"kind":"ready", "protocol_id":"wrong", "hook_installed":true})).unwrap();
        let result = capture_session(&mut parent, &mut client, &[], &stop,
            || Ok(true), Duration::from_secs(1));
        assert!(matches!(result, Err(CaptureFailure::Fatal(_))));
        assert!(finish_capture_session(&mut parent, &mut client, result).is_err());
    }

    #[test]
    fn idle_ipc_waits_and_remains_usable_after_timeouts() {
        let (mut sender, mut receiver) = pair();
        let mut frames = Frames::default();
        for _ in 0..3 {
            let began = Instant::now();
            assert!(frames.read(&mut receiver).unwrap().is_empty());
            assert!(
                began.elapsed() >= POLL / 2,
                "idle read returned immediately instead of waiting for its timeout"
            );
        }

        let edge = json!({"kind":"key", "usage":EXTRA_KEYS[0].0, "pressed":true});
        send(&mut sender, &edge).unwrap();
        assert_eq!(frames.read(&mut receiver).unwrap(), vec![edge]);

        sender.shutdown();
        assert!(frames.read(&mut receiver).is_err());
    }

    #[test]
    fn local_ipc_forwards_each_press_without_waiting_for_release() {
        let (mut gadget, mut helper_input) = pair();
        let (mut helper_output, mut app) = pair();
        let mut capture_frames = Frames::default();
        let mut app_frames = Frames::default();
        let mut times = Vec::new();
        for index in 0..100 {
            let usage = EXTRA_KEYS[index % EXTRA_KEYS.len()].0;
            let began = Instant::now();
            let edge = json!({"kind":"key", "usage":usage, "pressed":true});
            send(&mut gadget, &edge).unwrap();
            let captured = capture_frames.read(&mut helper_input).unwrap();
            assert_eq!(captured, vec![edge.clone()]);
            send(&mut helper_output, &captured[0]).unwrap();
            assert_eq!(app_frames.read(&mut app).unwrap(), vec![edge]);
            // Keep both connections open; no key-up or subsequent packet is
            // needed to make the current press available to the mapper.
            times.push(began.elapsed().as_micros());
        }
        times.sort_unstable();
        eprintln!(
            "Two-hop named-pipe IPC (100 presses): median={}us p95={}us max={}us",
            times[50], times[95], times[99]
        );

        // Packet boundaries must not be confused with report boundaries.
        gadget.write_all(b"{\"kind\":\"key\",\"pressed\":").unwrap();
        assert!(capture_frames.read(&mut helper_input).unwrap().is_empty());
        gadget.write_all(b"false}\n{\"kind\":\"reset\"}\n").unwrap();
        assert_eq!(
            capture_frames.read(&mut helper_input).unwrap(),
            vec![
                json!({"kind":"key", "pressed":false}),
                json!({"kind":"reset"})
            ]
        );
    }
}
fn gadget_pipe() -> String {
    format!(r"\\.\pipe\Axonkey.ExtraKeys.gadget.{}", script_id())
}
fn prepare_runtime() -> Result<(PathBuf, String), String> {
    if format!("{:x}", Sha256::digest(DLL)) != DLL_SHA {
        return Err("按键组件校验失败，请重新安装应用。".into());
    }
    let root = PathBuf::from(std::env::var_os("ProgramData").ok_or("无法读取系统组件目录")?)
        .join("Axonkey");
    os::secure_directory(&root)?;
    let root = root.join("extra-keys");
    os::secure_directory(&root)?;
    let root = root.join(script_id());
    os::secure_directory(&root)?;
    let token_path = root.join("control-token");
    let token = if token_path.exists() {
        os::validate_control_file(&token_path)?;
        std::fs::read_to_string(&token_path).map_err(|e| e.to_string())?
    } else {
        // Secure the empty file before writing the credential: no readable window.
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&token_path)
            .map_err(|e| e.to_string())?;
        os::secure_control_file(&token_path)?;
        let token = os::random_token()?;
        std::fs::write(&token_path, &token).map_err(|e| e.to_string())?;
        token
    };
    if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("按键组件会话校验失败，请检查安装。".into());
    }
    let dll_name = format!("AxonkeyExtraKeys_{}", script_id());
    let config = serde_json::to_vec_pretty(&json!({"interaction":{"type":"script", "path":"rc003.js", "parameters":{"pipe_name":gadget_pipe(), "protocol_id":script_id(), "auth_token":token}, "on_change":"ignore"},"runtime":"qjs","teardown":"minimal"})).unwrap();
    for (name, content) in [
        (format!("{dll_name}.dll"), DLL),
        (format!("{dll_name}.config"), config.as_slice()),
        ("rc003.js".into(), SCRIPT.as_bytes()),
    ] {
        let path = root.join(name);
        // Don't replace a loaded DLL. Every script revision has a separate runtime.
        if std::fs::read(&path).ok().as_deref() != Some(content) {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            use std::fs::OpenOptions;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            if path.extension().is_some_and(|e| e == "config") {
                os::secure_control_file(&path)?;
            }
            file.write_all(content).map_err(|e| e.to_string())?;
        }
    }
    Ok((root.join(format!("{dll_name}.dll")), token))
}

/// Enter before Tauri, its webview, and its single-instance plugin are initialized.
pub fn run_helper(args: &[String]) -> Result<(), String> {
    if args.len() != 3 || !os::elevated() {
        return Err("此辅助进程需要管理员权限。".into());
    }
    if !valid_app_pipe(&args[0]) {
        return Err("无效本地管道名称".into());
    }
    let parent_pid: u32 = args[1].parse().map_err(|_| "无效应用进程")?;
    if args[2].len() != 64 || !args[2].bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("无效会话".into());
    }
    let mut parent = PipeStream::connect(&args[0], Duration::from_secs(5))
        .map_err(|e| diagnostic("连接应用管道", &args[0], &e))?;
    if parent.peer_pid() != Some(parent_pid) {
        return Err("应用进程身份不匹配。".into());
    }
    send(&mut parent, &json!({"kind":"hello", "token":args[2]}))?;
    let mut framed = Frames::default();
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(5) {
            return Err("应用未确认授权会话。".into());
        }
        if framed
            .read(&mut parent)?
            .iter()
            .any(|m| m["kind"] == "start")
        {
            break;
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    let watch_stop = stop.clone();
    let mut watch = parent.clone();
    thread::spawn(move || {
        let mut byte = [0u8; 1];
        loop {
            match watch.read(&mut byte) {
                Err(e)
                    if [std::io::ErrorKind::WouldBlock, std::io::ErrorKind::TimedOut]
                        .contains(&e.kind()) =>
                {
                    continue
                }
                _ => {
                    watch_stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
    });
    let result = capture(&mut parent, &stop);
    if let Err(error) = &result {
        if report(&mut parent, "error", error, 0).is_ok() {
            // A pipe write may still be queued. The app closes its connection
            // after consuming an error; give it a bounded chance to log it
            // before shutdown cancels any outstanding native writes.
            let began = Instant::now();
            while !stop.load(Ordering::Relaxed) && began.elapsed() < Duration::from_secs(2) {
                thread::sleep(POLL);
            }
        }
    }
    parent.shutdown();
    result
}

#[derive(Debug)]
enum CaptureFailure {
    Reconnect(String),
    Fatal(String),
}

impl From<String> for CaptureFailure {
    fn from(message: String) -> Self {
        Self::Fatal(message)
    }
}

fn capture(parent: &mut PipeStream, stop: &AtomicBool) -> Result<(), String> {
    os::debug_privilege()?;
    let (dll, auth_token) = prepare_runtime()?;
    let pipe_name = gadget_pipe();
    // The helper has no logger; report diagnostics through the parent IPC.
    let mut server =
        PipeListener::bind(&pipe_name).map_err(|e| diagnostic("创建采集管道", &pipe_name, &e))?;
    let mut injected = None;
    while !stop.load(Ordering::Relaxed) {
        let Some(target) = os::target()? else {
            report(
                parent,
                "waitingDevice",
                "请连接并唤醒 RC003，服务会自动继续。",
                0,
            )?;
            thread::sleep(Duration::from_millis(500));
            continue;
        };
        let names = match os::device_names() {
            Ok(names) => names,
            Err(message) => {
                report(parent, "waitingDevice", &message, 0)?;
                thread::sleep(Duration::from_millis(500));
                continue;
            }
        };
        if injected != Some(target.0) {
            report(parent, "starting", "正在启用返回键与音量键，请稍候。", 0)?;
            os::inject(target.0, &dll)?;
            injected = Some(target.0);
        }
        let mut connecting = os::awake_ticks();
        let mut client = loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            if os::awake_ticks().saturating_sub(connecting) > 25 * 10_000_000 {
                // The existing Gadget retries when its host resumes. Retain the
                // listener and elevation instead of requiring another UAC dialog.
                report(parent, "starting", "正在等待按键组件恢复，无需重新授权。", 0)?;
                connecting = os::awake_ticks();
            }
            if os::target()?.as_ref() != Some(&target) {
                break None;
            }
            match server.accept() {
                Ok(client) if client.peer_pid() == Some(target.0) => break Some(client),
                Ok(client) => {
                    client.shutdown();
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    send(parent, &json!({"kind":"heartbeat"}))?;
                    thread::sleep(Duration::from_millis(500));
                }
                Err(e) => return Err(diagnostic("接受采集连接", &pipe_name, &e)),
            }
        };
        let Some(ref mut client) = client else {
            injected = None;
            continue;
        };
        if let Err(error) = send(
            client,
            &json!({"kind":"configure", "devices":names, "auth_token":auth_token}),
        ) {
            client.shutdown();
            send(parent, &json!({"kind":"reset"}))?;
            report(parent, "starting", &format!("按键连接中断，正在自动重连：{error}"), 0)?;
            thread::sleep(POLL);
            continue;
        }
        let session = capture_session(parent, client, &names, stop, || {
            Ok(os::target()?.as_ref() == Some(&target)
                && os::device_names().ok().as_ref() == Some(&names))
        }, Duration::from_secs(15));
        finish_capture_session(parent, client, session)?;
    }
    Ok(())
}

fn finish_capture_session(
    parent: &mut PipeStream,
    client: &mut PipeStream,
    result: Result<(), CaptureFailure>,
) -> Result<(), String> {
    client.shutdown(); // Gadget observes closure, detaches hooks and reconnects.
    // Reset precedes reconnection: old holds/delayed clicks must not survive it.
    send(parent, &json!({"kind":"reset"}))?;
    match result {
        Ok(()) => report(parent, "starting", "设备连接已变化，正在恢复按键采集。", 0),
        Err(CaptureFailure::Reconnect(message)) => {
            report(parent, "starting", &message, 0)?;
            thread::sleep(POLL);
            Ok(())
        }
        Err(CaptureFailure::Fatal(message)) => Err(message),
    }
}

fn capture_session(
    parent: &mut PipeStream,
    client: &mut PipeStream,
    names: &[String],
    stop: &AtomicBool,
    mut session_is_current: impl FnMut() -> Result<bool, String>,
    heartbeat_timeout: Duration,
) -> Result<(), CaptureFailure> {
    let mut input = ExtraKeyStream::default();
    let mut frames = Frames::default();
    let mut heartbeat = os::awake_ticks();
    let mut probe = Instant::now();
    let mut capture_ready = false;
    while !stop.load(Ordering::Relaxed) {
        if probe.elapsed() > Duration::from_secs(1) {
            if !session_is_current()? {
                return Ok(());
            }
            send(parent, &json!({"kind":"heartbeat"}))?;
            probe = Instant::now();
        }
        if Duration::from_nanos(os::awake_ticks().saturating_sub(heartbeat).saturating_mul(100)) > heartbeat_timeout {
            return Err(CaptureFailure::Reconnect(if capture_ready {
                "按键采集暂停，正在自动重连，无需重新授权。"
            } else {
                "按键组件尚未就绪，正在自动重连，无需重新授权。"
            }
            .into()));
        }
        for message in frames.read(client).map_err(CaptureFailure::Reconnect)? {
            if message["protocol_id"].as_str() != Some(&script_id()) {
                return Err(CaptureFailure::Fatal("按键组件版本不匹配，请重启 Windows 后重试。".into()));
            }
            match message["kind"].as_str() {
                Some("ready") | Some("heartbeat") => {
                    if message["hook_installed"] != true {
                        return Err(CaptureFailure::Fatal("Windows 未允许启用按键采集。".into()));
                    }
                    heartbeat = os::awake_ticks();
                    if !capture_ready {
                        // Publish readiness before any key in this same batch:
                        // the parent only accepts keys while the service is ready.
                        report(parent, "ready", "已启用", 0)?;
                        capture_ready = true;
                    }
                }
                Some("error") => {
                    return Err(CaptureFailure::Fatal("按键组件无法读取输入报告，请关闭后重试。".into()))
                }
                Some("stream_closed") => {
                    if input.closed(message["stream"].as_str().unwrap_or("")) {
                        send(parent, &json!({"kind":"reset"}))?;
                    }
                }
                Some("gatt_read") => {
                    if !capture_ready {
                        continue;
                    }
                    let Some(stream) =
                        message["stream"].as_str().filter(|s| s.len() <= 256)
                    else {
                        continue;
                    };
                    let device = message["device"].as_str().unwrap_or("");
                    let direct =
                        message["scope"] == "RC003" && names.iter().any(|n| n == device);
                    let proxy = message["scope"] == "UMDF_PROXY_UNVERIFIED"
                        && device.starts_with("\\device\\umdfctrldev-");
                    if !(direct || proxy) || !stream.starts_with(&format!("{device}:")) {
                        continue;
                    }
                    let Some(usages) = message["raw"].as_str().and_then(decode) else {
                        continue;
                    };
                    for (usage, pressed) in input.report(stream, usages) {
                        send(
                            parent,
                            &json!({"kind":"key", "usage":usage, "pressed":pressed}),
                        )?;
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(debug_assertions)]
pub fn smoke_test() -> Result<(), String> {
    let service = Arc::new(ExtraKeysService::default());
    service.start()?;
    let began = Instant::now();
    let mut previous = String::new();
    let mut count = [0usize; 3];
    let result = loop {
        let current = service.status();
        let detail = format!(
            "{} step={} {}",
            current.state, current.step, current.message
        );
        if detail != previous {
            println!("{detail}");
            previous = detail;
        }
        if current.state == "error" {
            break Err(current.message);
        }
        for (usage, pressed) in service.drain().1 {
            if let Some(index) = EXTRA_KEYS.iter().position(|k| k.0 == usage) {
                println!(
                    "KEY {} {}",
                    EXTRA_KEYS[index].1,
                    if pressed { "DOWN" } else { "UP" }
                );
                if !pressed {
                    count[index] += 1;
                }
            }
        }
        if count.iter().all(|count| *count > 0) {
            break Ok(());
        }
        if began.elapsed() > Duration::from_secs(120) {
            break Err("Live key verification timed out".into());
        }
        thread::sleep(POLL);
    };
    service.stop();
    result
}
