//! Bounded, in-memory telemetry. No audio payloads or device identifiers.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};

const HISTORY_MS: u64 = 600_000;
const FRESH_MS: u64 = 5_000;
const MAX_POINTS: usize = 1200;

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
    pps: f64,
    underruns: u64,
    streaming: bool,
    session_id: u64,
}

#[derive(Default)]
pub(super) struct SignalMonitor {
    last_poll: Option<u64>,
    started_at: u64,
    signals: VecDeque<SignalSample>,
    audio: VecDeque<AudioSample>,
    last_signal: Option<u64>,
    last_audio: Option<u64>,
    signal_error: bool,
    streaming: bool,
}

fn field(text: &str, name: &str) -> Option<u64> {
    text.split_whitespace().find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then(|| value.parse().ok()).flatten()
    })
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
        // Session state belongs to the audio service and survives closing the UI.
        let streaming = self.streaming;
        *self = Self {
            streaming,
            ..Self::default()
        };
    }
    pub fn disconnected(&mut self) {
        self.last_signal = None;
        self.signal_error = false;
        self.streaming = false;
        self.last_audio = None;
    }
    pub fn session(&mut self, streaming: bool) {
        self.streaming = streaming;
        // Do not present a previous session's rate while waiting for this one.
        if streaming {
            self.last_audio = None;
        }
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
    pub fn audio(&mut self, now: u64, report: &str, context: &str) {
        if !self.active(now) {
            return;
        }
        let (Some(window), Some(packets), Some(underruns), Some(streaming), Some(session_id)) = (
            field(report, "window_ms"),
            field(report, "rx_packets"),
            field(context, "underruns"),
            field(context, "streaming"),
            field(context, "session_id"),
        ) else {
            return;
        };
        if window == 0 {
            return;
        }
        self.audio.push_back(AudioSample {
            t: now,
            pps: packets as f64 * 1000.0 / window as f64,
            underruns,
            streaming: streaming != 0,
            session_id,
        });
        self.last_audio = Some(now);
        self.streaming = streaming != 0;
        self.prune(now);
    }
    fn prune(&mut self, now: u64) {
        while self
            .signals
            .front()
            .is_some_and(|p| now.saturating_sub(p.t) > HISTORY_MS)
            || self.signals.len() > MAX_POINTS
        {
            self.signals.pop_front();
        }
        while self
            .audio
            .front()
            .is_some_and(|p| now.saturating_sub(p.t) > HISTORY_MS)
            || self.audio.len() > MAX_POINTS
        {
            self.audio.pop_front();
        }
    }
    pub fn snapshot(&self, now: u64, connected: bool) -> Value {
        let signal_status = if !connected {
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
        json!({
            "now": now, "startedAt": self.started_at,
            "bluetooth": {
                "status": signal_status,
                "message": if !connected { "遥控器未连接，请先连接或按键唤醒。" } else if self.signal_error { "暂时无法读取蓝牙信号，正在重试。" } else { "等待遥控器提供新的信号读数。" },
                "lastSampleAt": self.last_signal, "samples": self.signals,
            },
            "audio": {
                "status": audio_status,
                "message": if !connected { "等待遥控器连接。" } else if !self.streaming { "等待按住语音键；停止后不会延续上次收包速率。" } else { "等待新的语音收包统计。" },
                "lastSampleAt": self.last_audio, "samples": self.audio,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_rate_from_actual_window_and_expires_live_values() {
        let mut monitor = SignalMonitor::default();
        monitor.poll(1000);
        monitor.rssi(1100, -58, false);
        monitor.session(true);
        monitor.audio(
            2000,
            "window_ms=1250 rx_packets=60",
            "underruns=13 streaming=1 session_id=7",
        );
        let state = monitor.snapshot(2100, true);
        assert_eq!(state["audio"]["samples"][0]["pps"], 48.0);
        assert_eq!(state["audio"]["status"], "live");
        assert_eq!(state["bluetooth"]["status"], "live");
        assert_eq!(monitor.snapshot(8000, true)["audio"]["status"], "stale");
        monitor.session(false);
        assert_eq!(monitor.snapshot(2200, true)["audio"]["status"], "idle");
        monitor.session(true);
        assert_eq!(monitor.snapshot(2300, true)["audio"]["status"], "waiting");
    }
    #[test]
    fn close_and_disconnect_never_reuse_old_live_readings() {
        let mut monitor = SignalMonitor::default();
        monitor.poll(1000);
        monitor.rssi(1100, -45, false);
        monitor.disconnected();
        assert_eq!(
            monitor.snapshot(1200, true)["bluetooth"]["status"],
            "waiting"
        );
        monitor.rssi(1300, 127, false);
        assert_eq!(monitor.signals.len(), 1);
        assert_eq!(monitor.snapshot(1400, true)["bluetooth"]["status"], "error");
        monitor.clear();
        monitor.rssi(1500, -42, false);
        assert!(monitor.signals.is_empty());
        monitor.poll(1600);
        monitor.rssi(1700, -42, false);
        assert_eq!(monitor.snapshot(1800, true)["bluetooth"]["status"], "live");
        monitor.poll(10000);
        assert!(monitor.signals.is_empty());
    }
    #[test]
    fn history_is_bounded_and_malformed_windows_are_ignored() {
        let mut monitor = SignalMonitor::default();
        for t in 0..2000 {
            monitor.poll(t);
            monitor.rssi(t, -50, false);
        }
        assert_eq!(monitor.signals.len(), MAX_POINTS);
        monitor.audio(
            2000,
            "window_ms=0 rx_packets=2",
            "underruns=1 streaming=1 session_id=2",
        );
        monitor.audio(
            2000,
            "window_ms=1000",
            "underruns=1 streaming=1 session_id=2",
        );
        assert!(monitor.audio.is_empty());
        monitor.prune(HISTORY_MS + 2000);
        assert!(monitor.signals.is_empty());
    }
}
