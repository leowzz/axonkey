use super::atvv::AtvvDecoder;
use crate::audio_service::{clamp_gain_db, diagnostics::AudioDiagnostics, AudioServiceStatus};
use crate::windows_vmic::{self, AudioSource, DriverSnapshot};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
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
                GattDeviceService, GattSharingMode, GattValueChangedEventArgs, GattWriteOption,
            },
        },
        Enumeration::DeviceInformation,
    },
    Foundation::TypedEventHandler,
    Storage::Streams::{DataReader, DataWriter, IBuffer},
};

const VOICE_SERVICE_UUID: GUID = GUID::from_u128(0xab5e0001_5a21_4f05_bc7d_af01f617b664);
const TRANSMIT_UUID: GUID = GUID::from_u128(0xab5e0002_5a21_4f05_bc7d_af01f617b664);
const AUDIO_UUID: GUID = GUID::from_u128(0xab5e0003_5a21_4f05_bc7d_af01f617b664);
const CONTROL_UUID: GUID = GUID::from_u128(0xab5e0004_5a21_4f05_bc7d_af01f617b664);
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
    recording_indicator: crate::recording_overlay::RecordingSource,
    diagnostics: AudioDiagnostics,
    status: Mutex<AudioServiceStatus>,
    protocol: Mutex<VoiceProtocolState>,
    decoder: Mutex<AtvvDecoder>,
    source: AudioSource,
    input: Mutex<()>,
    a15_active: AtomicBool,
    a15_connected: AtomicBool,
    a15_received: AtomicBool,
    enabled: AtomicBool,
    stop: AtomicBool,
    ble_refresh: AtomicBool,
    target_bluetooth_address: Option<String>,
}

impl Shared {
    fn new(target_bluetooth_address: Option<String>) -> Self {
        let mut protocol = VoiceProtocolState::default();
        protocol.reset_connection();
        Self {
            recording_indicator: Default::default(),
            diagnostics: AudioDiagnostics::default(),
            status: Mutex::new(AudioServiceStatus::default()),
            protocol: Mutex::new(protocol),
            decoder: Mutex::new(AtvvDecoder::default()),
            source: windows_vmic::source(),
            input: Mutex::new(()),
            a15_active: AtomicBool::new(false),
            a15_connected: AtomicBool::new(false),
            a15_received: AtomicBool::new(false),
            enabled: AtomicBool::new(true),
            stop: AtomicBool::new(false),
            ble_refresh: AtomicBool::new(false),
            target_bluetooth_address,
        }
    }

    fn update_status(&self, update: impl FnOnce(&mut AudioServiceStatus)) {
        if let Ok(mut status) = self.status.lock() {
            update(&mut status);
            self.recording_indicator
                .set(status.forwarding || self.a15_active.load(Ordering::Acquire));
        }
    }

    fn set_a15_recording(&self, active: bool) {
        if let Ok(_input) = self.input.lock() {
            if self.a15_active.swap(active, Ordering::AcqRel) != active {
                self.source.clear();
                self.a15_received.store(false, Ordering::Release);
                self.diagnostics.control(if active { 0x04 } else { 0x00 });
                self.recording_indicator.set(active);
            }
        }
    }

    fn reset_rc003_output(&self) {
        if let Ok(_input) = self.input.lock() {
            if !self.a15_active.load(Ordering::Acquire) {
                self.source.clear();
            }
        }
    }

    fn enqueue_pcm(&self, a15: bool, frame: &[i16]) {
        let Ok(_input) = self.input.lock() else {
            return;
        };
        if !self.enabled.load(Ordering::Acquire) || a15 != self.a15_active.load(Ordering::Acquire) {
            return;
        }
        self.diagnostics.decoded(frame);
        self.source.push_pcm(frame);
        if a15 {
            self.a15_received.store(true, Ordering::Release);
        }
    }

    fn driver_connected(&self) -> bool {
        self.enabled.load(Ordering::Acquire) && windows_vmic::snapshot().connected
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
        self.reset_rc003_output();
        self.update_status(|status| {
            status.forwarding = false;
            status.received_data = false;
            if status.bluetooth_connected {
                status.state = "ready".into();
            }
        });
    }
}

pub struct AudioService {
    shared: Arc<Shared>,
    ble_worker: Mutex<Option<JoinHandle<()>>>,
}

impl AudioService {
    #[cfg(test)]
    pub(crate) fn without_workers() -> Self {
        Self {
            shared: Arc::new(Shared::new(None)),
            ble_worker: Mutex::new(None),
        }
    }

    pub(crate) fn set_a15_recording(&self, active: bool) {
        self.shared.set_a15_recording(active);
    }

    pub(crate) fn set_a15_input_state(&self, connected: bool, recording: bool) {
        self.shared
            .a15_connected
            .store(connected, Ordering::Release);
        self.set_a15_recording(recording);
    }

    pub(crate) fn push_a15_pcm(&self, samples: &[i16]) {
        if samples.len() != 320 {
            return;
        }
        self.shared.enqueue_pcm(true, samples);
    }

    pub fn level(&self) -> crate::audio_service::AudioLevel {
        self.shared.diagnostics.level()
    }

    pub fn start() -> Self {
        // Saved instances own their BLE sessions; the legacy service must not
        // connect to the same remote a second time.
        let service = Self::start_workers(None, false);
        service.set_enabled(false);
        service
    }

    pub fn start_for(target_bluetooth_address: Option<String>) -> Self {
        Self::start_workers(target_bluetooth_address, true)
    }

    pub fn start_a15() -> Self {
        Self::start_workers(None, false)
    }

    fn start_workers(target_bluetooth_address: Option<String>, bluetooth: bool) -> Self {
        log::info!(target: "axonkey::audio", "Starting Windows virtual microphone source");
        let shared = Arc::new(Shared::new(target_bluetooth_address));
        let ble_worker = if bluetooth {
            let ble_shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("Axonkey RC003 voice BLE".into())
                .spawn(move || ble_worker_loop(ble_shared))
                .ok()
        } else {
            None
        };
        if bluetooth && ble_worker.is_none() {
            shared.update_status(|status| {
                status.state = "error".into();
                status.error = Some("Cannot start the Windows Bluetooth voice worker".into());
            });
        }
        Self {
            shared,
            ble_worker: Mutex::new(ble_worker),
        }
    }

    pub fn refresh(&self) {
        if !self.status().bluetooth_connected {
            self.shared.ble_refresh.store(true, Ordering::Release);
        }
    }

    pub fn pause(&self) {
        self.set_enabled(false);
    }

    pub fn resume(&self) {
        self.set_enabled(true);
    }

    pub fn restart(&self) -> Result<(), String> {
        self.pause();
        self.resume();
        Ok(())
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        if self.shared.enabled.swap(enabled, Ordering::AcqRel) == enabled {
            return;
        }
        self.shared.ble_refresh.store(true, Ordering::Release);
        if !enabled {
            self.shared.set_a15_recording(false);
            self.shared.source.clear();
            self.shared.update_status(|status| {
                status.forwarding = false;
                status.received_data = false;
            });
        }
    }

    pub fn set_gain_db(&self, gain: i16) -> Result<(), String> {
        let gain = clamp_gain_db(gain);
        self.shared.source.set_gain_db(gain);
        Ok(())
    }

    pub fn status(&self) -> AudioServiceStatus {
        self.status_with_driver(windows_vmic::snapshot())
    }

    fn status_with_driver(&self, driver: DriverSnapshot) -> AudioServiceStatus {
        let mut status = self
            .shared
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| AudioServiceStatus {
                state: "error".into(),
                error: Some("Windows audio status lock is unavailable".into()),
                ..AudioServiceStatus::default()
            });
        let enabled = self.shared.enabled.load(Ordering::Acquire);
        let a15 = self.shared.a15_connected.load(Ordering::Acquire)
            || self.shared.a15_active.load(Ordering::Acquire);
        if a15 {
            status.bluetooth_connected = true;
            status.received_data = self.shared.a15_received.load(Ordering::Acquire);
            status.forwarding =
                self.shared.a15_active.load(Ordering::Acquire) && status.received_data;
            status.error = None;
        }
        status.driver_installed = driver.installed;
        status.output_ready = enabled && driver.ready();
        status.forwarding &= status.output_ready;
        if !enabled {
            status.state = "stopped".into();
            status.error = None;
        } else if !driver.installed {
            status.state = "driverMissing".into();
            status.error = driver.error;
        } else if !driver.connected {
            status.state = "connecting".into();
            status.error = driver.error;
        } else if status.forwarding {
            status.state = "forwarding".into();
        } else if status.bluetooth_connected && status.state != "error" {
            status.state = "ready".into();
        } else if status.state.is_empty() {
            status.state = "scanning".into();
        }
        status
    }
}

impl Drop for AudioService {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        self.shared.ble_refresh.store(true, Ordering::Release);
        if let Ok(worker) = self.ble_worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
        self.shared.source.clear();
        self.shared.recording_indicator.set(false);
    }
}

fn ble_worker_loop(shared: Arc<Shared>) {
    let _apartment = match crate::windows_runtime::initialize_mta() {
        Ok(apartment) => apartment,
        Err(error) => {
            log::error!(target: "axonkey::audio", "Cannot initialize the Windows Bluetooth runtime: {error}");
            shared.update_status(|status| {
                status.state = "error".into();
                status.error = Some("Cannot initialize the Windows Bluetooth runtime".into());
            });
            return;
        }
    };

    let mut last_connection_error: Option<String> = None;
    while !shared.stop.load(Ordering::Acquire) {
        shared.ble_refresh.store(false, Ordering::Release);
        if !shared.driver_connected() {
            wait_or_stop(&shared, Duration::from_millis(500), &shared.ble_refresh);
            continue;
        }
        shared.update_status(|status| {
            status.state = "scanning".into();
            status.bluetooth_connected = false;
            status.forwarding = false;
            status.error = None;
        });
        let connection = {
            let _bluetooth_calls = crate::windows_runtime::bluetooth_call_guard();
            VoiceConnection::connect(Arc::clone(&shared))
        };
        match connection {
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
        let target = shared.target_bluetooth_address.as_deref();
        let (device, service) = find_remote(target)?;
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
        shared.reset_rc003_output();

        let transmit = find_characteristic(&service, TRANSMIT_UUID, "transmit")?;
        let audio = find_characteristic(&service, AUDIO_UUID, "audio")?;
        let control = find_characteristic(&service, CONTROL_UUID, "control")?;
        let (command_tx, commands) = mpsc::channel();

        let audio_token = watch_packets(
            &audio,
            Arc::clone(&shared),
            "audio packets",
            handle_audio_packet,
        )?;
        let control_token = watch_packets(
            &control,
            Arc::clone(&shared),
            "voice controls",
            move |shared, bytes| {
                if let Some(command) = handle_control_packet(shared, bytes) {
                    let _ = command_tx.send(command);
                }
            },
        )?;

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
            if !shared.driver_connected() {
                return Err(
                    "Quarbor virtual microphone control connection became unavailable".into(),
                );
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

fn find_remote(
    target_bluetooth_address: Option<&str>,
) -> Result<(BluetoothLEDevice, GattDeviceService), String> {
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
        if !approved_remote_service_id(&id.to_string(), target_bluetooth_address) {
            continue;
        }
        let name = info
            .Name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let result = (|| {
            // A service can be shared with the HID side of the remote. The
            // default sharing mode is left unspecified by Windows and can
            // produce a null object (reported as HRESULT 0) on those paths.
            let service = GattDeviceService::FromIdWithSharingModeAsync(
                &id,
                GattSharingMode::SharedReadAndWrite,
            )?
            .get()?;
            // The service already owns the BluetoothLEDevice for the same
            // instance. Re-opening it from GattSession.DeviceId() is not
            // equivalent: that ID is a Bluetooth device ID on some Windows
            // builds and a service/session ID on others.
            let device = service.Device()?;
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

fn approved_remote_service_id(id: &str, target_bluetooth_address: Option<&str>) -> bool {
    // Windows GATT instance paths retain the hardware identity even when the
    // device has a localized or user-chosen Bluetooth name.
    let normalized = id.to_ascii_lowercase();
    let approved = normalized.contains("_vid&012717_pid&32b8_")
        // Newer Windows Bluetooth stacks expose the same service below the
        // address-only BTHLE\DEV_* parent (for example C05D39C2CF83).
        || (normalized.contains(
            "bthledevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}_dev_",
        ) && !normalized.contains("_vid&")
            && !normalized.contains("_pid&"));
    if !approved {
        return false;
    }
    let Some(target) = target_bluetooth_address else {
        return true;
    };
    let compact: String = target
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    compact.len() == 12 && normalized.contains(&compact)
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

fn watch_packets(
    characteristic: &GattCharacteristic,
    shared: Arc<Shared>,
    name: &str,
    handle: impl Fn(&Shared, &[u8]) + Send + 'static,
) -> Result<i64, String> {
    let handler = TypedEventHandler::<GattCharacteristic, GattValueChangedEventArgs>::new(
        move |_, args| {
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            match event_bytes(args) {
                Ok(bytes) => handle(&shared, &bytes),
                Err(error) => {
                    log::warn!(target: "axonkey::audio", "Cannot read RC003 voice notification: {error}")
                }
            }
            Ok(())
        },
    );
    characteristic
        .ValueChanged(&handler)
        .map_err(|error| format!("Cannot watch RC003 {name}: {error}"))
}

fn event_bytes(args: &GattValueChangedEventArgs) -> windows::core::Result<Vec<u8>> {
    let buffer: IBuffer = args.CharacteristicValue()?;
    let reader = DataReader::FromBuffer(&buffer)?;
    let mut bytes = vec![0; reader.UnconsumedBufferLength()? as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(bytes)
}

fn handle_control_packet(shared: &Shared, bytes: &[u8]) -> Option<Vec<u8>> {
    let opcode = *bytes.first()?;
    if !shared.a15_active.load(Ordering::Acquire) {
        shared.diagnostics.control(opcode);
    }
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
                || !shared.driver_connected()
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
                shared.reset_rc003_output();
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
        status.received_data = true;
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
    for frame in frames {
        shared.enqueue_pcm(false, &frame);
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
    use super::{approved_remote_service_id, AudioService, Ordering, Shared};
    use crate::windows_vmic::{DriverSnapshot, DriverStatus};

    fn ready_driver() -> DriverSnapshot {
        DriverSnapshot {
            installed: true,
            connected: true,
            status: Some(DriverStatus {
                capture_active: 1,
                capture_state: 3,
                ..Default::default()
            }),
            error: None,
            ..Default::default()
        }
    }

    #[test]
    fn recording_indicator_tracks_a15_control_and_rc003_forwarding() {
        let shared = Shared::new(None);
        assert!(!shared.recording_indicator.is_active());
        shared.set_a15_recording(true);
        shared.update_status(|status| status.forwarding = false);
        assert!(shared.recording_indicator.is_active());
        shared.set_a15_recording(false);
        assert!(!shared.recording_indicator.is_active());
        shared.update_status(|status| status.forwarding = true);
        assert!(shared.recording_indicator.is_active());
        shared.reset_voice_session();
        assert!(!shared.recording_indicator.is_active());
    }

    #[test]
    fn dropping_audio_service_clears_its_source_and_recording_indicator() {
        let audio = AudioService::without_workers();
        let shared = Arc::clone(&audio.shared);
        audio.set_a15_recording(true);
        audio.push_a15_pcm(&[1000; 320]);
        assert_eq!(shared.source.queued_samples(), 320);
        drop(audio);
        assert_eq!(shared.source.queued_samples(), 0);
        assert!(!shared.recording_indicator.is_active());
    }

    #[test]
    fn a15_routes_without_a_playback_selection_and_status_tracks_the_driver() {
        let audio = AudioService::without_workers();
        audio.set_a15_input_state(true, true);
        assert!(!audio.status_with_driver(ready_driver()).forwarding);
        audio.push_a15_pcm(&[1000; 320]);
        let status = audio.status_with_driver(ready_driver());
        assert!(status.forwarding && status.output_ready && status.received_data);
        let stopped = DriverSnapshot {
            status: None,
            ..ready_driver()
        };
        assert!(!audio.status_with_driver(stopped).forwarding);
        let missing = DriverSnapshot::default();
        let status = audio.status_with_driver(missing);
        assert!(!status.driver_installed && !status.output_ready && !status.forwarding);
        assert_eq!(status.state, "driverMissing");
        audio.set_a15_input_state(true, false);
        assert!(audio.status_with_driver(ready_driver()).bluetooth_connected);
        assert!(!audio.status_with_driver(ready_driver()).received_data);
    }

    #[test]
    fn a15_and_rc003_own_independent_sources_and_stop_only_their_own_queue() {
        let a15 = AudioService::without_workers();
        let rc003 = AudioService::without_workers();
        a15.set_a15_recording(true);
        a15.push_a15_pcm(&[2000; 320]);
        rc003.shared.enqueue_pcm(false, &[1000; 240]);
        assert_eq!(a15.shared.source.queued_samples(), 320);
        assert_eq!(rc003.shared.source.queued_samples(), 240);
        rc003.shared.reset_voice_session();
        assert_eq!(rc003.shared.source.queued_samples(), 0);
        assert_eq!(a15.shared.source.queued_samples(), 320);
        a15.set_a15_recording(false);
        a15.push_a15_pcm(&[3000; 320]);
        assert_eq!(a15.shared.source.queued_samples(), 0);
    }

    #[test]
    fn a15_session_rejects_rc003_frames_and_preserves_its_queue_across_ble_reset() {
        let shared = Shared::new(None);
        shared.enqueue_pcm(false, &[1000; 240]);
        shared.set_a15_recording(true);
        assert_eq!(shared.source.queued_samples(), 0);
        shared.enqueue_pcm(true, &[2000; 320]);
        shared.enqueue_pcm(false, &[3000; 240]);
        shared.reset_voice_session();
        assert_eq!(shared.source.queued_samples(), 320);
        shared.set_a15_recording(false);
        shared.enqueue_pcm(true, &[4000; 320]);
        assert_eq!(shared.source.queued_samples(), 0);
    }

    #[test]
    fn source_queue_is_bounded_and_diagnostics_keep_ungained_pcm() {
        let audio = AudioService::without_workers();
        audio.set_a15_recording(true);
        audio.set_gain_db(20).unwrap();
        for _ in 0..110 {
            audio.push_a15_pcm(&[6000; 320]);
        }
        assert_eq!(audio.shared.source.queued_samples(), 32_000);
        assert!((audio.level().peak - 6000.0 / 32768.0).abs() < 0.001);
        audio.set_enabled(false);
        assert_eq!(audio.shared.source.queued_samples(), 0);
        audio.push_a15_pcm(&[6000; 320]);
        assert_eq!(audio.shared.source.queued_samples(), 0);
        assert_eq!(audio.status_with_driver(ready_driver()).state, "stopped");
    }

    use std::sync::Arc;

    #[test]
    fn legacy_service_does_not_duplicate_saved_instances_bluetooth_sessions() {
        let legacy = AudioService::start();
        assert!(legacy.ble_worker.lock().unwrap().is_none());
        assert!(!legacy.shared.enabled.load(Ordering::Acquire));
    }

    #[test]
    fn selects_rc003_voice_service_by_hardware_identity() {
        let id = r"\\?\BTHLEDevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}_Dev_VID&012717_PID&32b8_REV&00a4_001122334455#device";
        assert!(approved_remote_service_id(id, None));
        assert!(approved_remote_service_id(id, Some("00:11:22:33:44:55")));
        assert!(approved_remote_service_id(&id.to_ascii_uppercase(), None));
        assert!(!approved_remote_service_id(
            &id.replace("012717", "01046D"),
            None
        ));
        assert!(!approved_remote_service_id(
            &id.replace("32b8", "32b9"),
            None
        ));
        assert!(!approved_remote_service_id(
            &id.replace("32b8", "32b80"),
            None
        ));
        assert!(!approved_remote_service_id("RC003", None));
    }

    #[test]
    fn accepts_address_only_rc003_voice_service_instance() {
        let id = r"\\?\BTHLEDevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}_Dev_C05D39C2CF83#device";
        assert!(approved_remote_service_id(id, None));
        assert!(approved_remote_service_id(id, Some("C0:5D:39:C2:CF:83")));
        assert!(!approved_remote_service_id(id, Some("AA:BB:CC:DD:EE:FF")));
        assert!(!approved_remote_service_id(
            r"\\?\BTHLEDevice#{0000180f-0000-1000-8000-00805f9b34fb}_Dev_C05D39C2CF83#device",
            None
        ));
    }
}
