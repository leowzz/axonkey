mod device;
pub(crate) mod installer;
pub(crate) mod legacy;
mod pcm;

pub(crate) use device::DriverStatus;
pub(crate) use pcm::AudioSource;

use std::{
    sync::{Mutex, Once, OnceLock},
    thread,
    time::{Duration, Instant},
};

const RECONNECT_DELAY: Duration = Duration::from_secs(3);
const AUDIO_TICK: Duration = Duration::from_millis(10);
const IDLE_POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Default)]
pub(crate) struct DriverSnapshot {
    pub installed: bool,
    pub microphone_driver_abnormal: bool,
    pub microphone_driver_warning_suppressed: bool,
    pub connected: bool,
    pub status: Option<DriverStatus>,
    pub error: Option<String>,
}

impl DriverSnapshot {
    pub(crate) fn ready(&self) -> bool {
        self.connected && self.status.is_some_and(DriverStatus::is_running)
    }

    fn record_control_open(&mut self, opened: bool) {
        self.microphone_driver_abnormal = !opened;
        if opened {
            self.microphone_driver_warning_suppressed = false;
        }
    }

    fn dismiss_warning(&mut self) -> bool {
        self.microphone_driver_warning_suppressed = self.microphone_driver_abnormal;
        self.microphone_driver_warning_suppressed
    }
}

#[derive(Default)]
struct DriverService {
    snapshot: Mutex<DriverSnapshot>,
    mixer: Mutex<pcm::Mixer>,
}

static DRIVER: OnceLock<DriverService> = OnceLock::new();
static START: Once = Once::new();

pub(crate) fn start() {
    let service = global();
    START.call_once(|| {
        if let Err(error) = thread::Builder::new()
            .name("Axonkey virtual microphone".into())
            .spawn(move || service.run())
        {
            service.disconnect(format!("Cannot start virtual microphone worker: {error}"));
        }
    });
}

pub(crate) fn snapshot() -> DriverSnapshot {
    global().snapshot.lock().unwrap().clone()
}

pub(crate) fn dismiss_microphone_driver_warning() -> bool {
    global().snapshot.lock().unwrap().dismiss_warning()
}

pub(crate) fn record_installation(installed: bool) {
    global().record_installation(installed);
}

pub(crate) fn source() -> AudioSource {
    let source = AudioSource::new();
    global().mixer.lock().unwrap().add_source(&source);
    source
}

fn global() -> &'static DriverService {
    DRIVER.get_or_init(DriverService::default)
}

impl DriverService {
    fn run(&self) {
        loop {
            match self.connect() {
                Ok(device) => {
                    if let Err(error) = self.forward(&device) {
                        self.disconnect(error);
                    }
                }
                Err(error) => self.disconnect(error),
            }
            // This retry wait is only reached without a working control connection.
            thread::sleep(RECONNECT_DELAY);
        }
    }

    fn connect(&self) -> Result<device::Device, String> {
        let installed = device::is_installed()?;
        self.record_installation(installed);
        if !installed {
            return Err("Quarbor virtual microphone driver is not installed".into());
        }
        let device = self.open_control()?;
        let status = device.status()?;
        self.mixer.lock().unwrap().clear();
        self.update_status(status);
        if let Err(error) = device.flush() {
            // FLUSH is allowed to fail when no recording stream has been opened.
            if status.is_running() {
                log::warn!(target: "axonkey::audio", "{error}");
            } else {
                log::debug!(target: "axonkey::audio", "{error}");
            }
        }
        log::info!(target: "axonkey::audio", "Connected to Quarbor virtual microphone");
        Ok(device)
    }

    fn record_installation(&self, installed: bool) {
        let mut snapshot = self.snapshot.lock().unwrap();
        snapshot.installed = installed;
        if !installed {
            snapshot.microphone_driver_abnormal = true;
        }
    }

    fn open_control(&self) -> Result<device::Device, String> {
        let result = device::Device::open();
        // Only installation and control-open failures affect the home warning.
        self.snapshot
            .lock()
            .unwrap()
            .record_control_open(result.is_ok());
        result
    }

    fn forward(&self, device: &device::Device) -> Result<(), String> {
        let mut previous_format = None;
        loop {
            let tick_started = Instant::now();
            let status = device.status()?;
            self.update_status(status);
            if !status.is_running() {
                self.mixer.lock().unwrap().clear();
                previous_format = None;
                thread::sleep(IDLE_POLL);
                continue;
            }
            if previous_format != Some(status.format) {
                self.mixer.lock().unwrap().clear();
            }
            previous_format = Some(status.format);
            let frames = status.format.sample_rate as usize / 100;
            for _ in 0..writable_blocks(status) {
                let pcm = self.mixer.lock().unwrap().render(status.format, frames);
                let Some(pcm) = pcm else { break };
                if let Err(error) = device.write_pcm(&pcm, status.format) {
                    // A receiver can stop or renegotiate its format between the two IOCTLs.
                    if let Ok(current) = device.status() {
                        if !current.is_running() || current.format != status.format {
                            self.mixer.lock().unwrap().clear();
                            self.update_status(current);
                            break;
                        }
                    }
                    return Err(error);
                }
            }
            thread::sleep(AUDIO_TICK.saturating_sub(tick_started.elapsed()));
        }
    }

    fn update_status(&self, status: DriverStatus) {
        let mut snapshot = self.snapshot.lock().unwrap();
        snapshot.connected = true;
        snapshot.status = Some(status);
        snapshot.error = None;
    }

    fn disconnect(&self, error: String) {
        self.mixer.lock().unwrap().clear();
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.connected || snapshot.error.as_ref() != Some(&error) {
            log::warn!(target: "axonkey::audio", "{error}; reconnecting in 3 seconds");
        }
        snapshot.connected = false;
        snapshot.status = None;
        snapshot.error = Some(error);
    }
}

fn writable_blocks(status: DriverStatus) -> u32 {
    let block_bytes = (status.format.sample_rate / 100) * status.frame_bytes;
    // WaveRT consumption leaves fractional blocks. Round up to reach 20 ms;
    // rounding down can leave less than one tick queued and starve the writer.
    let target = (block_bytes * 2).min(status.fifo_capacity_bytes);
    target
        .saturating_sub(status.fifo_queued_bytes)
        .div_ceil(block_bytes)
        .min(status.fifo_free_bytes / block_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use device::PcmFormat;

    #[test]
    fn injection_obeys_fifo_space_and_limits_queued_latency() {
        let mut status = DriverStatus {
            format: PcmFormat {
                sample_rate: 44_100,
                bits_per_sample: 24,
                channels: 2,
            },
            frame_bytes: 6,
            fifo_capacity_bytes: 100_000,
            fifo_free_bytes: 100_000,
            ..Default::default()
        };
        let block_bytes = 441 * 6;
        assert_eq!(writable_blocks(status), 2);
        status.fifo_queued_bytes = block_bytes;
        assert_eq!(writable_blocks(status), 1);
        status.fifo_queued_bytes = block_bytes * 2;
        assert_eq!(writable_blocks(status), 0);
        status.fifo_queued_bytes = 0;
        status.fifo_free_bytes = block_bytes - 1;
        assert_eq!(writable_blocks(status), 0);
        status.fifo_free_bytes = block_bytes;
        assert_eq!(writable_blocks(status), 1);
    }

    #[test]
    fn fractional_fifo_remainders_still_refill_to_twenty_ms() {
        let mut status = DriverStatus {
            format: PcmFormat {
                sample_rate: 48_000,
                bits_per_sample: 16,
                channels: 2,
            },
            frame_bytes: 4,
            fifo_capacity_bytes: 100_000,
            fifo_free_bytes: 100_000,
            ..Default::default()
        };
        for (queued_frames, expected_blocks) in [(1, 2), (10, 2), (481, 1), (490, 1), (960, 0)] {
            status.fifo_queued_bytes = queued_frames * status.frame_bytes;
            status.fifo_free_bytes = status.fifo_capacity_bytes - status.fifo_queued_bytes;
            assert_eq!(
                writable_blocks(status),
                expected_blocks,
                "fractional FIFO remainder of {queued_frames} frames delays refilling"
            );
        }
    }

    #[test]
    fn fifo_refill_keeps_up_with_delayed_ticks_and_fractional_driver_consumption() {
        let format = PcmFormat {
            sample_rate: 48_000,
            bits_per_sample: 16,
            channels: 2,
        };
        let source = AudioSource::new();
        let mut mixer = pcm::Mixer::default();
        mixer.add_source(&source);
        source.push_pcm(&[4000; 1600]);

        // Independent WaveRT callbacks consume elapsed frames. GET_STATUS can
        // observe their fractional remainder between callbacks and writer ticks.
        let jitter_us = [0, 100, 300, 200, 500, 0, 400];
        let mut input_at = 20_000;
        let mut callback = 1;
        let mut driver_at = 10_000;
        let mut writer_at = 0;
        let mut last_driver_at = 0;
        let mut frame_remainder = 0;
        let mut fifo_frames = 0;
        let mut missing_frames = 0;
        let mut peak_fifo_frames = 0;
        loop {
            let now: u64 = input_at.min(driver_at).min(writer_at);
            if now > 20_000_000 {
                break;
            }
            if now == input_at {
                source.push_pcm(&[4000; 320]);
                input_at += 20_000;
            }
            if now == driver_at {
                let elapsed_frames = (now - last_driver_at) * 48_000 + frame_remainder;
                let needed = elapsed_frames / 1_000_000;
                frame_remainder = elapsed_frames % 1_000_000;
                let consumed = needed.min(fifo_frames);
                fifo_frames -= consumed;
                missing_frames += needed - consumed;
                last_driver_at = now;
                callback += 1;
                driver_at =
                    callback * 10_000 + jitter_us[(callback as usize - 1) % jitter_us.len()];
            }
            if now == writer_at {
                let queued_bytes = fifo_frames as u32 * 4;
                let status = DriverStatus {
                    format,
                    frame_bytes: 4,
                    fifo_capacity_bytes: 1_048_576,
                    fifo_queued_bytes: queued_bytes,
                    fifo_free_bytes: 1_048_576 - queued_bytes,
                    ..Default::default()
                };
                for _ in 0..writable_blocks(status) {
                    let Some(pcm) = mixer.render(format, 480) else {
                        break;
                    };
                    fifo_frames += pcm.len() as u64 / 4;
                }
                peak_fifo_frames = peak_fifo_frames.max(fifo_frames);
                writer_at += 10_288;
            }
        }
        assert!(
            source.queued_samples() <= 1600 + 640,
            "source backlog grew to {} samples over 20 seconds",
            source.queued_samples()
        );
        assert!(missing_frames <= 48, "driver repeatedly ran out of PCM");
        assert!(peak_fifo_frames < 1440, "FIFO exceeded 30 ms");
    }

    #[test]
    fn connected_control_device_only_becomes_ready_while_capture_is_running() {
        let mut snapshot = DriverSnapshot {
            installed: true,
            connected: true,
            status: Some(DriverStatus::default()),
            error: None,
            ..Default::default()
        };
        assert!(!snapshot.ready());
        let status = snapshot.status.as_mut().unwrap();
        status.capture_active = 1;
        status.capture_state = 3;
        assert!(snapshot.ready());
        snapshot.connected = false;
        assert!(!snapshot.ready());
    }

    #[test]
    fn missing_driver_sets_warning_until_control_is_opened() {
        let service = DriverService::default();
        assert!(!service.snapshot.lock().unwrap().microphone_driver_abnormal);
        service.record_installation(false);
        assert!(service.snapshot.lock().unwrap().microphone_driver_abnormal);
        service.record_installation(true);
        assert!(service.snapshot.lock().unwrap().microphone_driver_abnormal);
        let result = service.open_control();
        assert_eq!(
            service.snapshot.lock().unwrap().microphone_driver_abnormal,
            result.is_err()
        );
    }

    #[test]
    fn write_status_and_idle_capture_do_not_mark_driver_abnormal() {
        let service = DriverService::default();
        service.record_installation(true);
        service.update_status(DriverStatus::default());
        assert!(!service.snapshot.lock().unwrap().microphone_driver_abnormal);
        service.disconnect("Cannot write Quarbor virtual microphone PCM".into());
        assert!(!service.snapshot.lock().unwrap().microphone_driver_abnormal);
        service.disconnect("Cannot query Quarbor virtual microphone status".into());
        assert!(!service.snapshot.lock().unwrap().microphone_driver_abnormal);
        service.record_installation(false);
        service.disconnect("Cannot write Quarbor virtual microphone PCM".into());
        assert!(service.snapshot.lock().unwrap().microphone_driver_abnormal);
    }

    #[test]
    fn dismissed_warning_stays_suppressed_until_control_recovers() {
        let service = DriverService::default();
        service.record_installation(false);
        assert!(service.snapshot.lock().unwrap().dismiss_warning());
        service.record_installation(false);
        service.disconnect("Cannot write Quarbor virtual microphone PCM".into());
        let mut snapshot = service.snapshot.lock().unwrap();
        assert!(snapshot.microphone_driver_warning_suppressed);
        snapshot.record_control_open(false);
        assert!(snapshot.microphone_driver_abnormal);
        assert!(snapshot.microphone_driver_warning_suppressed);
        snapshot.record_control_open(true);
        assert!(!snapshot.microphone_driver_abnormal);
        assert!(!snapshot.microphone_driver_warning_suppressed);
        assert!(!snapshot.dismiss_warning());
        snapshot.record_control_open(false);
        assert!(snapshot.microphone_driver_abnormal);
        assert!(!snapshot.microphone_driver_warning_suppressed);
    }
}
