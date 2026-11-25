use serde::{Deserialize, Serialize};

pub const MOBILE_SUBPROTOCOL: &str = "axonkey.mobile/1";
pub const HOST_APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MOBILE_PROTOCOL_API: u32 = 2;
pub const MIN_REQUIRED_CLIENT_API: u32 = 1;
pub const MIN_RECOMMENDED_CLIENT_VERSION: &str = "0.2.0";
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
    #[serde(default)]
    pub host_version: String,
    #[serde(default)]
    pub protocol_api: u32,
    #[serde(default)]
    pub min_required_client_api: u32,
    #[serde(default)]
    pub min_recommended_client_version: String,
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
            host_version: HOST_APP_VERSION.into(),
            protocol_api: MOBILE_PROTOCOL_API,
            min_required_client_api: MIN_REQUIRED_CLIENT_API,
            min_recommended_client_version: MIN_RECOMMENDED_CLIENT_VERSION.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VersionCompatSeverity {
    Soft,
    Hard,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VersionCompatTarget {
    Mobile,
    Desktop,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientVersionHandshake {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_api: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_required_host_api: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_recommended_host_version: Option<String>,
}

#[cfg(test)]
impl ClientVersionHandshake {
    pub fn current_compatible_default() -> Self {
        Self {
            client_version: Some(MIN_RECOMMENDED_CLIENT_VERSION.into()),
            protocol_api: Some(MOBILE_PROTOCOL_API),
            min_required_host_api: Some(MIN_REQUIRED_CLIENT_API),
            min_recommended_host_version: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VersionCompatibilityNotice {
    pub key: String,
    #[serde(default)]
    pub occurrence_id: u64,
    pub severity: VersionCompatSeverity,
    pub target: VersionCompatTarget,
    pub device_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    pub expected_version: String,
    pub title: String,
    pub message: String,
}

pub fn compare_semver(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(raw: &str) -> ([u32; 3], Option<&str>) {
        let trimmed = raw.trim().trim_start_matches(['v', 'V']);
        let without_build = trimmed.split('+').next().unwrap_or("");
        let (core_str, pre) = match without_build.split_once('-') {
            Some((c, p)) if !p.is_empty() => (c, Some(p)),
            _ => (without_build, None),
        };
        let mut nums = [0u32; 3];
        for (idx, seg) in core_str.split('.').take(3).enumerate() {
            nums[idx] = seg.parse::<u32>().unwrap_or(0);
        }
        (nums, pre)
    }

    let (a_nums, a_pre) = parse(a);
    let (b_nums, b_pre) = parse(b);
    match a_nums.cmp(&b_nums) {
        std::cmp::Ordering::Equal => match (a_pre, b_pre) {
            (None, None) => std::cmp::Ordering::Equal,
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(ap), Some(bp)) => ap.cmp(bp),
        },
        ord => ord,
    }
}

pub fn evaluate_client_handshake_with_policy(
    device_name: &str,
    handshake: &ClientVersionHandshake,
    host_version: &str,
    host_api: u32,
    min_required_client_api: u32,
    min_recommended_client_version: &str,
    occurrence_id: u64,
) -> Option<VersionCompatibilityNotice> {
    let clean_device = if device_name.trim().is_empty() {
        "手机客户端"
    } else {
        device_name.trim()
    };

    // 1. Hard incompatibility: client requires a newer host protocol API than this desktop supports.
    if let Some(req_host_api) = handshake.min_required_host_api {
        if req_host_api > host_api {
            let expected = handshake
                .min_recommended_host_version
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(|v| format!("v{}", v.trim().trim_start_matches(['v', 'V'])))
                .unwrap_or_else(|| format!("协议 v{req_host_api}"));
            return Some(VersionCompatibilityNotice {
                key: format!("hard:desktop:{occurrence_id}:{expected}"),
                occurrence_id,
                severity: VersionCompatSeverity::Hard,
                target: VersionCompatTarget::Desktop,
                device_name: clean_device.to_owned(),
                current_version: Some(host_version.to_owned()),
                expected_version: expected.clone(),
                title: "需要更新电脑端 Axonkey".into(),
                message: format!(
                    "「{clean_device}」要求更高版本的通信协议（{expected}），当前电脑端（v{host_version}）无法建立控制连接。请先更新电脑端 Axonkey 后重新连接。"
                ),
            });
        }
    }

    // 2. Hard incompatibility: client protocol API is older than this desktop's minimum required API.
    let effective_client_api = handshake.protocol_api.unwrap_or(1);
    if effective_client_api < min_required_client_api {
        let cur_ver = handshake
            .client_version
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().trim_start_matches(['v', 'V']).to_owned());
        let ver_badge = cur_ver
            .as_deref()
            .map(|v| format!("（v{v}）"))
            .unwrap_or_default();
        let expected = format!("v{min_recommended_client_version}+");
        return Some(VersionCompatibilityNotice {
            key: format!("hard:mobile:{occurrence_id}:{expected}"),
            occurrence_id,
            severity: VersionCompatSeverity::Hard,
            target: VersionCompatTarget::Mobile,
            device_name: clean_device.to_owned(),
            current_version: cur_ver,
            expected_version: expected,
            title: "需要更新手机端客户端".into(),
            message: format!(
                "「{clean_device}」客户端版本过旧{ver_badge}，与当前电脑端通信协议不兼容，无法建立连接。请将手机端 Axonkey Mobile 更新至 v{min_recommended_client_version} 或更高版本。"
            ),
        });
    }

    // 3. Soft drift: mobile client version is older than desktop's recommended floor (or legacy pre-0.2.0 without version).
    let cur_client_ver = handshake
        .client_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_start_matches(['v', 'V']).to_owned());

    let client_below_recommended = match cur_client_ver.as_deref() {
        Some(ver) => compare_semver(ver, min_recommended_client_version).is_lt(),
        None => true,
    };
    if client_below_recommended {
        let cur_tag = cur_client_ver.as_deref().unwrap_or("legacy");
        let ver_desc = cur_client_ver
            .as_deref()
            .map(|v| format!("（v{v}）"))
            .unwrap_or_else(|| "（旧版）".into());
        return Some(VersionCompatibilityNotice {
            key: format!("soft:mobile:{cur_tag}->{min_recommended_client_version}"),
            occurrence_id: 0,
            severity: VersionCompatSeverity::Soft,
            target: VersionCompatTarget::Mobile,
            device_name: clean_device.to_owned(),
            current_version: cur_client_ver,
            expected_version: format!("v{min_recommended_client_version}+"),
            title: "建议更新手机端客户端".into(),
            message: format!(
                "「{clean_device}」当前版本{ver_desc}低于电脑端推荐版本（v{min_recommended_client_version}+）。基础遥控与语音仍可使用，但部分新组件、手势或同步体验可能受影响。"
            ),
        });
    }

    // 4. Soft drift: desktop version is older than mobile client's recommended host version.
    if let Some(rec_host) = handshake
        .min_recommended_host_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let clean_rec = rec_host.trim_start_matches(['v', 'V']);
        if compare_semver(host_version, clean_rec).is_lt() {
            return Some(VersionCompatibilityNotice {
                key: format!("soft:desktop:{host_version}->{clean_rec}"),
                occurrence_id: 0,
                severity: VersionCompatSeverity::Soft,
                target: VersionCompatTarget::Desktop,
                device_name: clean_device.to_owned(),
                current_version: Some(host_version.to_owned()),
                expected_version: format!("v{clean_rec}+"),
                title: "建议更新电脑端 Axonkey".into(),
                message: format!(
                    "当前电脑端版本（v{host_version}）低于「{clean_device}」期望版本（v{clean_rec}+）。基础操控仍可使用，但部分新功能或低延迟同步体验可能受影响。"
                ),
            });
        }
    }

    None
}

pub fn evaluate_current_client_handshake(
    device_name: &str,
    handshake: &ClientVersionHandshake,
    occurrence_id: u64,
) -> Option<VersionCompatibilityNotice> {
    evaluate_client_handshake_with_policy(
        device_name,
        handshake,
        HOST_APP_VERSION,
        MOBILE_PROTOCOL_API,
        MIN_REQUIRED_CLIENT_API,
        MIN_RECOMMENDED_CLIENT_VERSION,
        occurrence_id,
    )
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

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum DeckZoneKind {
    #[serde(rename = "bento-grid")]
    BentoGrid,
    #[serde(rename = "dpad-3x3")]
    Dpad3x3,
    #[serde(rename = "pointer-pad")]
    PointerPad,
    #[serde(rename = "gesture-pad")]
    GesturePad,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddedPointerMode {
    Trackpad,
    Relative,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddedPadHeight {
    Compact,
    Standard,
    Tall,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemTouchpadGesture {
    ThreeFingerUp,
    ThreeFingerDown,
    ThreeFingerLeft,
    ThreeFingerRight,
    ThreeFingerTap,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StarterPresetId {
    DailyRemote,
    VibeCoding,
    PresentationMedia,
    BlankCanvas,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoicePresetKind {
    DoubaoAlt,
    SystemWinH,
    CtrlWin,
    PureMic,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileDeckZone {
    pub id: String,
    pub kind: DeckZoneKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_mode: Option<EmbeddedPointerMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pad_height: Option<EmbeddedPadHeight>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_buttons: Option<bool>,
    #[serde(default)]
    pub tile_ids: Vec<String>,
}

const fn default_one() -> u8 {
    1
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
    #[serde(default = "default_one")]
    pub col_span: u8,
    #[serde(default = "default_one")]
    pub row_span: u8,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zones: Vec<MobileDeckZone>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_api: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_required_host_api: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_recommended_host_version: Option<String>,
    },
    #[serde(rename = "client.auth", rename_all = "camelCase")]
    ClientAuth {
        peer_id: String,
        peer_token: String,
        device_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol_api: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_required_host_api: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_recommended_host_version: Option<String>,
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
    #[serde(rename = "touchpad.gesture", rename_all = "camelCase")]
    TouchpadGesture {
        session_id: String,
        input_epoch: u64,
        seq: u64,
        lease_id: u64,
        gesture: SystemTouchpadGesture,
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
    #[serde(rename = "deck.apply_preset", rename_all = "camelCase")]
    DeckApplyPreset {
        session_id: String,
        request_id: String,
        preset: StarterPresetId,
        #[serde(default)]
        voice_preset: Option<VoicePresetKind>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version_notice: Option<VersionCompatibilityNotice>,
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
    Error {
        code: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version_notice: Option<VersionCompatibilityNotice>,
    },
}

#[cfg(test)]
mod version_compat_tests {
    use super::*;

    #[test]
    fn compatible_versions_produce_no_notice() {
        let hs = ClientVersionHandshake {
            client_version: Some("0.2.0".into()),
            protocol_api: Some(2),
            min_required_host_api: Some(1),
            min_recommended_host_version: Some("1.9.0".into()),
        };
        let res = evaluate_client_handshake_with_policy("K30S", &hs, "1.9.19", 2, 1, "0.2.0", 1);
        assert!(res.is_none());
    }

    #[test]
    fn distinguishes_soft_vs_hard_and_mobile_vs_desktop_targets() {
        // Hard desktop upgrade required
        let hs_future_mobile = ClientVersionHandshake {
            client_version: Some("2.0.0".into()),
            protocol_api: Some(3),
            min_required_host_api: Some(3),
            min_recommended_host_version: Some("2.4.0".into()),
        };
        let hard_desktop = evaluate_client_handshake_with_policy(
            "K30S",
            &hs_future_mobile,
            "1.9.19",
            2,
            1,
            "0.2.0",
            7,
        )
        .expect("hard desktop notice");
        assert_eq!(hard_desktop.severity, VersionCompatSeverity::Hard);
        assert_eq!(hard_desktop.target, VersionCompatTarget::Desktop);
        assert_eq!(hard_desktop.occurrence_id, 7);

        // Hard mobile upgrade required
        let hs_old_mobile = ClientVersionHandshake {
            client_version: Some("0.1.0".into()),
            protocol_api: Some(1),
            min_required_host_api: Some(1),
            min_recommended_host_version: None,
        };
        let hard_mobile = evaluate_client_handshake_with_policy(
            "K30S",
            &hs_old_mobile,
            "2.0.0",
            2,
            2,
            "0.2.0",
            9,
        )
        .expect("hard mobile notice");
        assert_eq!(hard_mobile.severity, VersionCompatSeverity::Hard);
        assert_eq!(hard_mobile.target, VersionCompatTarget::Mobile);

        // Soft mobile recommendation
        let soft_mobile = evaluate_client_handshake_with_policy(
            "K30S",
            &hs_old_mobile,
            "1.9.19",
            2,
            1,
            "0.2.0",
            0,
        )
        .expect("soft mobile notice");
        assert_eq!(soft_mobile.severity, VersionCompatSeverity::Soft);
        assert_eq!(soft_mobile.target, VersionCompatTarget::Mobile);

        // Soft desktop recommendation
        let hs_newer_mobile = ClientVersionHandshake {
            client_version: Some("0.3.0".into()),
            protocol_api: Some(2),
            min_required_host_api: Some(2),
            min_recommended_host_version: Some("1.12.0".into()),
        };
        let soft_desktop = evaluate_client_handshake_with_policy(
            "K30S",
            &hs_newer_mobile,
            "1.9.19",
            2,
            1,
            "0.2.0",
            0,
        )
        .expect("soft desktop notice");
        assert_eq!(soft_desktop.severity, VersionCompatSeverity::Soft);
        assert_eq!(soft_desktop.target, VersionCompatTarget::Desktop);
    }
}
