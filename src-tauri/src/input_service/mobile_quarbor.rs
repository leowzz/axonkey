#![cfg_attr(test, allow(dead_code))]
//! Hardware-grade virtual HID output routing for Axonkey Mobile on Windows.
//!
//! Priority order (zero-reinstall first):
//! 1. **In-process shared Quarbor channel**: If `axonkey.exe` already owns a live
//!    `ManagedQuarborChannel` (for example, a paired Xiaomi RC003 / CMIOT A15 remote
//!    whose `QuarborUniversalKeyboardDriver` output device is already online in Windows),
//!    `Axonkey Mobile` routes `KeySend` / `MouseMove` / `ResetInput` directly through
//!    that existing channel with zero driver installation and zero UAC prompts.
//! 2. **Direct Quarbor pipe connection**: If no `ManagedQuarborChannel` is currently
//!    claiming the pipe (e.g., physical remote instance disabled/unbound, or standalone
//!    `ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE` installed on a remote-free PC),
//!    connects directly via `windows_quarbor::Client`.
//! 3. **`SendInput` fallback**: Used transparently whenever no Quarbor Universal Keyboard
//!    driver node is installed on the machine yet.

use super::{
    cursor_delta, remote_actions::HidKey, windows::behavior_hid_chord, windows_quarbor::Client,
    MouseButton, NativeBehavior, WheelDirection,
};
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) const MOBILE_VHID_INSTANCE_ID: &str =
    r"ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE";

const PUMP_POLL_INTERVAL: Duration = Duration::from_millis(10);
const RECONNECT_BACKOFF: Duration = Duration::from_millis(800);
const HANDSHAKE_BUDGET: Duration = Duration::from_millis(180);
const SHARED_CMD_TIMEOUT: Duration = Duration::from_millis(120);

pub(super) enum SharedOutputCommand {
    KeyEdge {
        keys: Vec<HidKey>,
        down: bool,
    },
    KeyTap {
        keys: Vec<HidKey>,
    },
    MouseMove {
        dx: i32,
        dy: i32,
        wheel: i32,
        pan: i32,
    },
    ResetAll,
}

struct SharedChannelSlot {
    id: u64,
    ready: AtomicBool,
    has_work: AtomicBool,
    queue: Mutex<VecDeque<(SharedOutputCommand, SyncSender<bool>)>>,
}

pub(super) struct SharedChannelRegistration {
    slot: Arc<SharedChannelSlot>,
    held_by_mobile: HashSet<HidKey>,
}

static SHARED_CHANNELS: OnceLock<Mutex<Vec<Arc<SharedChannelSlot>>>> = OnceLock::new();
static NEXT_CHANNEL_ID: AtomicU64 = AtomicU64::new(1);

fn shared_channels() -> &'static Mutex<Vec<Arc<SharedChannelSlot>>> {
    SHARED_CHANNELS.get_or_init(|| Mutex::new(Vec::new()))
}

pub(super) fn register_shared_channel() -> SharedChannelRegistration {
    let slot = Arc::new(SharedChannelSlot {
        id: NEXT_CHANNEL_ID.fetch_add(1, Ordering::Relaxed),
        ready: AtomicBool::new(false),
        has_work: AtomicBool::new(false),
        queue: Mutex::new(VecDeque::new()),
    });
    if let Ok(mut list) = shared_channels().lock() {
        list.push(Arc::clone(&slot));
    }
    SharedChannelRegistration {
        slot,
        held_by_mobile: HashSet::new(),
    }
}

impl SharedChannelRegistration {
    pub(super) fn has_pending(&self) -> bool {
        self.slot.has_work.load(Ordering::Acquire)
    }

    pub(super) fn pump(&mut self, reader: &mut Option<Client>) {
        let is_ready = reader.as_ref().is_some_and(|c| c.ready());
        self.slot.ready.store(is_ready, Ordering::Release);
        if !self.slot.has_work.load(Ordering::Acquire) {
            if !is_ready {
                self.held_by_mobile.clear();
            }
            return;
        }
        let mut drained = Vec::new();
        if let Ok(mut q) = self.slot.queue.lock() {
            drained.extend(q.drain(..));
            self.slot.has_work.store(false, Ordering::Release);
        }
        for (cmd, reply) in drained {
            let Some(client) = reader.as_mut().filter(|c| c.ready()) else {
                self.held_by_mobile.clear();
                self.slot.ready.store(false, Ordering::Release);
                let _ = reply.send(false);
                continue;
            };
            let outcome = execute_on_shared_client(client, &mut self.held_by_mobile, cmd);
            match outcome {
                Ok(handled) => {
                    let _ = client.poll();
                    let _ = reply.send(handled);
                }
                Err(err) => {
                    log::warn!(
                        target: "axonkey::mobile",
                        "Shared Quarbor output failed on channel {}: {err}",
                        self.slot.id
                    );
                    self.held_by_mobile.clear();
                    self.slot.ready.store(false, Ordering::Release);
                    *reader = None;
                    let _ = reply.send(false);
                }
            }
        }
    }

    pub(super) fn unregister(&mut self, reader: &mut Option<Client>) {
        self.slot.ready.store(false, Ordering::Release);
        if !self.held_by_mobile.is_empty() {
            if let Some(client) = reader.as_mut().filter(|c| c.ready()) {
                for hid in self.held_by_mobile.drain() {
                    let _ = client.send_key(hid.page, hid.usage, false);
                }
                let _ = client.poll();
            } else {
                self.held_by_mobile.clear();
            }
        }
        if let Ok(mut q) = self.slot.queue.lock() {
            for (_, reply) in q.drain(..) {
                let _ = reply.send(false);
            }
            self.slot.has_work.store(false, Ordering::Release);
        }
        if let Ok(mut list) = shared_channels().lock() {
            list.retain(|item| item.id != self.slot.id);
        }
    }
}

fn execute_on_shared_client(
    client: &mut Client,
    held_by_mobile: &mut HashSet<HidKey>,
    cmd: SharedOutputCommand,
) -> std::io::Result<bool> {
    match cmd {
        SharedOutputCommand::KeyEdge { keys, down } => {
            if down {
                if !keys.iter().all(|k| client.supports_key(k.page, k.usage)) {
                    return Ok(false);
                }
                for hid in keys {
                    if held_by_mobile.insert(hid) {
                        client.send_key(hid.page, hid.usage, true)?;
                    }
                }
                Ok(true)
            } else {
                for hid in keys.into_iter().rev() {
                    if held_by_mobile.remove(&hid) {
                        client.send_key(hid.page, hid.usage, false)?;
                    }
                }
                Ok(true)
            }
        }
        SharedOutputCommand::KeyTap { keys } => {
            if keys.is_empty() || !keys.iter().all(|k| client.supports_key(k.page, k.usage)) {
                return Ok(false);
            }
            if keys.len() == 1 {
                client.tap_key(keys[0].page, keys[0].usage)?;
            } else {
                for k in &keys {
                    client.send_key(k.page, k.usage, true)?;
                }
                for k in keys.iter().rev() {
                    client.send_key(k.page, k.usage, false)?;
                }
            }
            Ok(true)
        }
        SharedOutputCommand::MouseMove { dx, dy, wheel, pan } => {
            if !client.supports_mouse_move() {
                return Ok(false);
            }
            send_chunked_mouse_move(client, dx, dy, wheel, pan)?;
            Ok(true)
        }
        SharedOutputCommand::ResetAll => {
            for hid in held_by_mobile.drain() {
                client.send_key(hid.page, hid.usage, false)?;
            }
            Ok(true)
        }
    }
}

pub(crate) fn has_shared_channel_ready() -> bool {
    shared_channels()
        .lock()
        .ok()
        .is_some_and(|list| list.iter().any(|slot| slot.ready.load(Ordering::Acquire)))
}

fn dispatch_to_shared_channel(
    target_id: Option<u64>,
    cmd: SharedOutputCommand,
) -> Option<(u64, bool)> {
    let slot = {
        let guard = shared_channels().lock().ok()?;
        match target_id {
            Some(id) => guard
                .iter()
                .find(|s| s.id == id && s.ready.load(Ordering::Acquire))
                .cloned(),
            None => guard
                .iter()
                .find(|s| s.ready.load(Ordering::Acquire))
                .cloned(),
        }?
    };
    let id = slot.id;
    let (tx, rx) = sync_channel(1);
    {
        let mut q = slot.queue.lock().ok()?;
        q.push_back((cmd, tx));
        slot.has_work.store(true, Ordering::Release);
    }
    match rx.recv_timeout(SHARED_CMD_TIMEOUT) {
        Ok(handled) => Some((id, handled)),
        Err(_) => Some((id, false)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeldRoute {
    Shared(u64),
    Direct,
}

struct DirectChannelState {
    client: Option<Client>,
    last_connect_attempt: Option<Instant>,
}

impl Default for DirectChannelState {
    fn default() -> Self {
        Self {
            client: None,
            last_connect_attempt: None,
        }
    }
}

struct MobileQuarborHub {
    direct: Mutex<DirectChannelState>,
    held_routes: Mutex<Vec<(HidKey, HeldRoute)>>,
    paused: AtomicBool,
    connect_enabled: AtomicBool,
    direct_connected: AtomicBool,
}

static HUB: OnceLock<MobileQuarborHub> = OnceLock::new();

fn hub() -> &'static MobileQuarborHub {
    HUB.get_or_init(|| {
        let hub = MobileQuarborHub {
            direct: Mutex::new(DirectChannelState::default()),
            held_routes: Mutex::new(Vec::new()),
            paused: AtomicBool::new(false),
            connect_enabled: AtomicBool::new(false),
            direct_connected: AtomicBool::new(false),
        };
        let _ = thread::Builder::new()
            .name("axonkey-mobile-quarbor".into())
            .spawn(pump_worker);
        hub
    })
}

fn pump_worker() {
    loop {
        let h = hub();
        if h.paused.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(50));
            continue;
        }
        // If an in-process ManagedQuarborChannel is already serving output, we don't even need a second pipe!
        if has_shared_channel_ready() {
            thread::sleep(Duration::from_millis(120));
            continue;
        }
        let mut sleep_dur = Duration::from_millis(120);
        if let Ok(mut guard) = h.direct.lock() {
            if guard.client.is_some() {
                drain_direct_client(&mut guard, &h.direct_connected);
                if guard.client.is_some() {
                    sleep_dur = PUMP_POLL_INTERVAL;
                }
            } else if h.connect_enabled.load(Ordering::Acquire) {
                let can_try = guard
                    .last_connect_attempt
                    .is_none_or(|last| last.elapsed() >= RECONNECT_BACKOFF);
                if can_try {
                    try_connect_direct_locked(&mut guard, &h.direct_connected);
                    sleep_dur = if guard.client.is_some() {
                        PUMP_POLL_INTERVAL
                    } else {
                        Duration::from_millis(300)
                    };
                }
            }
        }
        thread::sleep(sleep_dur);
    }
}

fn drop_direct_locked(state: &mut DirectChannelState, connected_flag: &AtomicBool) {
    state.client = None;
    connected_flag.store(false, Ordering::Release);
}

fn drain_direct_client(state: &mut DirectChannelState, connected_flag: &AtomicBool) {
    for _ in 0..32 {
        let Some(client) = state.client.as_mut() else {
            connected_flag.store(false, Ordering::Release);
            return;
        };
        match client.poll() {
            Ok(Some(_)) => {
                connected_flag.store(client.ready(), Ordering::Release);
            }
            Ok(None) => {
                connected_flag.store(client.ready(), Ordering::Release);
                return;
            }
            Err(err) => {
                log::debug!(
                    target: "axonkey::mobile",
                    "Mobile direct Quarbor pipe disconnected: {err}"
                );
                drop_direct_locked(state, connected_flag);
                return;
            }
        }
    }
}

fn candidate_direct_instance_ids() -> Vec<String> {
    let mut ids = vec![MOBILE_VHID_INSTANCE_ID.to_string()];
    if let Ok(devices) = crate::windows_driver_devices::list_present() {
        for dev in devices {
            if dev.present
                && dev.bound
                && !ids
                    .iter()
                    .any(|existing| existing.eq_ignore_ascii_case(&dev.instance_id))
            {
                ids.push(dev.instance_id);
            }
        }
    }
    ids
}

fn try_connect_direct_locked(state: &mut DirectChannelState, connected_flag: &AtomicBool) {
    state.last_connect_attempt = Some(Instant::now());
    for instance_id in candidate_direct_instance_ids() {
        let Ok(mut client) = Client::connect(&instance_id) else {
            continue;
        };
        let deadline = Instant::now() + HANDSHAKE_BUDGET;
        let mut failed = false;
        while !client.ready() && Instant::now() < deadline {
            match client.poll() {
                Ok(Some(_)) => {
                    if client.ready() {
                        break;
                    }
                }
                Ok(None) => thread::sleep(Duration::from_millis(2)),
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        if !failed && client.ready() {
            let _ = client.reset_input();
            let _ = client.poll();
            connected_flag.store(true, Ordering::Release);
            log::info!(
                target: "axonkey::mobile",
                "Mobile direct Quarbor output ready: {instance_id}"
            );
            state.client = Some(client);
            return;
        }
    }
    connected_flag.store(false, Ordering::Release);
}

fn with_direct_client<R>(f: impl FnOnce(&mut Client) -> std::io::Result<R>) -> Option<R> {
    let h = hub();
    if h.paused.load(Ordering::Acquire) {
        return None;
    }
    let mut guard = h.direct.lock().unwrap_or_else(|e| e.into_inner());
    if guard.client.is_none() && h.connect_enabled.load(Ordering::Acquire) {
        let can_try = guard
            .last_connect_attempt
            .is_none_or(|last| last.elapsed() >= RECONNECT_BACKOFF);
        if can_try {
            try_connect_direct_locked(&mut guard, &h.direct_connected);
        }
    }
    drain_direct_client(&mut guard, &h.direct_connected);
    let c = guard.client.as_mut().filter(|c| c.ready())?;
    match f(c) {
        Ok(val) => {
            let _ = c.poll();
            Some(val)
        }
        Err(err) => {
            log::warn!(
                target: "axonkey::mobile",
                "Mobile direct Quarbor command failed, falling back: {err}"
            );
            drop_direct_locked(&mut guard, &h.direct_connected);
            None
        }
    }
}

pub(crate) fn set_connect_enabled(enabled: bool) {
    let h = hub();
    let prev = h.connect_enabled.swap(enabled, Ordering::AcqRel);
    if enabled && !prev && !h.paused.load(Ordering::Acquire) {
        if let Ok(mut guard) = h.direct.lock() {
            guard.last_connect_attempt = None;
        }
    }
}

pub(crate) fn is_connected() -> bool {
    has_shared_channel_ready() || hub().direct_connected.load(Ordering::Acquire)
}

pub(crate) fn pause() {
    let h = hub();
    h.paused.store(true, Ordering::Release);
    if let Ok(mut routes) = h.held_routes.lock() {
        routes.clear();
    }
    if let Ok(mut guard) = h.direct.lock() {
        if let Some(client) = guard.client.as_mut().filter(|c| c.ready()) {
            let _ = client.reset_input();
            let _ = client.finish_pending(Duration::from_millis(40));
        }
        drop_direct_locked(&mut guard, &h.direct_connected);
    }
}

pub(crate) fn resume() {
    let h = hub();
    if let Ok(mut guard) = h.direct.lock() {
        guard.last_connect_attempt = None;
    }
    h.paused.store(false, Ordering::Release);
}

pub(crate) fn reset_all_inputs() {
    let h = hub();
    if let Ok(mut routes) = h.held_routes.lock() {
        routes.clear();
    }
    let _ = dispatch_to_shared_channel(None, SharedOutputCommand::ResetAll);
    let _ = with_direct_client(|client| client.reset_input().map(|_| ()));
}

fn mouse_button_hid_key(button: MouseButton) -> Option<HidKey> {
    let usage = match button {
        MouseButton::Left => 1,
        MouseButton::Right => 2,
        MouseButton::Middle => 3,
        MouseButton::Back | MouseButton::Forward => return None,
    };
    Some(HidKey { page: 0x09, usage })
}

fn driver_wheel_steps(direction: WheelDirection) -> (i32, i32) {
    match direction {
        WheelDirection::Up => (1, 0),
        WheelDirection::Down => (-1, 0),
        WheelDirection::Left => (0, -1),
        WheelDirection::Right => (0, 1),
    }
}

fn clamp_motion_steps(value: i32) -> impl Iterator<Item = i32> {
    let mut remaining = value;
    std::iter::from_fn(move || {
        if remaining == 0 {
            return None;
        }
        let step = remaining.clamp(-127, 127);
        remaining -= step;
        Some(step)
    })
}

fn send_chunked_mouse_move(
    client: &mut Client,
    dx: i32,
    dy: i32,
    wheel: i32,
    pan: i32,
) -> std::io::Result<()> {
    let mut xs = clamp_motion_steps(dx);
    let mut ys = clamp_motion_steps(dy);
    let mut ws = clamp_motion_steps(wheel);
    let mut ps = clamp_motion_steps(pan);
    loop {
        let step = (
            xs.next().unwrap_or(0),
            ys.next().unwrap_or(0),
            ws.next().unwrap_or(0),
            ps.next().unwrap_or(0),
        );
        if step == (0, 0, 0, 0) {
            return Ok(());
        }
        client.move_mouse(step.0, step.1, step.2, step.3)?;
    }
}

fn send_chord_edge(chord: Vec<HidKey>, down: bool) -> bool {
    let h = hub();
    if !down {
        let mut matched_route: Option<HeldRoute> = None;
        if let Ok(mut routes) = h.held_routes.lock() {
            for k in &chord {
                if let Some(pos) = routes.iter().position(|(hk, _)| hk == k) {
                    let (_, route) = routes.remove(pos);
                    matched_route.get_or_insert(route);
                }
            }
        }
        let Some(route) = matched_route else {
            return false;
        };
        return match route {
            HeldRoute::Shared(chan_id) => {
                let _ = dispatch_to_shared_channel(
                    Some(chan_id),
                    SharedOutputCommand::KeyEdge {
                        keys: chord,
                        down: false,
                    },
                );
                true
            }
            HeldRoute::Direct => {
                let _ = with_direct_client(|client| {
                    for hid in chord.iter().rev() {
                        client.send_key(hid.page, hid.usage, false)?;
                    }
                    Ok(())
                });
                true
            }
        };
    }

    // 1. Try existing in-process ManagedQuarborChannel first (zero reinstall!)
    if let Some((chan_id, true)) = dispatch_to_shared_channel(
        None,
        SharedOutputCommand::KeyEdge {
            keys: chord.clone(),
            down: true,
        },
    ) {
        if let Ok(mut routes) = h.held_routes.lock() {
            for k in chord {
                if !routes.iter().any(|(hk, _)| *hk == k) {
                    routes.push((k, HeldRoute::Shared(chan_id)));
                }
            }
        }
        return true;
    }

    // 2. Try standalone direct Quarbor pipe
    let direct_ok = with_direct_client(|client| {
        if !chord.iter().all(|k| client.supports_key(k.page, k.usage)) {
            return Ok(false);
        }
        for hid in &chord {
            client.send_key(hid.page, hid.usage, true)?;
        }
        Ok(true)
    })
    .unwrap_or(false);

    if direct_ok {
        if let Ok(mut routes) = h.held_routes.lock() {
            for k in chord {
                if !routes.iter().any(|(hk, _)| *hk == k) {
                    routes.push((k, HeldRoute::Direct));
                }
            }
        }
    }
    direct_ok
}

pub(super) fn try_key_edge(key: &str, down: bool) -> Result<bool, String> {
    let behavior = NativeBehavior::Key {
        enabled: true,
        key: key.to_owned(),
    };
    let Some(chord) = behavior_hid_chord(&behavior) else {
        return Ok(false);
    };
    Ok(send_chord_edge(chord, down))
}

pub(super) fn try_mouse_button_edge(button: MouseButton, down: bool) -> Result<bool, String> {
    let Some(hid) = mouse_button_hid_key(button) else {
        return Ok(false);
    };
    Ok(send_chord_edge(vec![hid], down))
}

pub(super) fn try_relative_motion(dx: i32, dy: i32) -> bool {
    if dx == 0 && dy == 0 {
        return true;
    }
    if let Some((_, true)) = dispatch_to_shared_channel(
        None,
        SharedOutputCommand::MouseMove {
            dx,
            dy,
            wheel: 0,
            pan: 0,
        },
    ) {
        return true;
    }
    with_direct_client(|client| {
        if !client.supports_mouse_move() {
            return Ok(false);
        }
        send_chunked_mouse_move(client, dx, dy, 0, 0)?;
        Ok(true)
    })
    .unwrap_or(false)
}

fn try_tap_chord(chord: Vec<HidKey>) -> bool {
    if chord.is_empty() {
        return false;
    }
    if let Some((_, true)) = dispatch_to_shared_channel(
        None,
        SharedOutputCommand::KeyTap {
            keys: chord.clone(),
        },
    ) {
        return true;
    }
    with_direct_client(|client| {
        if !chord.iter().all(|k| client.supports_key(k.page, k.usage)) {
            return Ok(false);
        }
        if chord.len() == 1 {
            client.tap_key(chord[0].page, chord[0].usage)?;
        } else {
            for k in &chord {
                client.send_key(k.page, k.usage, true)?;
            }
            for k in chord.iter().rev() {
                client.send_key(k.page, k.usage, false)?;
            }
        }
        Ok(true)
    })
    .unwrap_or(false)
}

pub(super) fn try_execute_behavior(behavior: &NativeBehavior) -> bool {
    match behavior {
        NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. } => {
            let Some(chord) = behavior_hid_chord(behavior) else {
                return false;
            };
            try_tap_chord(chord)
        }
        NativeBehavior::Mouse { button, .. } => {
            let Some(hid) = mouse_button_hid_key(*button) else {
                return false;
            };
            try_tap_chord(vec![hid])
        }
        NativeBehavior::CursorMove {
            direction,
            distance,
            ..
        } => {
            let (dx, dy) = cursor_delta(*direction, *distance);
            try_relative_motion(dx, dy)
        }
        NativeBehavior::Wheel { direction, .. } => {
            let (wheel, pan) = driver_wheel_steps(*direction);
            if let Some((_, true)) = dispatch_to_shared_channel(
                None,
                SharedOutputCommand::MouseMove {
                    dx: 0,
                    dy: 0,
                    wheel,
                    pan,
                },
            ) {
                return true;
            }
            with_direct_client(|client| {
                if !client.supports_mouse_move() {
                    return Ok(false);
                }
                send_chunked_mouse_move(client, 0, 0, wheel, pan)?;
                Ok(true)
            })
            .unwrap_or(false)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_doubao_left_and_right_alt_and_shortcuts_to_hid_usages() {
        let alt = behavior_hid_chord(&NativeBehavior::Key {
            enabled: true,
            key: "Alt".into(),
        })
        .expect("Alt HID chord");
        assert_eq!(
            alt,
            vec![HidKey {
                page: 0x07,
                usage: 0xE2
            }]
        );

        let ralt = behavior_hid_chord(&NativeBehavior::Key {
            enabled: true,
            key: "RAlt".into(),
        })
        .expect("RAlt HID chord");
        assert_eq!(
            ralt,
            vec![HidKey {
                page: 0x07,
                usage: 0xE6
            }]
        );
    }

    #[test]
    fn chunks_large_relative_motion_into_hid_i8_range() {
        let pos: Vec<i32> = clamp_motion_steps(300).collect();
        assert_eq!(pos, vec![127, 127, 46]);

        let neg: Vec<i32> = clamp_motion_steps(-260).collect();
        assert_eq!(neg, vec![-127, -127, -6]);
    }
}
