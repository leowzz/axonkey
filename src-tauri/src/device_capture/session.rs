use super::{format_hex, CaptureEvent, CaptureSessionStatus, CapturedKeySample};
use crate::devices::device_descriptor::{parse_svg, DeviceDescriptor};
use crate::devices::engine::DescriptorEngine;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const STREAM_WINDOW_MS: u64 = 1_000;
const STREAM_MIN_FRAMES: usize = 16;
const STREAM_MIN_DISTINCT_CHANGES: usize = 10;
const PULSE_RELEASE_TIMEOUT_MS: u64 = 450;
const COMBO_UPGRADE_WINDOW_MS: u64 = 25;

#[derive(Debug, Default)]
struct StreamHistory {
    timestamps_ms: VecDeque<u64>,
    change_timestamps_ms: VecDeque<u64>,
    last_payload: Option<Vec<u8>>,
    flagged_streaming: bool,
}

#[derive(Debug)]
struct ActiveCapture {
    input_id: String,
    report_id: u8,
    press_bytes: Vec<u8>,
    neutral_bytes: Vec<u8>,
    hold_count: u32,
    press_at_ms: u64,
    last_active_ms: u64,
}

#[derive(Debug, Default)]
pub struct KeySampler {
    neutral_by_report: BTreeMap<u8, Vec<u8>>,
    idle_candidate: BTreeMap<u8, (Vec<u8>, u32)>,
    streams: BTreeMap<u8, StreamHistory>,
    streaming_ids: BTreeSet<u8>,
    armed_input_id: Option<String>,
    active: Option<ActiveCapture>,
    frame_count: u64,
}

#[derive(Debug, Clone)]
pub struct FrameOutcome {
    pub sequence: u64,
    pub report_id: u8,
    pub hex: String,
    pub is_streaming_noise: bool,
    pub streaming_changed: bool,
    pub captured: Option<CapturedKeySample>,
}

impl KeySampler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn arm(&mut self, input_id: Option<String>) {
        self.armed_input_id = input_id.filter(|id| !id.trim().is_empty());
        self.active = None;
    }

    pub fn armed_input_id(&self) -> Option<&str> {
        self.armed_input_id.as_deref()
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    pub fn streaming_report_ids(&self) -> Vec<u8> {
        self.streaming_ids.iter().copied().collect()
    }

    pub fn push_frame(&mut self, bytes: &[u8], now_ms: u64) -> Option<FrameOutcome> {
        if bytes.is_empty() {
            return None;
        }
        self.frame_count += 1;
        let sequence = self.frame_count;
        let report_id = bytes[0];
        let hex = format_hex(bytes);

        let (is_streaming_noise, streaming_changed) =
            self.observe_streaming(report_id, bytes, now_ms);
        if is_streaming_noise {
            if self
                .active
                .as_ref()
                .is_some_and(|active| active.report_id == report_id)
            {
                self.active = None;
            }
            return Some(FrameOutcome {
                sequence,
                report_id,
                hex,
                is_streaming_noise: true,
                streaming_changed,
                captured: None,
            });
        }

        let captured = if self.armed_input_id.is_some() {
            self.process_armed_frame(report_id, bytes, now_ms)
        } else {
            self.learn_idle_neutral(report_id, bytes);
            None
        };

        Some(FrameOutcome {
            sequence,
            report_id,
            hex,
            is_streaming_noise: false,
            streaming_changed,
            captured,
        })
    }

    pub fn poll_timeout(&mut self, now_ms: u64) -> Option<CapturedKeySample> {
        let timed_out = self.active.as_ref().is_some_and(|active| {
            now_ms.saturating_sub(active.last_active_ms) >= PULSE_RELEASE_TIMEOUT_MS
        });
        if !timed_out {
            return None;
        }
        let active = self.active.take()?;
        self.armed_input_id = None;
        Some(CapturedKeySample {
            input_id: active.input_id,
            report_id: active.report_id,
            press_hex: format_hex(&active.press_bytes),
            release_hex: format_hex(&active.neutral_bytes),
            press_length: active.press_bytes.len(),
            release_length: active.neutral_bytes.len(),
            hold_count: active.hold_count,
            duration_ms: active
                .last_active_ms
                .saturating_sub(active.press_at_ms)
                .max(1),
        })
    }

    fn observe_streaming(&mut self, report_id: u8, bytes: &[u8], now_ms: u64) -> (bool, bool) {
        let entry = self.streams.entry(report_id).or_default();
        if entry.flagged_streaming {
            return (true, false);
        }

        let cutoff = now_ms.saturating_sub(STREAM_WINDOW_MS);
        while entry.timestamps_ms.front().is_some_and(|&t| t < cutoff) {
            entry.timestamps_ms.pop_front();
        }
        while entry
            .change_timestamps_ms
            .front()
            .is_some_and(|&t| t < cutoff)
        {
            entry.change_timestamps_ms.pop_front();
        }

        entry.timestamps_ms.push_back(now_ms);
        let changed = entry
            .last_payload
            .as_deref()
            .is_some_and(|prev| prev != bytes);
        if changed {
            entry.change_timestamps_ms.push_back(now_ms);
        }
        entry.last_payload = Some(bytes.to_vec());

        if entry.timestamps_ms.len() >= STREAM_MIN_FRAMES
            && entry.change_timestamps_ms.len() >= STREAM_MIN_DISTINCT_CHANGES
        {
            entry.flagged_streaming = true;
            let newly_added = self.streaming_ids.insert(report_id);
            return (true, newly_added);
        }
        (false, false)
    }

    fn learn_idle_neutral(&mut self, report_id: u8, bytes: &[u8]) {
        if payload_is_zero(bytes) {
            self.neutral_by_report.insert(report_id, bytes.to_vec());
            return;
        }
        let candidate = self
            .idle_candidate
            .entry(report_id)
            .or_insert_with(|| (bytes.to_vec(), 0));
        if candidate.0 == bytes {
            candidate.1 = candidate.1.saturating_add(1);
            if candidate.1 >= 3 && !self.neutral_by_report.contains_key(&report_id) {
                self.neutral_by_report.insert(report_id, bytes.to_vec());
            }
        } else {
            *candidate = (bytes.to_vec(), 1);
        }
    }

    fn default_neutral_for(&self, report_id: u8, len: usize) -> Vec<u8> {
        if let Some(existing) = self.neutral_by_report.get(&report_id) {
            if existing.len() == len {
                return existing.clone();
            }
        }
        let mut neutral = vec![0u8; len];
        if !neutral.is_empty() {
            neutral[0] = report_id;
        }
        neutral
    }

    fn process_armed_frame(
        &mut self,
        report_id: u8,
        bytes: &[u8],
        now_ms: u64,
    ) -> Option<CapturedKeySample> {
        if self.active.is_none() {
            let neutral = self.default_neutral_for(report_id, bytes.len());
            if bytes == neutral.as_slice() || payload_is_zero(bytes) {
                self.neutral_by_report.insert(report_id, bytes.to_vec());
                return None;
            }
            let input_id = self.armed_input_id.clone()?;
            self.active = Some(ActiveCapture {
                input_id,
                report_id,
                press_bytes: bytes.to_vec(),
                neutral_bytes: neutral,
                hold_count: 1,
                press_at_ms: now_ms,
                last_active_ms: now_ms,
            });
            return None;
        }

        let active = self.active.as_mut()?;
        if active.report_id != report_id {
            if payload_is_zero(bytes) {
                self.neutral_by_report.insert(report_id, bytes.to_vec());
            }
            return None;
        }

        if bytes == active.press_bytes.as_slice() {
            active.hold_count = active.hold_count.saturating_add(1);
            active.last_active_ms = now_ms;
            return None;
        }

        let is_release = bytes == active.neutral_bytes.as_slice() || payload_is_zero(bytes);
        if is_release {
            let finished = self.active.take()?;
            self.armed_input_id = None;
            self.neutral_by_report.insert(report_id, bytes.to_vec());
            return Some(CapturedKeySample {
                input_id: finished.input_id,
                report_id,
                press_hex: format_hex(&finished.press_bytes),
                release_hex: format_hex(bytes),
                press_length: finished.press_bytes.len(),
                release_length: bytes.len(),
                hold_count: finished.hold_count,
                duration_ms: now_ms.saturating_sub(finished.press_at_ms),
            });
        }

        if active.hold_count == 1
            && now_ms.saturating_sub(active.press_at_ms) <= COMBO_UPGRADE_WINDOW_MS
            && non_zero_payload_count(bytes) > non_zero_payload_count(&active.press_bytes)
        {
            active.press_bytes = bytes.to_vec();
            active.last_active_ms = now_ms;
        } else {
            active.last_active_ms = now_ms;
        }
        None
    }
}

fn payload_is_zero(bytes: &[u8]) -> bool {
    bytes.len() <= 1 || bytes[1..].iter().all(|&b| b == 0)
}

fn non_zero_payload_count(bytes: &[u8]) -> usize {
    bytes
        .get(1..)
        .map_or(0, |tail| tail.iter().filter(|&&b| b != 0).count())
}

struct SharedSessionState {
    status: CaptureSessionStatus,
    sampler: KeySampler,
    live_preview: Option<(DeviceDescriptor, DescriptorEngine)>,
}

struct RunningSession {
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<SharedSessionState>>,
    worker: Option<JoinHandle<()>>,
}

impl RunningSession {
    fn stop_and_join(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
        if let Ok(mut guard) = self.shared.lock() {
            guard.status.active = false;
        }
    }
}

impl Drop for RunningSession {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

fn global_slot() -> &'static Mutex<Option<RunningSession>> {
    static SLOT: OnceLock<Mutex<Option<RunningSession>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

pub(crate) fn start_global_session(
    target_id: String,
    instance_id: String,
    passthrough_standard_keys: bool,
    sink: Arc<dyn Fn(CaptureEvent) + Send + Sync>,
) -> Result<CaptureSessionStatus, String> {
    stop_global_session()?;

    let stop = Arc::new(AtomicBool::new(false));
    let initial_status = CaptureSessionStatus {
        active: true,
        target_id: Some(target_id.clone()),
        instance_id: Some(instance_id.clone()),
        transport_mode: "connecting".into(),
        driver_version: None,
        supports_keysend: false,
        supports_reset_input: false,
        frame_count: 0,
        streaming_report_ids: Vec::new(),
    };
    let shared = Arc::new(Mutex::new(SharedSessionState {
        status: initial_status,
        sampler: KeySampler::new(),
        live_preview: None,
    }));

    let (ready_tx, ready_rx) = mpsc::channel::<Result<CaptureSessionStatus, String>>();
    let worker_stop = stop.clone();
    let worker_shared = shared.clone();
    let worker_instance = instance_id.clone();

    let worker = thread::Builder::new()
        .name("Axonkey Capture Session".into())
        .spawn(move || {
            run_session_worker(
                worker_instance,
                passthrough_standard_keys,
                worker_stop,
                worker_shared,
                sink,
                ready_tx,
            );
        })
        .map_err(|error| format!("无法启动输入采集线程：{error}"))?;

    match ready_rx.recv_timeout(Duration::from_secs(6)) {
        Ok(Ok(status)) => {
            let mut slot = global_slot().lock().unwrap();
            *slot = Some(RunningSession {
                stop,
                shared,
                worker: Some(worker),
            });
            Ok(status)
        }
        Ok(Err(error)) => {
            stop.store(true, Ordering::Release);
            let _ = worker.join();
            Err(error)
        }
        Err(_) => {
            stop.store(true, Ordering::Release);
            let _ = worker.join();
            Err("连接输入采集通道超时，请确认设备在线并已唤醒。".into())
        }
    }
}

pub(crate) fn stop_global_session() -> Result<bool, String> {
    let existing = global_slot().lock().unwrap().take();
    if let Some(mut session) = existing {
        session.stop_and_join();
        Ok(true)
    } else {
        Ok(false)
    }
}

pub(crate) fn global_session_status() -> CaptureSessionStatus {
    let slot = global_slot().lock().unwrap();
    if let Some(session) = slot.as_ref() {
        if let Ok(guard) = session.shared.lock() {
            return guard.status.clone();
        }
    }
    CaptureSessionStatus::default()
}

pub(crate) fn arm_global_key(input_id: Option<String>) -> Result<bool, String> {
    let slot = global_slot().lock().unwrap();
    let session = slot
        .as_ref()
        .ok_or_else(|| "当前没有运行中的采集会话，请先开始采集。".to_string())?;
    let mut guard = session.shared.lock().unwrap();
    if !guard.status.active {
        return Err("采集会话已断开，请重新开始采集。".into());
    }
    guard.sampler.arm(input_id);
    Ok(true)
}

pub(crate) fn set_global_live_preview_svg(svg_content: Option<String>) -> Result<bool, String> {
    let parsed = match svg_content {
        Some(text) if !text.trim().is_empty() => {
            let descriptor =
                parse_svg(&text).map_err(|err| format!("试按预览 SVG 校验失败：{err}"))?;
            Some((descriptor, DescriptorEngine::default()))
        }
        _ => None,
    };
    let slot = global_slot().lock().unwrap();
    let session = slot
        .as_ref()
        .ok_or_else(|| "当前没有运行中的采集会话，请先开始采集。".to_string())?;
    let mut guard = session.shared.lock().unwrap();
    guard.live_preview = parsed;
    Ok(true)
}

pub(crate) fn capture_single_key(
    instance_id: &str,
    input_id: &str,
    baseline_ms: u64,
    timeout_ms: u64,
) -> Result<(CapturedKeySample, Vec<u8>), String> {
    let (sample_tx, sample_rx) = mpsc::channel::<CapturedKeySample>();
    let sink = Arc::new(move |event: CaptureEvent| {
        if let CaptureEvent::KeyCaptured { sample } = event {
            let _ = sample_tx.send(sample);
        }
    });

    start_global_session(
        format!("cli:{instance_id}"),
        instance_id.to_string(),
        false,
        sink,
    )?;

    let result = (|| {
        if baseline_ms > 0 {
            thread::sleep(Duration::from_millis(baseline_ms.min(5_000)));
        }
        arm_global_key(Some(input_id.to_string()))?;
        let sample = sample_rx
            .recv_timeout(Duration::from_millis(timeout_ms.max(500)))
            .map_err(|_| {
                format!(
                    "等待按键「{input_id}」超时（{timeout_ms} ms），未检测到有效按下与松开报文。"
                )
            })?;
        let streaming = global_session_status().streaming_report_ids;
        Ok((sample, streaming))
    })();

    let _ = stop_global_session();
    result
}

enum TransportReader {
    #[cfg(target_os = "windows")]
    Quarbor(windows_pipe::QuarborCaptureClient),
    Hid(hid_fallback::HidCaptureReader),
}

impl TransportReader {
    fn poll_report(&mut self, passthrough_standard_keys: bool) -> Result<Option<Vec<u8>>, String> {
        match self {
            #[cfg(target_os = "windows")]
            Self::Quarbor(client) => client.poll_report(passthrough_standard_keys),
            Self::Hid(reader) => {
                let _ = passthrough_standard_keys;
                reader.poll_report()
            }
        }
    }
}

fn open_transport(
    instance_id: &str,
    stop: &AtomicBool,
) -> Result<(TransportReader, String, Option<String>, bool, bool), String> {
    #[cfg(target_os = "windows")]
    {
        let bound = crate::windows_driver_devices::list()
            .ok()
            .and_then(|list| {
                list.into_iter()
                    .find(|d| d.instance_id.eq_ignore_ascii_case(instance_id))
                    .map(|d| d.bound)
            })
            .unwrap_or(false);

        if bound || windows_pipe::pipe_exists_or_connectable(instance_id) {
            let client = windows_pipe::QuarborCaptureClient::connect_with_retry(
                instance_id,
                stop,
                Duration::from_millis(2600),
            )?;
            let version = Some(client.driver_version().to_string());
            let keysend = client.supports_keysend();
            let reset = client.supports_reset_input();
            return Ok((
                TransportReader::Quarbor(client),
                "quarbor-pipe".into(),
                version,
                keysend,
                reset,
            ));
        }
    }

    let reader = hid_fallback::HidCaptureReader::open(instance_id)?;
    Ok((
        TransportReader::Hid(reader),
        "hidapi".into(),
        None,
        false,
        false,
    ))
}

fn run_session_worker(
    instance_id: String,
    passthrough_standard_keys: bool,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<SharedSessionState>>,
    sink: Arc<dyn Fn(CaptureEvent) + Send + Sync>,
    ready_tx: mpsc::Sender<Result<CaptureSessionStatus, String>>,
) {
    let (mut reader, mode, driver_version, supports_keysend, supports_reset_input) =
        match open_transport(&instance_id, &stop) {
            Ok(opened) => opened,
            Err(error) => {
                let _ = ready_tx.send(Err(error));
                return;
            }
        };

    let status_snapshot = {
        let mut guard = shared.lock().unwrap();
        guard.status.active = true;
        guard.status.transport_mode = mode;
        guard.status.driver_version = driver_version;
        guard.status.supports_keysend = supports_keysend;
        guard.status.supports_reset_input = supports_reset_input;
        guard.status.clone()
    };

    let _ = ready_tx.send(Ok(status_snapshot.clone()));
    sink(CaptureEvent::Status {
        connected: true,
        frame_count: 0,
        streaming_report_ids: Vec::new(),
        message: None,
    });

    let epoch = Instant::now();
    let mut disconnect_message: Option<String> = None;

    while !stop.load(Ordering::Acquire) {
        let now_ms = epoch.elapsed().as_millis() as u64;
        match reader.poll_report(passthrough_standard_keys) {
            Ok(Some(bytes)) => {
                let mut events_to_emit = Vec::new();
                {
                    let mut guard = shared.lock().unwrap();
                    if let Some(outcome) = guard.sampler.push_frame(&bytes, now_ms) {
                        guard.status.frame_count = guard.sampler.frame_count();
                        if outcome.streaming_changed {
                            let ids = guard.sampler.streaming_report_ids();
                            guard.status.streaming_report_ids = ids.clone();
                            events_to_emit.push(CaptureEvent::Status {
                                connected: true,
                                frame_count: guard.status.frame_count,
                                streaming_report_ids: ids,
                                message: Some(format!(
                                    "已自动忽略持续数据流报告 0x{:02X}",
                                    outcome.report_id
                                )),
                            });
                        }
                        events_to_emit.push(CaptureEvent::RawFrame {
                            sequence: outcome.sequence,
                            report_id: outcome.report_id,
                            hex: outcome.hex.clone(),
                            is_streaming_noise: outcome.is_streaming_noise,
                        });
                        if let Some(sample) = outcome.captured {
                            events_to_emit.push(CaptureEvent::KeyCaptured { sample });
                        }
                        if !outcome.is_streaming_noise {
                            if let Some((descriptor, engine)) = guard.live_preview.as_mut() {
                                for (input_id, pressed) in engine.accept(descriptor, &bytes) {
                                    events_to_emit.push(CaptureEvent::LiveHit {
                                        input_id,
                                        pressed,
                                        report_id: outcome.report_id,
                                        hex: outcome.hex.clone(),
                                    });
                                }
                            }
                        }
                    }
                }
                for event in events_to_emit {
                    sink(event);
                }
            }
            Ok(None) => {
                let timeout_sample = {
                    let mut guard = shared.lock().unwrap();
                    guard.sampler.poll_timeout(now_ms)
                };
                if let Some(sample) = timeout_sample {
                    sink(CaptureEvent::KeyCaptured { sample });
                }
                thread::sleep(Duration::from_millis(4));
            }
            Err(error) => {
                disconnect_message = Some(error);
                break;
            }
        }
    }

    drop(reader);

    let (frame_count, streaming_ids) = {
        let mut guard = shared.lock().unwrap();
        guard.status.active = false;
        (
            guard.status.frame_count,
            guard.status.streaming_report_ids.clone(),
        )
    };

    sink(CaptureEvent::Status {
        connected: false,
        frame_count,
        streaming_report_ids: streaming_ids,
        message: disconnect_message,
    });
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn extract_boot_keyboard_usages(data: &[u8]) -> Option<BTreeSet<u16>> {
    let payload = if data.len() == 8 && data[1] == 0 {
        &data[..8]
    } else if data.len() == 9 && data[0] == 1 && data[2] == 0 {
        &data[1..9]
    } else {
        return None;
    };
    if payload[2..8].iter().any(|usage| (1..=3).contains(usage)) {
        return None;
    }

    let mut current = BTreeSet::new();
    let modifiers = payload[0];
    for bit in 0..8u16 {
        if (modifiers & (1 << bit)) != 0 {
            current.insert(0xE0 + bit);
        }
    }
    for &usage in &payload[2..8] {
        if (0x04..=0xA4).contains(&usage) {
            current.insert(u16::from(usage));
        }
    }
    Some(current)
}

#[cfg(target_os = "windows")]
mod windows_pipe {
    use prost::Message;
    use std::collections::{BTreeSet, VecDeque};
    use std::fs::OpenOptions;
    use std::io;
    use std::os::windows::{fs::OpenOptionsExt, io::IntoRawHandle};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    };
    use std::time::{Duration, Instant};
    use tokio::net::windows::named_pipe::NamedPipeClient;
    use tokio::runtime::{Builder, Runtime};

    #[allow(dead_code)]
    mod proto {
        include!(concat!(env!("OUT_DIR"), "/quarbor.keyboard.v1.rs"));
    }

    const MAX_REPORT: usize = 65_536;
    const MAX_MESSAGE: usize = 66_048;
    const UNIVERSAL_DRIVER_NAME: &str = "QuarborUniversalKeyboardDriver";

    #[derive(PartialEq, Eq)]
    enum HandshakeStage {
        Hello,
        BasicInfo,
        Ready,
    }

    pub(super) struct QuarborCaptureClient {
        pipe: Option<NamedPipeClient>,
        instance_id: String,
        stage: HandshakeStage,
        driver_version: String,
        supports_keysend: bool,
        supports_reset_input: bool,
        frame: Box<[u8; MAX_MESSAGE + 4]>,
        offset: usize,
        target: usize,
        max_payload: usize,
        next_request: u64,
        outgoing: VecDeque<(Vec<u8>, usize)>,
        forwarded_keys: BTreeSet<u16>,
        reset_sent: bool,
    }

    pub(super) fn pipe_name(instance_id: &str) -> String {
        let mut hash = 0xcbf29ce484222325u64;
        for unit in instance_id.to_ascii_uppercase().encode_utf16() {
            for byte in unit.to_le_bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
        format!(r"\\.\pipe\Quarbor.UniversalKeyboard.v1.{hash:016X}")
    }

    pub(super) fn pipe_exists_or_connectable(instance_id: &str) -> bool {
        std::fs::metadata(pipe_name(instance_id)).is_ok()
    }

    fn capture_pipe_runtime() -> io::Result<&'static Runtime> {
        static RUNTIME: OnceLock<io::Result<Runtime>> = OnceLock::new();
        RUNTIME
            .get_or_init(|| {
                Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_io()
                    .thread_name("Axonkey Capture Pipe IO")
                    .build()
            })
            .as_ref()
            .map_err(|error| io::Error::new(error.kind(), error.to_string()))
    }

    impl QuarborCaptureClient {
        pub(super) fn connect_with_retry(
            instance_id: &str,
            stop: &AtomicBool,
            timeout: Duration,
        ) -> Result<Self, String> {
            let path = pipe_name(instance_id);
            let deadline = Instant::now() + timeout;
            let mut last_error = String::new();

            while !stop.load(Ordering::Acquire) {
                match Self::connect_once(&path, instance_id, stop) {
                    Ok(client) => return Ok(client),
                    Err(err) => {
                        last_error = err;
                        if Instant::now() >= deadline {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(80));
                    }
                }
            }
            Err(format!(
                "无法连接 Quarbor 拦截管道（{}）：{last_error}。若为蓝牙遥控器，请按任意键唤醒设备后重试。",
                instance_id
            ))
        }

        fn connect_once(path: &str, instance_id: &str, stop: &AtomicBool) -> Result<Self, String> {
            let _guard = capture_pipe_runtime()
                .map_err(|e| format!("初始化管道运行时失败：{e}"))?
                .enter();
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .access_mode(0x8000_0000 | 0x0002)
                .share_mode(0)
                .custom_flags(0x4000_0000)
                .security_qos_flags(0x0011_0000)
                .open(path)
                .map_err(|e| format!("{e}"))?;
            let pipe = unsafe { NamedPipeClient::from_raw_handle(file.into_raw_handle()) }
                .map_err(|e| format!("{e}"))?;

            let mut client = Self {
                pipe: Some(pipe),
                instance_id: instance_id.to_string(),
                stage: HandshakeStage::Hello,
                driver_version: String::new(),
                supports_keysend: false,
                supports_reset_input: false,
                frame: Box::new([0; MAX_MESSAGE + 4]),
                offset: 0,
                target: 4,
                max_payload: MAX_MESSAGE,
                next_request: 1,
                outgoing: VecDeque::new(),
                forwarded_keys: BTreeSet::new(),
                reset_sent: false,
            };

            let handshake_deadline = Instant::now() + Duration::from_millis(1800);
            while client.stage != HandshakeStage::Ready {
                if stop.load(Ordering::Acquire) {
                    return Err("采集已取消".into());
                }
                if Instant::now() >= handshake_deadline {
                    return Err("Quarbor 管道握手超时".into());
                }
                client.flush().map_err(|e| format!("管道写入失败：{e}"))?;
                if let Some(msg) = client
                    .try_read_message()
                    .map_err(|e| format!("管道读取失败：{e}"))?
                {
                    client.handle_handshake_message(msg)?;
                } else {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            Ok(client)
        }

        pub(super) fn driver_version(&self) -> &str {
            &self.driver_version
        }

        pub(super) fn supports_keysend(&self) -> bool {
            self.supports_keysend
        }

        pub(super) fn supports_reset_input(&self) -> bool {
            self.supports_reset_input
        }

        pub(super) fn poll_report(
            &mut self,
            passthrough_standard_keys: bool,
        ) -> Result<Option<Vec<u8>>, String> {
            self.flush()
                .map_err(|error| format!("Quarbor 管道写入断开：{error}"))?;
            let Some(message) = self
                .try_read_message()
                .map_err(|error| format!("Quarbor 管道已断开：{error}"))?
            else {
                return Ok(None);
            };
            use proto::server_message::Body;
            match message.body {
                Some(Body::PhysicalReport(report)) => {
                    if !(1..=MAX_REPORT).contains(&report.data.len()) {
                        return Ok(None);
                    }
                    if passthrough_standard_keys && self.supports_keysend {
                        self.forward_standard_boot_keys(&report.data);
                    }
                    Ok(Some(report.data))
                }
                Some(Body::InputResult(res)) if res.ntstatus != 0 => {
                    log::warn!(
                        target: "axonkey::capture",
                        "Quarbor InputResult NTSTATUS=0x{:08X}",
                        res.ntstatus
                    );
                    Ok(None)
                }
                _ => Ok(None),
            }
        }

        fn handle_handshake_message(
            &mut self,
            message: proto::ServerMessage,
        ) -> Result<(), String> {
            use proto::server_message::Body;
            match (message.body, &self.stage) {
                (Some(Body::Hello(hello)), HandshakeStage::Hello) => {
                    if hello.protocol_version != 2
                        || !(1..=MAX_MESSAGE as u32).contains(&hello.max_payload_bytes)
                    {
                        return Err("Quarbor 协议版本不兼容".into());
                    }
                    self.max_payload = hello.max_payload_bytes as usize;
                    self.stage = HandshakeStage::BasicInfo;
                    self.enqueue(proto::client_message::Body::QueryBasicInfo(
                        proto::QueryBasicInfo {},
                    ))
                    .map_err(|e| format!("发送 QueryBasicInfo 失败：{e}"))?;
                    Ok(())
                }
                (Some(Body::BasicInfo(info)), HandshakeStage::BasicInfo) => {
                    if info.driver_name != UNIVERSAL_DRIVER_NAME
                        || !self
                            .instance_id
                            .eq_ignore_ascii_case(&info.device_instance_id)
                    {
                        return Err("Quarbor 管道返回了不匹配的设备实例".into());
                    }
                    self.driver_version = info.driver_version;
                    self.supports_keysend = info.supports_keysend;
                    self.supports_reset_input = info.supports_reset_input;
                    self.stage = HandshakeStage::Ready;
                    Ok(())
                }
                _ => Err("Quarbor 握手阶段收到非预期消息".into()),
            }
        }

        fn forward_standard_boot_keys(&mut self, data: &[u8]) {
            let Some(current) = super::extract_boot_keyboard_usages(data) else {
                return;
            };

            let released: Vec<u16> = self.forwarded_keys.difference(&current).copied().collect();
            let pressed: Vec<u16> = current.difference(&self.forwarded_keys).copied().collect();

            for usage in released {
                let _ = self.enqueue(proto::client_message::Body::Keysend(proto::KeySend {
                    keys: vec![proto::Key {
                        usage_page: 0x07,
                        usage: u32::from(usage),
                        report_id: None,
                    }],
                    action: 2,
                }));
            }
            for usage in pressed {
                let _ = self.enqueue(proto::client_message::Body::Keysend(proto::KeySend {
                    keys: vec![proto::Key {
                        usage_page: 0x07,
                        usage: u32::from(usage),
                        report_id: None,
                    }],
                    action: 1,
                }));
            }
            self.forwarded_keys = current;
            let _ = self.flush();
        }

        fn enqueue(&mut self, body: proto::client_message::Body) -> io::Result<()> {
            let request_id = self.next_request;
            self.next_request = self.next_request.saturating_add(1);
            let encoded = proto::ClientMessage {
                request_id,
                body: Some(body),
            }
            .encode_to_vec();
            if encoded.is_empty() || encoded.len() > self.max_payload {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Quarbor payload out of bounds",
                ));
            }
            let mut framed = Vec::with_capacity(4 + encoded.len());
            framed.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
            framed.extend_from_slice(&encoded);
            self.outgoing.push_back((framed, 0));
            self.flush()
        }

        fn flush(&mut self) -> io::Result<()> {
            let Some(pipe) = self.pipe.as_ref() else {
                return Err(io::Error::new(io::ErrorKind::NotConnected, "pipe closed"));
            };
            while let Some((frame, offset)) = self.outgoing.front_mut() {
                match pipe.try_write(&frame[*offset..]) {
                    Ok(0) => {
                        return Err(io::Error::new(
                            io::ErrorKind::WriteZero,
                            "Quarbor pipe write zero",
                        ))
                    }
                    Ok(written) => {
                        *offset += written;
                        if *offset >= frame.len() {
                            self.outgoing.pop_front();
                        }
                    }
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                    Err(err) => return Err(err),
                }
            }
            Ok(())
        }

        fn try_read_message(&mut self) -> io::Result<Option<proto::ServerMessage>> {
            for _ in 0..8 {
                let Some(pipe) = self.pipe.as_ref() else {
                    return Err(io::Error::new(io::ErrorKind::NotConnected, "pipe closed"));
                };
                match pipe.try_read(&mut self.frame[self.offset..self.target]) {
                    Ok(0) => {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "Quarbor pipe closed",
                        ))
                    }
                    Ok(read) => {
                        self.offset += read;
                    }
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                    Err(err) => return Err(err),
                }
                if self.offset < self.target {
                    continue;
                }
                if self.target == 4 {
                    let size = u32::from_le_bytes(self.frame[..4].try_into().unwrap()) as usize;
                    let max = self.max_payload.min(MAX_MESSAGE);
                    if !(1..=max).contains(&size) {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "invalid Quarbor frame size",
                        ));
                    }
                    self.target = 4 + size;
                    continue;
                }
                let decoded = proto::ServerMessage::decode(&self.frame[4..self.target])
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
                self.frame[..self.target].fill(0);
                self.offset = 0;
                self.target = 4;
                return Ok(Some(decoded));
            }
            Ok(None)
        }

        fn send_reset_before_close(&mut self) {
            if self.reset_sent || self.stage != HandshakeStage::Ready {
                return;
            }
            self.reset_sent = true;
            if self.supports_reset_input {
                if self
                    .enqueue(proto::client_message::Body::ResetInput(
                        proto::ResetInput {},
                    ))
                    .is_err()
                {
                    return;
                }
            } else if self.supports_keysend && !self.forwarded_keys.is_empty() {
                for usage in std::mem::take(&mut self.forwarded_keys) {
                    if self
                        .enqueue(proto::client_message::Body::Keysend(proto::KeySend {
                            keys: vec![proto::Key {
                                usage_page: 0x07,
                                usage: u32::from(usage),
                                report_id: None,
                            }],
                            action: 2,
                        }))
                        .is_err()
                    {
                        return;
                    }
                }
            } else {
                return;
            }
            let deadline = Instant::now() + Duration::from_millis(80);
            while Instant::now() < deadline {
                let _ = self.flush();
                if self.outgoing.is_empty() {
                    if let Ok(Some(msg)) = self.try_read_message() {
                        if matches!(msg.body, Some(proto::server_message::Body::InputResult(_))) {
                            break;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(4));
            }
        }
    }

    impl Drop for QuarborCaptureClient {
        fn drop(&mut self) {
            self.send_reset_before_close();
            self.pipe = None;
        }
    }
}

mod hid_fallback {
    use hidapi::HidDevice;

    pub(super) struct HidCaptureReader {
        devices: Vec<HidDevice>,
        next_idx: usize,
        buf: [u8; 512],
    }

    impl HidCaptureReader {
        pub(super) fn open(instance_id: &str) -> Result<Self, String> {
            let api =
                hidapi::HidApi::new().map_err(|error| format!("无法初始化 HID 读取器：{error}"))?;
            let upper = instance_id.to_ascii_uppercase();
            let path_needle = upper.replace('\\', "#");
            let vid =
                super::super::candidates::parse_hex_token_after(&upper, "VID").map(|v| v as u16);
            let pid =
                super::super::candidates::parse_hex_token_after(&upper, "PID").map(|p| p as u16);

            let mut matched_paths = Vec::new();
            for info in api.device_list() {
                let path_str = info.path().to_string_lossy();
                let p_upper = path_str.to_ascii_uppercase();
                let direct_match = p_upper == upper || p_upper.contains(&path_needle);
                let vid_pid_ble_match = upper.starts_with("BTHLEDEVICE\\")
                    && vid.is_some()
                    && pid.is_some()
                    && Some(info.vendor_id()) == vid
                    && Some(info.product_id()) == pid;
                if direct_match || vid_pid_ble_match {
                    matched_paths.push(info.path().to_owned());
                }
            }

            let mut opened = Vec::new();
            for path in &matched_paths {
                if let Ok(dev) = api.open_path(path) {
                    let _ = dev.set_blocking_mode(false);
                    opened.push(dev);
                }
            }

            if opened.is_empty() {
                #[cfg(target_os = "windows")]
                return Err(
                    "Windows 系统独占了该设备的原始输入通道，请先点击「挂载拦截驱动」后再开始采集。"
                        .into(),
                );
                #[cfg(not(target_os = "windows"))]
                return Err(format!(
                    "无法打开 HID 设备节点 {instance_id}，请确认设备已连接且已授予「输入监控」权限。"
                ));
            }

            Ok(Self {
                devices: opened,
                next_idx: 0,
                buf: [0u8; 512],
            })
        }

        pub(super) fn poll_report(&mut self) -> Result<Option<Vec<u8>>, String> {
            let count = self.devices.len();
            for _ in 0..count {
                let idx = self.next_idx % count;
                self.next_idx = self.next_idx.wrapping_add(1);
                match self.devices[idx].read(&mut self.buf) {
                    Ok(0) => {}
                    Ok(len) => return Ok(Some(self.buf[..len].to_vec())),
                    Err(error) => {
                        return Err(format!("读取 HID 报告失败：{error}"));
                    }
                }
            }
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_captures_press_hold_and_release_accurately() {
        let mut sampler = KeySampler::new();
        // Baseline idle neutral frame
        let idle = sampler
            .push_frame(&[0x01, 0, 0, 0, 0, 0, 0, 0, 0], 10)
            .unwrap();
        assert!(idle.captured.is_none());

        sampler.arm(Some("tcl-rc802a.mute".into()));

        // Press + 2 auto-repeats + release
        assert!(sampler
            .push_frame(&[0x01, 0, 0, 0xEF, 0, 0, 0, 0, 0], 100)
            .unwrap()
            .captured
            .is_none());
        assert!(sampler
            .push_frame(&[0x01, 0, 0, 0xEF, 0, 0, 0, 0, 0], 160)
            .unwrap()
            .captured
            .is_none());
        assert!(sampler
            .push_frame(&[0x01, 0, 0, 0xEF, 0, 0, 0, 0, 0], 220)
            .unwrap()
            .captured
            .is_none());

        let released = sampler
            .push_frame(&[0x01, 0, 0, 0, 0, 0, 0, 0, 0], 260)
            .unwrap();
        let sample = released
            .captured
            .expect("key sample should emit on release");
        assert_eq!(sample.input_id, "tcl-rc802a.mute");
        assert_eq!(sample.report_id, 0x01);
        assert_eq!(sample.press_hex, "01 00 00 EF 00 00 00 00 00");
        assert_eq!(sample.release_hex, "01 00 00 00 00 00 00 00 00");
        assert_eq!(sample.press_length, 9);
        assert_eq!(sample.release_length, 9);
        assert_eq!(sample.hold_count, 3);
        assert_eq!(sample.duration_ms, 160);
        assert!(sampler.armed_input_id().is_none());
    }

    #[test]
    fn sampler_filters_high_frequency_streaming_imu_without_blocking_button_holds() {
        let mut sampler = KeySampler::new();
        // Feed 20 changing 0x6F IMU packets within 400ms (>15 Hz distinct payloads)
        for idx in 0..20u8 {
            let outcome = sampler
                .push_frame(&[0x6F, idx, idx.wrapping_mul(3), 0x01], u64::from(idx) * 20)
                .unwrap();
            if idx == 19 {
                assert!(outcome.is_streaming_noise);
            }
        }
        assert_eq!(sampler.streaming_report_ids(), vec![0x6F]);

        // Now hold a real button on report 0x02 at 25 Hz (25 identical frames in 1s):
        // identical frames must NOT be flagged as streaming noise!
        sampler.arm(Some("remote.volumeUp".into()));
        for step in 0..25u64 {
            let _ = sampler.push_frame(&[0x6F, step as u8, 0x99, 0x11], 500 + step * 30);
            let out = sampler
                .push_frame(&[0x02, 0xE9, 0x00], 500 + step * 35)
                .unwrap();
            assert!(!out.is_streaming_noise);
        }
        assert_eq!(sampler.streaming_report_ids(), vec![0x6F]);

        let done = sampler.push_frame(&[0x02, 0x00, 0x00], 1450).unwrap();
        let sample = done
            .captured
            .expect("held button must still capture cleanly");
        assert_eq!(sample.input_id, "remote.volumeUp");
        assert_eq!(sample.press_hex, "02 E9 00");
        assert_eq!(sample.release_hex, "02 00 00");
        assert_eq!(sample.hold_count, 25);
    }

    #[test]
    fn sampler_completes_stateless_pulse_key_on_timeout() {
        let mut sampler = KeySampler::new();
        sampler.arm(Some("pulse.power".into()));
        assert!(sampler
            .push_frame(&[0x04, 0x30, 0x00], 1_000)
            .unwrap()
            .captured
            .is_none());
        assert!(sampler.poll_timeout(1_300).is_none());
        let sample = sampler
            .poll_timeout(1_460)
            .expect("pulse key should complete after timeout");
        assert_eq!(sample.input_id, "pulse.power");
        assert_eq!(sample.press_hex, "04 30 00");
        assert_eq!(sample.release_hex, "04 00 00");
    }

    #[test]
    fn extracts_unnumbered_8byte_and_numbered_9byte_boot_keyboard_frames_and_skips_rollover() {
        let usb_boot = extract_boot_keyboard_usages(&[0x02, 0x00, 0x04, 0x28, 0, 0, 0, 0]).unwrap();
        assert_eq!(
            usb_boot.into_iter().collect::<Vec<_>>(),
            vec![0x04, 0x28, 0xE1]
        );

        let numbered =
            extract_boot_keyboard_usages(&[0x01, 0x05, 0x00, 0x29, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(
            numbered.into_iter().collect::<Vec<_>>(),
            vec![0x29, 0xE0, 0xE2]
        );

        // 6KRO phantom/rollover error bytes 0x01..=0x03 must return None so held keys are not cleared
        assert!(
            extract_boot_keyboard_usages(&[0x02, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01])
                .is_none()
        );
        // Consumer / vendor reports must be ignored
        assert!(extract_boot_keyboard_usages(&[0x02, 0xE9, 0x00]).is_none());
    }
}
