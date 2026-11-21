use super::deck::{DeckStore, DeckUpdateError};
use super::pairing::{PairedPeerSummary, PairingStore};
use super::protocol::{
    ClientMessage, DeckLayoutPatch, DeckSnapshot, ForegroundContext, HostCapabilities,
    PointerButtonName, PointerButtonPhase, ServerMessage, TextCommitMode, DEFAULT_LEASE_TTL_MS,
    DEFAULT_TICK_INTERVAL_MS,
};
use crate::input_service::mobile::{MobileInputBackend, MobileInputController};
use crate::input_service::MouseButton;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionPhase {
    Disconnected,
    Authenticating,
    Synchronizing,
    Active,
    Revoking,
    Closed,
}

struct IssuedLease {
    id: u64,
    expires_at: Instant,
}

struct ActiveSession {
    session_id: String,
    peer_id: String,
    device_name: String,
    input_epoch: u64,
    phase: SessionPhase,
    last_seq: Option<u32>,
    leases: VecDeque<IssuedLease>,
    next_lease_id: u64,
    last_alive_at: Instant,
    tx: mpsc::Sender<ServerMessage>,
}

impl ActiveSession {
    fn issue_lease(&mut self, now: Instant) -> u64 {
        let id = self.next_lease_id;
        self.next_lease_id += 1;
        self.leases.push_back(IssuedLease {
            id,
            expires_at: now + Duration::from_millis(DEFAULT_LEASE_TTL_MS),
        });
        while self.leases.len() > 8 {
            self.leases.pop_front();
        }
        id
    }

    fn is_lease_valid(&self, lease_id: u64, now: Instant) -> bool {
        self.leases
            .iter()
            .any(|l| l.id == lease_id && now <= l.expires_at)
    }

    fn accept_seq(&mut self, seq: u32) -> bool {
        match self.last_seq {
            None => {
                self.last_seq = Some(seq);
                true
            }
            Some(prev) if seq > prev => {
                self.last_seq = Some(seq);
                true
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSessionInfo {
    pub session_id: String,
    pub peer_id: String,
    pub device_name: String,
    pub input_epoch: u64,
}

/// Serial coordinator owning pairing, deck authority, active session, and revoke barrier.
pub struct MobileCoordinator<B: MobileInputBackend> {
    host_id: String,
    host_name: String,
    ca_cert_der_b64: String,
    pairing: PairingStore,
    deck: DeckStore,
    input: Arc<MobileInputController<B>>,
    active: Option<ActiveSession>,
    next_epoch: u64,
    context: ForegroundContext,
    context_revision: u64,
}

impl<B: MobileInputBackend> MobileCoordinator<B> {
    pub fn new(
        host_id: String,
        host_name: String,
        ca_cert_der_b64: String,
        pairing: PairingStore,
        deck: DeckStore,
        input: Arc<MobileInputController<B>>,
    ) -> Self {
        Self {
            host_id,
            host_name,
            ca_cert_der_b64,
            pairing,
            deck,
            input,
            active: None,
            next_epoch: 1,
            context: ForegroundContext {
                app_id: None,
                app_name: None,
                profile_name: "默认配置".into(),
            },
            context_revision: 1,
        }
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn host_name(&self) -> &str {
        &self.host_name
    }

    pub fn create_pairing_offer(&mut self, addrs: Vec<String>) -> super::protocol::PairingOfferQr {
        self.pairing
            .create_offer(&self.host_id, &self.host_name, addrs, &self.ca_cert_der_b64)
    }

    pub fn list_peers(&self) -> Vec<PairedPeerSummary> {
        self.pairing.list()
    }

    pub fn deck_state(&self) -> (u64, DeckSnapshot) {
        (self.deck.revision(), self.deck.snapshot())
    }

    pub fn bindings(&self) -> std::collections::HashMap<String, super::deck::TileActionBindings> {
        self.deck.bindings()
    }

    pub fn set_tile_binding_from_desktop(
        &mut self,
        tile_id: String,
        binding: super::deck::TileActionBindings,
    ) -> Result<(u64, DeckSnapshot), String> {
        let (rev, snap) = self.deck.set_tile_binding(tile_id, binding)?;
        if let Some(session) = &mut self.active {
            // Bump inputEpoch so in-flight presses from old bindings cannot trigger new bindings.
            let next_epoch = self.next_epoch;
            self.next_epoch += 1;
            session.input_epoch = next_epoch;
            let _ = self.input.revoke_session(&session.session_id);
            let _ = session.tx.try_send(ServerMessage::DeckSnapshotPush {
                deck_snapshot: snap.clone(),
                deck_revision: rev,
                input_epoch: next_epoch,
            });
        }
        Ok((rev, snap))
    }

    /// Syncs key mappings and active profile name from Axonkey's first-class `DeviceManager`
    /// `axonkeyMobile` instance so edits in the standard MappingPage immediately reflect on phone.
    pub fn sync_from_managed_instance(
        &mut self,
        profile_name: String,
        behaviors: &std::collections::HashMap<String, crate::input_service::TriggerBehaviors>,
    ) {
        if self.context.profile_name != profile_name {
            self.context.profile_name = profile_name;
            self.context_revision += 1;
            if let Some(session) = &self.active {
                let _ = session.tx.try_send(ServerMessage::ContextChanged {
                    context: self.context.clone(),
                    context_revision: self.context_revision,
                });
            }
        }
        if let Ok(Some((rev, snap))) = self.deck.sync_from_managed_profile(behaviors) {
            if let Some(session) = &mut self.active {
                let next_epoch = self.next_epoch;
                self.next_epoch += 1;
                session.input_epoch = next_epoch;
                let _ = self.input.revoke_session(&session.session_id);
                let _ = session.tx.try_send(ServerMessage::DeckSnapshotPush {
                    deck_snapshot: snap,
                    deck_revision: rev,
                    input_epoch: next_epoch,
                });
            }
        }
    }

    pub fn active_session_info(&self) -> Option<ActiveSessionInfo> {
        self.active.as_ref().map(|s| ActiveSessionInfo {
            session_id: s.session_id.clone(),
            peer_id: s.peer_id.clone(),
            device_name: s.device_name.clone(),
            input_epoch: s.input_epoch,
        })
    }

    pub fn revoke_peer(&mut self, peer_id: &str) -> Result<bool, String> {
        let removed = self.pairing.revoke(peer_id)?;
        if self
            .active
            .as_ref()
            .is_some_and(|s| s.peer_id == peer_id)
        {
            self.revoke_active_session("peer_revoked");
        }
        Ok(removed)
    }

    pub fn update_deck_from_desktop(
        &mut self,
        base_revision: u64,
        patch: DeckLayoutPatch,
    ) -> Result<(u64, DeckSnapshot), DeckUpdateError> {
        let (rev, snap) = self.deck.apply_layout_patch(base_revision, patch)?;
        if let Some(session) = &self.active {
            let _ = session.tx.try_send(ServerMessage::DeckSnapshotPush {
                deck_snapshot: snap.clone(),
                deck_revision: rev,
                input_epoch: session.input_epoch,
            });
        }
        Ok((rev, snap))
    }

    pub fn update_foreground_context(&mut self, app_id: Option<String>, app_name: Option<String>) {
        if self.context.app_id == app_id && self.context.app_name == app_name {
            return;
        }
        self.context.app_id = app_id;
        self.context.app_name = app_name;
        self.context_revision += 1;
        if let Some(session) = &self.active {
            let _ = session.tx.try_send(ServerMessage::ContextChanged {
                context: self.context.clone(),
                context_revision: self.context_revision,
            });
        }
    }

    pub fn handle_pair_request(&mut self, pair_token: &str, device_name: &str) -> ServerMessage {
        match self.pairing.consume_offer(pair_token, device_name) {
            Ok((peer_id, peer_token)) => ServerMessage::PairResult {
                ok: true,
                peer_id: Some(peer_id),
                peer_token: Some(peer_token),
                error: None,
            },
            Err(err) => ServerMessage::PairResult {
                ok: false,
                peer_id: None,
                peer_token: None,
                error: Some(err),
            },
        }
    }

    /// Authenticates a paired peer, serially revokes any previous session, and activates a new session.
    pub fn claim_control(
        &mut self,
        peer_id: &str,
        peer_token: &str,
        device_name: &str,
        tx: mpsc::Sender<ServerMessage>,
        now: Instant,
    ) -> Result<(String, ServerMessage), ServerMessage> {
        let peer = self
            .pairing
            .authenticate(peer_id, peer_token, device_name)
            .map_err(|msg| ServerMessage::Error {
                code: "auth_failed".into(),
                message: msg,
            })?;

        // Serial revoke barrier before activating the replacement session.
        if self.active.is_some() {
            self.revoke_active_session("replaced_by_new_session");
        }

        let session_id = Uuid::new_v4().to_string();
        let input_epoch = self.next_epoch;
        self.next_epoch += 1;

        let mut session = ActiveSession {
            session_id: session_id.clone(),
            peer_id: peer.peer_id,
            device_name: peer.device_name,
            input_epoch,
            phase: SessionPhase::Active,
            last_seq: None,
            leases: VecDeque::new(),
            next_lease_id: 1,
            last_alive_at: now,
            tx,
        };
        let lease_id = session.issue_lease(now);
        self.active = Some(session);

        let ready = ServerMessage::ServerReady {
            session_id: session_id.clone(),
            input_epoch,
            lease_id,
            lease_ttl_ms: DEFAULT_LEASE_TTL_MS,
            tick_interval_ms: DEFAULT_TICK_INTERVAL_MS,
            host_id: self.host_id.clone(),
            host_name: self.host_name.clone(),
            capabilities: HostCapabilities::current(),
            deck_snapshot: self.deck.snapshot(),
            deck_revision: self.deck.revision(),
            context: self.context.clone(),
            context_revision: self.context_revision,
        };
        Ok((session_id, ready))
    }

    pub fn tick(&mut self, now: Instant) {
        let Some(session) = self.active.as_mut() else {
            return;
        };
        if session.phase != SessionPhase::Active {
            return;
        }
        // If foreground confirmation has exceeded lease TTL, release held inputs immediately.
        if now.duration_since(session.last_alive_at) > Duration::from_millis(DEFAULT_LEASE_TTL_MS) {
            let sid = session.session_id.clone();
            let _ = self.input.revoke_session(&sid);
        }
        let lease_id = session.issue_lease(now);
        let msg = ServerMessage::ServerTick {
            session_id: session.session_id.clone(),
            input_epoch: session.input_epoch,
            lease_id,
            lease_ttl_ms: DEFAULT_LEASE_TTL_MS,
        };
        let _ = session.tx.try_send(msg);
    }

    pub fn disconnect_session(&mut self, session_id: &str, reason: &str) {
        if self
            .active
            .as_ref()
            .is_some_and(|s| s.session_id == session_id)
        {
            self.revoke_active_session(reason);
        }
    }

    /// Serial revoke barrier: invalidates epoch, releases only this session's held outputs, clears accumulators.
    pub fn revoke_active_session(&mut self, reason: &str) {
        let Some(mut old) = self.active.take() else {
            return;
        };
        old.phase = SessionPhase::Revoking;
        if let Err(err) = self.input.revoke_session(&old.session_id) {
            log::warn!(
                target: "axonkey::mobile",
                "Revoke barrier reported OS release error for session {}: {err}",
                old.session_id
            );
        }
        let _ = old.tx.try_send(ServerMessage::SessionRevoked {
            session_id: old.session_id.clone(),
            reason: reason.to_owned(),
        });
        old.phase = SessionPhase::Closed;
    }

    pub fn handle_session_message(
        &mut self,
        conn_session_id: &str,
        msg: ClientMessage,
        now: Instant,
    ) -> Option<ServerMessage> {
        match msg {
            ClientMessage::ClientAlive {
                session_id,
                lease_id,
            } => {
                if let Some(session) = self.active.as_mut() {
                    if session.session_id == conn_session_id
                        && session.session_id == session_id
                        && session.is_lease_valid(lease_id, now)
                    {
                        session.last_alive_at = now;
                    }
                }
                None
            }
            ClientMessage::InputCancel {
                session_id,
                input_epoch,
                ..
            } => {
                if let Some(session) = self.active.as_ref() {
                    if session.session_id == conn_session_id
                        && session.session_id == session_id
                        && session.input_epoch == input_epoch
                    {
                        let _ = self.input.revoke_session(&session.session_id);
                    }
                }
                None
            }
            ClientMessage::DeckUpdate {
                session_id,
                request_id,
                base_revision,
                layout_patch,
            } => {
                if !self
                    .active
                    .as_ref()
                    .is_some_and(|s| s.session_id == conn_session_id && s.session_id == session_id)
                {
                    return Some(ServerMessage::DeckUpdateResult {
                        request_id,
                        ok: false,
                        conflict: None,
                        deck_revision: self.deck.revision(),
                        deck_snapshot: None,
                        error: Some("会话已失效".into()),
                    });
                }
                match self.deck.apply_layout_patch(base_revision, layout_patch) {
                    Ok((rev, snap)) => Some(ServerMessage::DeckUpdateResult {
                        request_id,
                        ok: true,
                        conflict: Some(false),
                        deck_revision: rev,
                        deck_snapshot: Some(snap),
                        error: None,
                    }),
                    Err(DeckUpdateError::Conflict(conflict)) => {
                        Some(ServerMessage::DeckUpdateResult {
                            request_id,
                            ok: false,
                            conflict: Some(true),
                            deck_revision: conflict.revision,
                            deck_snapshot: Some(conflict.snapshot),
                            error: Some("桌面端配置已更新，请基于最新版本重新编辑".into()),
                        })
                    }
                    Err(DeckUpdateError::Invalid(e) | DeckUpdateError::Io(e)) => {
                        Some(ServerMessage::DeckUpdateResult {
                            request_id,
                            ok: false,
                            conflict: Some(false),
                            deck_revision: self.deck.revision(),
                            deck_snapshot: None,
                            error: Some(e),
                        })
                    }
                }
            }
            ClientMessage::TileActivate {
                session_id,
                input_epoch,
                seq,
                lease_id,
                request_id,
                tile_id,
                gesture,
            } => {
                if let Err(code) =
                    self.validate_input_gate(conn_session_id, &session_id, input_epoch, seq, lease_id, now)
                {
                    return Some(cmd_err(request_id, code, "输入已过期或会话已变更"));
                }
                let Some(actions) = self.deck.resolve_gesture(&tile_id, gesture) else {
                    return Some(cmd_err(request_id, "unbound_tile", "该按键未绑定动作"));
                };
                match self.input.execute_behaviors(actions) {
                    Ok(()) => Some(cmd_ok(request_id)),
                    Err(e) => Some(cmd_err(request_id, "injection_failed", &e)),
                }
            }
            ClientMessage::TileHoldBegin {
                session_id,
                input_epoch,
                seq,
                lease_id,
                request_id,
                tile_id,
                press_id,
            } => {
                if let Err(code) =
                    self.validate_input_gate(conn_session_id, &session_id, input_epoch, seq, lease_id, now)
                {
                    return Some(cmd_err(request_id, code, "输入已过期或会话已变更"));
                }
                let Some(keys) = self.deck.resolve_hold_keys(&tile_id) else {
                    return Some(cmd_err(request_id, "unbound_hold", "该按键未配置持续按住键"));
                };
                match self.input.hold_keys(&session_id, &press_id, keys, true) {
                    Ok(()) => Some(cmd_ok(request_id)),
                    Err(e) => Some(cmd_err(request_id, "injection_failed", &e)),
                }
            }
            ClientMessage::TileHoldEnd {
                session_id,
                input_epoch,
                seq,
                lease_id,
                request_id,
                press_id,
                ..
            } => {
                // Release is allowed even if lease just ticked, as long as session & epoch match.
                if !self.is_matching_session(conn_session_id, &session_id, input_epoch, seq) {
                    return Some(cmd_err(request_id, "stale_session", "会话已失效"));
                }
                let _ = lease_id;
                match self.input.hold_keys(&session_id, &press_id, Vec::new(), false) {
                    Ok(()) => Some(cmd_ok(request_id)),
                    Err(e) => Some(cmd_err(request_id, "injection_failed", &e)),
                }
            }
            ClientMessage::PointerMotion {
                session_id,
                input_epoch,
                seq,
                lease_id,
                dx,
                dy,
            } => {
                if !dx.is_finite() || !dy.is_finite() {
                    return None;
                }
                if self
                    .validate_input_gate(conn_session_id, &session_id, input_epoch, seq, lease_id, now)
                    .is_err()
                {
                    return None;
                }
                let sens = self.deck.snapshot().pointer_sensitivity;
                let _ = self.input.pointer_motion(&session_id, dx, dy, sens);
                None
            }
            ClientMessage::PointerScroll {
                session_id,
                input_epoch,
                seq,
                lease_id,
                x,
                y,
            } => {
                if !x.is_finite() || !y.is_finite() {
                    return None;
                }
                if self
                    .validate_input_gate(conn_session_id, &session_id, input_epoch, seq, lease_id, now)
                    .is_err()
                {
                    return None;
                }
                let sens = self.deck.snapshot().scroll_sensitivity;
                let _ = self.input.pointer_scroll(&session_id, x, y, sens);
                None
            }
            ClientMessage::PointerButton {
                session_id,
                input_epoch,
                seq,
                lease_id,
                request_id,
                button,
                phase,
                press_id,
            } => {
                let down = matches!(phase, PointerButtonPhase::Down);
                if down {
                    if let Err(code) = self.validate_input_gate(
                        conn_session_id,
                        &session_id,
                        input_epoch,
                        seq,
                        lease_id,
                        now,
                    ) {
                        return Some(cmd_err(request_id, code, "输入已过期或会话已变更"));
                    }
                } else if !self.is_matching_session(conn_session_id, &session_id, input_epoch, seq)
                {
                    return Some(cmd_err(request_id, "stale_session", "会话已失效"));
                }
                let btn = match button {
                    PointerButtonName::Left => MouseButton::Left,
                    PointerButtonName::Right => MouseButton::Right,
                    PointerButtonName::Middle => MouseButton::Middle,
                };
                match self.input.pointer_button(&session_id, &press_id, btn, down) {
                    Ok(()) => Some(cmd_ok(request_id)),
                    Err(e) => Some(cmd_err(request_id, "injection_failed", &e)),
                }
            }
            ClientMessage::TextCommit {
                session_id,
                input_epoch,
                seq,
                lease_id,
                request_id,
                text,
                mode,
                submit,
                context_revision,
            } => {
                if let Err(code) =
                    self.validate_input_gate(conn_session_id, &session_id, input_epoch, seq, lease_id, now)
                {
                    return Some(cmd_err(request_id, code, "输入已过期或会话已变更"));
                }
                if context_revision != self.context_revision {
                    return Some(cmd_err(
                        request_id,
                        "context_changed",
                        "桌面当前前台应用已切换，已取消本次文本提交",
                    ));
                }
                if text.is_empty() || text.len() > 16_384 {
                    return Some(cmd_err(request_id, "invalid_text", "文本长度超出限制"));
                }
                let paste_mode = matches!(mode, TextCommitMode::Paste);
                match self.input.text_commit(&text, paste_mode, submit) {
                    Ok(()) => Some(cmd_ok(request_id)),
                    Err(e) => Some(cmd_err(request_id, "injection_failed", &e)),
                }
            }
            ClientMessage::PairRequest { .. }
            | ClientMessage::ClientAuth { .. }
            | ClientMessage::AudioStart { .. }
            | ClientMessage::AudioStop { .. } => Some(ServerMessage::Error {
                code: "already_authenticated".into(),
                message: "会话已认证，无需重复握手".into(),
            }),
        }
    }

    fn validate_input_gate(
        &mut self,
        conn_session_id: &str,
        session_id: &str,
        input_epoch: u64,
        seq: u32,
        lease_id: u64,
        now: Instant,
    ) -> Result<(), &'static str> {
        let Some(session) = self.active.as_mut() else {
            return Err("no_active_session");
        };
        if session.phase != SessionPhase::Active
            || session.session_id != conn_session_id
            || session.session_id != session_id
            || session.input_epoch != input_epoch
        {
            return Err("stale_epoch");
        }
        if !session.accept_seq(seq) {
            return Err("out_of_order_seq");
        }
        if !session.is_lease_valid(lease_id, now) {
            return Err("lease_expired");
        }
        session.last_alive_at = now;
        Ok(())
    }

    fn is_matching_session(
        &mut self,
        conn_session_id: &str,
        session_id: &str,
        input_epoch: u64,
        seq: u32,
    ) -> bool {
        let Some(session) = self.active.as_mut() else {
            return false;
        };
        session.session_id == conn_session_id
            && session.session_id == session_id
            && session.input_epoch == input_epoch
            && session.accept_seq(seq)
    }
}

fn cmd_ok(request_id: String) -> ServerMessage {
    ServerMessage::CommandResult {
        request_id,
        ok: true,
        code: None,
        message: None,
    }
}

fn cmd_err(request_id: String, code: &str, message: &str) -> ServerMessage {
    ServerMessage::CommandResult {
        request_id,
        ok: false,
        code: Some(code.to_owned()),
        message: Some(message.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input_service::NativeBehavior;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockBackend {
        events: Mutex<Vec<String>>,
    }

    impl MobileInputBackend for MockBackend {
        fn execute_behaviors(&self, behaviors: &[NativeBehavior]) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("behaviors:{}", behaviors.len()));
            Ok(())
        }
        fn inject_relative_motion(&self, dx: i32, dy: i32) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("move:{dx},{dy}"));
            Ok(())
        }
        fn inject_wheel(&self, delta: i32, horizontal: bool) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("wheel:{delta}:{horizontal}"));
            Ok(())
        }
        fn inject_mouse_button(&self, button: MouseButton, down: bool) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("btn:{button:?}:{down}"));
            Ok(())
        }
        fn inject_key_edge(&self, key: &str, down: bool) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("key:{key}:{down}"));
            Ok(())
        }
    }

    #[test]
    fn enforces_lease_expiry_context_revision_and_serial_revoke_barrier() {
        let dir = std::env::temp_dir().join(format!("axonkey-sess-test-{}", Uuid::new_v4()));
        let pairing = PairingStore::load(dir.join("peers.json")).unwrap();
        let deck = DeckStore::load(dir.join("mobile-deck.json")).unwrap();
        let backend = MockBackend::default();
        let input = Arc::new(MobileInputController::new(backend));

        let mut coord = MobileCoordinator::new(
            "host-1".into(),
            "TestPC".into(),
            "CA".into(),
            pairing,
            deck,
            Arc::clone(&input),
        );

        let offer = coord.create_pairing_offer(vec!["127.0.0.1:12345".into()]);
        let pair_res = coord.handle_pair_request(&offer.pair_token, "Phone A");
        let (peer_id, peer_token) = match pair_res {
            ServerMessage::PairResult {
                ok: true,
                peer_id: Some(id),
                peer_token: Some(tok),
                ..
            } => (id, tok),
            other => panic!("Expected pair success, got {other:?}"),
        };

        let t0 = Instant::now();
        let (tx1, mut rx1) = mpsc::channel(16);
        let (sid1, ready) = coord
            .claim_control(&peer_id, &peer_token, "Phone A", tx1, t0)
            .unwrap();
        let (epoch1, lease1, ctx_rev1) = match ready {
            ServerMessage::ServerReady {
                input_epoch,
                lease_id,
                context_revision,
                ..
            } => (input_epoch, lease_id, context_revision),
            _ => panic!("Expected ServerReady"),
        };

        // Hold left mouse button down.
        let down_res = coord
            .handle_session_message(
                &sid1,
                ClientMessage::PointerButton {
                    session_id: sid1.clone(),
                    input_epoch: epoch1,
                    seq: 1,
                    lease_id: lease1,
                    request_id: "r1".into(),
                    button: PointerButtonName::Left,
                    phase: PointerButtonPhase::Down,
                    press_id: "drag-1".into(),
                },
                t0 + Duration::from_millis(50),
            )
            .unwrap();
        assert!(matches!(down_res, ServerMessage::CommandResult { ok: true, .. }));

        // Expired lease (>750ms) must be rejected.
        let expired_res = coord
            .handle_session_message(
                &sid1,
                ClientMessage::TileActivate {
                    session_id: sid1.clone(),
                    input_epoch: epoch1,
                    seq: 2,
                    lease_id: lease1,
                    request_id: "r2".into(),
                    tile_id: "tile.enter".into(),
                    gesture: super::super::protocol::TileGestureKind::Tap,
                },
                t0 + Duration::from_millis(900),
            )
            .unwrap();
        assert!(matches!(
            expired_res,
            ServerMessage::CommandResult { ok: false, code: Some(ref c), .. } if c == "lease_expired"
        ));

        // Foreground app change invalidates old contextRevision for text.commit.
        coord.update_foreground_context(Some("cursor.exe".into()), Some("Cursor".into()));
        let stale_ctx_res = coord
            .handle_session_message(
                &sid1,
                ClientMessage::TextCommit {
                    session_id: sid1.clone(),
                    input_epoch: epoch1,
                    seq: 3,
                    lease_id: lease1,
                    request_id: "r3".into(),
                    text: "hello".into(),
                    mode: TextCommitMode::Paste,
                    submit: true,
                    context_revision: ctx_rev1,
                },
                t0 + Duration::from_millis(100),
            )
            .unwrap();
        assert!(matches!(
            stale_ctx_res,
            ServerMessage::CommandResult { ok: false, code: Some(ref c), .. } if c == "context_changed"
        ));

        // New connection replaces old session -> triggers revoke barrier & releases Left button.
        let (tx2, _rx2) = mpsc::channel(16);
        let (_sid2, _ready2) = coord
            .claim_control(&peer_id, &peer_token, "Phone B", tx2, t0 + Duration::from_millis(200))
            .unwrap();

        // Drain rx1 and verify SessionRevoked was sent.
        let mut saw_revoked = false;
        while let Ok(msg) = rx1.try_recv() {
            if matches!(msg, ServerMessage::SessionRevoked { .. }) {
                saw_revoked = true;
            }
        }
        assert!(saw_revoked);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
