use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

pub(super) struct AudioDiagnostics {
    epoch: Instant,
    activity: AtomicBool,
    packets: AtomicU64,
    bytes: AtomicU64,
    last_packet_ms: AtomicU64,
    decoded: AtomicU64,
    energy: AtomicU64,
    peak: AtomicU64,
    callbacks: AtomicU64,
    consumed: AtomicU64,
    silent_frames: AtomicU64,
    queue_busy: AtomicU64,
    overflow: AtomicU64,
    rejected_packets: AtomicU64,
    read_errors: AtomicU64,
    starts: AtomicU64,
    stops: AtomicU64,
    syncs: AtomicU64,
}

impl Default for AudioDiagnostics {
    fn default() -> Self {
        Self {
            epoch: Instant::now(),
            activity: AtomicBool::new(false),
            packets: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            last_packet_ms: AtomicU64::new(u64::MAX),
            decoded: AtomicU64::new(0),
            energy: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            callbacks: AtomicU64::new(0),
            consumed: AtomicU64::new(0),
            silent_frames: AtomicU64::new(0),
            queue_busy: AtomicU64::new(0),
            overflow: AtomicU64::new(0),
            rejected_packets: AtomicU64::new(0),
            read_errors: AtomicU64::new(0),
            starts: AtomicU64::new(0),
            stops: AtomicU64::new(0),
            syncs: AtomicU64::new(0),
        }
    }
}

impl AudioDiagnostics {
    pub(super) fn received(&self, bytes: usize) {
        self.activity.store(true, Relaxed);
        self.packets.fetch_add(1, Relaxed);
        self.bytes.fetch_add(bytes as u64, Relaxed);
        self.last_packet_ms
            .store(self.epoch.elapsed().as_millis() as u64, Relaxed);
    }

    pub(super) fn decoded(&self, samples: &[i16]) {
        let mut energy = 0;
        let mut peak = 0;
        for sample in samples {
            let magnitude = i64::from(*sample).unsigned_abs();
            energy += magnitude * magnitude;
            peak = peak.max(magnitude);
        }
        self.decoded.fetch_add(samples.len() as u64, Relaxed);
        self.energy.fetch_add(energy, Relaxed);
        self.peak.fetch_max(peak, Relaxed);
    }

    pub(super) fn output(&self, consumed: usize, silent_frames: usize, queue_busy: bool) {
        self.callbacks.fetch_add(1, Relaxed);
        self.consumed.fetch_add(consumed as u64, Relaxed);
        self.silent_frames.fetch_add(silent_frames as u64, Relaxed);
        self.queue_busy.fetch_add(u64::from(queue_busy), Relaxed);
    }

    pub(super) fn overflow(&self, samples: usize) {
        self.overflow.fetch_add(samples as u64, Relaxed);
    }

    pub(super) fn rejected(&self) {
        self.rejected_packets.fetch_add(1, Relaxed);
    }

    pub(super) fn read_error(&self) {
        self.activity.store(true, Relaxed);
        self.read_errors.fetch_add(1, Relaxed);
    }

    pub(super) fn control(&self, opcode: u8) {
        self.activity.store(true, Relaxed);
        match opcode {
            0x04 => {
                self.starts.fetch_add(1, Relaxed);
            }
            0x00 => {
                self.stops.fetch_add(1, Relaxed);
            }
            0x0a => {
                self.syncs.fetch_add(1, Relaxed);
            }
            _ => {}
        }
    }

    pub(super) fn report(&self, active: bool, window: Duration) -> Option<String> {
        let activity = self.activity.swap(false, Relaxed);
        let packets = self.packets.swap(0, Relaxed);
        let bytes = self.bytes.swap(0, Relaxed);
        let decoded = self.decoded.swap(0, Relaxed);
        let energy = self.energy.swap(0, Relaxed);
        let peak = self.peak.swap(0, Relaxed);
        let callbacks = self.callbacks.swap(0, Relaxed);
        let consumed = self.consumed.swap(0, Relaxed);
        let silent_frames = self.silent_frames.swap(0, Relaxed);
        let queue_busy = self.queue_busy.swap(0, Relaxed);
        let overflow = self.overflow.swap(0, Relaxed);
        let rejected = self.rejected_packets.swap(0, Relaxed);
        let read_errors = self.read_errors.swap(0, Relaxed);
        let starts = self.starts.swap(0, Relaxed);
        let stops = self.stops.swap(0, Relaxed);
        let syncs = self.syncs.swap(0, Relaxed);
        if !active
            && !activity
            && packets == 0
            && decoded == 0
            && consumed == 0
            && read_errors == 0
            && starts == 0
            && stops == 0
            && syncs == 0
        {
            return None;
        }
        let last_packet = self.last_packet_ms.load(Relaxed);
        let last_rx_ms = if last_packet == u64::MAX {
            "never".into()
        } else {
            (self.epoch.elapsed().as_millis() as u64)
                .saturating_sub(last_packet)
                .to_string()
        };
        let rms = if decoded == 0 {
            0.0
        } else {
            (energy as f64 / decoded as f64).sqrt()
        };
        Some(format!(
            "window_ms={} active={active} rx_packets={packets} rx_bytes={bytes} last_rx_ms={last_rx_ms} rejected_packets={rejected} decoded_samples={decoded} pcm_peak={peak} pcm_rms={rms:.1} output_callbacks={callbacks} consumed_samples={consumed} unfilled_output_frames={silent_frames} queue_busy_callbacks={queue_busy} overflow_samples={overflow} notification_read_errors={read_errors} starts={starts} stops={stops} syncs={syncs}",
            window.as_millis()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_callbacks_do_not_log_but_active_silence_does() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.output(0, 480, false);
        assert!(diagnostics.report(false, Duration::from_secs(1)).is_none());
        let report = diagnostics.report(true, Duration::from_secs(1)).unwrap();
        assert!(report.contains("rx_packets=0"));
        assert!(report.contains("last_rx_ms=never"));
        assert!(report.contains("output_callbacks=0"));
    }

    #[test]
    fn short_session_preserves_signal_and_failure_statistics() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.control(0x04);
        diagnostics.received(120);
        diagnostics.decoded(&[i16::MIN, 0]);
        diagnostics.output(2, 48, true);
        diagnostics.overflow(3);
        diagnostics.rejected();
        diagnostics.read_error();
        diagnostics.control(0x0a);
        diagnostics.control(0x00);
        let report = diagnostics
            .report(false, Duration::from_millis(300))
            .unwrap();
        for field in [
            "window_ms=300",
            "rx_packets=1",
            "rx_bytes=120",
            "decoded_samples=2",
            "pcm_peak=32768",
            "pcm_rms=23170.5",
            "consumed_samples=2",
            "unfilled_output_frames=48",
            "queue_busy_callbacks=1",
            "overflow_samples=3",
            "notification_read_errors=1",
            "rejected_packets=1",
            "starts=1 stops=1 syncs=1",
        ] {
            assert!(report.contains(field), "{report} missing {field}");
        }
        assert!(diagnostics.report(false, Duration::from_secs(1)).is_none());
        let report = diagnostics.report(true, Duration::from_secs(1)).unwrap();
        assert!(report.contains("pcm_peak=0 pcm_rms=0.0"));
        assert!(!report.contains("last_rx_ms=never"));
    }

    #[test]
    fn distinguishes_silent_packets_from_a_stalled_receiver() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.received(120);
        diagnostics.decoded(&[1000; 240]);
        diagnostics.output(240, 0, false);
        let report = diagnostics.report(true, Duration::from_secs(1)).unwrap();
        assert!(report.contains("pcm_peak=1000 pcm_rms=1000.0"));

        diagnostics.received(120);
        diagnostics.decoded(&[0; 240]);
        diagnostics.output(240, 0, false);
        let report = diagnostics.report(true, Duration::from_secs(1)).unwrap();
        assert!(report.contains("rx_packets=1"));
        assert!(report.contains("decoded_samples=240 pcm_peak=0 pcm_rms=0.0"));
        assert!(report.contains("consumed_samples=240 unfilled_output_frames=0"));

        diagnostics.output(0, 480, false);
        let report = diagnostics.report(true, Duration::from_secs(1)).unwrap();
        assert!(report.contains("rx_packets=0"));
        assert!(report.contains("decoded_samples=0"));
        assert!(report.contains("consumed_samples=0 unfilled_output_frames=480"));
    }
}
