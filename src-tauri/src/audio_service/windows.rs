use super::{
    atvv::AtvvDecoder,
    clamp_gain_db,
    diagnostics::AudioDiagnostics,
    endpoint_config,
    endpoint_selection::{
        select_render_endpoint, AudioEndpoint, EndpointBinding, EndpointSelectionError,
    },
    windows_endpoints::enumerate_endpoints,
    AudioOutputStatus, AudioServiceStatus,
};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SampleFormat, SizedSample, StreamConfig, I24, U24,
};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
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
    output_generation: AtomicU64,
    binding: Mutex<Option<EndpointBinding>>,
}

impl Shared {
    fn new() -> Self {
        let mut protocol = VoiceProtocolState::default();
        protocol.reset_connection();
        Self {
            diagnostics: AudioDiagnostics::default(),
            status: Mutex::new(AudioServiceStatus {
                state: "stopped".into(),
                output: Some(AudioOutputStatus {
                    state: "switching".into(),
                    ..Default::default()
                }),
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
            output_generation: AtomicU64::new(0),
            binding: Mutex::new(None),
        }
    }

    fn update_status(&self, update: impl FnOnce(&mut AudioServiceStatus)) {
        if let Ok(mut status) = self.status.lock() {
            update(&mut status);
            status.event_version = status.event_version.wrapping_add(1);
        }
    }

    fn output_available(&self) -> bool {
        self.status
            .lock()
            .map(|status| status.output_ready)
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
            status.received_data = false;
            if status.output_ready && status.bluetooth_connected {
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
    output_commands: Sender<OutputCommand>,
}

enum OutputCommand {
    Select {
        render_id: String,
        capture_id: Option<String>,
        reply: Sender<Result<(), String>>,
    },
    Clear {
        reply: Sender<Result<(), String>>,
    },
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEndpointInventory {
    endpoints: Vec<AudioEndpoint>,
    binding: Option<EndpointBinding>,
    output: AudioOutputStatus,
    error: Option<String>,
}

impl AudioService {
    pub fn level(&self) -> super::AudioLevel {
        self.shared.diagnostics.level()
    }

    pub fn start(config_path: PathBuf) -> Self {
        log::info!(target: "axonkey::audio", "Starting Windows audio service");
        let shared = Arc::new(Shared::new());
        let audio_shared = Arc::clone(&shared);
        let (output_commands, output_requests) = mpsc::channel();
        let audio_worker = thread::Builder::new()
            .name("Axonkey CABLE audio output".into())
            .spawn(move || audio_output_loop(audio_shared, config_path, output_requests))
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
            output_commands,
        }
    }

    pub fn refresh(&self) {
        let status = self.status();
        log::debug!(target: "axonkey::audio", "Refreshing Windows audio state");
        self.shared.audio_refresh.store(true, Ordering::Release);
        if status.output_ready && !status.bluetooth_connected {
            self.shared.ble_refresh.store(true, Ordering::Release);
        }
    }

    pub fn endpoints(&self) -> AudioEndpointInventory {
        let (endpoints, error) = match enumerate_endpoints() {
            Ok(endpoints) => (endpoints, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        AudioEndpointInventory {
            endpoints,
            binding: self
                .shared
                .binding
                .lock()
                .ok()
                .and_then(|binding| binding.clone()),
            output: self.status().output.unwrap_or_default(),
            error,
        }
    }

    pub fn select_endpoint(
        &self,
        render_id: String,
        capture_id: Option<String>,
    ) -> Result<AudioServiceStatus, String> {
        let (reply, receiver) = mpsc::channel();
        self.output_commands
            .send(OutputCommand::Select {
                render_id,
                capture_id,
                reply,
            })
            .map_err(|_| "音频工作线程不可用".to_string())?;
        receiver
            .recv()
            .map_err(|_| "音频工作线程已停止".to_string())??;
        Ok(self.status())
    }

    pub fn clear_endpoint(&self) -> Result<AudioServiceStatus, String> {
        let (reply, receiver) = mpsc::channel();
        self.output_commands
            .send(OutputCommand::Clear { reply })
            .map_err(|_| "音频工作线程不可用".to_string())?;
        receiver
            .recv()
            .map_err(|_| "音频工作线程已停止".to_string())??;
        Ok(self.status())
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

fn output_error(state: &str, error: impl Into<String>) -> EndpointSelectionError {
    EndpointSelectionError {
        state: state.into(),
        error: error.into(),
    }
}

fn publish_output_error(shared: &Shared, error: &EndpointSelectionError) {
    shared.update_status(|status| {
        status.output_ready = false;
        status.forwarding = false;
        let output = status.output.get_or_insert_with(Default::default);
        if output.state != error.state || output.error.as_deref() != Some(&error.error) {
            log::warn!(target: "axonkey::audio", "Windows audio output {}: {}", error.state, error.error);
        }
        output.state = error.state.clone();
        output.error = Some(error.error.clone());
    });
}

fn publish_endpoint(
    shared: &Shared,
    endpoint: &AudioEndpoint,
    endpoints: &[AudioEndpoint],
    binding: &EndpointBinding,
) {
    let capture = binding
        .capture_endpoint_id
        .as_ref()
        .and_then(|id| endpoints.iter().find(|endpoint| &endpoint.id == id));
    shared.update_status(|status| {
        if shared.output_failed.load(Ordering::Acquire) {
            return;
        }
        status.output_ready = true;
        status.output = Some(AudioOutputStatus {
            state: "ready".into(),
            selected_endpoint_id: Some(endpoint.id.clone()),
            selected_endpoint_name: Some(endpoint.name.clone()),
            capture_endpoint_id: binding.capture_endpoint_id.clone(),
            capture_endpoint_name: capture.map(|endpoint| endpoint.name.clone()),
            error: None,
        });
    });
    log::info!(target: "axonkey::audio", "Windows audio output ready: {} (bound by endpoint ID)", endpoint.name);
}

fn stop_output(shared: &Shared, stream: &mut Option<cpal::Stream>) {
    if stream.is_some() {
        shared.ble_refresh.store(true, Ordering::Release);
    }
    shared.output_generation.fetch_add(1, Ordering::AcqRel);
    shared.update_status(|status| {
        status.output_ready = false;
        status.forwarding = false;
    });
    // Make callbacks from the old stream obsolete before dropping it.
    *stream = None;
    shared.output_failed.store(false, Ordering::Release);
    shared.reset_voice_session();
}

fn make_binding(
    endpoint: &AudioEndpoint,
    endpoints: &[AudioEndpoint],
    capture_id: Option<String>,
) -> Result<EndpointBinding, EndpointSelectionError> {
    let captures: Vec<_> = endpoints
        .iter()
        .filter(|candidate| {
            candidate.direction == "capture"
                && candidate.adapter_id == endpoint.adapter_id
                && candidate.state == "active"
        })
        .collect();
    let capture_id = match capture_id {
        Some(id) => {
            if !captures.iter().any(|candidate| candidate.id == id) {
                return Err(output_error(
                    "endpointUnavailable",
                    "录音端必须是同一虚拟声卡上可用的录音设备",
                ));
            }
            Some(id)
        }
        None if captures.len() == 1 => Some(captures[0].id.clone()),
        None => None,
    };
    Ok(EndpointBinding {
        schema_version: 1,
        render_endpoint_id: endpoint.id.clone(),
        capture_endpoint_id: capture_id,
        adapter_instance_id: endpoint.adapter_id.clone(),
    })
}

type PreparedOutput = (cpal::Device, StreamConfig, SampleFormat);

fn prepare_output(endpoint: &AudioEndpoint) -> Result<PreparedOutput, EndpointSelectionError> {
    let host = cpal::host_from_id(cpal::HostId::Wasapi)
        .map_err(|error| output_error("enumerationFailed", format!("无法访问 WASAPI：{error}")))?;
    let devices = host
        .output_devices()
        .map_err(|error| output_error("enumerationFailed", format!("无法枚举播放设备：{error}")))?;
    let device = devices
        .into_iter()
        .find(|device| device.id().is_ok_and(|id| id.id() == endpoint.id))
        .ok_or_else(|| output_error("endpointUnavailable", "所选播放端已不可用，请重新检测"))?;
    let supported = device.default_output_config().map_err(|error| {
        output_error(
            "unsupportedFormat",
            format!("无法读取所选设备的音频格式：{error}"),
        )
    })?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    if config.channels == 0 || config.sample_rate == 0 {
        return Err(output_error(
            "unsupportedFormat",
            "所选设备没有有效的声道或采样率",
        ));
    }
    Ok((device, config, sample_format))
}

fn start_output(
    shared: Arc<Shared>,
    prepared: PreparedOutput,
) -> Result<cpal::Stream, EndpointSelectionError> {
    let (device, config, sample_format) = prepared;
    log::info!(target: "axonkey::audio", "Windows audio output format: sample_rate={} channels={} sample_format={sample_format:?} source_sample_rate={SOURCE_SAMPLE_RATE}", config.sample_rate, config.channels);
    let (stream, startup) = match sample_format {
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
        unsupported => {
            return Err(output_error(
                "unsupportedFormat",
                format!("所选设备使用不支持的采样格式：{unsupported}"),
            ))
        }
    }
    .map_err(|error| output_error("openFailed", error))?;
    stream
        .play()
        .map_err(|error| output_error("openFailed", format!("无法启动所选播放设备：{error}")))?;
    // WASAPI play() enqueues a command. Only a real callback confirms that
    // IAudioClient::Start succeeded; never persist a queued but failed start.
    wait_for_output_start(startup, Duration::from_secs(5))?;
    Ok(stream)
}

fn wait_for_output_start(
    startup: Receiver<Result<(), String>>,
    timeout: Duration,
) -> Result<(), EndpointSelectionError> {
    startup
        .recv_timeout(timeout)
        .map_err(|error| output_error("openFailed", format!("等待音频设备启动失败：{error}")))?
        .map_err(|error| output_error("openFailed", error))
}

fn audio_output_loop(shared: Arc<Shared>, config_path: PathBuf, requests: Receiver<OutputCommand>) {
    let (mut binding, mut config_error) = match endpoint_config::load(&config_path) {
        Ok(binding) => (binding, None),
        Err(error) => (None, Some(error)),
    };
    *shared.binding.lock().unwrap() = binding.clone();
    if let Some(binding) = &binding {
        shared.update_status(|status| {
            let output = status.output.as_mut().unwrap();
            output.selected_endpoint_id = Some(binding.render_endpoint_id.clone());
            output.capture_endpoint_id = binding.capture_endpoint_id.clone();
        });
    }
    let mut automatic_allowed = config_error.is_none();
    let mut stream = None;
    let mut next_probe = Instant::now();
    while !shared.stop.load(Ordering::Acquire) {
        if shared.output_failed.swap(false, Ordering::AcqRel) {
            stop_output(&shared, &mut stream);
            next_probe = Instant::now() + RETRY_DELAY;
        }
        if shared.audio_refresh.swap(false, Ordering::AcqRel) || Instant::now() >= next_probe {
            next_probe = Instant::now()
                + if stream.is_some() {
                    Duration::from_secs(5)
                } else {
                    RETRY_DELAY
                };
            match enumerate_endpoints() {
                Err(error) => {
                    // A discovery error must not tear down an otherwise healthy stream.
                    if stream.is_none() {
                        publish_output_error(&shared, &output_error("enumerationFailed", error));
                    }
                }
                Ok(endpoints) => {
                    shared.update_status(|status| status.driver_installed = !endpoints.is_empty());
                    let selection = if let Some(error) = &config_error {
                        Err(output_error("configError", error.clone()))
                    } else if binding.is_none() && !automatic_allowed {
                        Err(output_error(
                            "selectionRequired",
                            "请选择语音播放端，选择成功后会记住该设备",
                        ))
                    } else {
                        select_render_endpoint(&endpoints, binding.as_ref())
                    };
                    match selection {
                        Err(error) => {
                            if stream.is_some() {
                                stop_output(&shared, &mut stream);
                            }
                            publish_output_error(&shared, &error);
                        }
                        Ok(endpoint) if stream.is_some() => {
                            // Renames only refresh labels; identity and the healthy stream stay unchanged.
                            shared.update_status(|status| {
                                if let Some(output) = &mut status.output {
                                    output.selected_endpoint_name = Some(endpoint.name.clone());
                                    output.capture_endpoint_name =
                                        output.capture_endpoint_id.as_ref().and_then(|id| {
                                            endpoints
                                                .iter()
                                                .find(|candidate| &candidate.id == id)
                                                .map(|candidate| candidate.name.clone())
                                        });
                                }
                            });
                        }
                        Ok(endpoint) => {
                            let result = (|| {
                                let selected = match &binding {
                                    Some(binding) => binding.clone(),
                                    None => make_binding(&endpoint, &endpoints, None)?,
                                };
                                let output =
                                    start_output(Arc::clone(&shared), prepare_output(&endpoint)?)?;
                                if binding.is_none() {
                                    endpoint_config::save(&config_path, &selected)
                                        .map_err(|error| output_error("configError", error))?;
                                }
                                Ok::<_, EndpointSelectionError>((output, selected))
                            })();
                            match result {
                                Ok((output, selected)) => {
                                    binding = Some(selected.clone());
                                    *shared.binding.lock().unwrap() = binding.clone();
                                    stream = Some(output);
                                    publish_endpoint(&shared, &endpoint, &endpoints, &selected);
                                }
                                Err(error) => {
                                    stop_output(&shared, &mut stream);
                                    if error.state == "configError" {
                                        config_error = Some(error.error.clone());
                                    }
                                    publish_output_error(&shared, &error);
                                }
                            }
                        }
                    }
                }
            }
        }
        match requests.recv_timeout(Duration::from_millis(200)) {
            Ok(OutputCommand::Clear { reply }) => {
                let result = endpoint_config::clear(&config_path);
                if result.is_ok() {
                    stop_output(&shared, &mut stream);
                    binding = None;
                    *shared.binding.lock().unwrap() = None;
                    automatic_allowed = false;
                    config_error = None;
                    shared.update_status(|status| {
                        status.output = Some(AudioOutputStatus {
                            state: "selectionRequired".into(),
                            error: Some("设备选择已清除，请重新选择语音播放端".into()),
                            ..Default::default()
                        })
                    });
                }
                let _ = reply.send(result);
            }
            Ok(OutputCommand::Select {
                render_id,
                capture_id,
                reply,
            }) => {
                // Requests are processed serially; no stale async result can overwrite a later selection.
                let result = (|| {
                    let endpoints = enumerate_endpoints()
                        .map_err(|error| output_error("enumerationFailed", error))?;
                    let endpoint = endpoints
                        .iter()
                        .find(|endpoint| endpoint.id == render_id && endpoint.direction == "render")
                        .ok_or_else(|| output_error("endpointUnavailable", "所选播放端已不可用"))?;
                    let selected = make_binding(endpoint, &endpoints, capture_id)?;
                    select_render_endpoint(&endpoints, Some(&selected))?;
                    let prepared = prepare_output(endpoint)?;
                    stop_output(&shared, &mut stream);
                    shared.update_status(|status| {
                        status.output.as_mut().unwrap().state = "switching".into()
                    });
                    let opened = start_output(Arc::clone(&shared), prepared).and_then(|output| {
                        endpoint_config::save(&config_path, &selected)
                            .map_err(|error| output_error("configError", error))?;
                        Ok(output)
                    });
                    match opened {
                        Ok(output) => {
                            binding = Some(selected.clone());
                            *shared.binding.lock().unwrap() = binding.clone();
                            stream = Some(output);
                            config_error = None;
                            publish_endpoint(&shared, endpoint, &endpoints, &selected);
                            Ok(())
                        }
                        Err(error) => {
                            stop_output(&shared, &mut stream);
                            // Preserve the persisted binding and restore the old stream when possible.
                            let restored = binding.as_ref().and_then(|old| {
                                let endpoint =
                                    select_render_endpoint(&endpoints, Some(old)).ok()?;
                                let output = start_output(
                                    Arc::clone(&shared),
                                    prepare_output(&endpoint).ok()?,
                                )
                                .ok()?;
                                publish_endpoint(&shared, &endpoint, &endpoints, old);
                                Some(output)
                            });
                            stream = restored;
                            if stream.is_none() {
                                publish_output_error(&shared, &error);
                            }
                            Err(error)
                        }
                    }
                })();
                let _ = reply.send(result.map_err(|error| error.error));
                next_probe = Instant::now() + RETRY_DELAY;
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    stop_output(&shared, &mut stream);
}

fn build_output_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    shared: Arc<Shared>,
) -> Result<(cpal::Stream, Receiver<Result<(), String>>), String>
where
    T: SizedSample + Sample + FromSample<f32>,
{
    let channels = usize::from(config.channels);
    let output_rate = config.sample_rate;
    let callback_shared = Arc::clone(&shared);
    let error_shared = Arc::clone(&shared);
    let generation = shared.output_generation.load(Ordering::Acquire);
    let (startup_sender, startup) = mpsc::channel();
    let error_startup = startup_sender.clone();
    let mut startup_sender = Some(startup_sender);
    let mut cursor = OutputCursor::new(output_rate);
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                fill_output(output, channels, &mut cursor, &callback_shared);
                if let Some(sender) = startup_sender.take() { let _ = sender.send(Ok(())); }
            },
            move |error| {
                if error_shared.output_generation.load(Ordering::Acquire) != generation {
                    return;
                }
                let _ = error_startup.send(Err(format!("无法启动或维持音频播放：{error}")));
                if !error_shared.output_failed.swap(true, Ordering::AcqRel) {
                    log::warn!(target: "axonkey::audio", "Selected playback endpoint callback failed: {error}");
                }
                publish_output_error(&error_shared, &output_error("openFailed", format!("播放设备连接失败：{error}")));
            },
            None,
        )
        .map(|stream| (stream, startup))
        .map_err(|error| format!("无法打开所选播放设备：{error}"))
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
            if status.output_ready {
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
    if bytes.is_empty() || !shared.output_available() {
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
    shared.update_status(|status| status.received_data = true);
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
#[path = "windows_output_tests.rs"]
mod output_integration_tests;

#[cfg(test)]
mod tests {
    use super::{
        approved_remote_service_id, fill_output, handle_audio_packet, output_error,
        publish_output_error, OutputCursor, Shared,
    };
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
    fn output_failure_does_not_claim_the_driver_is_missing() {
        let shared = Shared::new();
        shared.update_status(|status| {
            status.driver_installed = true;
            status.output_ready = true;
        });
        publish_output_error(&shared, &output_error("openFailed", "busy"));
        let status = shared.status.lock().unwrap();
        assert!(status.driver_installed);
        assert!(!status.output_ready);
        assert_eq!(status.output.as_ref().unwrap().state, "openFailed");
    }

    #[test]
    fn received_packets_do_not_report_forwarding_without_an_output() {
        let shared = Shared::new();
        shared.protocol.lock().unwrap().capabilities_confirmed = true;
        handle_audio_packet(&shared, &[1, 2, 3]);
        assert!(!shared.status.lock().unwrap().forwarding);
        assert!(shared.samples.lock().unwrap().is_empty());
    }

    #[test]
    fn decoded_audio_updates_and_resets_received_state() {
        let shared = Shared::new();
        shared.update_status(|status| status.output_ready = true);
        {
            let mut protocol = shared.protocol.lock().unwrap();
            protocol.capabilities_confirmed = true;
            protocol.frame_size = 3;
        }
        handle_audio_packet(&shared, &[0x11, 0x22]);
        assert!(!shared.status.lock().unwrap().received_data);
        handle_audio_packet(&shared, &[0x33]);
        assert!(shared.status.lock().unwrap().received_data);
        shared.reset_voice_session();
        assert!(!shared.status.lock().unwrap().received_data);
        assert!(!shared.status.lock().unwrap().forwarding);
    }

    #[test]
    fn startup_requires_callback_success_and_rejects_async_failure_or_timeout() {
        use std::sync::mpsc;
        let (sender, receiver) = mpsc::channel();
        sender
            .send(Err("IAudioClient::Start failed".into()))
            .unwrap();
        let error = super::wait_for_output_start(receiver, Duration::ZERO).unwrap_err();
        assert_eq!(error.state, "openFailed");
        assert!(error.error.contains("Start failed"));
        let (_sender, receiver) = mpsc::channel();
        assert!(super::wait_for_output_start(receiver, Duration::ZERO).is_err());
        let (sender, receiver) = mpsc::channel();
        sender.send(Ok(())).unwrap();
        assert!(super::wait_for_output_start(receiver, Duration::ZERO).is_ok());
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
