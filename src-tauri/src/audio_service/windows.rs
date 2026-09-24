use super::{atvv::AtvvDecoder, clamp_gain_db, diagnostics::AudioDiagnostics, AudioServiceStatus};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SampleFormat, SizedSample, StreamConfig, I24, U24,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::GUID,
    Devices::{
        Bluetooth::{
            BluetoothConnectionStatus, BluetoothLEDevice,
            GenericAttributeProfile::{
                GattCharacteristic, GattCharacteristicProperties,
                GattClientCharacteristicConfigurationDescriptorValue, GattCommunicationStatus,
                GattDeviceService, GattValueChangedEventArgs, GattWriteOption,
            },
        },
        Enumeration::DeviceInformation,
    },
    Foundation::TypedEventHandler,
    Storage::Streams::{DataReader, DataWriter, IBuffer},
    Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
};

const VOICE_SERVICE_UUID: GUID = GUID::from_u128(0xab5e0001_5a21_4f05_bc7d_af01f617b664);
const TRANSMIT_UUID: GUID = GUID::from_u128(0xab5e0002_5a21_4f05_bc7d_af01f617b664);
const AUDIO_UUID: GUID = GUID::from_u128(0xab5e0003_5a21_4f05_bc7d_af01f617b664);
const CONTROL_UUID: GUID = GUID::from_u128(0xab5e0004_5a21_4f05_bc7d_af01f617b664);
const SOURCE_SAMPLE_RATE: u32 = 16_000;
const PREBUFFER_SAMPLES: usize = 320;
const MAX_QUEUED_SAMPLES: usize = SOURCE_SAMPLE_RATE as usize * 2;
const RETRY_DELAY: Duration = Duration::from_secs(2);
const CONNECTION_POLL: Duration = Duration::from_millis(100);

#[derive(Default)]
struct VoiceProtocolState {
    capabilities_confirmed: bool,
    microphone_opened: bool,
    streaming: bool,
    protocol_version: u16,
    selected_codec: u8,
    session_id: u8,
    frame_size: usize,
    last_voice_stop: Option<Instant>,
}

impl VoiceProtocolState {
    fn reset_connection(&mut self) {
        *self = Self {
            protocol_version: 0x0100,
            selected_codec: 0x02,
            frame_size: 120,
            ..Self::default()
        };
    }
}

struct Shared {
    diagnostics: AudioDiagnostics,
    status: Mutex<AudioServiceStatus>,
    protocol: Mutex<VoiceProtocolState>,
    decoder: Mutex<AtvvDecoder>,
    samples: Mutex<VecDeque<i16>>,
    gain_db: AtomicI32,
    stop: AtomicBool,
    audio_refresh: AtomicBool,
    ble_refresh: AtomicBool,
    output_failed: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        let mut protocol = VoiceProtocolState::default();
        protocol.reset_connection();
        Self {
            diagnostics: AudioDiagnostics::default(),
            status: Mutex::new(AudioServiceStatus {
                state: "driverMissing".into(),
                ..AudioServiceStatus::default()
            }),
            protocol: Mutex::new(protocol),
            decoder: Mutex::new(AtvvDecoder::default()),
            samples: Mutex::new(VecDeque::new()),
            gain_db: AtomicI32::new(0),
            stop: AtomicBool::new(false),
            audio_refresh: AtomicBool::new(false),
            ble_refresh: AtomicBool::new(false),
            output_failed: AtomicBool::new(false),
        }
    }

    fn update_status(&self, update: impl FnOnce(&mut AudioServiceStatus)) {
        if let Ok(mut status) = self.status.lock() {
            update(&mut status);
        }
    }

    fn output_available(&self) -> bool {
        self.status
            .lock()
            .map(|status| status.driver_installed)
            .unwrap_or(false)
    }

    fn reset_voice_session(&self) {
        if let Ok(mut decoder) = self.decoder.lock() {
            decoder.reset_session();
        }
        if let Ok(mut protocol) = self.protocol.lock() {
            protocol.streaming = false;
            protocol.microphone_opened = false;
            protocol.last_voice_stop = Some(Instant::now());
        }
        // Drop buffered PCM immediately when the remote releases the voice
        // key; otherwise the output callback can play the stale queue for up
        // to MAX_QUEUED_SAMPLES / SOURCE_SAMPLE_RATE (about two seconds).
        if let Ok(mut samples) = self.samples.lock() {
            samples.clear();
        }
        self.update_status(|status| {
            status.forwarding = false;
            if status.driver_installed && status.bluetooth_connected {
                status.state = "ready".into();
            }
        });
    }

    fn report_diagnostics(&self, window: Duration) {
        let (streaming, microphone_opened, session_id) = self
            .protocol
            .lock()
            .map(|protocol| {
                (
                    protocol.streaming,
                    protocol.microphone_opened,
                    protocol.session_id,
                )
            })
            .unwrap_or_default();
        if let Some(report) = self
            .diagnostics
            .report(streaming || microphone_opened, window)
        {
            let queued = self
                .samples
                .lock()
                .map(|samples| samples.len())
                .unwrap_or_default();
            let gain_db = self.gain_db.load(Ordering::Acquire);
            log::info!(target: "axonkey::audio", "RC003 audio diagnostics: {report} streaming={streaming} microphone_opened={microphone_opened} session_id={session_id} queued_samples={queued} gain_db={gain_db}");
        }
    }
}

pub struct AudioService {
    shared: Arc<Shared>,
    audio_worker: Mutex<Option<JoinHandle<()>>>,
    ble_worker: Mutex<Option<JoinHandle<()>>>,
}

impl AudioService {
    pub fn level(&self) -> super::AudioLevel {
        self.shared.diagnostics.level()
    }

    pub fn start() -> Self {
        log::info!(target: "axonkey::audio", "Starting Windows audio service");
        let shared = Arc::new(Shared::new());
        let audio_shared = Arc::clone(&shared);
        let audio_worker = thread::Builder::new()
            .name("Axonkey CABLE audio output".into())
            .spawn(move || audio_output_loop(audio_shared))
            .ok();
        let ble_shared = Arc::clone(&shared);
        let ble_worker = thread::Builder::new()
            .name("Axonkey RC003 voice BLE".into())
            .spawn(move || ble_worker_loop(ble_shared))
            .ok();

        if audio_worker.is_none() || ble_worker.is_none() {
            log::error!(target: "axonkey::audio", "Cannot start the Windows audio bridge workers");
            shared.update_status(|status| {
                status.state = "error".into();
                status.error = Some("Cannot start the Windows audio bridge workers".into());
            });
        }

        Self {
            shared,
            audio_worker: Mutex::new(audio_worker),
            ble_worker: Mutex::new(ble_worker),
        }
    }

    pub fn refresh(&self) {
        let status = self.status();
        log::debug!(target: "axonkey::audio", "Refreshing Windows audio state");
        if !status.driver_installed {
            self.shared.audio_refresh.store(true, Ordering::Release);
        }
        if status.driver_installed && !status.bluetooth_connected {
            self.shared.ble_refresh.store(true, Ordering::Release);
        }
    }

    pub fn set_gain_db(&self, gain: i16) -> Result<(), String> {
        log::info!(target: "axonkey::audio", "Updating audio gain to {} dB", clamp_gain_db(gain));
        self.shared
            .gain_db
            .store(i32::from(clamp_gain_db(gain)), Ordering::Release);
        Ok(())
    }

    pub fn status(&self) -> AudioServiceStatus {
        self.shared
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| AudioServiceStatus {
                state: "error".into(),
                error: Some("Windows audio status lock is unavailable".into()),
                ..AudioServiceStatus::default()
            })
    }
}

impl Drop for AudioService {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        self.shared.audio_refresh.store(true, Ordering::Release);
        self.shared.ble_refresh.store(true, Ordering::Release);
        if let Ok(worker) = self.audio_worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
        if let Ok(worker) = self.ble_worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

fn audio_output_loop(shared: Arc<Shared>) {
    while !shared.stop.load(Ordering::Acquire) {
        shared.audio_refresh.store(false, Ordering::Release);
        shared.output_failed.store(false, Ordering::Release);
        match start_cable_output(Arc::clone(&shared)) {
            Ok((_stream, device_name)) => {
                shared.update_status(|status| {
                    status.driver_installed = true;
                    if status.state == "driverMissing" {
                        status.state = "scanning".into();
                    }
                    if status
                        .error
                        .as_deref()
                        .is_some_and(|error| error.contains("CABLE Input"))
                    {
                        status.error = None;
                    }
                });
                log::info!(target: "axonkey::audio", "Windows audio output ready: {device_name}");
                while !shared.stop.load(Ordering::Acquire)
                    && !shared.audio_refresh.swap(false, Ordering::AcqRel)
                    && !shared.output_failed.load(Ordering::Acquire)
                {
                    thread::sleep(Duration::from_millis(200));
                }
            }
            Err(error) => {
                let error_message = error.to_string();
                let should_log = shared
                    .status
                    .lock()
                    .map(|status| status.error.as_deref() != Some(error_message.as_str()))
                    .unwrap_or(true);
                shared.update_status(|status| {
                    status.driver_installed = false;
                    status.forwarding = false;
                    status.state = "driverMissing".into();
                    status.error = Some(error_message.clone());
                });
                if should_log {
                    log::warn!(target: "axonkey::audio", "Windows audio output unavailable: {error_message}");
                }
                wait_or_stop(&shared, RETRY_DELAY, &shared.audio_refresh);
            }
        }
    }
}

fn start_cable_output(shared: Arc<Shared>) -> Result<(cpal::Stream, String), String> {
    let host = cpal::default_host();
    let mut selected = None;
    let devices = host
        .output_devices()
        .map_err(|error| format!("Cannot enumerate Windows playback devices: {error}"))?;
    for device in devices {
        let Ok(description) = device.description() else {
            continue;
        };
        if cable_output_name(description.name()) {
            selected = Some((device, description.name().to_string()));
            break;
        }
    }
    let (device, device_name) = selected.ok_or_else(|| {
        "CABLE Input playback endpoint was not found; install VB-CABLE and restart Windows"
            .to_string()
    })?;
    let supported = device
        .default_output_config()
        .map_err(|error| format!("Cannot read CABLE Input audio format: {error}"))?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    log::info!(target: "axonkey::audio", "Windows audio output format: device={device_name} sample_rate={} channels={} sample_format={sample_format:?} source_sample_rate={SOURCE_SAMPLE_RATE}", config.sample_rate, config.channels);
    let stream = match sample_format {
        SampleFormat::I8 => build_output_stream::<i8>(&device, config, shared),
        SampleFormat::I16 => build_output_stream::<i16>(&device, config, shared),
        SampleFormat::I24 => build_output_stream::<I24>(&device, config, shared),
        SampleFormat::I32 => build_output_stream::<i32>(&device, config, shared),
        SampleFormat::I64 => build_output_stream::<i64>(&device, config, shared),
        SampleFormat::U8 => build_output_stream::<u8>(&device, config, shared),
        SampleFormat::U16 => build_output_stream::<u16>(&device, config, shared),
        SampleFormat::U24 => build_output_stream::<U24>(&device, config, shared),
        SampleFormat::U32 => build_output_stream::<u32>(&device, config, shared),
        SampleFormat::U64 => build_output_stream::<u64>(&device, config, shared),
        SampleFormat::F32 => build_output_stream::<f32>(&device, config, shared),
        SampleFormat::F64 => build_output_stream::<f64>(&device, config, shared),
        unsupported => Err(format!(
            "CABLE Input uses an unsupported sample format: {unsupported}"
        )),
    }?;
    stream
        .play()
        .map_err(|error| format!("Cannot start CABLE Input playback: {error}"))?;
    Ok((stream, device_name))
}

fn build_output_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Sample + FromSample<f32>,
{
    let channels = usize::from(config.channels);
    let output_rate = config.sample_rate;
    let callback_shared = Arc::clone(&shared);
    let error_shared = Arc::clone(&shared);
    let mut cursor = OutputCursor::new(output_rate);
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| fill_output(output, channels, &mut cursor, &callback_shared),
            move |error| {
                if !error_shared.output_failed.swap(true, Ordering::AcqRel) {
                    log::warn!(target: "axonkey::audio", "CABLE Input playback callback failed: {error}");
                }
                error_shared.update_status(|status| {
                    status.driver_installed = false;
                    status.forwarding = false;
                    status.state = "error".into();
                    status.error = Some(format!("CABLE Input playback failed: {error}"));
                });
            },
            None,
        )
        .map_err(|error| format!("Cannot create CABLE Input playback stream: {error}"))
}

struct OutputCursor {
    output_rate: u32,
    phase: u64,
    current: f32,
    next: f32,
    active: bool,
}

impl OutputCursor {
    fn new(output_rate: u32) -> Self {
        Self {
            output_rate: output_rate.max(1),
            phase: 0,
            current: 0.0,
            next: 0.0,
            active: false,
        }
    }

    fn reset(&mut self) {
        self.phase = 0;
        self.current = 0.0;
        self.next = 0.0;
        self.active = false;
    }

    fn prime(&mut self, samples: &mut VecDeque<i16>, streaming: bool) -> bool {
        if self.active {
            return true;
        }
        if samples.is_empty() || (streaming && samples.len() < PREBUFFER_SAMPLES) {
            return false;
        }
        self.current = pcm_to_f32(samples.pop_front().unwrap_or_default());
        self.next = samples.pop_front().map(pcm_to_f32).unwrap_or(self.current);
        self.active = true;
        true
    }

    fn next_sample(&mut self, samples: &mut VecDeque<i16>) -> f32 {
        let fraction = self.phase as f32 / f64::from(self.output_rate) as f32;
        let value = self.current + (self.next - self.current) * fraction;
        self.phase += u64::from(SOURCE_SAMPLE_RATE);
        while self.phase >= u64::from(self.output_rate) {
            self.phase -= u64::from(self.output_rate);
            self.current = self.next;
            let Some(next) = samples.pop_front() else {
                self.reset();
                break;
            };
            self.next = pcm_to_f32(next);
        }
        value
    }
}

fn fill_output<T>(output: &mut [T], channels: usize, cursor: &mut OutputCursor, shared: &Shared)
where
    T: Sample + FromSample<f32>,
{
    output.fill(T::from_sample(0.0));
    if channels == 0 {
        return;
    }
    let output_frames = output.len().div_ceil(channels);
    let streaming = shared
        .protocol
        .lock()
        .map(|protocol| protocol.streaming)
        .unwrap_or(false);
    let Ok(mut samples) = shared.samples.try_lock() else {
        shared.diagnostics.output(0, output_frames, true);
        return;
    };
    let queued_before = samples.len();
    if !cursor.prime(&mut samples, streaming) {
        shared.diagnostics.output(0, output_frames, false);
        return;
    }
    let gain_db = shared.gain_db.load(Ordering::Acquire) as f32;
    let gain = 10.0_f32.powf(gain_db / 20.0);
    let mut filled_frames = 0;
    for frame in output.chunks_mut(channels) {
        if !cursor.active && !cursor.prime(&mut samples, streaming) {
            break;
        }
        let value = (cursor.next_sample(&mut samples) * gain).clamp(-1.0, 1.0);
        let converted = T::from_sample(value);
        frame.fill(converted);
        filled_frames += 1;
    }
    shared.diagnostics.output(
        queued_before - samples.len(),
        output_frames - filled_frames,
        false,
    );
}

fn pcm_to_f32(sample: i16) -> f32 {
    f32::from(sample) / f32::from(i16::MAX)
}

fn cable_output_name(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    normalized.starts_with("cable input") && !normalized.contains("16ch")
}

fn ble_worker_loop(shared: Arc<Shared>) {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    if !initialized {
        log::error!(target: "axonkey::audio", "Cannot initialize the Windows Bluetooth runtime");
        shared.update_status(|status| {
            status.state = "error".into();
            status.error = Some("Cannot initialize the Windows Bluetooth runtime".into());
        });
        return;
    }

    let mut last_connection_error: Option<String> = None;
    while !shared.stop.load(Ordering::Acquire) {
        shared.ble_refresh.store(false, Ordering::Release);
        if !shared.output_available() {
            wait_or_stop(&shared, Duration::from_millis(500), &shared.ble_refresh);
            continue;
        }
        shared.update_status(|status| {
            status.state = "scanning".into();
            status.bluetooth_connected = false;
            status.forwarding = false;
            status.error = None;
        });
        match VoiceConnection::connect(Arc::clone(&shared)) {
            Ok(mut connection) => {
                last_connection_error = None;
                log::info!(target: "axonkey::audio", "RC003 voice GATT connected");
                let result = connection.run(&shared);
                connection.close(&shared);
                if let Err(error) = result {
                    log::warn!(target: "axonkey::audio", "RC003 voice bridge stopped: {error}");
                    shared.update_status(|status| {
                        status.state = "error".into();
                        status.error = Some(error);
                    });
                }
            }
            Err(error) => {
                if last_connection_error.as_deref() != Some(error.as_str()) {
                    log::warn!(target: "axonkey::audio", "RC003 voice bridge waiting: {error}");
                    last_connection_error = Some(error.clone());
                }
                shared.update_status(|status| {
                    status.bluetooth_connected = false;
                    status.forwarding = false;
                    status.state = "scanning".into();
                    status.error = Some(error);
                });
            }
        }
        wait_or_stop(&shared, RETRY_DELAY, &shared.ble_refresh);
    }
    unsafe { CoUninitialize() };
}

struct VoiceConnection {
    last_report: Instant,
    device: BluetoothLEDevice,
    service: GattDeviceService,
    transmit: GattCharacteristic,
    audio: GattCharacteristic,
    control: GattCharacteristic,
    audio_token: i64,
    control_token: i64,
    commands: Receiver<Vec<u8>>,
}

impl VoiceConnection {
    fn connect(shared: Arc<Shared>) -> Result<Self, String> {
        let (device, service) = find_remote()?;
        shared.update_status(|status| {
            status.bluetooth_connected = true;
            status.state = "connecting".into();
            status.error = None;
        });
        if let Ok(mut protocol) = shared.protocol.lock() {
            protocol.reset_connection();
        }
        if let Ok(mut decoder) = shared.decoder.lock() {
            decoder.reset_session();
        }
        if let Ok(mut samples) = shared.samples.lock() {
            samples.clear();
        }

        let transmit = find_characteristic(&service, TRANSMIT_UUID, "transmit")?;
        let audio = find_characteristic(&service, AUDIO_UUID, "audio")?;
        let control = find_characteristic(&service, CONTROL_UUID, "control")?;
        let (command_tx, commands) = mpsc::channel();

        let audio_shared = Arc::clone(&shared);
        let audio_handler = TypedEventHandler::<GattCharacteristic, GattValueChangedEventArgs>::new(
            move |_, args| {
                if let Some(args) = args.as_ref() {
                    match event_bytes(args) {
                        Ok(bytes) => handle_audio_packet(&audio_shared, &bytes),
                        Err(_) => audio_shared.diagnostics.read_error(),
                    }
                }
                Ok(())
            },
        );
        let audio_token = audio
            .ValueChanged(&audio_handler)
            .map_err(|error| format!("Cannot watch RC003 audio packets: {error}"))?;

        let control_shared = Arc::clone(&shared);
        let control_handler =
            TypedEventHandler::<GattCharacteristic, GattValueChangedEventArgs>::new(
                move |_, args| {
                    if let Some(args) = args.as_ref() {
                        match event_bytes(args) {
                            Ok(bytes) => {
                                if let Some(command) =
                                    handle_control_packet(&control_shared, &bytes)
                                {
                                    let _ = command_tx.send(command);
                                }
                            }
                            Err(_) => control_shared.diagnostics.read_error(),
                        }
                    }
                    Ok(())
                },
            );
        let control_token = control
            .ValueChanged(&control_handler)
            .map_err(|error| format!("Cannot watch RC003 voice controls: {error}"))?;

        enable_notifications(&audio, "audio")?;
        enable_notifications(&control, "control")?;
        write_characteristic(&transmit, &[0x0a, 0x01, 0x00, 0x00, 0x03, 0x03])?;

        Ok(Self {
            last_report: Instant::now(),
            device,
            service,
            transmit,
            audio,
            control,
            audio_token,
            control_token,
            commands,
        })
    }

    fn run(&mut self, shared: &Shared) -> Result<(), String> {
        while !shared.stop.load(Ordering::Acquire)
            && !shared.ble_refresh.swap(false, Ordering::AcqRel)
        {
            if self.last_report.elapsed() >= Duration::from_secs(1) {
                shared.report_diagnostics(self.last_report.elapsed());
                self.last_report = Instant::now();
            }
            if !shared.output_available() {
                return Err("CABLE Input playback endpoint became unavailable".into());
            }
            if self
                .device
                .ConnectionStatus()
                .map_err(|error| format!("Cannot read RC003 connection state: {error}"))?
                == BluetoothConnectionStatus::Disconnected
            {
                return Err(
                    "RC003 voice channel disconnected; wake the remote to reconnect".into(),
                );
            }
            match self.commands.recv_timeout(CONNECTION_POLL) {
                Ok(command) => {
                    write_characteristic(&self.transmit, &command)?;
                    log::info!(target: "axonkey::audio", "RC003 voice command sent: opcode=0x{:02x}", command[0]);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("RC003 voice notification handler stopped".into())
                }
            }
        }
        Ok(())
    }

    fn close(&mut self, shared: &Shared) {
        shared.report_diagnostics(self.last_report.elapsed());
        let close_command = shared.protocol.lock().ok().and_then(|protocol| {
            (protocol.microphone_opened || protocol.streaming).then(|| {
                let command = [0x0d, protocol.session_id];
                let length = if protocol.protocol_version >= 0x0100 {
                    2
                } else {
                    1
                };
                command[..length].to_vec()
            })
        });
        if let Some(command) = close_command {
            let _ = write_characteristic(&self.transmit, &command);
        }
        let _ = self.audio.RemoveValueChanged(self.audio_token);
        let _ = self.control.RemoveValueChanged(self.control_token);
        let _ = self.service.Close();
        let _ = self.device.Close();
        shared.reset_voice_session();
        shared.update_status(|status| {
            status.bluetooth_connected = false;
            status.forwarding = false;
            if status.driver_installed {
                status.state = "scanning".into();
            }
        });
    }
}

fn find_remote() -> Result<(BluetoothLEDevice, GattDeviceService), String> {
    let selector = GattDeviceService::GetDeviceSelectorFromUuid(VOICE_SERVICE_UUID)
        .map_err(|error| format!("Cannot create the RC003 voice service selector: {error}"))?;
    let devices = DeviceInformation::FindAllAsyncAqsFilter(&selector)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Cannot enumerate Bluetooth voice services: {error}"))?;
    let mut failures = Vec::new();
    for index in 0..devices.Size().unwrap_or_default() {
        let Ok(info) = devices.GetAt(index) else {
            continue;
        };
        let Ok(id) = info.Id() else {
            continue;
        };
        if !approved_remote_service_id(&id.to_string()) {
            continue;
        }
        let name = info
            .Name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let result = (|| {
            let service = GattDeviceService::FromIdAsync(&id)?.get()?;
            let device_id = service.Session()?.DeviceId()?.Id()?;
            let device = BluetoothLEDevice::FromIdAsync(&device_id)?.get()?;
            Ok::<_, windows::core::Error>((device, service))
        })();
        match result {
            Ok(connection) => return Ok(connection),
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    if failures.is_empty() {
        Err("RC003 voice service was not found; pair or wake the remote in Windows Bluetooth settings".into())
    } else {
        Err(format!(
            "Cannot open the RC003 voice service ({})",
            failures.join("; ")
        ))
    }
}

fn approved_remote_service_id(id: &str) -> bool {
    // Windows GATT instance paths retain the hardware identity even when the
    // device has a localized or user-chosen Bluetooth name.
    id.to_ascii_lowercase().contains("_vid&012717_pid&32b8_")
}

fn find_characteristic(
    service: &GattDeviceService,
    uuid: GUID,
    name: &str,
) -> Result<GattCharacteristic, String> {
    let result = service
        .GetCharacteristicsForUuidAsync(uuid)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Cannot discover the RC003 {name} characteristic: {error}"))?;
    if result
        .Status()
        .map_err(|error| format!("Cannot read RC003 {name} discovery status: {error}"))?
        != GattCommunicationStatus::Success
    {
        return Err(format!("RC003 {name} characteristic is unreachable"));
    }
    let characteristics = result
        .Characteristics()
        .map_err(|error| format!("Cannot read RC003 {name} characteristic: {error}"))?;
    if characteristics.Size().unwrap_or_default() == 0 {
        return Err(format!("RC003 {name} characteristic was not found"));
    }
    characteristics
        .GetAt(0)
        .map_err(|error| format!("Cannot open RC003 {name} characteristic: {error}"))
}

fn enable_notifications(characteristic: &GattCharacteristic, name: &str) -> Result<(), String> {
    let properties = characteristic
        .CharacteristicProperties()
        .map_err(|error| format!("Cannot read RC003 {name} properties: {error}"))?;
    let value = if properties.contains(GattCharacteristicProperties::Notify) {
        GattClientCharacteristicConfigurationDescriptorValue::Notify
    } else if properties.contains(GattCharacteristicProperties::Indicate) {
        GattClientCharacteristicConfigurationDescriptorValue::Indicate
    } else {
        return Err(format!("RC003 {name} characteristic cannot notify"));
    };
    let status = characteristic
        .WriteClientCharacteristicConfigurationDescriptorAsync(value)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Cannot subscribe to RC003 {name}: {error}"))?;
    if status != GattCommunicationStatus::Success {
        return Err(format!("RC003 {name} subscription failed: {status:?}"));
    }
    Ok(())
}

fn write_characteristic(characteristic: &GattCharacteristic, bytes: &[u8]) -> Result<(), String> {
    let writer = DataWriter::new().map_err(|error| format!("Cannot create GATT data: {error}"))?;
    writer
        .WriteBytes(bytes)
        .map_err(|error| format!("Cannot encode GATT data: {error}"))?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|error| format!("Cannot finalize GATT data: {error}"))?;
    let properties = characteristic
        .CharacteristicProperties()
        .map_err(|error| format!("Cannot read RC003 transmit properties: {error}"))?;
    let option = if properties.contains(GattCharacteristicProperties::WriteWithoutResponse) {
        GattWriteOption::WriteWithoutResponse
    } else {
        GattWriteOption::WriteWithResponse
    };
    let status = characteristic
        .WriteValueWithOptionAsync(&buffer, option)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Cannot write RC003 voice command: {error}"))?;
    if status != GattCommunicationStatus::Success {
        return Err(format!("RC003 voice command failed: {status:?}"));
    }
    Ok(())
}

fn event_bytes(args: &GattValueChangedEventArgs) -> windows::core::Result<Vec<u8>> {
    let buffer: IBuffer = args.CharacteristicValue()?;
    let reader = DataReader::FromBuffer(&buffer)?;
    let mut bytes = vec![0; reader.UnconsumedBufferLength()? as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(bytes)
}

fn handle_control_packet(shared: &Shared, bytes: &[u8]) -> Option<Vec<u8>> {
    shared.diagnostics.control(*bytes.first()?);
    let command = match bytes.first().copied()? {
        0x0b => {
            if bytes.len() < 7 {
                shared.update_status(|status| {
                    status.state = "error".into();
                    status.error = Some("RC003 returned invalid voice capabilities".into());
                });
                return None;
            }
            let mut unsupported = false;
            if let Ok(mut protocol) = shared.protocol.lock() {
                protocol.protocol_version = u16::from_be_bytes([bytes[1], bytes[2]]);
                let mut codecs = bytes[3];
                if protocol.protocol_version >= 0x0100 && codecs == 0 && bytes[4] & 0x03 != 0 {
                    codecs = bytes[4];
                }
                protocol.selected_codec = if codecs & 0x02 != 0 { 0x02 } else { 0x01 };
                protocol.frame_size = usize::from(u16::from_be_bytes([bytes[5], bytes[6]]));
                if protocol.frame_size == 0 {
                    protocol.frame_size = 120;
                }
                unsupported = protocol.selected_codec != 0x02;
                protocol.capabilities_confirmed = !unsupported;
                log::info!(target: "axonkey::audio", "RC003 voice format: protocol_version=0x{:04x} selected_codec=0x{:02x} frame_bytes={} supported={}", protocol.protocol_version, protocol.selected_codec, protocol.frame_size, !unsupported);
            }
            shared.update_status(|status| {
                if unsupported {
                    status.state = "error".into();
                    status.error = Some("RC003 did not offer 16 kHz voice audio".into());
                } else {
                    status.state = "ready".into();
                    status.error = None;
                }
            });
            if !unsupported {
                log::info!(target: "axonkey::audio", "RC003 voice capabilities ready");
            }
            None
        }
        0x08 => shared.protocol.lock().ok().and_then(|mut protocol| {
            if !protocol.capabilities_confirmed
                || protocol.microphone_opened
                || protocol.streaming
                || !shared.output_available()
            {
                return None;
            }
            let bytes = [0x0c, 0x00, protocol.selected_codec];
            let length = if protocol.protocol_version >= 0x0100 {
                2
            } else {
                3
            };
            protocol.microphone_opened = true;
            Some(bytes[..length].to_vec())
        }),
        0x04 => {
            let mut accepted = false;
            if let Ok(mut protocol) = shared.protocol.lock() {
                if protocol.capabilities_confirmed && (bytes.len() < 3 || bytes[2] == 0x02) {
                    protocol.session_id = bytes.get(3).copied().unwrap_or_default();
                    protocol.streaming = true;
                    protocol.last_voice_stop = None;
                    accepted = true;
                }
            }
            if accepted {
                if let Ok(mut decoder) = shared.decoder.lock() {
                    decoder.reset_session();
                }
                if let Ok(mut samples) = shared.samples.lock() {
                    samples.clear();
                }
                shared.update_status(|status| {
                    status.forwarding = true;
                    status.state = "forwarding".into();
                    status.error = None;
                });
                log::info!(target: "axonkey::audio", "RC003 voice forwarding started");
            } else if bytes.len() >= 3 && bytes[2] != 0x02 {
                shared.update_status(|status| {
                    status.forwarding = false;
                    status.state = "error".into();
                    status.error = Some("RC003 started an unsupported 8 kHz stream".into());
                });
            }
            None
        }
        0x00 => {
            shared.reset_voice_session();
            log::info!(target: "axonkey::audio", "RC003 voice forwarding stopped");
            None
        }
        0x0a => {
            if bytes.len() >= 7 {
                let predictor = i16::from_be_bytes([bytes[4], bytes[5]]);
                if let Ok(mut decoder) = shared.decoder.lock() {
                    decoder.synchronize(i32::from(predictor), i32::from(bytes[6]));
                }
            }
            None
        }
        _ => None,
    };
    command
}

fn handle_audio_packet(shared: &Shared, bytes: &[u8]) {
    shared.diagnostics.received(bytes.len());
    if bytes.is_empty() {
        shared.diagnostics.rejected();
        return;
    }
    let frame_size = {
        let Ok(mut protocol) = shared.protocol.lock() else {
            shared.diagnostics.rejected();
            return;
        };
        if !protocol.capabilities_confirmed {
            shared.diagnostics.rejected();
            return;
        }
        if !protocol.streaming {
            if protocol
                .last_voice_stop
                .is_some_and(|stopped| stopped.elapsed() < Duration::from_millis(300))
            {
                shared.diagnostics.rejected();
                return;
            }
            protocol.streaming = true;
            protocol.last_voice_stop = None;
        }
        protocol.frame_size.max(1)
    };
    shared.update_status(|status| {
        status.forwarding = true;
        status.state = "forwarding".into();
        status.error = None;
    });
    let frames = shared
        .decoder
        .lock()
        .map(|mut decoder| decoder.append(bytes, frame_size))
        .unwrap_or_default();
    if frames.is_empty() {
        return;
    }
    for frame in &frames {
        shared.diagnostics.decoded(frame);
    }
    if let Ok(mut queued) = shared.samples.lock() {
        for frame in frames {
            let overflow = queued
                .len()
                .saturating_add(frame.len())
                .saturating_sub(MAX_QUEUED_SAMPLES);
            if overflow > 0 {
                let remove = overflow.min(queued.len());
                queued.drain(..remove);
                shared.diagnostics.overflow(remove);
            }
            queued.extend(frame);
        }
    }
}

fn wait_or_stop(shared: &Shared, duration: Duration, refresh: &AtomicBool) {
    let deadline = Instant::now() + duration;
    while !shared.stop.load(Ordering::Acquire)
        && !refresh.swap(false, Ordering::AcqRel)
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::{approved_remote_service_id, cable_output_name, fill_output, OutputCursor, Shared};
    use std::time::Duration;

    #[test]
    fn output_diagnostics_count_source_samples_without_changing_stereo_audio() {
        let shared = Shared::new();
        shared.samples.lock().unwrap().extend([1000; 640]);
        let mut cursor = OutputCursor::new(48_000);
        let mut output = [0.0_f32; 960];
        fill_output(&mut output, 2, &mut cursor, &shared);
        assert!(output
            .iter()
            .all(|sample| (*sample - 1000.0 / 32767.0).abs() < 0.00001));
        assert_eq!(shared.samples.lock().unwrap().len(), 478);
        let report = shared
            .diagnostics
            .report(true, Duration::from_secs(1))
            .unwrap();
        assert!(report.contains("output_callbacks=1 consumed_samples=162 unfilled_output_frames=0"));
    }

    #[test]
    fn output_diagnostics_distinguish_prebuffer_and_queue_contention() {
        let shared = Shared::new();
        shared.protocol.lock().unwrap().streaming = true;
        shared.samples.lock().unwrap().extend([1000; 240]);
        let mut cursor = OutputCursor::new(48_000);
        let mut output = [1.0_f32; 960];
        fill_output(&mut output, 2, &mut cursor, &shared);
        assert!(output.iter().all(|sample| *sample == 0.0));
        let report = shared
            .diagnostics
            .report(true, Duration::from_secs(1))
            .unwrap();
        assert!(
            report.contains("consumed_samples=0 unfilled_output_frames=480 queue_busy_callbacks=0")
        );

        let _guard = shared.samples.lock().unwrap();
        fill_output(&mut output, 2, &mut cursor, &shared);
        let report = shared
            .diagnostics
            .report(true, Duration::from_secs(1))
            .unwrap();
        assert!(
            report.contains("consumed_samples=0 unfilled_output_frames=480 queue_busy_callbacks=1")
        );
    }

    #[test]
    fn selects_only_the_vb_cable_playback_endpoint() {
        assert!(cable_output_name("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(!cable_output_name("CABLE Output (VB-Audio Virtual Cable)"));
        assert!(!cable_output_name("CABLE In 16ch (VB-Audio Virtual Cable)"));
    }

    #[test]
    fn selects_rc003_voice_service_by_hardware_identity() {
        let id = r"\\?\BTHLEDevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}_Dev_VID&012717_PID&32b8_REV&00a4_001122334455#device";
        assert!(approved_remote_service_id(id));
        assert!(approved_remote_service_id(&id.to_ascii_uppercase()));
        assert!(!approved_remote_service_id(&id.replace("012717", "01046D")));
        assert!(!approved_remote_service_id(&id.replace("32b8", "32b9")));
        assert!(!approved_remote_service_id(&id.replace("32b8", "32b80")));
        assert!(!approved_remote_service_id("RC003"));
    }
}
