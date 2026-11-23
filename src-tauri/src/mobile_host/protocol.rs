use serde::{Deserialize, Serialize};

pub const MOBILE_SUBPROTOCOL: &str = "axonkey.mobile/1";
pub const DEFAULT_TICK_INTERVAL_MS: u64 = 250;
pub const DEFAULT_LEASE_TTL_MS: u64 = 750;
pub const DEFAULT_IDLE_DISCONNECT_MS: u64 = 4_500;
pub const MAX_WS_FRAME_BYTES: usize = 128 * 1024;
pub const UDP_DISCOVERY_PORT: u16 = 49_671;

pub const AKP1_MAGIC: &[u8; 4] = b"AKP1";
pub const AKP1_FRAME_BYTES: usize = 40;
pub const AKA1_MAGIC: &[u8; 4] = b"AKA1";
pub const AKA1_HEADER_BYTES: usize = 32;
pub const MAX_AUDIO_PCM_BYTES: usize = 2_560;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingOfferQr {
    pub v: u32,
    pub host_id: String,
    pub host_name: String,
    pub addrs: Vec<String>,
    pub ca_cert_der_b64: String,
    pub pair_token: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    pub relative_pointer: bool,
    #[serde(default)]
    pub absolute_pointer: bool,
    #[serde(default)]
    pub binary_pointer_v1: bool,
    #[serde(default)]
    pub binary_audio_v1: bool,
    pub text_commit: bool,
    pub audio_pcm16: bool,
    #[serde(default)]
    pub udp_discovery_port: u16,
    pub platform: String,
}

impl HostCapabilities {
    pub fn current() -> Self {
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "unknown"
        };
        Self {
            relative_pointer: cfg!(windows),
            absolute_pointer: cfg!(windows),
            binary_pointer_v1: cfg!(windows),
            binary_audio_v1: cfg!(windows),
            text_commit: cfg!(any(windows, target_os = "macos")),
            audio_pcm16: cfg!(windows),
            udp_discovery_port: UDP_DISCOVERY_PORT,
            platform: platform.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Akp1PointerKind {
    TrackpadRelative = 1,
    GyroRelative = 2,
    GyroAbsolute = 3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Akp1PointerFrame {
    pub kind: Akp1PointerKind,
    pub flags: u8,
    pub input_generation: u64,
    pub seq: u64,
    pub sample_time_us: u64,
    pub x: f32,
    pub y: f32,
}

pub fn parse_akp1_frame(bytes: &[u8]) -> Option<Akp1PointerFrame> {
    if bytes.len() != AKP1_FRAME_BYTES || &bytes[0..4] != AKP1_MAGIC {
        return None;
    }
    let kind = match bytes[4] {
        1 => Akp1PointerKind::TrackpadRelative,
        2 => Akp1PointerKind::GyroRelative,
        3 => Akp1PointerKind::GyroAbsolute,
        _ => return None,
    };
    let flags = bytes[5];
    let frame_bytes = u16::from_le_bytes([bytes[6], bytes[7]]);
    if usize::from(frame_bytes) != AKP1_FRAME_BYTES {
        return None;
    }
    let input_generation = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let seq = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    let sample_time_us = u64::from_le_bytes(bytes[24..32].try_into().ok()?);
    let x = f32::from_le_bytes(bytes[32..36].try_into().ok()?);
    let y = f32::from_le_bytes(bytes[36..40].try_into().ok()?);
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(Akp1PointerFrame {
        kind,
        flags,
        input_generation,
        seq,
        sample_time_us,
        x,
        y,
    })
}

#[cfg(test)]
pub fn encode_akp1_frame(
    kind: Akp1PointerKind,
    input_generation: u64,
    seq: u64,
    sample_time_us: u64,
    x: f32,
    y: f32,
) -> [u8; AKP1_FRAME_BYTES] {
    let mut buf = [0u8; AKP1_FRAME_BYTES];
    buf[0..4].copy_from_slice(AKP1_MAGIC);
    buf[4] = kind as u8;
    buf[5] = 0;
    buf[6..8].copy_from_slice(&(AKP1_FRAME_BYTES as u16).to_le_bytes());
    buf[8..16].copy_from_slice(&input_generation.to_le_bytes());
    buf[16..24].copy_from_slice(&seq.to_le_bytes());
    buf[24..32].copy_from_slice(&sample_time_us.to_le_bytes());
    buf[32..36].copy_from_slice(&x.to_le_bytes());
    buf[36..40].copy_from_slice(&y.to_le_bytes());
    buf
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Aka1AudioFrame<'a> {
    pub format: u8,
    pub flags: u8,
    pub input_generation: u64,
    pub stream_id: u64,
    pub first_sample_index: u64,
    pub pcm_le_bytes: &'a [u8],
}

pub fn parse_aka1_frame(bytes: &[u8]) -> Option<Aka1AudioFrame<'_>> {
    if bytes.len() <= AKA1_HEADER_BYTES || &bytes[0..4] != AKA1_MAGIC {
        return None;
    }
    let format = bytes[4];
    if format != 1 {
        return None;
    }
    let flags = bytes[5];
    let header_bytes = u16::from_le_bytes([bytes[6], bytes[7]]);
    if usize::from(header_bytes) != AKA1_HEADER_BYTES {
        return None;
    }
    let input_generation = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let stream_id = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    if stream_id == 0 {
        return None;
    }
    let first_sample_index = u64::from_le_bytes(bytes[24..32].try_into().ok()?);
    let pcm_le_bytes = &bytes[AKA1_HEADER_BYTES..];
    if pcm_le_bytes.is_empty()
        || pcm_le_bytes.len() > MAX_AUDIO_PCM_BYTES
        || pcm_le_bytes.len() % 2 != 0
    {
        return None;
    }
    Some(Aka1AudioFrame {
        format,
        flags,
        input_generation,
        stream_id,
        first_sample_index,
        pcm_le_bytes,
    })
}

#[cfg(test)]
pub fn encode_aka1_frame(
    input_generation: u64,
    stream_id: u64,
    first_sample_index: u64,
    samples: &[i16],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(AKA1_HEADER_BYTES + samples.len() * 2);
    buf.extend_from_slice(AKA1_MAGIC);
    buf.push(1);
    buf.push(0);
    buf.extend_from_slice(&(AKA1_HEADER_BYTES as u16).to_le_bytes());
    buf.extend_from_slice(&input_generation.to_le_bytes());
    buf.extend_from_slice(&stream_id.to_le_bytes());
    buf.extend_from_slice(&first_sample_index.to_le_bytes());
    for &sample in samples {
        buf.extend_from_slice(&sample.to_le_bytes());
    }
    buf
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundContext {
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    pub profile_name: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TileMode {
    Gesture,
    Hold,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TileGestureKind {
    Tap,
    Double,
    Long,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TileAccent {
    Slate,
    Blue,
    Emerald,
    Amber,
    Rose,
    Violet,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PointerButtonName {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PointerButtonPhase {
    Down,
    Up,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextCommitMode {
    Paste,
    Type,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PageLayout {
    Remote,
    #[default]
    Grid,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileTile {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// Derived automatically on the PC from the actual configured NativeBehavior bindings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_summary: Option<String>,
    pub icon: String,
    pub accent: TileAccent,
    pub col_span: u8,
    pub mode: TileMode,
    #[serde(default)]
    pub has_double_click: bool,
    #[serde(default)]
    pub has_long_press: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileDeckPage {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub layout: PageLayout,
    pub columns: u8,
    pub tiles: Vec<MobileTile>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeckSnapshot {
    pub version: u32,
    pub active_page_id: String,
    pub trackpad_split: f64,
    pub pointer_sensitivity: f64,
    pub scroll_sensitivity: f64,
    pub double_click_window_ms: u64,
    pub long_press_window_ms: u64,
    #[serde(default)]
    pub voice_binding_summary: Option<String>,
    pub pages: Vec<MobileDeckPage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeckLayoutPatch {
    pub active_page_id: Option<String>,
    pub trackpad_split: Option<f64>,
    pub pointer_sensitivity: Option<f64>,
    pub scroll_sensitivity: Option<f64>,
    pub pages: Option<Vec<MobileDeckPage>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "pair.request", rename_all = "camelCase")]
    PairRequest {
        pair_token: String,
        device_name: String,
    },
    #[serde(rename = "client.auth", rename_all = "camelCase")]
    ClientAuth {
        peer_id: String,
        peer_token: String,
        device_name: String,
    },
    #[serde(rename = "client.alive", rename_all = "camelCase")]
    ClientAlive { session_id: String, lease_id: u64 },
    #[serde(rename = "client.rename", rename_all = "camelCase")]
    ClientRename {
        session_id: String,
        device_name: String,
    },
    #[serde(rename = "tile.activate", rename_all = "camelCase")]
    TileActivate {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        request_id: String,
        tile_id: String,
        gesture: TileGestureKind,
    },
    #[serde(rename = "tile.hold.begin", rename_all = "camelCase")]
    TileHoldBegin {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        request_id: String,
        tile_id: String,
        press_id: String,
    },
    #[serde(rename = "tile.hold.end", rename_all = "camelCase")]
    TileHoldEnd {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        request_id: String,
        tile_id: String,
        press_id: String,
    },
    #[serde(rename = "pointer.motion", rename_all = "camelCase")]
    PointerMotion {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        dx: f64,
        dy: f64,
    },
    #[serde(rename = "pointer.scroll", rename_all = "camelCase")]
    PointerScroll {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        x: f64,
        y: f64,
    },
    #[serde(rename = "pointer.button", rename_all = "camelCase")]
    PointerButton {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        request_id: String,
        button: PointerButtonName,
        phase: PointerButtonPhase,
        press_id: String,
    },
    #[serde(rename = "text.commit", rename_all = "camelCase")]
    TextCommit {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        request_id: String,
        text: String,
        mode: TextCommitMode,
        submit: bool,
        context_revision: u64,
    },
    #[serde(rename = "voice.begin", rename_all = "camelCase")]
    VoiceBegin {
        session_id: String,
        input_epoch: u64,
        #[serde(default)]
        input_generation: u64,
        seq: u64,
        lease_id: u64,
        request_id: String,
        stream_id: u64,
    },
    #[serde(rename = "voice.end", rename_all = "camelCase")]
    VoiceEnd {
        session_id: String,
        input_epoch: u64,
        #[serde(default)]
        input_generation: u64,
        seq: u64,
        request_id: String,
        stream_id: u64,
        #[serde(default)]
        final_sample_exclusive: u64,
    },
    #[serde(rename = "voice.cancel", rename_all = "camelCase")]
    VoiceCancel {
        session_id: String,
        input_epoch: u64,
        stream_id: u64,
        #[serde(default)]
        reason: String,
    },
    #[serde(rename = "deck.update", rename_all = "camelCase")]
    DeckUpdate {
        session_id: String,
        request_id: String,
        base_revision: u64,
        layout_patch: DeckLayoutPatch,
    },
    #[serde(rename = "input.cancel", rename_all = "camelCase")]
    InputCancel {
        session_id: String,
        input_epoch: u64,
        reason: String,
    },
    #[serde(rename = "audio.start", rename_all = "camelCase")]
    AudioStart {
        session_id: String,
        sample_rate: u32,
        channels: u8,
    },
    #[serde(rename = "audio.stop", rename_all = "camelCase")]
    AudioStop { session_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "pair.result", rename_all = "camelCase")]
    PairResult {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        peer_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "server.ready", rename_all = "camelCase")]
    ServerReady {
        session_id: String,
        input_epoch: u64,
        #[serde(default)]
        input_generation: u64,
        lease_id: u64,
        lease_ttl_ms: u64,
        tick_interval_ms: u64,
        host_id: String,
        host_name: String,
        capabilities: HostCapabilities,
        deck_snapshot: DeckSnapshot,
        deck_revision: u64,
        context: ForegroundContext,
        context_revision: u64,
    },
    #[serde(rename = "server.tick", rename_all = "camelCase")]
    ServerTick {
        session_id: String,
        input_epoch: u64,
        #[serde(default)]
        input_generation: u64,
        lease_id: u64,
        lease_ttl_ms: u64,
    },
    #[serde(rename = "deck.snapshot", rename_all = "camelCase")]
    DeckSnapshotPush {
        deck_snapshot: DeckSnapshot,
        deck_revision: u64,
        input_epoch: u64,
        #[serde(default)]
        input_generation: u64,
    },
    #[serde(rename = "context.changed", rename_all = "camelCase")]
    ContextChanged {
        context: ForegroundContext,
        context_revision: u64,
    },
    #[serde(rename = "deck.update.result", rename_all = "camelCase")]
    DeckUpdateResult {
        request_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        conflict: Option<bool>,
        deck_revision: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        deck_snapshot: Option<DeckSnapshot>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "command.result", rename_all = "camelCase")]
    CommandResult {
        request_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "session.revoked", rename_all = "camelCase")]
    SessionRevoked { session_id: String, reason: String },
    #[serde(rename = "error", rename_all = "camelCase")]
    Error { code: String, message: String },
}
