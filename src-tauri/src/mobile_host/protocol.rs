use serde::{Deserialize, Serialize};

pub const MOBILE_SUBPROTOCOL: &str = "axonkey.mobile/1";
pub const DEFAULT_TICK_INTERVAL_MS: u64 = 250;
pub const DEFAULT_LEASE_TTL_MS: u64 = 750;
pub const DEFAULT_IDLE_DISCONNECT_MS: u64 = 4_500;
pub const MAX_WS_FRAME_BYTES: usize = 128 * 1024;

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
    pub text_commit: bool,
    pub audio_pcm16: bool,
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
            text_commit: cfg!(any(windows, target_os = "macos")),
            audio_pcm16: cfg!(windows),
            platform: platform.into(),
        }
    }
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
    #[serde(rename = "tile.activate", rename_all = "camelCase")]
    TileActivate {
        session_id: String,
        input_epoch: u64,
        seq: u32,
        lease_id: u64,
        request_id: String,
        tile_id: String,
        gesture: TileGestureKind,
    },
    #[serde(rename = "tile.hold.begin", rename_all = "camelCase")]
    TileHoldBegin {
        session_id: String,
        input_epoch: u64,
        seq: u32,
        lease_id: u64,
        request_id: String,
        tile_id: String,
        press_id: String,
    },
    #[serde(rename = "tile.hold.end", rename_all = "camelCase")]
    TileHoldEnd {
        session_id: String,
        input_epoch: u64,
        seq: u32,
        lease_id: u64,
        request_id: String,
        tile_id: String,
        press_id: String,
    },
    #[serde(rename = "pointer.motion", rename_all = "camelCase")]
    PointerMotion {
        session_id: String,
        input_epoch: u64,
        seq: u32,
        lease_id: u64,
        dx: f64,
        dy: f64,
    },
    #[serde(rename = "pointer.scroll", rename_all = "camelCase")]
    PointerScroll {
        session_id: String,
        input_epoch: u64,
        seq: u32,
        lease_id: u64,
        x: f64,
        y: f64,
    },
    #[serde(rename = "pointer.button", rename_all = "camelCase")]
    PointerButton {
        session_id: String,
        input_epoch: u64,
        seq: u32,
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
        seq: u32,
        lease_id: u64,
        request_id: String,
        text: String,
        mode: TextCommitMode,
        submit: bool,
        context_revision: u64,
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
        lease_id: u64,
        lease_ttl_ms: u64,
    },
    #[serde(rename = "deck.snapshot", rename_all = "camelCase")]
    DeckSnapshotPush {
        deck_snapshot: DeckSnapshot,
        deck_revision: u64,
        input_epoch: u64,
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
