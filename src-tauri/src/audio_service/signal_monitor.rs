//! Bounded numeric telemetry; no audio payloads or device identifiers.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};

const HISTORY_MS: u64 = 600_000;
const FRESH_MS: u64 = 2_000;
const MAX_POINTS: usize = 3_100;

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Must match AKMonitorSnapshot. Counters survive native queue resets.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct NativeMonitorSnapshot {
    pub uptime_ms: u64,
    pub packets: u64,
    pub session: u64,
    pub streaming: u64,
    pub queued: u64,
    pub peak: u64,
    pub capacity: u64,
    pub underruns: u64,
    pub emptied: u64,
    pub full: u64,
    pub resets: u64,
    pub discarded: u64,
    pub draining: u64,
    pub running: u64,
}
#[derive(Clone, Serialize)]
struct SignalSample {
    t: u64,
    rssi: i32,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioSample {
    t: u64,
    pps: Option<f64>,
    underruns: u64,
    session_id: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueSample {
    t: u64,
    samples: u64,
    peak_samples: u64,
    capacity: u64,
    queued_ms: f64,
    peak_ms: f64,
    capacity_ms: f64,
    emptied: u64,
    full: u64,
    resets: u64,
    discarded: u64,
    underruns: u64,
    state: &'static str,
}
#[derive(Default)]
pub(super) struct SignalMonitor {
    pub generation: u64,
    last_poll: Option<u64>,
    started_at: u64,
    signals: VecDeque<SignalSample>,
    audio: VecDeque<AudioSample>,
    queue: VecDeque<QueueSample>,
    last_signal: Option<u64>,
    last_audio: Option<u64>,
    signal_error: bool,
    streaming: bool,
    previous: Option<NativeMonitorSnapshot>,
    rates: VecDeque<(u64, u64)>,
}
impl SignalMonitor {
    fn active(&self, now: u64) -> bool {
        self.last_poll
            .is_some_and(|t| now.saturating_sub(t) <= FRESH_MS)
    }
    pub fn poll(&mut self, now: u64) {
        if !self.active(now) {
            self.clear();
            self.started_at = now;
        }
        self.last_poll = Some(now);
        self.prune(now);
    }
    pub fn clear(&mut self) {
        *self = Self {
            streaming: self.streaming,
            generation: self.generation.wrapping_add(1),
            ..Self::default()
        };
    }
    pub fn disconnected(&mut self) {
        self.last_signal = None;
        self.signal_error = false;
        self.session(false);
    }
    pub fn session(&mut self, streaming: bool) {
        self.streaming = streaming;
        self.last_audio = None;
        self.rates.clear();
    }
    pub fn rssi(&mut self, now: u64, rssi: i32, failed: bool) {
        if !self.active(now) {
            return;
        }
        self.signal_error = failed || !(-127..=20).contains(&rssi);
        if self.signal_error {
            return;
        }
        self.signals.push_back(SignalSample { t: now, rssi });
        self.last_signal = Some(now);
        self.prune(now);
    }
    pub fn observe(&mut self, now: u64, s: NativeMonitorSnapshot) {
        if !self.active(now) {
            return;
        }
        // Bound sampling independently of callers; a second window cannot inflate history.
        if self
            .previous
            .is_some_and(|p| s.uptime_ms.saturating_sub(p.uptime_ms) < 150)
        {
            return;
        }
        let prev = self.previous.unwrap_or(s);
        if s.session != prev.session
            || s.streaming != prev.streaming
            || s.uptime_ms < prev.uptime_ms
            || s.packets < prev.packets
        {
            self.rates.clear();
        }
        self.streaming = s.streaming != 0;
        let mut pps = None;
        if self.streaming {
            self.rates.push_back((s.uptime_ms, s.packets));
            // Keep the closest baseline at or before one second ago, using actual elapsed time.
            while self.rates.len() > 2 && self.rates[1].0 <= s.uptime_ms.saturating_sub(1000) {
                self.rates.pop_front();
            }
            if let Some(&(time, packets)) = self.rates.front() {
                let elapsed = s.uptime_ms.saturating_sub(time);
                if (150..=2000).contains(&elapsed) {
                    pps = Some(s.packets.saturating_sub(packets) as f64 * 1000.0 / elapsed as f64);
                } else if elapsed > 2000 {
                    self.rates.clear();
                    self.rates.push_back((s.uptime_ms, s.packets));
                }
            }
        } else {
            self.rates.clear();
        }
        self.last_audio = pps.map(|_| now);
        let underruns = s.underruns.saturating_sub(prev.underruns);
        self.audio.push_back(AudioSample {
            t: now,
            pps,
            underruns,
            session_id: s.session,
        });
        self.queue.push_back(QueueSample {
            t: now,
            samples: s.queued,
            peak_samples: s.peak.max(s.queued),
            capacity: s.capacity,
            queued_ms: s.queued as f64 / 16.0,
            peak_ms: s.peak.max(s.queued) as f64 / 16.0,
            capacity_ms: s.capacity as f64 / 16.0,
            emptied: s.emptied.saturating_sub(prev.emptied),
            full: s.full.saturating_sub(prev.full),
            resets: s.resets.saturating_sub(prev.resets),
            discarded: s.discarded.saturating_sub(prev.discarded),
            underruns,
            state: if s.queued == 0 {
                "empty"
            } else if s.draining != 0 {
                "draining"
            } else if s.running == 0 {
                "paused"
            } else {
                "buffered"
            },
        });
        self.previous = Some(s);
        self.prune(now);
    }
    fn prune(&mut self, now: u64) {
        macro_rules! prune {
            ($series:ident) => {
                while self
                    .$series
                    .front()
                    .is_some_and(|p| now.saturating_sub(p.t) > HISTORY_MS)
                    || self.$series.len() > MAX_POINTS
                {
                    self.$series.pop_front();
                }
            };
        }
        prune!(signals);
        prune!(audio);
        prune!(queue);
    }
    pub fn snapshot(&self, now: u64, connected: bool, after: Option<u64>) -> Value {
        let status = if !connected {
            "waiting"
        } else if self.signal_error {
            "error"
        } else if self
            .last_signal
            .is_some_and(|t| now.saturating_sub(t) <= FRESH_MS)
        {
            "live"
        } else if self.last_signal.is_some() {
            "stale"
        } else {
            "waiting"
        };
        let audio_status = if !connected || !self.streaming {
            "idle"
        } else if self
            .last_audio
            .is_some_and(|t| now.saturating_sub(t) <= FRESH_MS)
        {
            "live"
        } else if self.last_audio.is_some() {
            "stale"
        } else {
            "waiting"
        };
        // Incremental responses keep 5 Hz polling inexpensive even after ten minutes.
        let cutoff = after.filter(|t| *t >= self.started_at).unwrap_or(0);
        json!({
            "now": now, "startedAt": self.started_at, "generation": self.generation, "intervalMs": 200,
            "bluetooth": { "status": status, "lastSampleAt": self.last_signal,
                "message": if !connected { "遥控器未连接，请先连接或按键唤醒。" } else if self.signal_error { "暂时无法读取蓝牙信号，正在重试。" } else { "等待新的信号读数。" },
                "samples": self.signals.iter().filter(|p| p.t > cutoff).collect::<Vec<_>>() },
            "audio": { "status": audio_status, "lastSampleAt": self.last_audio,
                "message": if !self.streaming { "等待按住语音键。" } else { "等待新的收包统计。" },
                "samples": self.audio.iter().filter(|p| p.t > cutoff).collect::<Vec<_>>() },
            "queue": { "status": if self.previous.is_some() && self.active(now) { "live" } else { "waiting" },
                "samples": self.queue.iter().filter(|p| p.t > cutoff).collect::<Vec<_>>() }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(t: u64, packets: u64) -> NativeMonitorSnapshot {
        NativeMonitorSnapshot {
            uptime_ms: t,
            packets,
            session: 1,
            streaming: 1,
            capacity: 4096,
            running: 1,
            ..Default::default()
        }
    }
    #[test]
    fn rolling_rate_uses_monotonic_elapsed_and_stops_at_session_boundaries() {
        let mut m = SignalMonitor::default();
        m.poll(1000);
        for i in 0..=5 {
            m.observe(1000 + i * 200, sample(1000 + i * 200, i * 10));
        }
        assert_eq!(m.audio.back().unwrap().pps, Some(50.0));
        m.session(false);
        let mut s = sample(2200, 50);
        s.streaming = 0;
        m.observe(2200, s);
        assert_eq!(m.audio.back().unwrap().pps, None);
        m.session(true);
        m.observe(2400, sample(2400, 55));
        assert_eq!(m.audio.back().unwrap().pps, None);
        // A wall-clock change does not change the measured rate.
        m.poll(9000);
        m.observe(9000, sample(2600, 65));
        m.observe(9200, sample(2800, 75));
        assert_eq!(m.audio.back().unwrap().pps, Some(50.0));
    }
    #[test]
    fn transient_full_empty_and_reset_events_survive_between_polls() {
        let mut m = SignalMonitor::default();
        m.poll(1000);
        m.observe(1000, sample(1000, 0));
        let mut s = sample(1200, 10);
        s.peak = 4096;
        s.queued = 0;
        s.emptied = 3;
        s.full = 2;
        s.resets = 1;
        s.discarded = 240;
        s.underruns = 2;
        m.observe(1200, s);
        let q = m.queue.back().unwrap();
        assert_eq!(
            (
                q.peak_ms,
                q.queued_ms,
                q.emptied,
                q.full,
                q.resets,
                q.discarded
            ),
            (256.0, 0.0, 3, 2, 1, 240)
        );
        s.uptime_ms = 1400;
        s.peak = 0;
        m.observe(1400, s);
        assert_eq!(m.queue.back().unwrap().emptied, 0);
        let generation = m.generation;
        m.clear();
        m.poll(1600);
        s.uptime_ms = 1600;
        m.observe(1600, s);
        assert!(m.generation > generation);
        assert_eq!(m.queue.len(), 1);
        assert_eq!(m.queue[0].resets, 0);
    }
    #[test]
    fn incremental_history_is_bounded_and_disconnect_expires_readings() {
        let mut m = SignalMonitor::default();
        for i in 0..4000 {
            let t = 1000 + i * 200;
            m.poll(t);
            m.rssi(t, -48, false);
            m.observe(t, sample(t, i));
        }
        assert!(m.queue.len() <= MAX_POINTS);
        assert!(m.signals.len() <= MAX_POINTS);
        let v = m.snapshot(800800, true, Some(800600));
        assert_eq!(v["queue"]["samples"].as_array().unwrap().len(), 1);
        m.disconnected();
        assert_eq!(m.snapshot(800800, false, None)["audio"]["status"], "idle");
        m.clear();
        m.rssi(800900, -30, false);
        assert!(m.signals.is_empty());
    }
}
