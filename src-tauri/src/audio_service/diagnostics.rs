use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

// Both RC003 decoders produce 16 kHz mono PCM. Count samples rather than
// wall time so delayed Bluetooth packets cannot leak the button transient.
const TEST_WARMUP_SAMPLES: usize = 16_000 / 5;

struct TestLevel {
    remaining: usize,
    waveform: VecDeque<super::AudioWaveformPoint>,
    sample: Option<(Instant, f64, f64)>,
}

impl Default for TestLevel {
    fn default() -> Self {
        Self {
            remaining: TEST_WARMUP_SAMPLES,
            waveform: VecDeque::new(),
            sample: None,
        }
    }
}

pub(super) struct AudioDiagnostics {
    level: std::sync::Mutex<TestLevel>,
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
    scheduled: AtomicU64,
    enqueue_failures: AtomicU64,
    enqueue_failed_samples: AtomicU64,
    discarded_buffers: AtomicU64,
    decoder_pending_bytes: AtomicU64,
    decoder_discarded_bytes: AtomicU64,
}

impl Default for AudioDiagnostics {
    fn default() -> Self {
        Self {
            level: std::sync::Mutex::new(TestLevel::default()),
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
            scheduled: AtomicU64::new(0),
            enqueue_failures: AtomicU64::new(0),
            enqueue_failed_samples: AtomicU64::new(0),
            discarded_buffers: AtomicU64::new(0),
            decoder_pending_bytes: AtomicU64::new(0),
            decoder_discarded_bytes: AtomicU64::new(0),
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
        if let Ok(mut level) = self.level.lock() {
            let skipped = level.remaining.min(samples.len());
            level.remaining -= skipped;
            let samples = &samples[skipped..];
            if !samples.is_empty() {
                let trimmed_peak = trimmed_sample_peak(samples);
                let energy: f64 = samples
                    .iter()
                    .map(|sample| f64::from(*sample).powi(2))
                    .sum();
                let t = self.epoch.elapsed().as_millis() as u64 / 20 * 20;
                let peak = trimmed_peak as f64 / 32768.0;
                if let Some(last) = level.waveform.back_mut().filter(|p| p.t == t) {
                    last.peak = last.peak.max(peak);
                } else {
                    level
                        .waveform
                        .push_back(super::AudioWaveformPoint { t, peak });
                }
                while level.waveform.len() > 501
                    || level
                        .waveform
                        .front()
                        .is_some_and(|p| t.saturating_sub(p.t) > 10_000)
                {
                    level.waveform.pop_front();
                }
                level.sample = Some((
                    Instant::now(),
                    trimmed_peak as f64 / 32768.0,
                    (energy / samples.len() as f64).sqrt() / 32768.0,
                ));
            }
        }
    }

    pub(super) fn level(&self) -> super::AudioLevel {
        let Ok(level) = self.level.lock() else {
            return super::AudioLevel::default();
        };
        let fresh = level
            .sample
            .as_ref()
            .filter(|(updated, _, _)| updated.elapsed() < Duration::from_millis(300));
        super::AudioLevel {
            peak: fresh.map_or(0.0, |(_, peak, _)| *peak),
            rms: fresh.map_or(0.0, |(_, _, rms)| *rms),
            now_ms: self.epoch.elapsed().as_millis() as u64,
            // Keep the last spoken segment visible after release. New START clears it.
            waveform: level.waveform.iter().cloned().collect(),
        }
    }

    pub(super) fn output(&self, consumed: usize, silent_frames: usize, queue_busy: bool) {
        self.callbacks.fetch_add(1, Relaxed);
        self.consumed.fetch_add(consumed as u64, Relaxed);
        self.silent_frames.fetch_add(silent_frames as u64, Relaxed);
        self.queue_busy.fetch_add(u64::from(queue_busy), Relaxed);
    }

    #[cfg(any(target_os = "windows", test))]
    pub(super) fn overflow(&self, samples: usize) {
        self.overflow.fetch_add(samples as u64, Relaxed);
    }

    pub(super) fn rejected(&self) {
        self.activity.store(true, Relaxed);
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
                if let Ok(mut level) = self.level.lock() {
                    *level = TestLevel::default();
                }
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

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn scheduled(&self, samples: usize, success: bool) {
        self.activity.store(true, Relaxed);
        if success {
            self.scheduled.fetch_add(samples as u64, Relaxed);
        } else {
            self.enqueue_failures.fetch_add(1, Relaxed);
            self.enqueue_failed_samples
                .fetch_add(samples as u64, Relaxed);
        }
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn discarded_buffers(&self, count: usize) {
        if count > 0 {
            self.activity.store(true, Relaxed);
            self.discarded_buffers.fetch_add(count as u64, Relaxed);
        }
    }

    #[cfg(any(target_os = "windows", test))]
    pub(super) fn report(&self, active: bool, window: Duration) -> Option<String> {
        self.report_platform(active, window, false)
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn decoder_pending(&self, pending: usize, discarded: usize) {
        self.decoder_pending_bytes.store(pending as u64, Relaxed);
        if discarded > 0 {
            self.activity.store(true, Relaxed);
            self.decoder_discarded_bytes
                .fetch_add(discarded as u64, Relaxed);
        }
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn note_native_activity(&self) {
        self.activity.store(true, Relaxed);
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn report_macos(&self, active: bool, window: Duration) -> Option<String> {
        self.report_platform(active, window, true)
    }

    fn report_platform(&self, active: bool, window: Duration, macos: bool) -> Option<String> {
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
        let scheduled = self.scheduled.swap(0, Relaxed);
        let enqueue_failures = self.enqueue_failures.swap(0, Relaxed);
        let failed_samples = self.enqueue_failed_samples.swap(0, Relaxed);
        let discarded_buffers = self.discarded_buffers.swap(0, Relaxed);
        let decoder_pending = self.decoder_pending_bytes.load(Relaxed);
        let decoder_discarded = self.decoder_discarded_bytes.swap(0, Relaxed);
        if !active
            && !activity
            && packets == 0
            && decoded == 0
            && consumed == 0
            && read_errors == 0
            && starts == 0
            && stops == 0
            && syncs == 0
            && scheduled == 0
            && enqueue_failures == 0
            && discarded_buffers == 0
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
        let output = if macos {
            let seconds = window.as_secs_f64();
            let packets_per_second = if seconds > 0.0 {
                packets as f64 / seconds
            } else {
                0.0
            };
            let decoded_ms = decoded as f64 / 16.0;
            // A delivery rate over the whole timer window, not a loss estimate.
            // Session edges and delayed batches can make this exceed 100%.
            let coverage = if seconds > 0.0 {
                decoded_ms / (seconds * 10.0)
            } else {
                0.0
            };
            format!("scheduled_samples={scheduled} completed_buffers={callbacks} rendered_samples={consumed} enqueue_failures={enqueue_failures} discarded_pending_buffers={discarded_buffers} enqueue_failed_samples={failed_samples} rx_packets_per_second={packets_per_second:.2} decoded_ms={decoded_ms:.1} decoded_window_percent={coverage:.1} decoder_pending_bytes={decoder_pending} decoder_discarded_bytes={decoder_discarded}")
        } else {
            format!("output_callbacks={callbacks} consumed_samples={consumed} unfilled_output_frames={silent_frames} queue_busy_callbacks={queue_busy} overflow_samples={overflow}")
        };
        Some(format!(
            "window_ms={} active={active} rx_packets={packets} rx_bytes={bytes} last_rx_ms={last_rx_ms} rejected_packets={rejected} decoded_samples={decoded} pcm_peak={peak} pcm_rms={rms:.1} {output} notification_read_errors={read_errors} starts={starts} stops={stops} syncs={syncs}",
            window.as_millis()
        ))
    }
}

fn trimmed_sample_peak(samples: &[i16]) -> u16 {
    if samples.is_empty() {
        return 0;
    }
    let mut magnitudes: Vec<u16> = samples.iter().map(|sample| sample.unsigned_abs()).collect();
    let retained_peak_index = magnitudes.len() - magnitudes.len() / 100 - 1;
    let (_, peak, _) = magnitudes.select_nth_unstable(retained_peak_index);
    *peak
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_delivery_rates_use_actual_window_and_reset_deltas() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.received(120);
        diagnostics.decoded(&[0; 240]);
        diagnostics.scheduled(240, false);
        diagnostics.decoder_pending(3, 7);
        let report = diagnostics
            .report_macos(false, Duration::from_millis(500))
            .unwrap();
        for field in [
            "enqueue_failed_samples=240",
            "rx_packets_per_second=2.00",
            "decoded_ms=15.0",
            "decoded_window_percent=3.0",
            "decoder_pending_bytes=3 decoder_discarded_bytes=7",
        ] {
            assert!(report.contains(field), "missing {field}: {report}");
        }
        assert!(diagnostics
            .report_macos(false, Duration::from_secs(1))
            .is_none());
        diagnostics.note_native_activity();
        let report = diagnostics.report_macos(false, Duration::ZERO).unwrap();
        assert!(report.contains("active=false"));
        assert!(report.contains("enqueue_failed_samples=0"));
        assert!(report.contains("rx_packets_per_second=0.00"));
        assert!(report.contains("decoded_window_percent=0.0"));
        assert!(report.contains("decoder_pending_bytes=3 decoder_discarded_bytes=0"));
        diagnostics.rejected();
        assert!(diagnostics
            .report_macos(false, Duration::from_secs(1))
            .unwrap()
            .contains("rejected_packets=1"));
    }

    #[test]
    fn test_level_skips_first_200ms_across_batches_and_preserves_diagnostics() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.control(0x04);
        diagnostics.decoded(&[i16::MIN; 3190]);
        diagnostics.decoded(&[]);
        assert_eq!(diagnostics.level().peak, 0.0);
        assert_eq!(diagnostics.level().rms, 0.0);
        let mut boundary = vec![i16::MIN; 10];
        boundary.extend_from_slice(&[1000; 200]);
        diagnostics.decoded(&boundary);
        assert_eq!(diagnostics.level().peak, 1000.0 / 32768.0);
        assert_eq!(diagnostics.level().rms, 1000.0 / 32768.0);
        let report = diagnostics.report(true, Duration::from_secs(1)).unwrap();
        assert!(report.contains("decoded_samples=3400 pcm_peak=32768"));

        diagnostics.control(0x00);
        diagnostics.control(0x04);
        assert_eq!(diagnostics.level().peak, 0.0);
        diagnostics.decoded(&[i16::MAX; TEST_WARMUP_SAMPLES]);
        assert_eq!(diagnostics.level().peak, 0.0);
        assert_eq!(diagnostics.level().rms, 0.0);
        diagnostics.decoded(&[2000]);
        assert_eq!(diagnostics.level().peak, 2000.0 / 32768.0);
        assert_eq!(diagnostics.level().rms, 2000.0 / 32768.0);
    }

    #[test]
    fn calibration_waveform_uses_filtered_peaks_survives_stop_and_resets_on_start() {
        let d = AudioDiagnostics::default();
        d.control(0x04);
        d.decoded(&[i16::MAX; TEST_WARMUP_SAMPLES]);
        assert!(d.level().waveform.is_empty());
        let mut samples = vec![1000; 200];
        samples[0] = i16::MAX;
        d.decoded(&samples);
        let state = d.level();
        assert_eq!(state.waveform.len(), 1);
        assert_eq!(state.waveform[0].peak, state.peak);
        assert_eq!(state.peak, 1000.0 / 32768.0);
        d.control(0x00);
        d.level.lock().unwrap().sample = Some((Instant::now() - Duration::from_secs(1), 1.0, 1.0));
        assert_eq!(d.level().peak, 0.0);
        assert_eq!(d.level().waveform[0].peak, 1000.0 / 32768.0);
        d.control(0x04);
        assert!(d.level().waveform.is_empty());
    }

    #[test]
    fn calibration_waveform_history_is_bounded() {
        let mut d = AudioDiagnostics::default();
        d.level.lock().unwrap().remaining = 0;
        for i in 0..650 {
            d.epoch = Instant::now() - Duration::from_millis(i * 20);
            d.decoded(&[1000; 240]);
        }
        let state = d.level();
        assert!(state.waveform.len() <= 501);
        assert!(state.waveform.last().unwrap().t - state.waveform[0].t <= 10_000);
    }

    #[test]
    fn test_peak_trims_top_one_percent_without_changing_rms_or_log_peak() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.level.lock().unwrap().remaining = 0;
        let mut samples = vec![1000; 200];
        samples[0] = i16::MIN;
        samples[1] = i16::MAX;
        diagnostics.decoded(&samples);
        assert_eq!(diagnostics.level().peak, 1000.0 / 32768.0);
        let energy = 198.0 * 1000.0_f64.powi(2) + 32768.0_f64.powi(2) + 32767.0_f64.powi(2);
        assert!((diagnostics.level().rms - (energy / 200.0).sqrt() / 32768.0).abs() < 1e-12);
        let report = diagnostics.report(true, Duration::from_secs(1)).unwrap();
        assert!(report.contains("pcm_peak=32768"));
    }

    #[test]
    fn trimmed_peak_preserves_sustained_loud_audio_and_handles_small_batches() {
        assert_eq!(trimmed_sample_peak(&[]), 0);
        assert_eq!(trimmed_sample_peak(&[i16::MIN]), 32768);
        assert_eq!(trimmed_sample_peak(&[0; 200]), 0);
        assert_eq!(trimmed_sample_peak(&[i16::MIN; 200]), 32768);
        let mut samples = vec![1000; 200];
        samples[..3].fill(-20000);
        assert_eq!(trimmed_sample_peak(&samples), 20000);
    }

    #[test]
    fn live_level_normalizes_pcm_and_expires_without_packets() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.level.lock().unwrap().remaining = 0;
        assert_eq!(diagnostics.level().peak, 0.0);
        diagnostics.decoded(&[i16::MIN, 0]);
        assert_eq!(diagnostics.level().peak, 1.0);
        assert!((diagnostics.level().rms - 0.5_f64.sqrt()).abs() < 0.000001);
        diagnostics.report(true, Duration::from_secs(1));
        assert_eq!(diagnostics.level().peak, 1.0);
        diagnostics.level.lock().unwrap().sample =
            Some((Instant::now() - Duration::from_secs(1), 1.0, 1.0));
        assert_eq!(diagnostics.level().peak, 0.0);
        assert_eq!(diagnostics.level().rms, 0.0);
        diagnostics.decoded(&[0, 0]);
        assert_eq!(diagnostics.level().peak, 0.0);
        diagnostics.decoded(&[]);
        assert!(diagnostics.level().rms.is_finite());
    }

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

    #[test]
    fn macos_scheduling_is_not_playback_completion() {
        let diagnostics = AudioDiagnostics::default();
        diagnostics.scheduled(240, true);
        diagnostics.scheduled(240, false);
        let report = diagnostics
            .report_macos(false, Duration::from_secs(1))
            .unwrap();
        assert!(report.contains(
            "scheduled_samples=240 completed_buffers=0 rendered_samples=0 enqueue_failures=1"
        ));
        assert!(!report.contains("unfilled_output_frames"));
        diagnostics.output(240, 0, false);
        diagnostics.discarded_buffers(2);
        let report = diagnostics
            .report_macos(false, Duration::from_secs(1))
            .unwrap();
        assert!(report.contains("scheduled_samples=0 completed_buffers=1 rendered_samples=240"));
        assert!(report.contains("discarded_pending_buffers=2"));
        assert!(diagnostics
            .report_macos(false, Duration::from_secs(1))
            .is_none());
    }
}
