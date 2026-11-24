//! Kivo K18 Lite (RP2040) vendor Raw HID protocol and non-blocking 128x32 1bpp OLED service.

pub(crate) mod font;

use super::device_descriptor::DeviceDescriptor;
use crate::input_service::{
    managed::DeviceDisplaySettings, MouseButton, NativeBehavior, WheelDirection,
};
use hidapi::HidDevice;
use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) const KIND: &str = "kivoK18Lite";
#[cfg(test)]
pub(crate) const DESCRIPTOR_ID: &str = "kivo.k18Lite";

pub(crate) const DEFAULT_WIDTH: u16 = 128;
pub(crate) const DEFAULT_HEIGHT: u16 = 32;
pub(crate) const FRAME_BYTES: usize = 512;

pub(crate) const OUTPUT_REPORT_ID: u8 = 0x02;
pub(crate) const OUTPUT_REPORT_LEN: usize = 64;
pub(crate) const OP_CONTROL_LEASE: u8 = 0x01;
pub(crate) const OP_FRAME_CHUNK: u8 = 0x02;
pub(crate) const CHUNK_FLAG_CLEAR_STAGING: u8 = 0x01;
pub(crate) const CHUNK_FLAG_COMMIT: u8 = 0x02;
pub(crate) const MAX_CHUNK_DATA: usize = 56;

pub(crate) const FEATURE_CAPS_REPORT_ID: u8 = 0x10;
pub(crate) const FEATURE_CAPS_REPORT_LEN: usize = 16;
pub(crate) const FEATURE_STATE_REPORT_ID: u8 = 0x11;
pub(crate) const FEATURE_STATE_REPORT_LEN: usize = 8;

const LEASE_SECONDS: u8 = 5;
const UNCHANGED_SETTING: u8 = 0xff;
const LEASE_HEARTBEAT: Duration = Duration::from_secs(2);
pub(crate) const TOAST_DURATION: Duration = Duration::from_millis(1000);
pub(crate) const MAX_PACKETS_PER_TICK: usize = 3;

pub(crate) fn descriptor() -> Option<&'static DeviceDescriptor> {
    static DESCRIPTOR: OnceLock<Option<DeviceDescriptor>> = OnceLock::new();
    super::descriptor_registry::load(
        include_str!("../../../../public/device-descriptors/kivo-k18-lite.svg"),
        &DESCRIPTOR,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Capabilities {
    pub proto_version: u8,
    pub key_count: u8,
    pub has_display: bool,
    pub width: u16,
    pub height: u16,
    pub pixel_format: u8,
    pub brightness: u8,
    pub status_flags: u8,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            proto_version: 1,
            key_count: 18,
            has_display: true,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            pixel_format: 1,
            brightness: 100,
            status_flags: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StateSnapshot {
    pub key_bitmap: u32,
    pub enc_delta: i8,
    pub flags: u8,
    pub seq: u8,
}

pub(crate) fn parse_capabilities_report(bytes: &[u8]) -> Option<Capabilities> {
    if bytes.len() < FEATURE_CAPS_REPORT_LEN || bytes[0] != FEATURE_CAPS_REPORT_ID || bytes[1] != 1
    {
        return None;
    }
    Some(Capabilities {
        proto_version: bytes[1],
        key_count: bytes[2],
        has_display: (bytes[3] & 0x01) != 0,
        width: u16::from_le_bytes([bytes[4], bytes[5]]),
        height: u16::from_le_bytes([bytes[6], bytes[7]]),
        pixel_format: bytes[8],
        brightness: bytes[9],
        status_flags: bytes[10],
    })
}

pub(crate) fn parse_state_snapshot_report(bytes: &[u8]) -> Option<StateSnapshot> {
    if bytes.len() < FEATURE_STATE_REPORT_LEN || bytes[0] != FEATURE_STATE_REPORT_ID {
        return None;
    }
    Some(StateSnapshot {
        key_bitmap: u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) & 0x0003_ffff,
        enc_delta: bytes[5] as i8,
        flags: bytes[6],
        seq: bytes[7],
    })
}

pub(crate) fn probe_capabilities(device: &HidDevice) -> Capabilities {
    let mut buf = [0u8; FEATURE_CAPS_REPORT_LEN];
    buf[0] = FEATURE_CAPS_REPORT_ID;
    match device.get_feature_report(&mut buf) {
        Ok(len) => parse_capabilities_report(&buf[..len]).unwrap_or_default(),
        Err(_) => Capabilities::default(),
    }
}

pub(crate) fn probe_initial_input_report(
    device: &HidDevice,
) -> Option<[u8; FEATURE_STATE_REPORT_LEN]> {
    let mut buf = [0u8; FEATURE_STATE_REPORT_LEN];
    buf[0] = FEATURE_STATE_REPORT_ID;
    let len = device.get_feature_report(&mut buf).ok()?;
    let snapshot = parse_state_snapshot_report(&buf[..len])?;
    let [b0, b1, b2, b3] = snapshot.key_bitmap.to_le_bytes();
    Some([
        0x01,
        b0,
        b1,
        b2,
        b3,
        snapshot.enc_delta as u8,
        snapshot.flags,
        snapshot.seq,
    ])
}

pub(crate) fn encode_control_lease(
    mode: u8,
    lease_sec: u8,
    brightness: u8,
    power_save: u8,
) -> [u8; OUTPUT_REPORT_LEN] {
    let mut packet = [0u8; OUTPUT_REPORT_LEN];
    packet[0] = OUTPUT_REPORT_ID;
    packet[1] = OP_CONTROL_LEASE;
    packet[2] = mode;
    packet[3] = lease_sec;
    packet[4] = brightness;
    packet[5] = power_save;
    packet
}

#[cfg(test)]
pub(crate) fn lease_acquire_packet() -> [u8; OUTPUT_REPORT_LEN] {
    encode_control_lease(1, LEASE_SECONDS, UNCHANGED_SETTING, 0)
}

pub(crate) fn lease_release_packet() -> [u8; OUTPUT_REPORT_LEN] {
    encode_control_lease(0, 0, UNCHANGED_SETTING, UNCHANGED_SETTING)
}

pub(crate) fn encode_frame_chunks(
    frame_id: u8,
    framebuffer: &[u8],
) -> Vec<[u8; OUTPUT_REPORT_LEN]> {
    if framebuffer.is_empty() {
        return Vec::new();
    }
    let total = framebuffer.len();
    let mut packets = Vec::with_capacity(total.div_ceil(MAX_CHUNK_DATA));
    let mut offset = 0usize;
    while offset < total {
        let len = (total - offset).min(MAX_CHUNK_DATA);
        let mut flags = 0u8;
        if offset == 0 {
            flags |= CHUNK_FLAG_CLEAR_STAGING;
        }
        if offset + len == total {
            flags |= CHUNK_FLAG_COMMIT;
        }
        let [offset_lo, offset_hi] = (offset as u16).to_le_bytes();
        let mut packet = [0u8; OUTPUT_REPORT_LEN];
        packet[0] = OUTPUT_REPORT_ID;
        packet[1] = OP_FRAME_CHUNK;
        packet[2] = frame_id;
        packet[3] = flags;
        packet[4] = offset_lo;
        packet[5] = offset_hi;
        packet[6] = len as u8;
        packet[7..7 + len].copy_from_slice(&framebuffer[offset..offset + len]);
        packets.push(packet);
        offset += len;
    }
    packets
}

pub(crate) fn input_short_label(descriptor: &DeviceDescriptor, key: &str) -> String {
    if let Some(input) = descriptor
        .inputs
        .iter()
        .find(|input| super::descriptor_registry::input_key(input) == key || input.id == key)
    {
        return input.label.clone();
    }
    key.rsplit('.').next().unwrap_or(key).to_ascii_uppercase()
}

pub(crate) fn format_key_token(token: &str, macos_labels: bool) -> String {
    let trimmed = token.trim();
    match trimmed.to_ascii_uppercase().as_str() {
        "CTRL" | "CONTROL" | "LCTRL" => "Ctrl".into(),
        "RCTRL" => "RCtrl".into(),
        "SHIFT" | "LSHIFT" => "Shift".into(),
        "RSHIFT" => "RShift".into(),
        "ALT" | "LALT" | "OPTION" | "LOPTION" => {
            if macos_labels {
                "Opt".into()
            } else {
                "Alt".into()
            }
        }
        "RALT" | "ROPTION" => {
            if macos_labels {
                "ROpt".into()
            } else {
                "RAlt".into()
            }
        }
        "WIN" | "LWIN" | "CMD" | "COMMAND" => {
            if macos_labels {
                "Cmd".into()
            } else {
                "Win".into()
            }
        }
        "RWIN" | "RCMD" | "RCOMMAND" => {
            if macos_labels {
                "RCmd".into()
            } else {
                "RWin".into()
            }
        }
        "ESC" | "ESCAPE" => "Esc".into(),
        "ENTER" | "RETURN" => "Enter".into(),
        "BACKSPACE" => "Bksp".into(),
        "DELETE" => "Del".into(),
        "SPACE" => "Space".into(),
        "TAB" => "Tab".into(),
        "PAGEUP" => "PgUp".into(),
        "PAGEDOWN" => "PgDn".into(),
        "ARROWUP" | "UP" => "Up".into(),
        "ARROWDOWN" | "DOWN" => "Down".into(),
        "ARROWLEFT" | "LEFT" => "Left".into(),
        "ARROWRIGHT" | "RIGHT" => "Right".into(),
        _ if trimmed.len() == 1 => trimmed.to_ascii_uppercase(),
        _ => trimmed.into(),
    }
}

pub(crate) fn format_key_chord_summary(tokens: &[String], macos_labels: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    for raw in tokens {
        for piece in raw.split('+').map(str::trim).filter(|s| !s.is_empty()) {
            let formatted = format_key_token(piece, macos_labels);
            if !parts.contains(&formatted) {
                parts.push(formatted);
            }
        }
        if raw.trim() == "+" || raw.trim().ends_with("++") {
            let plus = "+".to_string();
            if !parts.contains(&plus) {
                parts.push(plus);
            }
        }
    }
    parts.join("+")
}

pub(crate) fn summarize_behaviors(behaviors: &[NativeBehavior]) -> Option<String> {
    summarize_behaviors_for_platform(behaviors, cfg!(target_os = "macos"))
}

pub(crate) fn summarize_trigger_behaviors(behaviors: &[NativeBehavior]) -> String {
    if let Some(summary) = summarize_behaviors(behaviors) {
        return summary;
    }
    if behaviors
        .iter()
        .any(|b| b.enabled() && matches!(b, NativeBehavior::Disabled { .. }))
    {
        "已禁用".into()
    } else {
        "未配置行为".into()
    }
}

pub(crate) fn summarize_behaviors_for_platform(
    behaviors: &[NativeBehavior],
    macos_labels: bool,
) -> Option<String> {
    let active: Vec<&NativeBehavior> = behaviors
        .iter()
        .filter(|b| b.enabled() && !matches!(b, NativeBehavior::Disabled { .. }))
        .collect();
    if active.is_empty() {
        return None;
    }
    let meaningful: Vec<&NativeBehavior> = active
        .iter()
        .copied()
        .filter(|b| !matches!(b, NativeBehavior::Delay { .. }))
        .collect();
    let first = meaningful.first().copied().unwrap_or(active[0]);
    let primary = summarize_single_behavior(first, macos_labels);
    if meaningful.len() <= 1 {
        Some(primary)
    } else {
        Some(format!("{primary} +{}", meaningful.len() - 1))
    }
}

fn summarize_single_behavior(behavior: &NativeBehavior, macos_labels: bool) -> String {
    match behavior {
        NativeBehavior::Key { key, .. } => {
            format_key_chord_summary(std::slice::from_ref(key), macos_labels)
        }
        NativeBehavior::Shortcut { keys, .. } => format_key_chord_summary(keys, macos_labels),
        NativeBehavior::Paste { .. } => "粘贴".into(),
        NativeBehavior::CopyText { title, .. } => title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| "复制文本".into()),
        NativeBehavior::TypeText { .. } => "输入文本".into(),
        NativeBehavior::OpenApp { .. } => "打开应用".into(),
        NativeBehavior::OpenPath { .. } => "打开文件".into(),
        NativeBehavior::OpenWebsite { .. } => "打开网页".into(),
        NativeBehavior::RunCommand { title, .. } => title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| "执行命令".into()),
        NativeBehavior::HttpRequest { method, title, .. } => title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{} 请求", method.trim().to_ascii_uppercase())),
        NativeBehavior::SwitchProfile { .. } => "切换配置".into(),
        NativeBehavior::QuickOverlay { .. } => "快捷交互窗".into(),
        NativeBehavior::ClipboardOverlay { .. } => "剪贴板".into(),
        NativeBehavior::Mouse { button, .. } => match button {
            MouseButton::Left => "鼠标左键",
            MouseButton::Right => "鼠标右键",
            MouseButton::Middle => "鼠标中键",
            MouseButton::Back => "鼠标后退",
            MouseButton::Forward => "鼠标前进",
        }
        .into(),
        NativeBehavior::Wheel { direction, .. } => match direction {
            WheelDirection::Up => "滚轮向上",
            WheelDirection::Down => "滚轮向下",
            WheelDirection::Left => "滚轮向左",
            WheelDirection::Right => "滚轮向右",
        }
        .into(),
        NativeBehavior::CursorMove { .. } => "移动指针".into(),
        NativeBehavior::Delay { ms, .. } => format!("延时 {ms}ms"),
        NativeBehavior::Disabled { .. } => String::new(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToastKind {
    Key,
    Profile,
}

struct DisplayState {
    stop: bool,
    write_failed: bool,
    settings: DeviceDisplaySettings,
    sleeping: bool,
    last_activity: Instant,
    idle: (String, String),
    toast: Option<(ToastKind, String, String, Instant)>,
    dirty: bool,
    outbox: VecDeque<[u8; OUTPUT_REPORT_LEN]>,
}

pub(crate) struct DisplayController {
    shared: Arc<(Mutex<DisplayState>, Condvar)>,
    worker: Option<JoinHandle<()>>,
    toast_duration: Duration,
}

impl DisplayController {
    pub(crate) fn open(
        device: &HidDevice,
        idle_top: String,
        idle_bottom: String,
        settings: DeviceDisplaySettings,
    ) -> Option<Self> {
        let caps = probe_capabilities(device);
        if !caps.has_display
            || caps.width != DEFAULT_WIDTH
            || caps.height != DEFAULT_HEIGHT
            || caps.pixel_format != 1
        {
            return None;
        }
        Some(Self::start_worker(
            idle_top,
            idle_bottom,
            settings,
            TOAST_DURATION,
            Duration::from_secs(1),
        ))
    }

    pub(crate) fn start_worker(
        idle_top: String,
        idle_bottom: String,
        settings: DeviceDisplaySettings,
        toast_duration: Duration,
        sleep_unit: Duration,
    ) -> Self {
        let mut outbox = VecDeque::with_capacity(16);
        outbox.push_back(encode_control_lease(
            1,
            LEASE_SECONDS,
            settings.brightness,
            0,
        ));
        let shared = Arc::new((
            Mutex::new(DisplayState {
                stop: false,
                write_failed: false,
                settings,
                sleeping: false,
                last_activity: Instant::now(),
                idle: (idle_top, idle_bottom),
                toast: None,
                dirty: true,
                outbox,
            }),
            Condvar::new(),
        ));
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("Axonkey K18 OLED".into())
            .spawn(move || display_worker(worker_shared, sleep_unit))
            .ok();
        Self {
            shared,
            worker,
            toast_duration,
        }
    }

    pub(crate) fn record_activity(&self) {
        let (lock, cvar) = &*self.shared;
        let mut state = lock.lock().unwrap();
        if record_activity_locked(&mut state, Instant::now()) {
            cvar.notify_one();
        }
    }

    pub(crate) fn set_settings(&self, settings: DeviceDisplaySettings) {
        let (lock, cvar) = &*self.shared;
        let mut state = lock.lock().unwrap();
        if state.settings == settings {
            return;
        }
        let brightness_changed = state.settings.brightness != settings.brightness;
        let sleep_timeout_changed = state.settings.sleep_timeout_sec != settings.sleep_timeout_sec;
        state.settings = settings;

        let mut notify = record_activity_locked(&mut state, Instant::now());
        if brightness_changed && !notify {
            enqueue_control_lease(&mut state);
        }
        if let Some((kind, _, _, _)) = &state.toast {
            let keep = match kind {
                ToastKind::Key => state.settings.show_key_toast,
                ToastKind::Profile => state.settings.show_profile_toast,
            };
            if !keep {
                state.toast = None;
                state.dirty = true;
                notify = true;
            }
        }
        if sleep_timeout_changed {
            notify = true;
        }
        if notify {
            cvar.notify_one();
        }
    }

    pub(crate) fn set_idle(&self, top: String, bottom: String) {
        let (lock, cvar) = &*self.shared;
        let mut state = lock.lock().unwrap();
        if state.idle.0 != top || state.idle.1 != bottom {
            state.idle = (top, bottom);
            let woke = record_activity_locked(&mut state, Instant::now());
            if state.toast.is_none() {
                state.dirty = true;
            }
            if woke || state.dirty {
                cvar.notify_one();
            }
        }
    }

    pub(crate) fn show_key_toast(&self, top: String, bottom: String) {
        self.show_toast_kind(ToastKind::Key, top, bottom);
    }

    pub(crate) fn show_profile_toast(&self, top: String, bottom: String) {
        self.show_toast_kind(ToastKind::Profile, top, bottom);
    }

    fn show_toast_kind(&self, kind: ToastKind, top: String, bottom: String) {
        let (lock, cvar) = &*self.shared;
        let mut state = lock.lock().unwrap();
        let now = Instant::now();
        let woke = record_activity_locked(&mut state, now);
        let enabled = match kind {
            ToastKind::Key => state.settings.show_key_toast,
            ToastKind::Profile => state.settings.show_profile_toast,
        };
        if enabled {
            state.toast = Some((kind, top, bottom, now + self.toast_duration));
            state.dirty = true;
            cvar.notify_one();
        } else if woke {
            cvar.notify_one();
        }
    }

    #[cfg(test)]
    pub(crate) fn drain_queued_packets_for_test(&self) -> Vec<[u8; OUTPUT_REPORT_LEN]> {
        let mut state = self.shared.0.lock().unwrap();
        state.outbox.drain(..).collect()
    }

    pub(crate) fn drain_to(&self, device: &HidDevice) {
        for _ in 0..MAX_PACKETS_PER_TICK {
            let packet = {
                let (lock, _) = &*self.shared;
                let mut state = lock.lock().unwrap();
                if state.write_failed {
                    return;
                }
                state.outbox.pop_front()
            };
            let Some(packet) = packet else {
                return;
            };
            if let Err(error) = device.write(&packet) {
                log::debug!(target: "axonkey::devices", "K18 OLED output write stopped: {error}");
                let (lock, _) = &*self.shared;
                let mut state = lock.lock().unwrap();
                state.write_failed = true;
                state.outbox.clear();
                return;
            }
        }
    }

    pub(crate) fn abandon(&mut self) {
        self.stop_worker();
    }

    pub(crate) fn shutdown_and_release(mut self, device: &HidDevice) {
        self.stop_worker();
        let failed = self.shared.0.lock().unwrap().write_failed;
        if !failed {
            let _ = device.write(&lease_release_packet());
        }
    }

    fn stop_worker(&mut self) {
        let (lock, cvar) = &*self.shared;
        {
            let mut state = lock.lock().unwrap();
            state.stop = true;
        }
        cvar.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for DisplayController {
    fn drop(&mut self) {
        self.stop_worker();
    }
}

fn enqueue_control_lease(state: &mut DisplayState) {
    if state.write_failed {
        return;
    }
    let packet = encode_control_lease(
        1,
        LEASE_SECONDS,
        state.settings.brightness,
        u8::from(state.sleeping),
    );
    if let Some(existing) = state
        .outbox
        .iter_mut()
        .find(|pkt| pkt[1] == OP_CONTROL_LEASE)
    {
        *existing = packet;
    } else {
        state.outbox.push_front(packet);
    }
}

fn record_activity_locked(state: &mut DisplayState, now: Instant) -> bool {
    state.last_activity = now;
    if state.sleeping {
        state.sleeping = false;
        state.dirty = true;
        enqueue_control_lease(state);
        return true;
    }
    false
}

fn sleep_deadline(state: &DisplayState, sleep_unit: Duration) -> Option<Instant> {
    if state.sleeping || state.settings.sleep_timeout_sec == 0 {
        return None;
    }
    Some(state.last_activity + sleep_unit.saturating_mul(state.settings.sleep_timeout_sec))
}

fn display_worker(shared: Arc<(Mutex<DisplayState>, Condvar)>, sleep_unit: Duration) {
    let (lock, cvar) = &*shared;
    let mut next_lease = Instant::now() + LEASE_HEARTBEAT;
    let mut frame_id = 0u8;
    let mut rendered_lines: Option<(String, String)> = None;

    loop {
        let mut state = lock.lock().unwrap();
        let now = Instant::now();

        if state.stop {
            return;
        }

        if state
            .toast
            .as_ref()
            .is_some_and(|(_, _, _, expires_at)| now >= *expires_at)
        {
            state.toast = None;
            state.dirty = true;
        }

        if let Some(deadline) = sleep_deadline(&state, sleep_unit) {
            if now >= deadline {
                state.sleeping = true;
                state.outbox.retain(|packet| packet[1] != OP_FRAME_CHUNK);
                rendered_lines = None;
                enqueue_control_lease(&mut state);
                next_lease = now + LEASE_HEARTBEAT;
            }
        }

        if now >= next_lease {
            if !state.write_failed
                && !state
                    .outbox
                    .iter()
                    .any(|packet| packet[1] == OP_CONTROL_LEASE)
            {
                let heartbeat = encode_control_lease(
                    1,
                    LEASE_SECONDS,
                    state.settings.brightness,
                    u8::from(state.sleeping),
                );
                state.outbox.push_back(heartbeat);
            }
            next_lease = now + LEASE_HEARTBEAT;
        }

        if !state.sleeping && state.dirty {
            state.dirty = false;
            let desired = match &state.toast {
                Some((_, top, bottom, _)) => (top.clone(), bottom.clone()),
                None => state.idle.clone(),
            };
            let write_failed = state.write_failed;
            drop(state);

            if !write_failed && rendered_lines.as_ref() != Some(&desired) {
                let framebuffer = font::render_two_lines_128x32(&desired.0, &desired.1);
                frame_id = frame_id.wrapping_add(1);
                if frame_id == 0 {
                    frame_id = 1;
                }
                let chunks = encode_frame_chunks(frame_id, &framebuffer);
                let mut state = lock.lock().unwrap();
                if state.stop {
                    return;
                }
                if !state.sleeping {
                    state.outbox.retain(|packet| packet[1] != OP_FRAME_CHUNK);
                    state.outbox.extend(chunks);
                    rendered_lines = Some(desired);
                }
            }
            continue;
        }

        let mut timeout = next_lease.saturating_duration_since(now);
        if let Some((_, _, _, expires_at)) = &state.toast {
            timeout = timeout.min(expires_at.saturating_duration_since(now));
        }
        if let Some(deadline) = sleep_deadline(&state, sleep_unit) {
            timeout = timeout.min(deadline.saturating_duration_since(now));
        }
        let _ = cvar.wait_timeout(state, timeout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::engine::DescriptorEngine;

    #[test]
    fn descriptor_parses_vendor_identity_and_decodes_all_18_nkro_keys() {
        let desc = descriptor().expect("kivoK18Lite descriptor must parse");
        assert_eq!(desc.id, DESCRIPTOR_ID);
        assert_eq!(desc.inputs.len(), 18);
        assert!(crate::devices::descriptor_registry::uses_vendor_usb_hid(
            KIND
        ));
        assert!(crate::devices::descriptor_registry::matches_hardware(
            KIND,
            0x2e8a,
            0xa018,
            Some(0xff60),
            Some(0x01),
        ));
        assert!(!crate::devices::descriptor_registry::matches_hardware(
            KIND,
            0x2e8a,
            0xa018,
            Some(0x01),
            Some(0x06),
        ));

        let mut engine = DescriptorEngine::default();
        for index in 0..18u32 {
            let expected_id = format!("kivo.k18Lite.k{:02}", index + 1);
            let bitmap = 1u32 << index;
            let [b0, b1, b2, b3] = bitmap.to_le_bytes();
            let report = [0x01, b0, b1, b2, b3, 0, 0x05, index as u8];
            assert_eq!(
                engine.accept(desc, &report),
                vec![(expected_id.clone(), true)],
                "single press K{:02}",
                index + 1
            );
            let neutral = [0x01, 0, 0, 0, 0, 0, 0x05, index as u8 + 1];
            assert_eq!(
                engine.accept(desc, &neutral),
                vec![(expected_id, false)],
                "single release K{:02}",
                index + 1
            );
        }

        // Full 18-key simultaneous NKRO press and release.
        let all_mask: u32 = (1u32 << 18) - 1;
        let [b0, b1, b2, b3] = all_mask.to_le_bytes();
        let down_edges = engine.accept(desc, &[0x01, b0, b1, b2, b3, 0, 0x01, 99]);
        assert_eq!(down_edges.len(), 18);
        assert!(down_edges.iter().all(|(_, down)| *down));
        let up_edges = engine.accept(desc, &[0x01, 0, 0, 0, 0, 0, 0x01, 100]);
        assert_eq!(up_edges.len(), 18);
        assert!(up_edges.iter().all(|(_, down)| !*down));
    }

    #[test]
    fn encodes_control_lease_and_512_byte_frame_into_10_64_byte_chunks() {
        let acquire = lease_acquire_packet();
        assert_eq!(acquire.len(), 64);
        assert_eq!(&acquire[..6], &[0x02, 0x01, 1, 5, 0xff, 0]);
        assert!(acquire[6..].iter().all(|&b| b == 0));

        let release = lease_release_packet();
        assert_eq!(&release[..6], &[0x02, 0x01, 0, 0, 0xff, 0xff]);
        assert!(release[6..].iter().all(|&b| b == 0));

        let mut source = [0u8; FRAME_BYTES];
        for (index, byte) in source.iter_mut().enumerate() {
            *byte = ((index * 37 + 13) & 0xff) as u8;
        }
        let chunks = encode_frame_chunks(0x2a, &source);
        assert_eq!(chunks.len(), 10);

        let mut reassembled = [0u8; FRAME_BYTES];
        for (i, packet) in chunks.iter().enumerate() {
            assert_eq!(packet.len(), 64);
            assert_eq!(packet[0], OUTPUT_REPORT_ID);
            assert_eq!(packet[1], OP_FRAME_CHUNK);
            assert_eq!(packet[2], 0x2a);
            let expected_flags = if i == 0 {
                CHUNK_FLAG_CLEAR_STAGING
            } else if i == 9 {
                CHUNK_FLAG_COMMIT
            } else {
                0
            };
            assert_eq!(packet[3], expected_flags, "chunk {i} flags");
            let offset = u16::from_le_bytes([packet[4], packet[5]]) as usize;
            let len = packet[6] as usize;
            assert_eq!(offset, i * 56);
            assert_eq!(len, if i < 9 { 56 } else { 8 });
            assert!(packet[7 + len..].iter().all(|&b| b == 0));
            reassembled[offset..offset + len].copy_from_slice(&packet[7..7 + len]);
        }
        assert_eq!(reassembled, source);
    }

    #[test]
    fn parses_feature_capabilities_and_initial_state_reports() {
        let caps = [0x10, 1, 18, 0x01, 128, 0, 32, 0, 1, 85, 0x05, 0, 0, 0, 0, 0];
        assert_eq!(
            parse_capabilities_report(&caps),
            Some(Capabilities {
                proto_version: 1,
                key_count: 18,
                has_display: true,
                width: 128,
                height: 32,
                pixel_format: 1,
                brightness: 85,
                status_flags: 0x05,
            })
        );
        assert_eq!(parse_capabilities_report(&[0x10, 2, 18]), None);

        let state = [0x11, 0x05, 0x00, 0x02, 0x00, 0xff, 0x05, 0x42];
        assert_eq!(
            parse_state_snapshot_report(&state),
            Some(StateSnapshot {
                key_bitmap: 0x0002_0005,
                enc_delta: -1,
                flags: 0x05,
                seq: 0x42,
            })
        );
    }

    #[test]
    fn renders_ascii_and_cjk_lines_into_row_major_msb_first_1bpp_framebuffer() {
        let ascii_frame = font::render_two_lines_128x32("Kivo K18 Lite", "Ctrl+Cmd+A");
        assert!(ascii_frame[..256].iter().any(|&b| b != 0), "top line lit");
        assert!(
            ascii_frame[256..].iter().any(|&b| b != 0),
            "bottom line lit"
        );
        assert_eq!(
            ascii_frame,
            font::render_two_lines_128x32("Kivo K18 Lite", "Ctrl+Cmd+A"),
            "built-in ASCII pixel font is deterministic"
        );

        // Verify exact MSB-first row-major coordinate mapping on 'T' (top bar wider than stem).
        let t_band = font::render_line_128x16("T");
        let lit_in_row = |y: usize| -> u32 {
            t_band[y * 16..(y + 1) * 16]
                .iter()
                .map(|b| b.count_ones())
                .sum()
        };
        assert_eq!(lit_in_row(3), 5, "T top bar spans 5 pixels on row 3");
        assert_eq!(lit_in_row(6), 1, "T vertical stem is 1 pixel wide on row 6");
        // 'T' starts at x=2, so row 3 pixels x=2..=6 set bits 5..=1 of byte 0 (`0b0011_1110 = 0x3E`).
        assert_eq!(t_band[3 * 16], 0b0011_1110);

        let cjk_frame = font::render_two_lines_128x32("悬浮终端", "默认配置");
        let top_lit: u32 = cjk_frame[..256].iter().map(|b| b.count_ones()).sum();
        let bottom_lit: u32 = cjk_frame[256..].iter().map(|b| b.count_ones()).sum();
        assert!(top_lit > 30, "expected CJK top line pixels, got {top_lit}");
        assert!(
            bottom_lit > 30,
            "expected CJK bottom line pixels, got {bottom_lit}"
        );
        assert_ne!(&cjk_frame[..256], &cjk_frame[256..]);
    }

    #[test]
    fn summarizes_behaviors_concisely_for_oled_toasts() {
        let chord = NativeBehavior::Shortcut {
            enabled: true,
            keys: vec!["Ctrl".into(), "Win".into(), "a".into()],
        };
        assert_eq!(
            summarize_behaviors_for_platform(std::slice::from_ref(&chord), true).as_deref(),
            Some("Ctrl+Cmd+A")
        );
        assert_eq!(
            summarize_behaviors_for_platform(std::slice::from_ref(&chord), false).as_deref(),
            Some("Ctrl+Win+A")
        );
        assert_eq!(
            summarize_behaviors_for_platform(
                &[NativeBehavior::Paste {
                    enabled: true,
                    text: "secret".into()
                }],
                true
            )
            .as_deref(),
            Some("粘贴")
        );
        assert_eq!(
            summarize_behaviors_for_platform(&[NativeBehavior::Disabled { enabled: true }], true),
            None
        );
        assert_eq!(
            summarize_trigger_behaviors(&[NativeBehavior::Disabled { enabled: true }]),
            "已禁用"
        );
        assert_eq!(summarize_trigger_behaviors(&[]), "未配置行为");
        assert_eq!(
            summarize_trigger_behaviors(&[NativeBehavior::Key {
                enabled: false,
                key: "A".into(),
            }]),
            "未配置行为"
        );
    }

    fn reassemble_frame(chunks: &[[u8; OUTPUT_REPORT_LEN]]) -> [u8; FRAME_BYTES] {
        assert_eq!(chunks.len(), 10);
        assert_eq!(chunks[0][3], CHUNK_FLAG_CLEAR_STAGING);
        assert_eq!(chunks[9][3], CHUNK_FLAG_COMMIT);
        let mut fb = [0u8; FRAME_BYTES];
        for pkt in chunks {
            assert_eq!(pkt[1], OP_FRAME_CHUNK);
            let off = u16::from_le_bytes([pkt[4], pkt[5]]) as usize;
            let len = pkt[6] as usize;
            fb[off..off + len].copy_from_slice(&pkt[7..7 + len]);
        }
        fb
    }

    fn wait_packets(
        controller: &DisplayController,
        expected: usize,
    ) -> Vec<[u8; OUTPUT_REPORT_LEN]> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut state = controller.shared.0.lock().unwrap();
            if state.outbox.len() >= expected {
                return state.outbox.drain(..).collect();
            }
            drop(state);
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {expected} OLED packets"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn display_worker_enqueues_lease_idle_toast_supersede_and_toast_expiry_non_blockingly() {
        let controller = DisplayController::start_worker(
            "Kivo K18 Lite".into(),
            "默认配置".into(),
            DeviceDisplaySettings::default(),
            Duration::from_millis(60),
            Duration::from_secs(1),
        );

        // Initial lease packet (default brightness=100, power_save=0) + 10 frame chunks for Idle screen.
        let initial = wait_packets(&controller, 11);
        assert_eq!(&initial[0][..6], &[0x02, OP_CONTROL_LEASE, 1, 5, 100, 0]);
        assert_eq!(
            reassemble_frame(&initial[1..]),
            font::render_two_lines_128x32("Kivo K18 Lite", "默认配置")
        );

        // Superseding toast replaces unsent frame chunks and then reverts to Idle after expiry.
        controller.show_key_toast("K01 按住".into(), "Ctrl".into());
        controller.show_key_toast("K03 按住".into(), "Ctrl+Cmd+A".into());
        let toast_packets = wait_packets(&controller, 10);
        assert_eq!(
            reassemble_frame(&toast_packets),
            font::render_two_lines_128x32("K03 按住", "Ctrl+Cmd+A")
        );

        // Wait for 60ms toast to expire and restore Idle frame automatically.
        let restored = wait_packets(&controller, 10);
        assert_eq!(
            reassemble_frame(&restored),
            font::render_two_lines_128x32("Kivo K18 Lite", "默认配置")
        );
    }

    #[test]
    fn display_controller_applies_brightness_idle_sleep_activity_wake_and_toast_gating() {
        let _ = font::render_two_lines_128x32("Kivo K18 Lite", "默认");
        let controller = DisplayController::start_worker(
            "Kivo K18 Lite".into(),
            "默认".into(),
            DeviceDisplaySettings {
                brightness: 80,
                sleep_timeout_sec: 4,
                show_key_toast: false,
                show_profile_toast: true,
            },
            Duration::from_millis(200),
            Duration::from_millis(35),
        );

        let initial = wait_packets(&controller, 11);
        assert_eq!(&initial[0][..6], &[0x02, OP_CONTROL_LEASE, 1, 5, 80, 0]);

        // Live brightness update (including 0) sends immediate CONTROL_LEASE and supersedes stale unsent lease.
        controller.set_settings(DeviceDisplaySettings {
            brightness: 45,
            sleep_timeout_sec: 4,
            show_key_toast: false,
            show_profile_toast: true,
        });
        controller.set_settings(DeviceDisplaySettings {
            brightness: 0,
            sleep_timeout_sec: 4,
            show_key_toast: false,
            show_profile_toast: true,
        });
        let brightness_pkts = wait_packets(&controller, 1);
        assert_eq!(brightness_pkts.len(), 1);
        assert_eq!(
            &brightness_pkts[0][..6],
            &[0x02, OP_CONTROL_LEASE, 1, 5, 0, 0]
        );

        // Toast gating: key toast is suppressed when show_key_toast=false, profile toast is shown.
        controller.show_key_toast("K01 单击".into(), "Ctrl".into());
        thread::sleep(Duration::from_millis(20));
        assert!(controller.drain_queued_packets_for_test().is_empty());

        controller.show_profile_toast("切换配置".into(), "悬浮终端".into());
        let profile_toast = wait_packets(&controller, 10);
        assert_eq!(
            reassemble_frame(&profile_toast),
            font::render_two_lines_128x32("切换配置", "悬浮终端")
        );

        // Turning off show_profile_toast while profile toast is active immediately restores Idle.
        controller.set_settings(DeviceDisplaySettings {
            brightness: 65,
            sleep_timeout_sec: 4,
            show_key_toast: true,
            show_profile_toast: false,
        });
        let cleared = wait_packets(&controller, 11);
        assert_eq!(&cleared[0][..6], &[0x02, OP_CONTROL_LEASE, 1, 5, 65, 0]);
        assert_eq!(
            reassemble_frame(&cleared[1..]),
            font::render_two_lines_128x32("Kivo K18 Lite", "默认")
        );

        controller.show_profile_toast("切换配置".into(), "游戏".into());
        thread::sleep(Duration::from_millis(20));
        assert!(controller.drain_queued_packets_for_test().is_empty());

        // Idle timeout (4 * 35ms = 140ms) enters sleep (`power_save = 1`).
        let sleep_pkt = wait_packets(&controller, 1);
        assert_eq!(&sleep_pkt[0][..6], &[0x02, OP_CONTROL_LEASE, 1, 5, 65, 1]);

        // Physical key activity (`record_activity`) wakes immediately (`power_save = 0`) and restores visible frame.
        controller.record_activity();
        let wake_pkts = wait_packets(&controller, 11);
        assert_eq!(&wake_pkts[0][..6], &[0x02, OP_CONTROL_LEASE, 1, 5, 65, 0]);
        assert_eq!(
            reassemble_frame(&wake_pkts[1..]),
            font::render_two_lines_128x32("Kivo K18 Lite", "默认")
        );

        // Let it sleep again, then verify setting `sleep_timeout_sec = 0` wakes immediately and never re-sleeps.
        let sleep_again = wait_packets(&controller, 1);
        assert_eq!(&sleep_again[0][..6], &[0x02, OP_CONTROL_LEASE, 1, 5, 65, 1]);

        controller.set_settings(DeviceDisplaySettings {
            brightness: 65,
            sleep_timeout_sec: 0,
            show_key_toast: true,
            show_profile_toast: false,
        });
        let wake_never = wait_packets(&controller, 11);
        assert_eq!(&wake_never[0][..6], &[0x02, OP_CONTROL_LEASE, 1, 5, 65, 0]);
        assert_eq!(
            reassemble_frame(&wake_never[1..]),
            font::render_two_lines_128x32("Kivo K18 Lite", "默认")
        );

        thread::sleep(Duration::from_millis(160));
        assert!(
            controller.drain_queued_packets_for_test().is_empty(),
            "sleep_timeout_sec = 0 must never enter idle sleep"
        );
    }
}
