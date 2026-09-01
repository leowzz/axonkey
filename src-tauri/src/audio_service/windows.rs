use super::{atvv::AtvvDecoder, clamp_gain_db, AudioServiceStatus};
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
        self.update_status(|status| {
            status.forwarding = false;
            if status.driver_installed && status.bluetooth_connected {
                status.state = "ready".into();
            }
        });
    }
}

pub struct AudioService {
    shared: Arc<Shared>,
    audio_worker: Mutex<Option<JoinHandle<()>>>,
    ble_worker: Mutex<Option<JoinHandle<()>>>,
}

impl AudioService {
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
                error_shared.output_failed.store(true, Ordering::Release);
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
    let streaming = shared
        .protocol
        .lock()
        .map(|protocol| protocol.streaming)
        .unwrap_or(false);
    let Ok(mut samples) = shared.samples.try_lock() else {
        return;
    };
    if !cursor.prime(&mut samples, streaming) {
        return;
    }
    let gain_db = shared.gain_db.load(Ordering::Acquire) as f32;
    let gain = 10.0_f32.powf(gain_db / 20.0);
    for frame in output.chunks_mut(channels) {
        if !cursor.active && !cursor.prime(&mut samples, streaming) {
            break;
        }
        let value = (cursor.next_sample(&mut samples) * gain).clamp(-1.0, 1.0);
        let converted = T::from_sample(value);
        frame.fill(converted);
    }
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
                    if let Ok(bytes) = event_bytes(args) {
                        handle_audio_packet(&audio_shared, &bytes);
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
                        if let Ok(bytes) = event_bytes(args) {
                            if let Some(command) = handle_control_packet(&control_shared, &bytes) {
                                let _ = command_tx.send(command);
                            }
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
                Ok(command) => write_characteristic(&self.transmit, &command)?,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("RC003 voice notification handler stopped".into())
                }
            }
        }
        Ok(())
    }

    fn close(&mut self, shared: &Shared) {
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
    let selector = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)
        .map_err(|error| format!("Cannot create the paired Bluetooth selector: {error}"))?;
    let devices = DeviceInformation::FindAllAsyncAqsFilter(&selector)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Cannot enumerate paired Bluetooth LE devices: {error}"))?;
    let mut failures = Vec::new();
    for index in 0..devices.Size().unwrap_or_default() {
        let Ok(info) = devices.GetAt(index) else {
            continue;
        };
        let name = info
            .Name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        if !approved_remote_name(&name) {
            continue;
        }
        let result = (|| {
            let id = info.Id()?;
            let device = BluetoothLEDevice::FromIdAsync(&id)?.get()?;
            let services = device
                .GetGattServicesForUuidAsync(VOICE_SERVICE_UUID)?
                .get()?;
            if services.Status()? != GattCommunicationStatus::Success {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x8007_0436_u32 as i32,
                )));
            }
            let list = services.Services()?;
            if list.Size()? == 0 {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x8007_0490_u32 as i32,
                )));
            }
            Ok((device, list.GetAt(0)?))
        })();
        match result {
            Ok(connection) => return Ok(connection),
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    if failures.is_empty() {
        Err("Paired RC003 was not found; pair or wake MI RC in Windows Bluetooth settings".into())
    } else {
        Err(format!(
            "Cannot open the RC003 voice service ({})",
            failures.join("; ")
        ))
    }
}

fn approved_remote_name(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase().replace(['-', '_'], " ");
    matches!(normalized.as_str(), "mi rc" | "xiaomi remote" | "rc003")
        || normalized.contains("rc003")
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
    if bytes.is_empty() {
        return;
    }
    let frame_size = {
        let Ok(mut protocol) = shared.protocol.lock() else {
            return;
        };
        if !protocol.capabilities_confirmed {
            return;
        }
        if !protocol.streaming {
            if protocol
                .last_voice_stop
                .is_some_and(|stopped| stopped.elapsed() < Duration::from_millis(300))
            {
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
    if let Ok(mut queued) = shared.samples.lock() {
        for frame in frames {
            let overflow = queued
                .len()
                .saturating_add(frame.len())
                .saturating_sub(MAX_QUEUED_SAMPLES);
            if overflow > 0 {
                let remove = overflow.min(queued.len());
                queued.drain(..remove);
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
    use super::{approved_remote_name, cable_output_name};

    #[test]
    fn selects_only_the_vb_cable_playback_endpoint() {
        assert!(cable_output_name("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(!cable_output_name("CABLE Output (VB-Audio Virtual Cable)"));
        assert!(!cable_output_name("CABLE In 16ch (VB-Audio Virtual Cable)"));
    }

    #[test]
    fn accepts_known_rc003_names() {
        assert!(approved_remote_name("MI RC"));
        assert!(approved_remote_name("RC003"));
        assert!(approved_remote_name("Xiaomi Remote"));
        assert!(!approved_remote_name("MX Master 3S"));
    }
}
