//! Google Voice over BLE (ATVV) HTT protocol, IMA ADPCM decoder, and PCM/WAV sink for TCL RC902N/RC902V.
use std::time::{Duration, Instant};

pub(crate) const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const STREAM_STALL_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProtocolVersion {
    V04,
    V10,
}

impl ProtocolVersion {
    pub(crate) fn from_wire(raw: u16) -> Result<Self, AtvvError> {
        match raw {
            0x0004 => Ok(Self::V04),
            0x0100 => Ok(Self::V10),
            other => Err(AtvvError::UnsupportedVersion(other)),
        }
    }

    pub(crate) fn wire_code(self) -> u16 {
        match self {
            Self::V04 => 0x0004,
            Self::V10 => 0x0100,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdpcmCodec {
    Adpcm8k = 0x01,
    Adpcm16k = 0x02,
}

impl AdpcmCodec {
    pub(crate) fn from_wire(raw: u8) -> Option<Self> {
        match raw {
            0x01 => Some(Self::Adpcm8k),
            0x02 => Some(Self::Adpcm16k),
            _ => None,
        }
    }

    pub(crate) fn select_preferred(mask: u8) -> Option<Self> {
        if mask & 0x02 != 0 {
            Some(Self::Adpcm16k)
        } else if mask & 0x01 != 0 {
            Some(Self::Adpcm8k)
        } else {
            None
        }
    }

    pub(crate) fn sample_rate(self) -> u32 {
        match self {
            Self::Adpcm8k => 8_000,
            Self::Adpcm16k => 16_000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InteractionModel {
    OnRequest = 0x00,
    Ptt = 0x01,
    Htt = 0x03,
}

impl InteractionModel {
    fn from_wire(raw: u8) -> Option<Self> {
        match raw {
            0x00 => Some(Self::OnRequest),
            0x01 => Some(Self::Ptt),
            0x03 => Some(Self::Htt),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum MicOpenMode {
    Playback = 0x00,
    Capture = 0x01,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Capabilities {
    pub version: ProtocolVersion,
    pub codecs_mask: u8,
    pub preferred_codec: Option<AdpcmCodec>,
    pub model: InteractionModel,
    pub raw_model: u8,
    pub frame_size: u16,
    pub extra: u8,
    pub vendor_data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AtvvError {
    EmptyPacket,
    Truncated {
        opcode: u8,
        len: usize,
        min: usize,
    },
    UnsupportedVersion(u16),
    UnsupportedModel {
        version: ProtocolVersion,
        raw_model: u8,
    },
    NoSupportedCodec(u8),
    InvalidFrameSize,
}

impl std::fmt::Display for AtvvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyPacket => write!(f, "ATVV control notification is empty"),
            Self::Truncated { opcode, len, min } => write!(
                f,
                "ATVV opcode 0x{opcode:02x} truncated ({len} bytes, expected >= {min})"
            ),
            Self::UnsupportedVersion(version) => write!(
                f,
                "Unsupported ATVV protocol version 0x{version:04x}; stopping without blind writes"
            ),
            Self::UnsupportedModel { version, raw_model } => write!(
                f,
                "TCL RC902 requires ATVV HTT mode (0x03), remote reported version=0x{:04x} model=0x{raw_model:02x}",
                version.wire_code()
            ),
            Self::NoSupportedCodec(mask) => {
                write!(f, "TCL RC902 offered no supported ADPCM codec (mask=0x{mask:02x})")
            }
            Self::InvalidFrameSize => write!(f, "TCL RC902 reported zero ATVV frame_size"),
        }
    }
}

pub(crate) struct AtvvV10;

impl AtvvV10 {
    pub(crate) fn get_caps() -> [u8; 6] {
        // 0x0A + v1.0 (0x0100) + legacy constant (0x0003) + On-request/PTT/HTT (0x03).
        [0x0a, 0x01, 0x00, 0x00, 0x03, 0x03]
    }

    #[allow(dead_code)]
    pub(crate) fn mic_open(mode: MicOpenMode) -> [u8; 2] {
        [0x0c, mode as u8]
    }

    pub(crate) fn mic_close(stream_id: u8) -> [u8; 2] {
        [0x0d, stream_id]
    }

    pub(crate) fn mic_extend(stream_id: u8) -> [u8; 2] {
        [0x0e, stream_id]
    }

    pub(crate) fn parse_caps_resp(bytes: &[u8]) -> Result<Capabilities, AtvvError> {
        if bytes.len() < 9 {
            return Err(AtvvError::Truncated {
                opcode: 0x0b,
                len: bytes.len(),
                min: 9,
            });
        }
        let codecs_mask = bytes[3];
        let raw_model = bytes[4];
        let model = InteractionModel::from_wire(raw_model).unwrap_or(InteractionModel::OnRequest);
        let frame_size = u16::from_be_bytes([bytes[5], bytes[6]]);
        Ok(Capabilities {
            version: ProtocolVersion::V10,
            codecs_mask,
            preferred_codec: AdpcmCodec::select_preferred(codecs_mask),
            model,
            raw_model,
            frame_size,
            extra: bytes[7],
            vendor_data: bytes[9..].to_vec(),
        })
    }
}

pub(crate) struct AtvvV04;

impl AtvvV04 {
    #[allow(dead_code)]
    pub(crate) fn mic_open(codec: AdpcmCodec) -> [u8; 3] {
        [0x0c, 0x00, codec as u8]
    }

    pub(crate) fn mic_close() -> [u8; 1] {
        [0x0d]
    }

    pub(crate) fn parse_caps_resp(bytes: &[u8]) -> Result<Capabilities, AtvvError> {
        if bytes.len() < 7 {
            return Err(AtvvError::Truncated {
                opcode: 0x0b,
                len: bytes.len(),
                min: 7,
            });
        }
        // v0.4e encodes supported codecs as a 16-bit big-endian bitmask in bytes 3..=4.
        let codecs_u16 = u16::from_be_bytes([bytes[3], bytes[4]]);
        let codecs_mask = (codecs_u16 & 0x00ff) as u8 | ((codecs_u16 >> 8) as u8 & 0x03);
        let frame_size = u16::from_be_bytes([bytes[5], bytes[6]]);
        Ok(Capabilities {
            version: ProtocolVersion::V04,
            codecs_mask,
            preferred_codec: AdpcmCodec::select_preferred(codecs_mask),
            model: InteractionModel::OnRequest,
            raw_model: 0x00,
            frame_size,
            extra: 0,
            vendor_data: bytes[7..].to_vec(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ControlEvent {
    AudioStop {
        reason: u8,
    },
    AudioStart {
        reason: u8,
        codec: u8,
        stream_id: u8,
    },
    StartSearch,
    AudioSync {
        codec: u8,
        frame_no: u16,
        predictor: i16,
        step_index: u8,
    },
    CapsResp(Capabilities),
    MicOpenError {
        code: u16,
    },
    Unknown {
        opcode: u8,
        raw: Vec<u8>,
    },
}

impl ControlEvent {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, AtvvError> {
        let Some(&opcode) = bytes.first() else {
            return Err(AtvvError::EmptyPacket);
        };
        match opcode {
            0x00 => Ok(Self::AudioStop {
                reason: bytes.get(1).copied().unwrap_or(0),
            }),
            0x04 => {
                if bytes.len() < 4 {
                    return Err(AtvvError::Truncated {
                        opcode,
                        len: bytes.len(),
                        min: 4,
                    });
                }
                Ok(Self::AudioStart {
                    reason: bytes[1],
                    codec: bytes[2],
                    stream_id: bytes[3],
                })
            }
            0x08 => Ok(Self::StartSearch),
            // 0x0A on CTL is AUDIO_SYNC (distinct from 0x0A GET_CAPS written to TX).
            0x0a => {
                if bytes.len() < 7 {
                    return Err(AtvvError::Truncated {
                        opcode,
                        len: bytes.len(),
                        min: 7,
                    });
                }
                Ok(Self::AudioSync {
                    codec: bytes[1],
                    frame_no: u16::from_be_bytes([bytes[2], bytes[3]]),
                    predictor: i16::from_be_bytes([bytes[4], bytes[5]]),
                    step_index: bytes[6],
                })
            }
            0x0b => {
                if bytes.len() < 3 {
                    return Err(AtvvError::Truncated {
                        opcode,
                        len: bytes.len(),
                        min: 3,
                    });
                }
                let raw_version = u16::from_be_bytes([bytes[1], bytes[2]]);
                let caps = match ProtocolVersion::from_wire(raw_version)? {
                    ProtocolVersion::V10 => AtvvV10::parse_caps_resp(bytes)?,
                    ProtocolVersion::V04 => AtvvV04::parse_caps_resp(bytes)?,
                };
                Ok(Self::CapsResp(caps))
            }
            0x0c => {
                if bytes.len() < 3 {
                    return Err(AtvvError::Truncated {
                        opcode,
                        len: bytes.len(),
                        min: 3,
                    });
                }
                Ok(Self::MicOpenError {
                    code: u16::from_be_bytes([bytes[1], bytes[2]]),
                })
            }
            _ => Ok(Self::Unknown {
                opcode,
                raw: bytes.to_vec(),
            }),
        }
    }
}

pub(crate) fn describe_mic_open_error(code: u16) -> String {
    match code {
        0x0f02 => "RC902V MIC_OPEN_ERROR 0x0F02: remote is not active".into(),
        0x0f03 => {
            "RC902V MIC_OPEN_ERROR 0x0F03: audio notifications are not enabled (check AUDIO CCCD)"
                .into()
        }
        0x0f80 => "RC902V MIC_OPEN_ERROR 0x0F80: PTT/HTT voice session already active".into(),
        0x0fff => "RC902V MIC_OPEN_ERROR 0x0FFF: remote internal microphone error".into(),
        other => format!("RC902V MIC_OPEN_ERROR 0x{other:04X}"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionState {
    Disconnected,
    Subscribed,
    Negotiating,
    Ready,
    Streaming,
    Stopping,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionEvent {
    Capabilities(Capabilities),
    SessionStarted { stream_id: u8, sample_rate: u32 },
    PcmChunk { sample_rate: u32, samples: Vec<i16> },
    SessionStopped { stream_id: u8, reason: u8 },
    Error(String),
    Disconnected,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SessionAction {
    pub tx_commands: Vec<Vec<u8>>,
    pub events: Vec<SessionEvent>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SessionStats {
    pub audio_packets: usize,
    pub audio_bytes: usize,
    pub min_packet_len: usize,
    pub max_packet_len: usize,
    pub decoded_samples: usize,
    pub sync_gaps: usize,
    pub dropped_non_streaming_packets: usize,
}

pub(crate) struct AtvvSession {
    state: SessionState,
    capabilities: Option<Capabilities>,
    active_codec: AdpcmCodec,
    active_stream_id: Option<u8>,
    closing_stream_id: Option<u8>,
    negotiating_since: Option<Instant>,
    stream_started_at: Option<Instant>,
    last_audio_at: Option<Instant>,
    last_keepalive_at: Option<Instant>,
    decoder: ImaAdpcmDecoder,
    stats: SessionStats,
}

impl Default for AtvvSession {
    fn default() -> Self {
        Self {
            state: SessionState::Disconnected,
            capabilities: None,
            active_codec: AdpcmCodec::Adpcm16k,
            active_stream_id: None,
            closing_stream_id: None,
            negotiating_since: None,
            stream_started_at: None,
            last_audio_at: None,
            last_keepalive_at: None,
            decoder: ImaAdpcmDecoder::default(),
            stats: SessionStats::default(),
        }
    }
}

impl AtvvSession {
    #[cfg(test)]
    pub(crate) fn state(&self) -> SessionState {
        self.state
    }

    pub(crate) fn stats(&self) -> SessionStats {
        self.stats
    }

    #[cfg(test)]
    pub(crate) fn active_stream_id(&self) -> Option<u8> {
        self.active_stream_id
    }

    pub(crate) fn begin_negotiation(&mut self, now: Instant) -> SessionAction {
        self.decoder.reset_session();
        self.capabilities = None;
        self.active_stream_id = None;
        self.closing_stream_id = None;
        self.stream_started_at = None;
        self.last_audio_at = None;
        self.last_keepalive_at = None;
        self.stats = SessionStats::default();
        self.state = SessionState::Subscribed;
        self.state = SessionState::Negotiating;
        self.negotiating_since = Some(now);
        SessionAction {
            tx_commands: vec![AtvvV10::get_caps().to_vec()],
            events: Vec::new(),
        }
    }

    pub(crate) fn handle_control(&mut self, bytes: &[u8], now: Instant) -> SessionAction {
        let mut out = SessionAction::default();
        let parsed = match ControlEvent::parse(bytes) {
            Ok(event) => event,
            Err(error) => {
                if matches!(error, AtvvError::UnsupportedVersion(_)) {
                    self.abort_into_error(error.to_string(), &mut out);
                } else {
                    out.events.push(SessionEvent::Error(error.to_string()));
                }
                return out;
            }
        };

        match parsed {
            ControlEvent::CapsResp(caps) => self.on_capabilities(caps, &mut out),
            ControlEvent::StartSearch => {
                // RC902V runs strictly in HTT (Hold-to-Talk); never send MIC_OPEN for click/on-request search.
                log::debug!(
                    target: "axonkey::audio",
                    "RC902V ignored START_SEARCH (0x08) because HTT-only mode is active"
                );
            }
            ControlEvent::AudioStart {
                reason,
                codec,
                stream_id,
            } => self.on_audio_start(reason, codec, stream_id, now, &mut out),
            ControlEvent::AudioSync {
                codec,
                frame_no,
                predictor,
                step_index,
            } => self.on_audio_sync(codec, frame_no, predictor, step_index),
            ControlEvent::AudioStop { reason } => self.on_audio_stop(reason, &mut out),
            ControlEvent::MicOpenError { code } => {
                let message = describe_mic_open_error(code);
                if let Some(stream_id) = self.active_stream_id.take() {
                    self.clear_stream_timers();
                    self.decoder.reset_session();
                    out.events.push(SessionEvent::SessionStopped {
                        stream_id,
                        reason: 0x80,
                    });
                }
                if self.capabilities.is_some() {
                    self.state = SessionState::Ready;
                } else {
                    self.state = SessionState::Error;
                }
                out.events.push(SessionEvent::Error(message));
            }
            ControlEvent::Unknown { opcode, raw } => {
                log::debug!(
                    target: "axonkey::audio",
                    "RC902V unhandled ATVV CTL opcode=0x{opcode:02x} len={} hex={}",
                    raw.len(),
                    hex_bytes(&raw)
                );
            }
        }
        out
    }

    pub(crate) fn handle_audio(&mut self, bytes: &[u8], now: Instant) -> SessionAction {
        let mut out = SessionAction::default();
        if bytes.is_empty() {
            return out;
        }
        if self.state != SessionState::Streaming {
            self.stats.dropped_non_streaming_packets += 1;
            return out;
        }
        let Some(caps) = &self.capabilities else {
            self.stats.dropped_non_streaming_packets += 1;
            return out;
        };
        let frame_size = usize::from(caps.frame_size).max(1);
        self.last_audio_at = Some(now);
        self.stats.audio_packets += 1;
        self.stats.audio_bytes += bytes.len();
        self.stats.min_packet_len = if self.stats.min_packet_len == 0 {
            bytes.len()
        } else {
            self.stats.min_packet_len.min(bytes.len())
        };
        self.stats.max_packet_len = self.stats.max_packet_len.max(bytes.len());

        let sample_rate = self.active_codec.sample_rate();
        for samples in self.decoder.append(bytes, frame_size) {
            self.stats.decoded_samples += samples.len();
            out.events.push(SessionEvent::PcmChunk {
                sample_rate,
                samples,
            });
        }
        self.stats.sync_gaps = self.decoder.sync_gaps();
        out
    }

    pub(crate) fn close_stream(&mut self, target_stream_id: u8) -> Option<SessionAction> {
        let current = self.active_stream_id?;
        if target_stream_id != 0xff && target_stream_id != current {
            return None;
        }
        let version = self
            .capabilities
            .as_ref()
            .map_or(ProtocolVersion::V10, |caps| caps.version);
        let command = encode_mic_close(version, current);
        self.active_stream_id = None;
        self.closing_stream_id = Some(current);
        self.clear_stream_timers();
        self.decoder.reset_session();
        self.state = SessionState::Stopping;
        Some(SessionAction {
            tx_commands: vec![command],
            events: vec![SessionEvent::SessionStopped {
                stream_id: current,
                reason: 0x00,
            }],
        })
    }

    pub(crate) fn abort_active_stream(&mut self) -> Option<SessionAction> {
        let current = self.active_stream_id?;
        self.close_stream(current)
    }

    pub(crate) fn poll_timers(&mut self, now: Instant) -> SessionAction {
        let mut out = SessionAction::default();
        if self.state == SessionState::Negotiating
            && self.negotiating_since.is_some_and(|started| {
                now.saturating_duration_since(started) >= NEGOTIATION_TIMEOUT
            })
        {
            self.negotiating_since = None;
            self.state = SessionState::Error;
            out.events.push(SessionEvent::Error(
                "TCL RC902 ATVV capability negotiation timed out waiting for CAPS_RESP".into(),
            ));
            return out;
        }

        if self.state == SessionState::Streaming {
            let reference = self.last_audio_at.or(self.stream_started_at).unwrap_or(now);
            if now.saturating_duration_since(reference) >= STREAM_STALL_TIMEOUT {
                if let Some(mut closed) = self.abort_active_stream() {
                    self.state = SessionState::Ready;
                    out.tx_commands.append(&mut closed.tx_commands);
                    out.events.append(&mut closed.events);
                }
                out.events.push(SessionEvent::Error(
                    "TCL RC902 voice stream timed out without receiving audio packets".into(),
                ));
                return out;
            }

            if self
                .capabilities
                .as_ref()
                .is_some_and(|caps| caps.version == ProtocolVersion::V10)
                && self
                    .last_keepalive_at
                    .is_some_and(|last| now.saturating_duration_since(last) >= KEEPALIVE_INTERVAL)
            {
                if let Some(stream_id) = self.active_stream_id {
                    self.last_keepalive_at = Some(now);
                    out.tx_commands
                        .push(AtvvV10::mic_extend(stream_id).to_vec());
                }
            }
        }
        out
    }

    pub(crate) fn disconnect(&mut self) -> SessionAction {
        let mut out = SessionAction::default();
        if let Some(stream_id) = self.active_stream_id.take() {
            out.events.push(SessionEvent::SessionStopped {
                stream_id,
                reason: 0x80,
            });
        }
        self.capabilities = None;
        self.closing_stream_id = None;
        self.negotiating_since = None;
        self.clear_stream_timers();
        self.decoder.reset_session();
        self.state = SessionState::Disconnected;
        out.events.push(SessionEvent::Disconnected);
        out
    }

    fn on_capabilities(&mut self, caps: Capabilities, out: &mut SessionAction) {
        self.negotiating_since = None;
        if caps.version != ProtocolVersion::V10 || caps.model != InteractionModel::Htt {
            let error = AtvvError::UnsupportedModel {
                version: caps.version,
                raw_model: caps.raw_model,
            };
            self.abort_into_error(error.to_string(), out);
            return;
        }
        if caps.frame_size == 0 {
            self.abort_into_error(AtvvError::InvalidFrameSize.to_string(), out);
            return;
        }
        let Some(preferred_codec) = caps.preferred_codec else {
            self.abort_into_error(
                AtvvError::NoSupportedCodec(caps.codecs_mask).to_string(),
                out,
            );
            return;
        };
        self.active_codec = preferred_codec;
        self.capabilities = Some(caps.clone());
        self.state = SessionState::Ready;
        out.events.push(SessionEvent::Capabilities(caps));
    }

    fn on_audio_start(
        &mut self,
        reason: u8,
        raw_codec: u8,
        stream_id: u8,
        now: Instant,
        out: &mut SessionAction,
    ) {
        let Some(caps) = self.capabilities.as_ref() else {
            return;
        };
        let version = caps.version;
        if reason != InteractionModel::Htt as u8 {
            out.tx_commands.push(encode_mic_close(version, stream_id));
            out.events.push(SessionEvent::Error(format!(
                "TCL RC902 rejected non-HTT AUDIO_START reason=0x{reason:02x} stream_id={stream_id}"
            )));
            return;
        }
        let Some(codec) = AdpcmCodec::from_wire(raw_codec) else {
            out.tx_commands.push(encode_mic_close(version, stream_id));
            out.events.push(SessionEvent::Error(format!(
                "TCL RC902 started unsupported ADPCM codec=0x{raw_codec:02x}"
            )));
            return;
        };

        // Finish any previous stream before initializing the new one so ADPCM state never mixes.
        if let Some(previous_id) = self.active_stream_id.take() {
            self.decoder.reset_session();
            out.events.push(SessionEvent::SessionStopped {
                stream_id: previous_id,
                reason: 0x04,
            });
        }

        self.decoder.reset_session();
        self.active_codec = codec;
        self.active_stream_id = Some(stream_id);
        self.closing_stream_id = None;
        self.stream_started_at = Some(now);
        self.last_audio_at = None;
        self.last_keepalive_at = Some(now);
        self.stats = SessionStats {
            dropped_non_streaming_packets: self.stats.dropped_non_streaming_packets,
            ..SessionStats::default()
        };
        self.state = SessionState::Streaming;
        out.events.push(SessionEvent::SessionStarted {
            stream_id,
            sample_rate: codec.sample_rate(),
        });
    }

    fn on_audio_sync(&mut self, raw_codec: u8, frame_no: u16, predictor: i16, step_index: u8) {
        if self.state != SessionState::Streaming {
            return;
        }
        if let Some(codec) = AdpcmCodec::from_wire(raw_codec) {
            self.active_codec = codec;
        }
        self.decoder
            .synchronize(frame_no, i32::from(predictor), i32::from(step_index));
        self.stats.sync_gaps = self.decoder.sync_gaps();
    }

    fn on_audio_stop(&mut self, reason: u8, out: &mut SessionAction) {
        // A delayed AUDIO_STOP(reason=0x00) acknowledging an earlier MIC_CLOSE must not kill a newly opened stream.
        if reason == 0x00 && self.active_stream_id.is_some() && self.closing_stream_id.is_none() {
            return;
        }
        self.closing_stream_id = None;
        if let Some(stream_id) = self.active_stream_id.take() {
            if matches!(reason, 0x00 | 0x02 | 0x04) {
                let tail = self.decoder.flush_tail();
                if !tail.is_empty() {
                    self.stats.decoded_samples += tail.len();
                    out.events.push(SessionEvent::PcmChunk {
                        sample_rate: self.active_codec.sample_rate(),
                        samples: tail,
                    });
                }
            }
            self.decoder.reset_session();
            self.clear_stream_timers();
            out.events
                .push(SessionEvent::SessionStopped { stream_id, reason });
        } else {
            self.decoder.reset_session();
            self.clear_stream_timers();
        }
        if self.capabilities.is_some() {
            self.state = SessionState::Ready;
        }
    }

    fn abort_into_error(&mut self, message: String, out: &mut SessionAction) {
        if let Some(stream_id) = self.active_stream_id.take() {
            out.events.push(SessionEvent::SessionStopped {
                stream_id,
                reason: 0x80,
            });
        }
        self.capabilities = None;
        self.closing_stream_id = None;
        self.clear_stream_timers();
        self.decoder.reset_session();
        self.state = SessionState::Error;
        out.events.push(SessionEvent::Error(message));
    }

    fn clear_stream_timers(&mut self) {
        self.stream_started_at = None;
        self.last_audio_at = None;
        self.last_keepalive_at = None;
    }
}

fn encode_mic_close(version: ProtocolVersion, stream_id: u8) -> Vec<u8> {
    match version {
        ProtocolVersion::V10 => AtvvV10::mic_close(stream_id).to_vec(),
        ProtocolVersion::V04 => AtvvV04::mic_close().to_vec(),
    }
}

pub(crate) fn hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Default)]
pub(crate) struct ImaAdpcmDecoder {
    pending: Vec<u8>,
    predictor: i32,
    step_index: i32,
    frames_decoded: u16,
    pending_sync: Option<(u16, i32, i32)>,
    sync_gaps: usize,
}

impl ImaAdpcmDecoder {
    #[cfg(target_os = "macos")]
    pub(crate) fn pending_bytes(&self) -> usize {
        self.pending.len()
    }

    pub(crate) fn sync_gaps(&self) -> usize {
        self.sync_gaps
    }

    pub(crate) fn reset_session(&mut self) {
        self.pending.clear();
        self.predictor = 0;
        self.step_index = 0;
        self.frames_decoded = 0;
        self.pending_sync = None;
        self.sync_gaps = 0;
    }

    pub(crate) fn synchronize(&mut self, frame_no: u16, predictor: i32, step_index: i32) {
        // Only drop buffered partial bytes when packets were actually lost ahead of frame_no.
        if frame_no > self.frames_decoded
            && !(frame_no == self.frames_decoded.wrapping_add(1) && !self.pending.is_empty())
        {
            self.pending.clear();
            self.frames_decoded = frame_no;
            self.sync_gaps += 1;
        }
        self.pending_sync = Some((frame_no, predictor, step_index));
    }

    pub(crate) fn append(&mut self, packet: &[u8], frame_size: usize) -> Vec<Vec<i16>> {
        let frame_size = frame_size.max(1);
        self.pending.extend_from_slice(packet);
        let frame_count = self.pending.len() / frame_size;
        if frame_count == 0 {
            return Vec::new();
        }
        let consumed = frame_count * frame_size;
        let bytes = self.pending.drain(..consumed).collect::<Vec<_>>();
        bytes
            .chunks_exact(frame_size)
            .map(|frame| {
                self.apply_pending_sync_for_current_frame();
                let samples = self.decode_bytes(frame);
                self.frames_decoded = self.frames_decoded.wrapping_add(1);
                samples
            })
            .collect()
    }

    pub(crate) fn flush_tail(&mut self) -> Vec<i16> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        self.apply_pending_sync_for_current_frame();
        let remaining = std::mem::take(&mut self.pending);
        let samples = self.decode_bytes(&remaining);
        self.frames_decoded = self.frames_decoded.wrapping_add(1);
        samples
    }

    pub(crate) fn decode_bytes(&mut self, data: &[u8]) -> Vec<i16> {
        let mut samples = Vec::with_capacity(data.len() * 2);
        for &byte in data {
            // ATVV IMA ADPCM decodes the high nibble [7:4] first, then the low nibble [3:0].
            samples.push(self.decode_nibble(i32::from(byte >> 4)));
            samples.push(self.decode_nibble(i32::from(byte & 0x0f)));
        }
        samples
    }

    fn apply_pending_sync_for_current_frame(&mut self) {
        if let Some((target_frame, predictor, step_index)) = self.pending_sync {
            if target_frame <= self.frames_decoded {
                self.predictor = predictor.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
                self.step_index = step_index.clamp(0, 88);
                self.pending_sync = None;
            }
        }
    }

    fn decode_nibble(&mut self, nibble: i32) -> i16 {
        const STEP_TABLE: [i32; 89] = [
            7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55,
            60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
            337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
            1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
            5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
            20350, 22385, 24623, 27086, 29794, 32767,
        ];
        const INDEX_TABLE: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

        let step = STEP_TABLE[self.step_index as usize];
        let mut difference = step >> 3;
        if nibble & 1 != 0 {
            difference += step >> 2;
        }
        if nibble & 2 != 0 {
            difference += step >> 1;
        }
        if nibble & 4 != 0 {
            difference += step;
        }
        self.predictor += if nibble & 8 != 0 {
            -difference
        } else {
            difference
        };
        self.predictor = self
            .predictor
            .clamp(i32::from(i16::MIN), i32::from(i16::MAX));
        self.step_index = (self.step_index + INDEX_TABLE[(nibble & 7) as usize]).clamp(0, 88);
        self.predictor as i16
    }
}

/// Resamples 8 kHz mono PCM to 16 kHz mono PCM for virtual microphone backends fixed at 16 kHz.
pub(crate) fn upsample_8k_to_16k(samples: &[i16], previous_sample: &mut Option<i16>) -> Vec<i16> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &sample in samples {
        let midpoint = match *previous_sample {
            Some(prev) => ((i32::from(prev) + i32::from(sample)) / 2) as i16,
            None => sample,
        };
        out.push(midpoint);
        out.push(sample);
        *previous_sample = Some(sample);
    }
    out
}

#[allow(dead_code)]
pub(crate) trait AudioSink {
    fn start(&mut self, sample_rate: u32, channels: u16) -> Result<(), String>;
    fn write_pcm_i16(&mut self, samples: &[i16]) -> Result<(), String>;
    fn finish(&mut self) -> Result<(), String>;
}

/// In-memory 16-bit signed little-endian mono RIFF/WAVE sink for trace replay and protocol verification.
#[allow(dead_code)]
#[derive(Default)]
pub(crate) struct WavSink {
    bytes: Vec<u8>,
    data_bytes: u32,
    sample_rate: u32,
    channels: u16,
    finalized: bool,
}

#[allow(dead_code)]
impl WavSink {
    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn is_finalized(&self) -> bool {
        self.finalized
    }
}

impl AudioSink for WavSink {
    fn start(&mut self, sample_rate: u32, channels: u16) -> Result<(), String> {
        if sample_rate == 0 || channels == 0 {
            return Err("WAV sample_rate and channels must be non-zero".into());
        }
        self.bytes.clear();
        self.data_bytes = 0;
        self.sample_rate = sample_rate;
        self.channels = channels;
        self.finalized = false;

        let block_align = channels.saturating_mul(2);
        let byte_rate = sample_rate.saturating_mul(u32::from(block_align));
        self.bytes.extend_from_slice(b"RIFF");
        self.bytes.extend_from_slice(&36_u32.to_le_bytes());
        self.bytes.extend_from_slice(b"WAVEfmt ");
        self.bytes.extend_from_slice(&16_u32.to_le_bytes());
        self.bytes.extend_from_slice(&1_u16.to_le_bytes());
        self.bytes.extend_from_slice(&channels.to_le_bytes());
        self.bytes.extend_from_slice(&sample_rate.to_le_bytes());
        self.bytes.extend_from_slice(&byte_rate.to_le_bytes());
        self.bytes.extend_from_slice(&block_align.to_le_bytes());
        self.bytes.extend_from_slice(&16_u16.to_le_bytes());
        self.bytes.extend_from_slice(b"data");
        self.bytes.extend_from_slice(&0_u32.to_le_bytes());
        Ok(())
    }

    fn write_pcm_i16(&mut self, samples: &[i16]) -> Result<(), String> {
        if self.bytes.len() < 44 || self.finalized {
            return Err("WAV sink is not open".into());
        }
        for &sample in samples {
            self.bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.data_bytes = self.data_bytes.saturating_add((samples.len() * 2) as u32);
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        if self.bytes.len() < 44 {
            return Err("WAV sink was never started".into());
        }
        let riff_size = 36_u32.saturating_add(self.data_bytes);
        self.bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        self.bytes[40..44].copy_from_slice(&self.data_bytes.to_le_bytes());
        self.finalized = true;
        Ok(())
    }
}

/// Filters Windows GATT `AB5E0001` service paths for a bound TCL RC902N/RC902V instance.
///
/// RC902N and RC902V share VID 0x0417 / PID 0x0304, so a bound 12-hex Bluetooth
/// address from the verified instance is always required.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn approved_rc902_service_id(
    kind: &str,
    id: &str,
    target_bluetooth_address: Option<&str>,
) -> bool {
    let normalized = id.to_ascii_lowercase();
    if !normalized.contains("bthledevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}") {
        return false;
    }
    let Some(target) = target_bluetooth_address else {
        return false;
    };
    let compact: String = target
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    if compact.len() != 12 || !normalized.contains(&compact) {
        return false;
    }
    if normalized.contains("_vid&") || normalized.contains("_pid&") {
        crate::devices::descriptor_registry::matches_hardware_id(kind, id)
    } else {
        normalized.contains("bthledevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}_dev_")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_v10_htt_caps_resp() -> [u8; 9] {
        // Synthetic test vector from Spec §10.2 (not a real FMR1 capture).
        [0x0b, 0x01, 0x00, 0x02, 0x03, 0x00, 0xa0, 0x01, 0x00]
    }

    fn feed_events_to_wav(events: &[SessionEvent], wav: &mut WavSink) {
        for event in events {
            match event {
                SessionEvent::SessionStarted { sample_rate, .. } => {
                    wav.start(*sample_rate, 1).unwrap();
                }
                SessionEvent::PcmChunk { samples, .. } => {
                    wav.write_pcm_i16(samples).unwrap();
                }
                SessionEvent::SessionStopped { .. } => {
                    if !wav.is_finalized() {
                        wav.finish().unwrap();
                    }
                }
                _ => {}
            }
        }
    }

    #[test]
    fn v10_get_caps_encodes_expected_wire_bytes() {
        assert_eq!(AtvvV10::get_caps(), [0x0a, 0x01, 0x00, 0x00, 0x03, 0x03]);
    }

    #[test]
    fn parses_synthetic_v10_caps_resp_and_rejects_unknown_versions() {
        let event = ControlEvent::parse(&synthetic_v10_htt_caps_resp()).unwrap();
        assert_eq!(
            event,
            ControlEvent::CapsResp(Capabilities {
                version: ProtocolVersion::V10,
                codecs_mask: 0x02,
                preferred_codec: Some(AdpcmCodec::Adpcm16k),
                model: InteractionModel::Htt,
                raw_model: 0x03,
                frame_size: 160,
                extra: 1,
                vendor_data: Vec::new(),
            })
        );

        let v04 = ControlEvent::parse(&[0x0b, 0x00, 0x04, 0x00, 0x02, 0x00, 0x86]).unwrap();
        assert_eq!(
            v04,
            ControlEvent::CapsResp(Capabilities {
                version: ProtocolVersion::V04,
                codecs_mask: 0x02,
                preferred_codec: Some(AdpcmCodec::Adpcm16k),
                model: InteractionModel::OnRequest,
                raw_model: 0x00,
                frame_size: 134,
                extra: 0,
                vendor_data: Vec::new(),
            })
        );

        let mut session = AtvvSession::default();
        let now = Instant::now();
        let init = session.begin_negotiation(now);
        assert_eq!(
            init.tx_commands,
            vec![vec![0x0a, 0x01, 0x00, 0x00, 0x03, 0x03]]
        );
        let unknown =
            session.handle_control(&[0x0b, 0x02, 0x00, 0x02, 0x03, 0x00, 0xa0, 0x00, 0x00], now);
        assert!(unknown.tx_commands.is_empty());
        assert_eq!(session.state(), SessionState::Error);
    }

    #[test]
    fn v10_and_v04_command_formats_stay_isolated() {
        assert_eq!(AtvvV10::mic_open(MicOpenMode::Capture), [0x0c, 0x01]);
        assert_eq!(AtvvV10::mic_open(MicOpenMode::Playback), [0x0c, 0x00]);
        assert_eq!(AtvvV04::mic_open(AdpcmCodec::Adpcm16k), [0x0c, 0x00, 0x02]);
        assert_ne!(
            AtvvV10::mic_open(MicOpenMode::Capture).as_slice(),
            AtvvV04::mic_open(AdpcmCodec::Adpcm16k).as_slice()
        );
        assert_eq!(AtvvV10::mic_close(5), [0x0d, 0x05]);
        assert_eq!(AtvvV04::mic_close(), [0x0d]);
    }

    #[test]
    fn parses_v10_htt_audio_start_and_audio_sync_vectors() {
        assert_eq!(
            ControlEvent::parse(&[0x04, 0x03, 0x02, 0x05]).unwrap(),
            ControlEvent::AudioStart {
                reason: 0x03,
                codec: 0x02,
                stream_id: 5,
            }
        );
        assert_eq!(
            ControlEvent::parse(&[0x0a, 0x02, 0x00, 0x10, 0x00, 0x00, 0x00]).unwrap(),
            ControlEvent::AudioSync {
                codec: 2,
                frame_no: 16,
                predictor: 0,
                step_index: 0,
            }
        );
    }

    #[test]
    fn mic_close_encodes_stream_id_and_ignores_stream_mismatch() {
        let now = Instant::now();
        let mut session = AtvvSession::default();
        session.begin_negotiation(now);
        session.handle_control(&synthetic_v10_htt_caps_resp(), now);
        session.handle_control(&[0x04, 0x03, 0x02, 0x05], now);
        assert_eq!(session.state(), SessionState::Streaming);
        assert_eq!(session.active_stream_id(), Some(5));

        assert!(session.close_stream(4).is_none());
        assert_eq!(session.state(), SessionState::Streaming);
        assert_eq!(session.active_stream_id(), Some(5));

        let closed = session.close_stream(5).unwrap();
        assert_eq!(closed.tx_commands, vec![vec![0x0d, 0x05]]);
        assert_eq!(session.state(), SessionState::Stopping);
        assert_eq!(session.active_stream_id(), None);
    }

    #[test]
    fn htt_only_policy_ignores_start_search_and_closes_non_htt_streams() {
        let now = Instant::now();
        let mut session = AtvvSession::default();
        session.begin_negotiation(now);
        session.handle_control(&synthetic_v10_htt_caps_resp(), now);
        assert_eq!(session.state(), SessionState::Ready);

        // On-request START_SEARCH (0x08) must never emit MIC_OPEN in HTT-only mode.
        let search = session.handle_control(&[0x08], now);
        assert!(search.tx_commands.is_empty());
        assert_eq!(session.state(), SessionState::Ready);

        // PTT AUDIO_START (reason=0x01) must be closed immediately so the mic cannot stay open after release.
        let ptt = session.handle_control(&[0x04, 0x01, 0x02, 0x07], now);
        assert_eq!(ptt.tx_commands, vec![vec![0x0d, 0x07]]);
        assert_eq!(session.state(), SessionState::Ready);
    }

    #[test]
    fn adpcm_decoder_enforces_high_nibble_first_order() {
        let mut decoder = ImaAdpcmDecoder::default();
        // High nibble 0x7 (+11 from step 7 -> predictor 11, step_index 8 -> step 16),
        // then low nibble 0xF (-30 from step 16 -> predictor -19).
        // Low-nibble-first would produce [-11, 19] instead of [11, -19].
        let decoded = decoder.decode_bytes(&[0x7f]);
        assert_eq!(decoded, vec![11, -19]);
        assert_ne!(decoded, vec![-11, 19]);

        decoder.reset_session();
        assert_eq!(decoder.decode_bytes(&[0x30, 0xb0]), vec![4, 4, 0, 0]);
    }

    #[test]
    fn drops_audio_packets_outside_streaming_without_buffering() {
        let now = Instant::now();
        let mut session = AtvvSession::default();
        session.begin_negotiation(now);
        session.handle_control(&synthetic_v10_htt_caps_resp(), now);
        assert_eq!(session.state(), SessionState::Ready);

        for _ in 0..500 {
            let out = session.handle_audio(&[0x7f; 160], now);
            assert!(out.events.is_empty());
        }
        assert_eq!(session.stats().dropped_non_streaming_packets, 500);
        assert_eq!(session.stats().decoded_samples, 0);
        assert!(session.decoder.pending.is_empty());
    }

    #[test]
    fn disconnect_timeout_keepalive_and_multi_session_finalize_wav_without_state_bleed() {
        let t0 = Instant::now();
        let mut session = AtvvSession::default();
        session.begin_negotiation(t0);
        session.handle_control(&synthetic_v10_htt_caps_resp(), t0);

        // Session 1: hold -> stream + keepalive -> release (AUDIO_STOP reason=0x02).
        let mut wav1 = WavSink::default();
        let started = session.handle_control(&[0x04, 0x03, 0x02, 0x01], t0);
        feed_events_to_wav(&started.events, &mut wav1);

        let audio1 = session.handle_audio(&[0x7f; 160], t0 + Duration::from_millis(20));
        feed_events_to_wav(&audio1.events, &mut wav1);

        let _ = session.handle_audio(&[0x11; 160], t0 + Duration::from_secs(4));
        let _ = session.handle_audio(&[0x11; 160], t0 + Duration::from_secs(8));
        let keepalive = session.poll_timers(t0 + Duration::from_secs(9));
        assert_eq!(keepalive.tx_commands, vec![vec![0x0e, 0x01]]);

        let stopped = session.handle_control(&[0x00, 0x02], t0 + Duration::from_secs(10));
        feed_events_to_wav(&stopped.events, &mut wav1);
        assert!(wav1.is_finalized());
        assert_eq!(&wav1.bytes()[0..4], b"RIFF");
        assert_eq!(&wav1.bytes()[8..12], b"WAVE");
        assert_eq!(
            u32::from_le_bytes(wav1.bytes()[40..44].try_into().unwrap()),
            640
        );

        // Session 2: identical first packet must produce identical PCM (no residual predictor/step_index).
        let mut wav2 = WavSink::default();
        let started2 =
            session.handle_control(&[0x04, 0x03, 0x02, 0x02], t0 + Duration::from_secs(11));
        feed_events_to_wav(&started2.events, &mut wav2);
        let audio2 = session.handle_audio(&[0x7f; 160], t0 + Duration::from_secs(11));
        assert_eq!(audio1.events, audio2.events);
        feed_events_to_wav(&audio2.events, &mut wav2);

        // Disconnect mid-stream finalizes WAV cleanly.
        let disconnected = session.disconnect();
        feed_events_to_wav(&disconnected.events, &mut wav2);
        assert!(wav2.is_finalized());
        assert_eq!(session.state(), SessionState::Disconnected);

        // Session 3: stream stall timeout sends MIC_CLOSE and finalizes WAV cleanly.
        let mut wav3 = WavSink::default();
        session.begin_negotiation(t0 + Duration::from_secs(20));
        session.handle_control(&synthetic_v10_htt_caps_resp(), t0 + Duration::from_secs(20));
        let started3 =
            session.handle_control(&[0x04, 0x03, 0x02, 0x03], t0 + Duration::from_secs(20));
        feed_events_to_wav(&started3.events, &mut wav3);
        let timed_out = session.poll_timers(t0 + Duration::from_secs(26));
        assert_eq!(timed_out.tx_commands, vec![vec![0x0d, 0x03]]);
        feed_events_to_wav(&timed_out.events, &mut wav3);
        assert!(wav3.is_finalized());
        assert_eq!(session.state(), SessionState::Ready);
    }

    #[test]
    fn upsampler_converts_8khz_chunks_to_16khz_continuously() {
        let mut prev = None;
        assert_eq!(
            upsample_8k_to_16k(&[100, 300, -100], &mut prev),
            vec![100, 100, 200, 300, 100, -100]
        );
        assert_eq!(upsample_8k_to_16k(&[100], &mut prev), vec![0, 100]);
    }

    #[test]
    fn matches_rc902_windows_gatt_service_paths_only_with_bound_address() {
        let pnp_id = r"\\?\BTHLEDevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}_Dev_VID&010417_PID&0304_REV&0001_A1B2C3D4E5F6#device";
        let address_only =
            r"\\?\BTHLEDevice#{ab5e0001-5a21-4f05-bc7d-af01f617b664}_Dev_A1B2C3D4E5F6#device";
        for kind in ["tclRc902n", "tclRc902v"] {
            assert!(!approved_rc902_service_id(kind, pnp_id, None));
            assert!(approved_rc902_service_id(
                kind,
                pnp_id,
                Some("A1:B2:C3:D4:E5:F6")
            ));
            assert!(!approved_rc902_service_id(
                kind,
                pnp_id,
                Some("00:11:22:33:44:55")
            ));
            assert!(!approved_rc902_service_id(
                kind,
                &pnp_id.replace("010417", "012717"),
                Some("A1:B2:C3:D4:E5:F6")
            ));
            assert!(!approved_rc902_service_id(kind, address_only, None));
            assert!(approved_rc902_service_id(
                kind,
                address_only,
                Some("a1:b2:c3:d4:e5:f6")
            ));
        }
    }
}
