// SPDX-License-Identifier: GPL-3.0-only
//! Optional, explicitly elevated HID acquisition. Mapping stays in the normal input worker.
use super::extra_keys_protocol::{decode, ExtraKeyStream, EXTRA_KEYS};
use super::extra_keys_winapi as os;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
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
    connection: Option<TcpStream>,
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
    pub fn stop(&self) {
        let mut state = self.inner.lock().unwrap();
        state.startup_attempted = true;
        state.generation += 1;
        if let Some(stream) = state.connection.take() {
            let _ = stream.shutdown(Shutdown::Both);
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
                log::info!(target: "axonkey::input", "Extra keys: state={}, step={}", status.state, status.step);
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
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let token = os::random_token()?;
        let args = format!(
            "--extra-keys-helper {} {} {}",
            listener.local_addr().unwrap().port(),
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
                Ok((client, _)) if os::peer_pid(&client) == Some(pid) => break client,
                Ok((client, _)) => {
                    let _ = client.shutdown(Shutdown::Both);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(POLL),
                Err(e) => return Err(e.to_string()),
            }
        };
        stream
            .set_read_timeout(Some(POLL))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        {
            let mut state = self.inner.lock().unwrap();
            if state.generation != generation {
                return Ok(());
            }
            state.connection = Some(stream.try_clone().map_err(|e| e.to_string())?);
        }
        let mut framed = Frames::default();
        let mut authenticated = false;
        let mut last = Instant::now();
        while self.current(generation) {
            if !os::alive(&process) {
                return Err("按键辅助进程已退出，请重新授权。".into());
            }
            if last.elapsed() > Duration::from_secs(35) {
                return Err("按键服务失去响应，请关闭后重试。".into());
            }
            for message in framed.read(&mut stream)? {
                last = Instant::now();
                if !authenticated {
                    if message["kind"] != "hello" || message["token"].as_str() != Some(&token) {
                        return Err("按键辅助进程身份验证失败。".into());
                    }
                    authenticated = true;
                    send(&mut stream, &json!({"kind":"start"}))?;
                    continue;
                }
                match message["kind"].as_str() {
                    Some("status") => {
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
        let _ = stream.shutdown(Shutdown::Both);
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
fn send(stream: &mut TcpStream, message: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())
}
fn report(stream: &mut TcpStream, state: &str, message: &str, step: usize) -> Result<(), String> {
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
    fn read(&mut self, stream: &mut TcpStream) -> Result<Vec<Value>, String> {
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
fn gadget_port() -> u16 {
    30000 + u16::from_str_radix(&script_id()[..4], 16).unwrap() % 20000
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
    let config = serde_json::to_vec_pretty(&json!({"interaction":{"type":"script", "path":"rc003.js", "parameters":{"host":"127.0.0.1", "port":gadget_port(), "protocol_id":script_id(), "auth_token":token}, "on_change":"ignore"},"runtime":"qjs","teardown":"minimal"})).unwrap();
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
    let port: u16 = args[0].parse().map_err(|_| "无效会话端口")?;
    let parent_pid: u32 = args[1].parse().map_err(|_| "无效应用进程")?;
    if args[2].len() != 64 || !args[2].bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("无效会话".into());
    }
    let mut parent =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
    if os::peer_pid(&parent) != Some(parent_pid) {
        return Err("应用进程身份不匹配。".into());
    }
    parent
        .set_read_timeout(Some(POLL))
        .map_err(|e| e.to_string())?;
    parent
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
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
    let mut watch = parent.try_clone().map_err(|e| e.to_string())?;
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
        let _ = report(&mut parent, "error", error, 0);
    }
    let _ = parent.shutdown(Shutdown::Both);
    result
}

fn capture(parent: &mut TcpStream, stop: &AtomicBool) -> Result<(), String> {
    os::debug_privilege()?;
    let (dll, auth_token) = prepare_runtime()?;
    let server = TcpListener::bind(("127.0.0.1", gadget_port()))
        .map_err(|_| "按键服务已被占用，请先关闭其他 Axonkey 按键采集窗口。")?;
    server.set_nonblocking(true).map_err(|e| e.to_string())?;
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
        let connecting = Instant::now();
        let mut client = loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            if connecting.elapsed() > Duration::from_secs(25) {
                return Err("按键组件连接超时，请关闭后重试。".into());
            }
            if os::target()?.as_ref() != Some(&target) {
                break None;
            }
            match server.accept() {
                Ok((client, _)) if os::peer_pid(&client) == Some(target.0) => break Some(client),
                Ok((client, _)) => {
                    let _ = client.shutdown(Shutdown::Both);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    send(parent, &json!({"kind":"heartbeat"}))?;
                    thread::sleep(Duration::from_millis(500));
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        let Some(ref mut client) = client else {
            injected = None;
            continue;
        };
        client
            .set_read_timeout(Some(POLL))
            .map_err(|e| e.to_string())?;
        client
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        send(
            client,
            &json!({"kind":"configure", "devices":names, "auth_token":auth_token}),
        )?;
        let mut input = ExtraKeyStream::default();
        let mut frames = Frames::default();
        let mut heartbeat = Instant::now();
        let mut probe = Instant::now();
        let mut capture_ready = false;
        let session: Result<(), String> = (|| {
            while !stop.load(Ordering::Relaxed) {
                if probe.elapsed() > Duration::from_secs(1) {
                    if os::target()?.as_ref() != Some(&target)
                        || os::device_names().ok().as_ref() != Some(&names)
                    {
                        return Ok(());
                    }
                    send(parent, &json!({"kind":"heartbeat"}))?;
                    probe = Instant::now();
                }
                if heartbeat.elapsed() > Duration::from_secs(15) {
                    return Err(if capture_ready {
                        "按键采集失去响应，请关闭后重试。"
                    } else {
                        "按键组件未确认就绪，请关闭后重试。"
                    }
                    .into());
                }
                for message in frames.read(client)? {
                    if message["protocol_id"].as_str() != Some(&script_id()) {
                        return Err("按键组件版本不匹配，请重启 Windows 后重试。".into());
                    }
                    match message["kind"].as_str() {
                        Some("ready") | Some("heartbeat") => {
                            if message["hook_installed"] != true {
                                return Err("Windows 未允许启用按键采集。".into());
                            }
                            heartbeat = Instant::now();
                            if !capture_ready {
                                // Publish readiness before any key in this same batch:
                                // the parent only accepts keys while the service is ready.
                                report(parent, "ready", "已启用", 0)?;
                                capture_ready = true;
                            }
                        }
                        Some("error") => {
                            return Err("按键组件无法读取输入报告，请关闭后重试。".into())
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
        })();
        let _ = client.shutdown(Shutdown::Both); // Gadget observes EOF and detaches both hooks.
        send(parent, &json!({"kind":"reset"}))?;
        session?;
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
