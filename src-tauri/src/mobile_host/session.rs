use super::deck::{
    bindings_to_trigger_behaviors_dto, DeckStore, DeckUpdateError, TileActionBindings, VOICE_KEY_ID,
};
use super::pairing::{PairedPeerSummary, PairingStore};
use super::protocol::{
    evaluate_current_client_handshake, Aka1AudioFrame, Akp1PointerFrame, Akp1PointerKind,
    ClientMessage, ClientVersionHandshake, DeckLayoutPatch, DeckSnapshot, ForegroundContext,
    HostCapabilities, PointerButtonName, PointerButtonPhase, ServerMessage, StarterPresetId,
    SystemTouchpadGesture, TextCommitMode, VersionCompatSeverity, VersionCompatTarget,
    VersionCompatibilityNotice, VoicePresetKind, DEFAULT_LEASE_TTL_MS, DEFAULT_TICK_INTERVAL_MS,
    MAX_AUDIO_PCM_BYTES,
};
use crate::input_service::mobile::{MobileInputBackend, MobileInputController};
use crate::input_service::{MouseButton, NativeBehavior};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use uuid::Uuid;

pub const VOICE_DRAIN_POLL_MS: u64 = 5;
pub const VOICE_DOWNSTREAM_MARGIN_MS: u64 = 45;
pub const VOICE_DRAIN_HARD_CAP_MS: u64 = 200;
pub const TILE_ACTIVATE_FLASH_MS: u64 = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionPhase {
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
    input_generation: u64,
    phase: SessionPhase,
    last_seq: Option<u64>,
    leases: VecDeque<IssuedLease>,
    next_lease_id: u64,
    last_alive_at: Instant,
    version_notice: Option<VersionCompatibilityNotice>,
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

    fn has_unexpired_lease(&self, now: Instant) -> bool {
        self.leases.iter().any(|l| now <= l.expires_at)
    }

    fn accept_seq(&mut self, seq: u64) -> bool {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VoicePhase {
    Streaming,
    Draining,
}

struct ActiveVoiceStream {
    session_id: String,
    stream_id: u64,
    phase: VoicePhase,
    next_sample_index: u64,
    final_sample_exclusive: Option<u64>,
}

pub struct SessionOutcome {
    pub reply: Option<ServerMessage>,
    pub voice_drain: Option<(String, u64)>,
    pub ui_flash_release: Option<(String, u64)>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSessionInfo {
    pub session_id: String,
    pub peer_id: String,
    pub device_name: String,
    pub input_epoch: u64,
    pub input_generation: u64,
}

/// Serial coordinator owning pairing, deck authority, active session, voice stream, and revoke barrier.
pub struct MobileCoordinator<B: MobileInputBackend> {
    host_id: String,
    host_name: String,
    ca_cert_der_b64: String,
    pairing: PairingStore,
    deck: DeckStore,
    input: Arc<MobileInputController<B>>,
    active: Option<ActiveSession>,
    next_epoch: u64,
    next_generation: u64,
    context: ForegroundContext,
    context_revision: u64,
    last_managed_keys: HashSet<String>,
    audio_gain_db: i16,
    active_voice: Option<ActiveVoiceStream>,
    legacy_audio_active: bool,
    #[cfg(windows)]
    audio_source: crate::windows_vmic::AudioSource,
    #[cfg(any(target_os = "windows", target_os = "macos", test))]
    audio_diagnostics: crate::audio_service::diagnostics::AudioDiagnostics,
    received_audio_packets: bool,
    ui_presses: BTreeMap<String, String>,
    next_flash_id: u64,
    rejected_version_notice: Option<VersionCompatibilityNotice>,
    rejection_seq: u64,
    ui_tx: Option<mpsc::UnboundedSender<Vec<String>>>,
    deck_event_tx: Option<mpsc::UnboundedSender<super::MobileDeckResponse>>,
    preset_event_tx: Option<mpsc::UnboundedSender<super::MobilePresetAppliedPayload>>,
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
        #[cfg(windows)]
        let audio_source = crate::windows_vmic::source();
        Self {
            host_id,
            host_name,
            ca_cert_der_b64,
            pairing,
            deck,
            input,
            active: None,
            next_epoch: 1,
            next_generation: 1,
            context: ForegroundContext {
                app_id: None,
                app_name: None,
                profile_name: "默认配置".into(),
            },
            context_revision: 1,
            last_managed_keys: HashSet::new(),
            audio_gain_db: 0,
            active_voice: None,
            legacy_audio_active: false,
            #[cfg(windows)]
            audio_source,
            #[cfg(any(target_os = "windows", target_os = "macos", test))]
            audio_diagnostics: crate::audio_service::diagnostics::AudioDiagnostics::default(),
            received_audio_packets: false,
            ui_presses: BTreeMap::new(),
            next_flash_id: 0,
            rejected_version_notice: None,
            rejection_seq: 0,
            ui_tx: None,
            deck_event_tx: None,
            preset_event_tx: None,
        }
    }

    #[cfg(all(windows, test))]
    pub(crate) fn new_with_audio_source(
        host_id: String,
        host_name: String,
        ca_cert_der_b64: String,
        pairing: PairingStore,
        deck: DeckStore,
        input: Arc<MobileInputController<B>>,
        audio_source: crate::windows_vmic::AudioSource,
    ) -> Self {
        let mut coord = Self::new(host_id, host_name, ca_cert_der_b64, pairing, deck, input);
        coord.audio_source = audio_source;
        coord
    }

    pub fn set_ui_event_sender(&mut self, tx: mpsc::UnboundedSender<Vec<String>>) {
        self.ui_tx = Some(tx);
    }

    pub fn set_deck_event_sender(&mut self, tx: mpsc::UnboundedSender<super::MobileDeckResponse>) {
        self.deck_event_tx = Some(tx);
    }

    pub fn set_preset_event_sender(
        &mut self,
        tx: mpsc::UnboundedSender<super::MobilePresetAppliedPayload>,
    ) {
        self.preset_event_tx = Some(tx);
    }

    fn emit_deck_changed(&self, revision: u64, snapshot: DeckSnapshot) {
        if let Some(tx) = &self.deck_event_tx {
            let _ = tx.send(super::MobileDeckResponse { revision, snapshot });
        }
    }

    fn emit_preset_applied(
        &self,
        revision: u64,
        snapshot: DeckSnapshot,
        bindings: std::collections::HashMap<String, TileActionBindings>,
    ) {
        if let Some(tx) = &self.preset_event_tx {
            let behaviors = bindings_to_trigger_behaviors_dto(&bindings);
            let _ = tx.send(super::MobilePresetAppliedPayload {
                revision,
                snapshot,
                bindings,
                behaviors,
            });
        }
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn host_name(&self) -> &str {
        &self.host_name
    }

    pub fn paired_count(&self) -> usize {
        self.pairing.list().len()
    }

    pub fn is_voice_active(&self) -> bool {
        self.active_voice.is_some() || self.legacy_audio_active
    }

    pub fn has_received_audio(&self) -> bool {
        self.received_audio_packets
    }

    pub fn set_audio_gain_db(&mut self, gain_db: i16) {
        let clamped = crate::audio_service::clamp_gain_db(gain_db);
        self.audio_gain_db = clamped;
        #[cfg(windows)]
        self.audio_source.set_gain_db(clamped);
    }

    #[cfg(any(target_os = "windows", target_os = "macos", test))]
    pub fn audio_level(&self) -> crate::audio_service::AudioLevel {
        self.audio_diagnostics.level()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", test)))]
    pub fn audio_level(&self) -> crate::audio_service::AudioLevel {
        crate::audio_service::AudioLevel::default()
    }

    #[cfg(any(target_os = "windows", target_os = "macos", test))]
    fn record_diagnostics_pcm(&self, samples: &[i16]) {
        if samples.is_empty() {
            return;
        }
        let gain = 10.0_f32.powf(f32::from(self.audio_gain_db) / 20.0);
        if (gain - 1.0).abs() < 1e-4 {
            self.audio_diagnostics.decoded(samples);
        } else {
            let scaled: Vec<i16> = samples
                .iter()
                .map(|&s| (f32::from(s) * gain).round().clamp(-32768.0, 32767.0) as i16)
                .collect();
            self.audio_diagnostics.decoded(&scaled);
        }
    }

    #[cfg(windows)]
    pub(crate) fn audio_source(&self) -> &crate::windows_vmic::AudioSource {
        &self.audio_source
    }

    pub fn is_voice_draining(&self, session_id: &str, stream_id: u64) -> bool {
        self.active_voice.as_ref().is_some_and(|v| {
            v.session_id == session_id
                && v.stream_id == stream_id
                && v.phase == VoicePhase::Draining
        })
    }

    pub fn complete_voice_drain(&mut self, session_id: &str, stream_id: u64) -> bool {
        if !self.is_voice_draining(session_id, stream_id) {
            return false;
        }
        self.active_voice = None;
        let press_id = format!("voice:{stream_id}");
        let _ = self
            .input
            .hold_keys(session_id, &press_id, Vec::new(), false);
        if self.ui_presses.remove(&press_id).is_some() {
            self.emit_ui_presses();
        }
        true
    }

    pub fn finish_ui_flash(&mut self, token: &str) {
        if self.ui_presses.remove(token).is_some() {
            self.emit_ui_presses();
        }
    }

    fn emit_ui_presses(&self) {
        let Some(tx) = &self.ui_tx else {
            return;
        };
        let mut unique = Vec::with_capacity(self.ui_presses.len());
        for key in self.ui_presses.values() {
            if !unique.contains(key) {
                unique.push(key.clone());
            }
        }
        let _ = tx.send(unique);
    }

    fn clear_all_ui_presses(&mut self) {
        if !self.ui_presses.is_empty() {
            self.ui_presses.clear();
            self.emit_ui_presses();
        }
    }

    fn cancel_voice_internal(&mut self) {
        let mut ui_changed = false;
        if let Some(voice) = self.active_voice.take() {
            let press_id = format!("voice:{}", voice.stream_id);
            let _ = self
                .input
                .hold_keys(&voice.session_id, &press_id, Vec::new(), false);
            #[cfg(windows)]
            self.audio_source.clear();
            ui_changed |= self.ui_presses.remove(&press_id).is_some();
        }
        if self.legacy_audio_active {
            self.legacy_audio_active = false;
            #[cfg(windows)]
            self.audio_source.clear();
            ui_changed |= self.ui_presses.remove("legacy:audio").is_some();
        }
        if ui_changed {
            self.emit_ui_presses();
        }
    }

    fn allocate_generation(&mut self) -> u64 {
        let gen = self.next_generation;
        self.next_generation += 1;
        gen
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
        self.cancel_voice_internal();
        self.clear_all_ui_presses();
        let next_epoch = self.next_epoch;
        let next_gen = self.allocate_generation();
        if let Some(session) = &mut self.active {
            // Bump inputEpoch & inputGeneration so in-flight presses from old bindings cannot trigger new bindings.
            self.next_epoch += 1;
            session.input_epoch = next_epoch;
            session.input_generation = next_gen;
            let _ = self.input.revoke_session(&session.session_id);
            let _ = session.tx.try_send(ServerMessage::DeckSnapshotPush {
                deck_snapshot: snap.clone(),
                deck_revision: rev,
                input_epoch: next_epoch,
                input_generation: next_gen,
            });
        }
        self.emit_deck_changed(rev, snap.clone());
        Ok((rev, snap))
    }

    pub fn apply_preset_from_desktop(
        &mut self,
        preset: StarterPresetId,
        voice_preset: Option<VoicePresetKind>,
    ) -> Result<(u64, DeckSnapshot), String> {
        let (rev, snap, bindings) = self.deck.apply_preset(preset, voice_preset)?;
        self.last_managed_keys = bindings.keys().cloned().collect();
        self.cancel_voice_internal();
        self.clear_all_ui_presses();
        let next_epoch = self.next_epoch;
        let next_gen = self.allocate_generation();
        if let Some(session) = &mut self.active {
            self.next_epoch += 1;
            session.input_epoch = next_epoch;
            session.input_generation = next_gen;
            let _ = self.input.revoke_session(&session.session_id);
            let _ = session.tx.try_send(ServerMessage::DeckSnapshotPush {
                deck_snapshot: snap.clone(),
                deck_revision: rev,
                input_epoch: next_epoch,
                input_generation: next_gen,
            });
        }
        self.emit_deck_changed(rev, snap.clone());
        self.emit_preset_applied(rev, snap.clone(), bindings);
        Ok((rev, snap))
    }

    /// Syncs key mappings, audio gain, and active profile name from Axonkey's first-class
    /// `DeviceManager` `axonkeyMobile` instance (including foreground app profile switches).
    pub fn sync_from_managed_instance_with_gain(
        &mut self,
        profile_name: String,
        audio_gain_db: i16,
        behaviors: &std::collections::HashMap<String, crate::input_service::TriggerBehaviors>,
    ) {
        let clamped_gain = crate::audio_service::clamp_gain_db(audio_gain_db);
        if self.audio_gain_db != clamped_gain {
            self.audio_gain_db = clamped_gain;
            #[cfg(windows)]
            self.audio_source.set_gain_db(clamped_gain);
        }
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
        let prev_keys = std::mem::replace(
            &mut self.last_managed_keys,
            behaviors.keys().cloned().collect(),
        );
        let is_explicit_blank_profile = behaviors.is_empty()
            && prev_keys.is_empty()
            && (self.context.profile_name.starts_with("纯净空白")
                || self.context.profile_name.starts_with("空白配置"));
        let sync_result = if is_explicit_blank_profile {
            self.deck.clear_all_bindings()
        } else {
            self.deck
                .sync_from_managed_profile_with_previous(behaviors, &prev_keys)
        };
        if let Ok(Some((rev, snap))) = sync_result {
            self.cancel_voice_internal();
            self.clear_all_ui_presses();
            let next_epoch = self.next_epoch;
            let next_gen = self.allocate_generation();
            if let Some(session) = &mut self.active {
                self.next_epoch += 1;
                session.input_epoch = next_epoch;
                session.input_generation = next_gen;
                let _ = self.input.revoke_session(&session.session_id);
                let _ = session.tx.try_send(ServerMessage::DeckSnapshotPush {
                    deck_snapshot: snap.clone(),
                    deck_revision: rev,
                    input_epoch: next_epoch,
                    input_generation: next_gen,
                });
            }
            self.emit_deck_changed(rev, snap);
        }
    }

    pub fn active_session_info(&self) -> Option<ActiveSessionInfo> {
        self.active.as_ref().map(|s| ActiveSessionInfo {
            session_id: s.session_id.clone(),
            peer_id: s.peer_id.clone(),
            device_name: s.device_name.clone(),
            input_epoch: s.input_epoch,
            input_generation: s.input_generation,
        })
    }

    pub fn version_notice(&self) -> Option<VersionCompatibilityNotice> {
        if let Some(session) = &self.active {
            return session.version_notice.clone();
        }
        self.rejected_version_notice.clone()
    }

    pub fn revoke_peer(&mut self, peer_id: &str) -> Result<bool, String> {
        let removed = self.pairing.revoke(peer_id)?;
        if self.active.as_ref().is_some_and(|s| s.peer_id == peer_id) {
            self.revoke_active_session("peer_revoked");
        }
        Ok(removed)
    }

    pub fn rename_peer(
        &mut self,
        peer_id: &str,
        remark: Option<String>,
    ) -> Result<PairedPeerSummary, String> {
        let summary = self.pairing.set_peer_remark(peer_id, remark)?;
        if let Some(session) = self.active.as_mut() {
            if session.peer_id == peer_id {
                session.device_name = summary.device_name.clone();
            }
        }
        Ok(summary)
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
                input_generation: session.input_generation,
            });
        }
        self.emit_deck_changed(rev, snap.clone());
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

    #[cfg(test)]
    pub fn handle_pair_request(&mut self, pair_token: &str, device_name: &str) -> ServerMessage {
        self.handle_pair_request_with_handshake(
            pair_token,
            device_name,
            &ClientVersionHandshake::current_compatible_default(),
        )
    }

    pub fn handle_pair_request_with_handshake(
        &mut self,
        pair_token: &str,
        device_name: &str,
        handshake: &ClientVersionHandshake,
    ) -> ServerMessage {
        let next_occ = self.rejection_seq + 1;
        if let Some(notice) = evaluate_current_client_handshake(device_name, handshake, next_occ) {
            if notice.severity == VersionCompatSeverity::Hard {
                self.rejection_seq = next_occ;
                self.rejected_version_notice = Some(notice.clone());
                return ServerMessage::PairResult {
                    ok: false,
                    peer_id: None,
                    peer_token: None,
                    error: Some(notice.message.clone()),
                    version_notice: Some(notice),
                };
            }
        }
        match self.pairing.consume_offer(pair_token, device_name) {
            Ok((peer_id, peer_token)) => ServerMessage::PairResult {
                ok: true,
                peer_id: Some(peer_id),
                peer_token: Some(peer_token),
                error: None,
                version_notice: None,
            },
            Err(err) => ServerMessage::PairResult {
                ok: false,
                peer_id: None,
                peer_token: None,
                error: Some(err),
                version_notice: None,
            },
        }
    }

    /// Authenticates a paired peer, serially revokes any previous session, and activates a new session.
    #[cfg(test)]
    pub fn claim_control(
        &mut self,
        peer_id: &str,
        peer_token: &str,
        device_name: &str,
        tx: mpsc::Sender<ServerMessage>,
        now: Instant,
    ) -> Result<(String, ServerMessage), ServerMessage> {
        self.claim_control_with_handshake(
            peer_id,
            peer_token,
            device_name,
            &ClientVersionHandshake::current_compatible_default(),
            tx,
            now,
        )
    }

    pub fn claim_control_with_handshake(
        &mut self,
        peer_id: &str,
        peer_token: &str,
        device_name: &str,
        handshake: &ClientVersionHandshake,
        tx: mpsc::Sender<ServerMessage>,
        now: Instant,
    ) -> Result<(String, ServerMessage), ServerMessage> {
        let peer = self
            .pairing
            .authenticate(peer_id, peer_token, device_name)
            .map_err(|msg| ServerMessage::Error {
                code: "auth_failed".into(),
                message: msg,
                version_notice: None,
            })?;

        let next_occ = self.rejection_seq + 1;
        let maybe_notice =
            evaluate_current_client_handshake(&peer.device_name, handshake, next_occ);
        if let Some(notice) = maybe_notice.as_ref() {
            if notice.severity == VersionCompatSeverity::Hard {
                self.rejection_seq = next_occ;
                self.rejected_version_notice = Some(notice.clone());
                let code = match notice.target {
                    VersionCompatTarget::Mobile => "client_upgrade_required",
                    VersionCompatTarget::Desktop => "host_upgrade_required",
                };
                return Err(ServerMessage::Error {
                    code: code.into(),
                    message: notice.message.clone(),
                    version_notice: Some(notice.clone()),
                });
            }
        }

        self.rejected_version_notice = None;

        // Serial revoke barrier before activating the replacement session.
        if self.active.is_some() {
            self.revoke_active_session("replaced_by_new_session");
        }

        let session_id = Uuid::new_v4().to_string();
        let input_epoch = self.next_epoch;
        self.next_epoch += 1;
        let input_generation = self.allocate_generation();

        let mut session = ActiveSession {
            session_id: session_id.clone(),
            peer_id: peer.peer_id,
            device_name: peer.device_name,
            input_epoch,
            input_generation,
            phase: SessionPhase::Active,
            last_seq: None,
            leases: VecDeque::new(),
            next_lease_id: 1,
            last_alive_at: now,
            version_notice: maybe_notice,
            tx,
        };
        let lease_id = session.issue_lease(now);
        self.active = Some(session);

        let ready = ServerMessage::ServerReady {
            session_id: session_id.clone(),
            input_epoch,
            input_generation,
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
        let expired = self.active.as_ref().is_some_and(|session| {
            session.phase == SessionPhase::Active
                && now.saturating_duration_since(session.last_alive_at)
                    > Duration::from_millis(DEFAULT_LEASE_TTL_MS)
        });
        if expired {
            self.cancel_voice_internal();
            self.clear_all_ui_presses();
            let next_gen = self.allocate_generation();
            if let Some(session) = self.active.as_mut() {
                session.input_generation = next_gen;
                let _ = self.input.revoke_session(&session.session_id);
            }
        }
        let Some(session) = self.active.as_mut() else {
            return;
        };
        if session.phase != SessionPhase::Active {
            return;
        }
        let lease_id = session.issue_lease(now);
        let msg = ServerMessage::ServerTick {
            session_id: session.session_id.clone(),
            input_epoch: session.input_epoch,
            input_generation: session.input_generation,
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

    /// Serial revoke barrier: invalidates epoch/voice, releases only this session's held outputs, clears accumulators.
    pub fn revoke_active_session(&mut self, reason: &str) {
        self.cancel_voice_internal();
        self.clear_all_ui_presses();
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

    /// Constant-time `AKP1` 40-byte binary pointer validation & injection under `coordinator` serial lock.
    pub fn handle_binary_pointer(
        &mut self,
        conn_session_id: &str,
        frame: Akp1PointerFrame,
        now: Instant,
    ) -> bool {
        if !frame.x.is_finite() || !frame.y.is_finite() || frame.input_generation == 0 {
            return false;
        }
        let session_id = {
            let Some(session) = self.active.as_mut() else {
                return false;
            };
            if session.phase != SessionPhase::Active
                || session.session_id != conn_session_id
                || session.input_generation != frame.input_generation
                || !session.has_unexpired_lease(now)
                || !session.accept_seq(frame.seq)
            {
                return false;
            }
            session.last_alive_at = now;
            session.session_id.clone()
        };

        match frame.kind {
            Akp1PointerKind::TrackpadRelative => {
                let sens = self.deck.pointer_sensitivity();
                let _ = self.input.pointer_motion(
                    &session_id,
                    f64::from(frame.x),
                    f64::from(frame.y),
                    sens,
                );
            }
            Akp1PointerKind::GyroRelative => {
                let _ = self.input.pointer_motion(
                    &session_id,
                    f64::from(frame.x),
                    f64::from(frame.y),
                    1.0,
                );
            }
            Akp1PointerKind::GyroAbsolute => {
                let u = f64::from(frame.x).clamp(0.0, 1.0);
                let v = f64::from(frame.y).clamp(0.0, 1.0);
                let _ = self.input.pointer_absolute(&session_id, u, v);
            }
        }
        true
    }

    /// Validates `AKA1` 32-byte header binary PCM16LE frame and appends samples to `AudioSource`.
    pub fn handle_binary_audio(
        &mut self,
        conn_session_id: &str,
        frame: Aka1AudioFrame<'_>,
        now: Instant,
    ) -> bool {
        if frame.input_generation == 0 {
            return false;
        }
        {
            let Some(session) = self.active.as_mut() else {
                return false;
            };
            if session.phase != SessionPhase::Active
                || session.session_id != conn_session_id
                || session.input_generation != frame.input_generation
            {
                return false;
            }
            session.last_alive_at = now;
        }
        let skip_samples = {
            let Some(voice) = self.active_voice.as_mut() else {
                return false;
            };
            if voice.session_id != conn_session_id
                || voice.stream_id != frame.stream_id
                || voice.phase != VoicePhase::Streaming
            {
                return false;
            }
            let total_samples = (frame.pcm_le_bytes.len() / 2) as u64;
            let skip = if frame.first_sample_index < voice.next_sample_index {
                let overlap = voice.next_sample_index - frame.first_sample_index;
                if overlap >= total_samples {
                    return true;
                }
                overlap as usize
            } else {
                if frame.first_sample_index > voice.next_sample_index {
                    log::debug!(
                        target: "axonkey::mobile",
                        "AKA1 sample gap on stream {}: expected {}, got {}",
                        frame.stream_id,
                        voice.next_sample_index,
                        frame.first_sample_index
                    );
                }
                0
            };
            voice.next_sample_index = frame.first_sample_index + total_samples;
            skip
        };

        #[cfg(windows)]
        {
            let slice = &frame.pcm_le_bytes[skip_samples * 2..];
            if !slice.is_empty() {
                let samples: Vec<i16> = slice
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]))
                    .collect();
                self.received_audio_packets = true;
                self.record_diagnostics_pcm(&samples);
                self.audio_source.push_pcm(&samples);
            }
        }
        #[cfg(not(windows))]
        let _ = skip_samples;
        true
    }

    /// Fallback for legacy `AudioStart` clients sending unframed raw 16kHz PCM16LE binary packets.
    pub fn handle_legacy_binary_pcm(
        &mut self,
        conn_session_id: &str,
        raw_pcm: &[u8],
        now: Instant,
    ) -> bool {
        if !self.legacy_audio_active
            || raw_pcm.is_empty()
            || raw_pcm.len() > MAX_AUDIO_PCM_BYTES
            || raw_pcm.len() % 2 != 0
        {
            return false;
        }
        let Some(session) = self.active.as_mut() else {
            return false;
        };
        if session.phase != SessionPhase::Active || session.session_id != conn_session_id {
            return false;
        }
        session.last_alive_at = now;
        #[cfg(windows)]
        {
            let samples: Vec<i16> = raw_pcm
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect();
            self.received_audio_packets = true;
            self.record_diagnostics_pcm(&samples);
            self.audio_source.push_pcm(&samples);
        }
        true
    }

    #[cfg(test)]
    pub fn handle_session_message(
        &mut self,
        conn_session_id: &str,
        msg: ClientMessage,
        now: Instant,
    ) -> Option<ServerMessage> {
        self.handle_session_message_with_effects(conn_session_id, msg, now)
            .reply
    }

    pub fn handle_session_message_with_effects(
        &mut self,
        conn_session_id: &str,
        msg: ClientMessage,
        now: Instant,
    ) -> SessionOutcome {
        let mut outcome = SessionOutcome {
            reply: None,
            voice_drain: None,
            ui_flash_release: None,
        };
        outcome.reply = match msg {
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
            ClientMessage::ClientRename {
                session_id,
                device_name,
            } => {
                let peer_id = self
                    .active
                    .as_ref()
                    .filter(|s| s.session_id == conn_session_id && s.session_id == session_id)
                    .map(|s| s.peer_id.clone());
                if let Some(pid) = peer_id {
                    if let Some(summary) = self.pairing.update_reported_name(&pid, &device_name) {
                        if let Some(session) = self.active.as_mut() {
                            if session.peer_id == pid {
                                session.device_name = summary.device_name;
                            }
                        }
                    }
                }
                None
            }
            ClientMessage::InputCancel {
                session_id,
                input_epoch,
                ..
            } => {
                let matches = self.active.as_ref().is_some_and(|session| {
                    session.session_id == conn_session_id
                        && session.session_id == session_id
                        && session.input_epoch == input_epoch
                });
                if matches {
                    self.cancel_voice_internal();
                    self.clear_all_ui_presses();
                    let _ = self.input.revoke_session(&session_id);
                }
                None
            }
            ClientMessage::VoiceBegin {
                session_id,
                input_epoch,
                input_generation,
                seq,
                lease_id,
                request_id,
                stream_id,
            } => {
                if stream_id == 0 {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "invalid_stream", "无效的语音流编号")),
                        ..outcome
                    };
                }
                if input_generation != 0
                    && !self
                        .active
                        .as_ref()
                        .is_some_and(|s| s.input_generation == input_generation)
                {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "stale_generation", "输入代际已变更")),
                        ..outcome
                    };
                }
                if let Err(code) = self.validate_input_gate(
                    conn_session_id,
                    &session_id,
                    input_epoch,
                    seq,
                    lease_id,
                    now,
                ) {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, code, "输入已过期或会话已变更")),
                        ..outcome
                    };
                }

                // Cleanly finish/cancel any previous streaming or draining voice utterance first.
                self.cancel_voice_internal();

                #[cfg(windows)]
                {
                    self.audio_source.prepare_stream();
                    self.audio_source.set_gain_db(self.audio_gain_db);
                }
                #[cfg(any(target_os = "windows", target_os = "macos", test))]
                self.audio_diagnostics.control(0x04);

                let keys = self.deck.resolve_voice_hold_keys();
                let press_id = format!("voice:{stream_id}");
                if !keys.is_empty() {
                    if let Err(e) = self.input.hold_keys(&session_id, &press_id, keys, true) {
                        #[cfg(windows)]
                        self.audio_source.clear();
                        return SessionOutcome {
                            reply: Some(cmd_err(request_id, "injection_failed", &e)),
                            ..outcome
                        };
                    }
                }
                self.active_voice = Some(ActiveVoiceStream {
                    session_id: session_id.clone(),
                    stream_id,
                    phase: VoicePhase::Streaming,
                    next_sample_index: 0,
                    final_sample_exclusive: None,
                });
                self.ui_presses.insert(press_id, VOICE_KEY_ID.to_owned());
                self.emit_ui_presses();
                Some(cmd_ok(request_id))
            }
            ClientMessage::VoiceEnd {
                session_id,
                input_epoch,
                input_generation,
                seq,
                request_id,
                stream_id,
                final_sample_exclusive,
            } => {
                if input_generation != 0
                    && !self
                        .active
                        .as_ref()
                        .is_some_and(|s| s.input_generation == input_generation)
                {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "stale_generation", "输入代际已变更")),
                        ..outcome
                    };
                }
                if !self.is_matching_session(conn_session_id, &session_id, input_epoch, seq) {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "stale_session", "会话已失效")),
                        ..outcome
                    };
                }
                let valid_stream = self.active_voice.as_mut().and_then(|voice| {
                    (voice.session_id == session_id
                        && voice.stream_id == stream_id
                        && voice.phase == VoicePhase::Streaming)
                        .then_some(voice)
                });
                let Some(voice) = valid_stream else {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "stale_stream", "语音流不存在或已结束")),
                        ..outcome
                    };
                };
                if final_sample_exclusive > 0 && voice.next_sample_index != final_sample_exclusive {
                    log::debug!(
                        target: "axonkey::mobile",
                        "VoiceEnd sample count mismatch on stream {stream_id}: received {}, expected {final_sample_exclusive}",
                        voice.next_sample_index
                    );
                }
                voice.phase = VoicePhase::Draining;
                voice.final_sample_exclusive = Some(final_sample_exclusive);
                #[cfg(windows)]
                self.audio_source.mark_eof();
                outcome.voice_drain = Some((session_id, stream_id));
                Some(cmd_ok(request_id))
            }
            ClientMessage::VoiceCancel {
                session_id,
                input_epoch,
                stream_id,
                ..
            } => {
                let session_ok = self.active.as_ref().is_some_and(|s| {
                    s.session_id == conn_session_id
                        && s.session_id == session_id
                        && s.input_epoch == input_epoch
                });
                if session_ok
                    && self
                        .active_voice
                        .as_ref()
                        .is_some_and(|v| v.stream_id == stream_id)
                {
                    self.cancel_voice_internal();
                }
                None
            }
            ClientMessage::AudioStart {
                session_id,
                sample_rate,
                channels,
            } => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|s| s.session_id == conn_session_id && s.session_id == session_id)
                    && sample_rate == 16_000
                    && channels == 1
                {
                    self.cancel_voice_internal();
                    #[cfg(windows)]
                    {
                        self.audio_source.prepare_stream();
                        self.audio_source.set_gain_db(self.audio_gain_db);
                    }
                    self.legacy_audio_active = true;
                    self.ui_presses
                        .insert("legacy:audio".into(), VOICE_KEY_ID.to_owned());
                    self.emit_ui_presses();
                }
                None
            }
            ClientMessage::AudioStop { session_id } => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|s| s.session_id == conn_session_id && s.session_id == session_id)
                    && self.legacy_audio_active
                {
                    self.legacy_audio_active = false;
                    #[cfg(windows)]
                    self.audio_source.clear();
                    if self.ui_presses.remove("legacy:audio").is_some() {
                        self.emit_ui_presses();
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
                    return SessionOutcome {
                        reply: Some(ServerMessage::DeckUpdateResult {
                            request_id,
                            ok: false,
                            conflict: None,
                            deck_revision: self.deck.revision(),
                            deck_snapshot: None,
                            error: Some("会话已失效".into()),
                        }),
                        ..outcome
                    };
                }
                match self.deck.apply_layout_patch(base_revision, layout_patch) {
                    Ok((rev, snap)) => {
                        self.emit_deck_changed(rev, snap.clone());
                        Some(ServerMessage::DeckUpdateResult {
                            request_id,
                            ok: true,
                            conflict: Some(false),
                            deck_revision: rev,
                            deck_snapshot: Some(snap),
                            error: None,
                        })
                    }
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
            ClientMessage::DeckApplyPreset {
                session_id,
                request_id,
                preset,
                voice_preset,
            } => {
                if !self
                    .active
                    .as_ref()
                    .is_some_and(|s| s.session_id == conn_session_id && s.session_id == session_id)
                {
                    return SessionOutcome {
                        reply: Some(ServerMessage::DeckUpdateResult {
                            request_id,
                            ok: false,
                            conflict: None,
                            deck_revision: self.deck.revision(),
                            deck_snapshot: None,
                            error: Some("会话已失效".into()),
                        }),
                        ..outcome
                    };
                }
                match self.deck.apply_preset(preset, voice_preset) {
                    Ok((rev, snap, bindings)) => {
                        self.last_managed_keys = bindings.keys().cloned().collect();
                        self.cancel_voice_internal();
                        self.clear_all_ui_presses();
                        if let Some(session) = &self.active {
                            let _ = self.input.revoke_session(&session.session_id);
                            let _ = session.tx.try_send(ServerMessage::DeckSnapshotPush {
                                deck_snapshot: snap.clone(),
                                deck_revision: rev,
                                input_epoch: session.input_epoch,
                                input_generation: session.input_generation,
                            });
                        }
                        self.emit_deck_changed(rev, snap.clone());
                        self.emit_preset_applied(rev, snap.clone(), bindings);
                        Some(ServerMessage::DeckUpdateResult {
                            request_id,
                            ok: true,
                            conflict: None,
                            deck_revision: rev,
                            deck_snapshot: Some(snap),
                            error: None,
                        })
                    }
                    Err(e) => Some(ServerMessage::DeckUpdateResult {
                        request_id,
                        ok: false,
                        conflict: None,
                        deck_revision: self.deck.revision(),
                        deck_snapshot: None,
                        error: Some(e),
                    }),
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
                if let Err(code) = self.validate_input_gate(
                    conn_session_id,
                    &session_id,
                    input_epoch,
                    seq,
                    lease_id,
                    now,
                ) {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, code, "输入已过期或会话已变更")),
                        ..outcome
                    };
                }
                let Some(actions) = self.deck.resolve_gesture(&tile_id, gesture) else {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "unbound_tile", "该按键未绑定动作")),
                        ..outcome
                    };
                };
                match self.input.execute_behaviors(actions) {
                    Ok(()) => {
                        self.next_flash_id += 1;
                        let token = format!("flash:{session_id}:{}", self.next_flash_id);
                        self.ui_presses.insert(token.clone(), tile_id);
                        self.emit_ui_presses();
                        outcome.ui_flash_release = Some((token, TILE_ACTIVATE_FLASH_MS));
                        Some(cmd_ok(request_id))
                    }
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
                if let Err(code) = self.validate_input_gate(
                    conn_session_id,
                    &session_id,
                    input_epoch,
                    seq,
                    lease_id,
                    now,
                ) {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, code, "输入已过期或会话已变更")),
                        ..outcome
                    };
                }
                let Some(keys) = self.deck.resolve_hold_keys(&tile_id) else {
                    return SessionOutcome {
                        reply: Some(cmd_err(
                            request_id,
                            "unbound_hold",
                            "该按键未配置持续按住键",
                        )),
                        ..outcome
                    };
                };
                match self.input.hold_keys(&session_id, &press_id, keys, true) {
                    Ok(()) => {
                        self.ui_presses
                            .insert(format!("hold:{session_id}:{press_id}"), tile_id);
                        self.emit_ui_presses();
                        Some(cmd_ok(request_id))
                    }
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
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "stale_session", "会话已失效")),
                        ..outcome
                    };
                }
                let _ = lease_id;
                match self
                    .input
                    .hold_keys(&session_id, &press_id, Vec::new(), false)
                {
                    Ok(()) => {
                        if self
                            .ui_presses
                            .remove(&format!("hold:{session_id}:{press_id}"))
                            .is_some()
                        {
                            self.emit_ui_presses();
                        }
                        Some(cmd_ok(request_id))
                    }
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
                    return outcome;
                }
                if self
                    .validate_input_gate(
                        conn_session_id,
                        &session_id,
                        input_epoch,
                        seq,
                        lease_id,
                        now,
                    )
                    .is_err()
                {
                    return outcome;
                }
                let sens = self.deck.pointer_sensitivity();
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
                    return outcome;
                }
                if self
                    .validate_input_gate(
                        conn_session_id,
                        &session_id,
                        input_epoch,
                        seq,
                        lease_id,
                        now,
                    )
                    .is_err()
                {
                    return outcome;
                }
                let sens = self.deck.scroll_sensitivity();
                let _ = self.input.pointer_scroll(&session_id, x, y, sens);
                None
            }
            ClientMessage::TouchpadGesture {
                session_id,
                input_epoch,
                seq,
                lease_id,
                gesture,
            } => {
                if self
                    .validate_input_gate(
                        conn_session_id,
                        &session_id,
                        input_epoch,
                        seq,
                        lease_id,
                        now,
                    )
                    .is_err()
                {
                    return outcome;
                }
                match gesture {
                    SystemTouchpadGesture::ThreeFingerUp => {
                        let actions = [NativeBehavior::Shortcut {
                            enabled: true,
                            keys: vec!["Win".into(), "Tab".into()],
                        }];
                        let _ = self.input.execute_behaviors(&actions);
                    }
                    SystemTouchpadGesture::ThreeFingerDown => {
                        let actions = [NativeBehavior::Shortcut {
                            enabled: true,
                            keys: vec!["Win".into(), "D".into()],
                        }];
                        let _ = self.input.execute_behaviors(&actions);
                    }
                    SystemTouchpadGesture::ThreeFingerLeft => {
                        let actions = [NativeBehavior::Shortcut {
                            enabled: true,
                            keys: vec!["Ctrl".into(), "Win".into(), "Right".into()],
                        }];
                        let _ = self.input.execute_behaviors(&actions);
                    }
                    SystemTouchpadGesture::ThreeFingerRight => {
                        let actions = [NativeBehavior::Shortcut {
                            enabled: true,
                            keys: vec!["Ctrl".into(), "Win".into(), "Left".into()],
                        }];
                        let _ = self.input.execute_behaviors(&actions);
                    }
                    SystemTouchpadGesture::ThreeFingerTap => {
                        let press_id = format!("gesture:middle:{seq}");
                        if self
                            .input
                            .pointer_button(&session_id, &press_id, MouseButton::Middle, true)
                            .is_ok()
                        {
                            let _ = self.input.pointer_button(
                                &session_id,
                                &press_id,
                                MouseButton::Middle,
                                false,
                            );
                        }
                    }
                }
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
                        return SessionOutcome {
                            reply: Some(cmd_err(request_id, code, "输入已过期或会话已变更")),
                            ..outcome
                        };
                    }
                } else if !self.is_matching_session(conn_session_id, &session_id, input_epoch, seq)
                {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "stale_session", "会话已失效")),
                        ..outcome
                    };
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
                if let Err(code) = self.validate_input_gate(
                    conn_session_id,
                    &session_id,
                    input_epoch,
                    seq,
                    lease_id,
                    now,
                ) {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, code, "输入已过期或会话已变更")),
                        ..outcome
                    };
                }
                if context_revision != self.context_revision {
                    return SessionOutcome {
                        reply: Some(cmd_err(
                            request_id,
                            "context_changed",
                            "桌面当前前台应用已切换，已取消本次文本提交",
                        )),
                        ..outcome
                    };
                }
                if text.is_empty() || text.len() > 16_384 {
                    return SessionOutcome {
                        reply: Some(cmd_err(request_id, "invalid_text", "文本长度超出限制")),
                        ..outcome
                    };
                }
                let paste_mode = matches!(mode, TextCommitMode::Paste);
                match self.input.text_commit(&text, paste_mode, submit) {
                    Ok(()) => Some(cmd_ok(request_id)),
                    Err(e) => Some(cmd_err(request_id, "injection_failed", &e)),
                }
            }
            ClientMessage::PairRequest { .. } | ClientMessage::ClientAuth { .. } => {
                Some(ServerMessage::Error {
                    code: "already_authenticated".into(),
                    message: "会话已认证，无需重复握手".into(),
                    version_notice: None,
                })
            }
        };
        outcome
    }

    fn validate_input_gate(
        &mut self,
        conn_session_id: &str,
        session_id: &str,
        input_epoch: u64,
        seq: u64,
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
        seq: u64,
    ) -> bool {
        let Some(session) = self.active.as_mut() else {
            return false;
        };
        if session.session_id == conn_session_id
            && session.session_id == session_id
            && session.input_epoch == input_epoch
            && session.accept_seq(seq)
        {
            return true;
        }
        false
    }
}

/// Sample-exact normal voice release drain task:
/// Polls `AudioSource::is_drained()` every 5ms + 45ms WaveRT/ASR downstream margin
/// (capped at 200ms total deadline) WITHOUT holding `coordinator` lock across sleeps,
/// then releases `voice:{stream_id}` hold keys if the stream was not cancelled/replaced.
pub async fn drain_voice_stream<B: MobileInputBackend + 'static>(
    coordinator: Arc<Mutex<MobileCoordinator<B>>>,
    session_id: String,
    stream_id: u64,
) {
    let deadline = Instant::now() + Duration::from_millis(VOICE_DRAIN_HARD_CAP_MS);
    #[cfg(windows)]
    {
        let audio_source = {
            let guard = coordinator.lock().unwrap_or_else(|e| e.into_inner());
            if !guard.is_voice_draining(&session_id, stream_id) {
                return;
            }
            guard.audio_source().clone()
        };

        let mut drained = audio_source.is_drained();
        while !drained && Instant::now() < deadline {
            let sleep_dur = Duration::from_millis(VOICE_DRAIN_POLL_MS)
                .min(deadline.saturating_duration_since(Instant::now()));
            if sleep_dur.is_zero() {
                break;
            }
            tokio::time::sleep(sleep_dur).await;
            let still_draining = coordinator
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_voice_draining(&session_id, stream_id);
            if !still_draining {
                return;
            }
            drained = audio_source.is_drained();
        }

        if drained {
            let margin = Duration::from_millis(VOICE_DOWNSTREAM_MARGIN_MS)
                .min(deadline.saturating_duration_since(Instant::now()));
            if !margin.is_zero() {
                tokio::time::sleep(margin).await;
            }
        } else {
            log::debug!(
                target: "axonkey::mobile",
                "Voice stream {stream_id} reached {VOICE_DRAIN_HARD_CAP_MS}ms drain cap; clearing unplayed buffer before key release"
            );
            audio_source.clear();
        }
    }
    #[cfg(not(windows))]
    {
        let margin = Duration::from_millis(VOICE_DOWNSTREAM_MARGIN_MS)
            .min(deadline.saturating_duration_since(Instant::now()));
        if !margin.is_zero() {
            tokio::time::sleep(margin).await;
        }
    }

    coordinator
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .complete_voice_drain(&session_id, stream_id);
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
            self.events.lock().unwrap().push(format!("move:{dx},{dy}"));
            Ok(())
        }
        fn inject_absolute_pointer(&self, u: f64, v: f64) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("abs:{u:.3},{v:.3}"));
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
        let (epoch1, gen1, lease1, ctx_rev1) = match ready {
            ServerMessage::ServerReady {
                input_epoch,
                input_generation,
                lease_id,
                context_revision,
                ..
            } => (input_epoch, input_generation, lease_id, context_revision),
            _ => panic!("Expected ServerReady"),
        };
        assert_eq!(gen1, 1);

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
        assert!(matches!(
            down_res,
            ServerMessage::CommandResult { ok: true, .. }
        ));

        // Expired lease (>750ms) must be rejected for both JSON and AKP1 binary frames.
        let expired_akp1 =
            super::super::protocol::parse_akp1_frame(&super::super::protocol::encode_akp1_frame(
                Akp1PointerKind::TrackpadRelative,
                gen1,
                2,
                1000,
                10.0,
                5.0,
            ))
            .unwrap();
        assert!(!coord.handle_binary_pointer(&sid1, expired_akp1, t0 + Duration::from_millis(900)));

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

        // New connection replaces old session -> triggers revoke barrier & bumps input_generation.
        let (tx2, _rx2) = mpsc::channel(16);
        let (_sid2, ready2) = coord
            .claim_control(
                &peer_id,
                &peer_token,
                "Phone B",
                tx2,
                t0 + Duration::from_millis(200),
            )
            .unwrap();
        match ready2 {
            ServerMessage::ServerReady {
                input_generation, ..
            } => assert!(input_generation > gen1),
            _ => panic!("Expected ServerReady"),
        }

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

    #[test]
    fn akp1_binary_pointer_applies_trackpad_sensitivity_gyro_unity_and_absolute_clamp() {
        let dir = std::env::temp_dir().join(format!("axonkey-akp1-test-{}", Uuid::new_v4()));
        let pairing = PairingStore::load(dir.join("peers.json")).unwrap();
        let deck = DeckStore::load(dir.join("mobile-deck.json")).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));

        struct SharedMock(Arc<Mutex<Vec<String>>>);
        impl MobileInputBackend for SharedMock {
            fn execute_behaviors(&self, _: &[NativeBehavior]) -> Result<(), String> {
                Ok(())
            }
            fn inject_relative_motion(&self, dx: i32, dy: i32) -> Result<(), String> {
                self.0.lock().unwrap().push(format!("rel:{dx},{dy}"));
                Ok(())
            }
            fn inject_absolute_pointer(&self, u: f64, v: f64) -> Result<(), String> {
                self.0.lock().unwrap().push(format!("abs:{u:.2},{v:.2}"));
                Ok(())
            }
            fn inject_wheel(&self, _: i32, _: bool) -> Result<(), String> {
                Ok(())
            }
            fn inject_mouse_button(&self, _: MouseButton, _: bool) -> Result<(), String> {
                Ok(())
            }
            fn inject_key_edge(&self, k: &str, down: bool) -> Result<(), String> {
                self.0.lock().unwrap().push(format!("key:{k}:{down}"));
                Ok(())
            }
        }

        let input = Arc::new(MobileInputController::new(SharedMock(Arc::clone(&events))));
        let mut coord = MobileCoordinator::new(
            "host-akp1".into(),
            "TestPC".into(),
            "CA".into(),
            pairing,
            deck,
            input,
        );
        let offer = coord.create_pairing_offer(vec!["127.0.0.1:9999".into()]);
        let (peer_id, peer_token) = match coord.handle_pair_request(&offer.pair_token, "Phone") {
            ServerMessage::PairResult {
                peer_id: Some(id),
                peer_token: Some(tok),
                ..
            } => (id, tok),
            _ => unreachable!(),
        };
        let t0 = Instant::now();
        let (tx, _rx) = mpsc::channel(16);
        let (sid, ready) = coord
            .claim_control(&peer_id, &peer_token, "Phone", tx, t0)
            .unwrap();
        let gen = match ready {
            ServerMessage::ServerReady {
                input_generation, ..
            } => input_generation,
            _ => unreachable!(),
        };

        // 1. Trackpad kind=1 uses deck.pointer_sensitivity() (default 1.4): 10 * 1.4 = 14
        let f1 =
            super::super::protocol::parse_akp1_frame(&super::super::protocol::encode_akp1_frame(
                Akp1PointerKind::TrackpadRelative,
                gen,
                10,
                100,
                10.0,
                -5.0,
            ))
            .unwrap();
        assert!(coord.handle_binary_pointer(&sid, f1, t0 + Duration::from_millis(10)));

        // Out-of-order seq <= 10 must be rejected
        assert!(!coord.handle_binary_pointer(&sid, f1, t0 + Duration::from_millis(12)));

        // Wrong generation must be rejected without consuming seq
        let wrong_gen =
            super::super::protocol::parse_akp1_frame(&super::super::protocol::encode_akp1_frame(
                Akp1PointerKind::GyroRelative,
                gen + 99,
                11,
                200,
                10.0,
                5.0,
            ))
            .unwrap();
        assert!(!coord.handle_binary_pointer(&sid, wrong_gen, t0 + Duration::from_millis(15)));

        // 2. Gyro relative kind=2 uses 1.0 sensitivity: 10 * 1.0 = 10
        let f2 =
            super::super::protocol::parse_akp1_frame(&super::super::protocol::encode_akp1_frame(
                Akp1PointerKind::GyroRelative,
                gen,
                11,
                200,
                10.0,
                5.0,
            ))
            .unwrap();
        assert!(coord.handle_binary_pointer(&sid, f2, t0 + Duration::from_millis(20)));

        // 3. Gyro absolute kind=3 clamps [0.0, 1.0]
        let f3 =
            super::super::protocol::parse_akp1_frame(&super::super::protocol::encode_akp1_frame(
                Akp1PointerKind::GyroAbsolute,
                gen,
                12,
                300,
                1.25,
                -0.2,
            ))
            .unwrap();
        assert!(coord.handle_binary_pointer(&sid, f3, t0 + Duration::from_millis(30)));

        assert_eq!(
            *events.lock().unwrap(),
            vec!["rel:14,-7", "rel:10,5", "abs:1.00,0.00"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn voice_end_drains_tail_before_releasing_alt_while_cancel_releases_immediately() {
        let dir = std::env::temp_dir().join(format!("axonkey-voice-sm-{}", Uuid::new_v4()));
        let pairing = PairingStore::load(dir.join("peers.json")).unwrap();
        let deck = DeckStore::load(dir.join("mobile-deck.json")).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));

        struct VoiceMock(Arc<Mutex<Vec<String>>>);
        impl MobileInputBackend for VoiceMock {
            fn execute_behaviors(&self, _: &[NativeBehavior]) -> Result<(), String> {
                Ok(())
            }
            fn inject_relative_motion(&self, _: i32, _: i32) -> Result<(), String> {
                Ok(())
            }
            fn inject_absolute_pointer(&self, _: f64, _: f64) -> Result<(), String> {
                Ok(())
            }
            fn inject_wheel(&self, _: i32, _: bool) -> Result<(), String> {
                Ok(())
            }
            fn inject_mouse_button(&self, _: MouseButton, _: bool) -> Result<(), String> {
                Ok(())
            }
            fn inject_key_edge(&self, key: &str, down: bool) -> Result<(), String> {
                self.0.lock().unwrap().push(format!("key:{key}:{down}"));
                Ok(())
            }
        }

        let audio_src = crate::windows_vmic::AudioSource::new();
        let input = Arc::new(MobileInputController::new(VoiceMock(Arc::clone(&events))));
        let coord = Arc::new(Mutex::new(MobileCoordinator::new_with_audio_source(
            "host-voice".into(),
            "TestPC".into(),
            "CA".into(),
            pairing,
            deck,
            input,
            audio_src.clone(),
        )));
        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();
        coord.lock().unwrap().set_ui_event_sender(ui_tx);

        let offer = coord
            .lock()
            .unwrap()
            .create_pairing_offer(vec!["127.0.0.1:8888".into()]);
        let (peer_id, peer_token) = match coord
            .lock()
            .unwrap()
            .handle_pair_request(&offer.pair_token, "Phone")
        {
            ServerMessage::PairResult {
                peer_id: Some(id),
                peer_token: Some(tok),
                ..
            } => (id, tok),
            _ => unreachable!(),
        };

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let t0 = Instant::now();
            let (tx, _rx) = mpsc::channel(16);
            let (sid, ready) = coord
                .lock()
                .unwrap()
                .claim_control(&peer_id, &peer_token, "Phone", tx, t0)
                .unwrap();
            let (epoch, gen, lease) = match ready {
                ServerMessage::ServerReady {
                    input_epoch,
                    input_generation,
                    lease_id,
                    ..
                } => (input_epoch, input_generation, lease_id),
                _ => unreachable!(),
            };

            // 1. Normal utterance: VoiceBegin -> AKA1 PCM -> VoiceEnd (must NOT clear or release Alt yet!)
            let out_begin = coord.lock().unwrap().handle_session_message_with_effects(
                &sid,
                ClientMessage::VoiceBegin {
                    session_id: sid.clone(),
                    input_epoch: epoch,
                    input_generation: gen,
                    seq: 1,
                    lease_id: lease,
                    request_id: "vb-1".into(),
                    stream_id: 1,
                },
                Instant::now(),
            );
            assert!(matches!(
                out_begin.reply,
                Some(ServerMessage::CommandResult { ok: true, .. })
            ));
            assert_eq!(*events.lock().unwrap(), vec!["key:Alt:true"]);
            assert_eq!(ui_rx.try_recv().unwrap(), vec!["mobile.voice".to_owned()]);
            assert!(coord.lock().unwrap().is_voice_active());

            // Push 160 samples via AKA1
            let raw_aka1 = super::super::protocol::encode_aka1_frame(gen, 1, 0, &[5000i16; 160]);
            let parsed_aka1 = super::super::protocol::parse_aka1_frame(&raw_aka1).unwrap();
            assert!(coord
                .lock()
                .unwrap()
                .handle_binary_audio(&sid, parsed_aka1, Instant::now()));
            assert_eq!(audio_src.queued_samples(), 160);

            // Send VoiceEnd: samples MUST remain queued (NOT cleared!) and Alt MUST remain held!
            let out_end = coord.lock().unwrap().handle_session_message_with_effects(
                &sid,
                ClientMessage::VoiceEnd {
                    session_id: sid.clone(),
                    input_epoch: epoch,
                    input_generation: gen,
                    seq: 2,
                    request_id: "ve-1".into(),
                    stream_id: 1,
                    final_sample_exclusive: 160,
                },
                Instant::now(),
            );
            assert_eq!(audio_src.queued_samples(), 160);
            assert_eq!(*events.lock().unwrap(), vec!["key:Alt:true"]);
            assert_eq!(out_end.voice_drain, Some((sid.clone(), 1)));

            let drain_handle = tokio::spawn(drain_voice_stream(Arc::clone(&coord), sid.clone(), 1));

            // Simulate driver consuming the queued samples 12ms later
            tokio::time::sleep(Duration::from_millis(12)).await;
            // Alt is STILL held while samples are unconsumed!
            assert_eq!(*events.lock().unwrap(), vec!["key:Alt:true"]);
            audio_src.clear(); // simulate mixer draining samples to 0

            // Wait for 5ms poll + 45ms downstream WaveRT/ASR margin
            drain_handle.await.unwrap();
            assert_eq!(
                *events.lock().unwrap(),
                vec!["key:Alt:true", "key:Alt:false"]
            );
            assert!(!coord.lock().unwrap().is_voice_active());
            assert_eq!(ui_rx.try_recv().unwrap(), Vec::<String>::new());

            // 2. Abnormal cancel: VoiceBegin(stream 2) -> AKA1 -> VoiceCancel releases Alt & clears PCM IMMEDIATELY
            coord.lock().unwrap().tick(Instant::now());
            let lease2 = 2;
            coord.lock().unwrap().handle_session_message_with_effects(
                &sid,
                ClientMessage::VoiceBegin {
                    session_id: sid.clone(),
                    input_epoch: epoch,
                    input_generation: gen,
                    seq: 3,
                    lease_id: lease2,
                    request_id: "vb-2".into(),
                    stream_id: 2,
                },
                Instant::now(),
            );
            let raw_aka2 = super::super::protocol::encode_aka1_frame(gen, 2, 0, &[7000i16; 160]);
            let parsed_aka2 = super::super::protocol::parse_aka1_frame(&raw_aka2).unwrap();
            coord
                .lock()
                .unwrap()
                .handle_binary_audio(&sid, parsed_aka2, Instant::now());
            assert_eq!(audio_src.queued_samples(), 160);

            coord.lock().unwrap().handle_session_message_with_effects(
                &sid,
                ClientMessage::VoiceCancel {
                    session_id: sid.clone(),
                    input_epoch: epoch,
                    stream_id: 2,
                    reason: "paused".into(),
                },
                Instant::now(),
            );
            // Immediately cleared & released with zero sleep!
            assert_eq!(audio_src.queued_samples(), 0);
            assert!(!coord.lock().unwrap().is_voice_active());
            assert_eq!(
                *events.lock().unwrap(),
                vec![
                    "key:Alt:true",
                    "key:Alt:false",
                    "key:Alt:true",
                    "key:Alt:false"
                ]
            );
        });

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn touchpad_gesture_dispatches_system_shortcuts_and_middle_click_under_input_gate() {
        let dir = std::env::temp_dir().join(format!("axonkey-gesture-test-{}", Uuid::new_v4()));
        let pairing = PairingStore::load(dir.join("peers.json")).unwrap();
        let deck = DeckStore::load(dir.join("mobile-deck.json")).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));

        struct GestureMock(Arc<Mutex<Vec<String>>>);
        impl MobileInputBackend for GestureMock {
            fn execute_behaviors(&self, behaviors: &[NativeBehavior]) -> Result<(), String> {
                for b in behaviors {
                    if let NativeBehavior::Shortcut { keys, .. } = b {
                        self.0
                            .lock()
                            .unwrap()
                            .push(format!("shortcut:{}", keys.join("+")));
                    } else {
                        self.0.lock().unwrap().push(format!("other:{b:?}"));
                    }
                }
                Ok(())
            }
            fn inject_relative_motion(&self, _: i32, _: i32) -> Result<(), String> {
                Ok(())
            }
            fn inject_absolute_pointer(&self, _: f64, _: f64) -> Result<(), String> {
                Ok(())
            }
            fn inject_wheel(&self, _: i32, _: bool) -> Result<(), String> {
                Ok(())
            }
            fn inject_mouse_button(&self, button: MouseButton, down: bool) -> Result<(), String> {
                self.0
                    .lock()
                    .unwrap()
                    .push(format!("btn:{button:?}:{down}"));
                Ok(())
            }
            fn inject_key_edge(&self, _: &str, _: bool) -> Result<(), String> {
                Ok(())
            }
        }

        let input = Arc::new(MobileInputController::new(GestureMock(Arc::clone(&events))));
        let mut coord = MobileCoordinator::new(
            "host-gesture".into(),
            "TestPC".into(),
            "CA".into(),
            pairing,
            deck,
            input,
        );
        let offer = coord.create_pairing_offer(vec!["127.0.0.1:9999".into()]);
        let (peer_id, peer_token) = match coord.handle_pair_request(&offer.pair_token, "Phone") {
            ServerMessage::PairResult {
                peer_id: Some(id),
                peer_token: Some(tok),
                ..
            } => (id, tok),
            _ => unreachable!(),
        };
        let t0 = Instant::now();
        let (tx, _rx) = mpsc::channel(16);
        let (sid, ready) = coord
            .claim_control(&peer_id, &peer_token, "Phone", tx, t0)
            .unwrap();
        let (epoch, lease) = match ready {
            ServerMessage::ServerReady {
                input_epoch,
                lease_id,
                ..
            } => (input_epoch, lease_id),
            _ => unreachable!(),
        };

        // Verify wire JSON parsing for `touchpad.gesture`
        let parsed_up: ClientMessage = serde_json::from_value(serde_json::json!({
            "type": "touchpad.gesture",
            "sessionId": sid,
            "inputEpoch": epoch,
            "seq": 1,
            "leaseId": lease,
            "gesture": "three_finger_up"
        }))
        .unwrap();
        assert!(coord
            .handle_session_message(&sid, parsed_up, t0 + Duration::from_millis(10))
            .is_none());

        for (seq, gesture) in [
            (2, SystemTouchpadGesture::ThreeFingerDown),
            (3, SystemTouchpadGesture::ThreeFingerLeft),
            (4, SystemTouchpadGesture::ThreeFingerRight),
            (5, SystemTouchpadGesture::ThreeFingerTap),
        ] {
            coord.handle_session_message(
                &sid,
                ClientMessage::TouchpadGesture {
                    session_id: sid.clone(),
                    input_epoch: epoch,
                    seq,
                    lease_id: lease,
                    gesture,
                },
                t0 + Duration::from_millis(20 + seq * 5),
            );
        }

        // Duplicate seq or expired lease must be silently dropped
        coord.handle_session_message(
            &sid,
            ClientMessage::TouchpadGesture {
                session_id: sid.clone(),
                input_epoch: epoch,
                seq: 5,
                lease_id: lease,
                gesture: SystemTouchpadGesture::ThreeFingerUp,
            },
            t0 + Duration::from_millis(60),
        );
        coord.handle_session_message(
            &sid,
            ClientMessage::TouchpadGesture {
                session_id: sid.clone(),
                input_epoch: epoch,
                seq: 6,
                lease_id: lease,
                gesture: SystemTouchpadGesture::ThreeFingerUp,
            },
            t0 + Duration::from_millis(900),
        );

        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "shortcut:Win+Tab",
                "shortcut:Win+D",
                "shortcut:Ctrl+Win+Right",
                "shortcut:Ctrl+Win+Left",
                "btn:Middle:true",
                "btn:Middle:false",
            ]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deck_apply_preset_from_mobile_and_desktop_emits_events_and_syncs_idempotently() {
        let dir = std::env::temp_dir().join(format!("axonkey-preset-sess-{}", Uuid::new_v4()));
        let pairing = PairingStore::load(dir.join("peers.json")).unwrap();
        let deck = DeckStore::load(dir.join("mobile-deck.json")).unwrap();
        let input = Arc::new(MobileInputController::new(MockBackend::default()));

        let mut coord = MobileCoordinator::new(
            "host-preset".into(),
            "TestPC".into(),
            "CA".into(),
            pairing,
            deck,
            input,
        );
        let (deck_tx, mut deck_rx) = mpsc::unbounded_channel();
        let (preset_tx, mut preset_rx) = mpsc::unbounded_channel();
        coord.set_deck_event_sender(deck_tx);
        coord.set_preset_event_sender(preset_tx);

        let offer = coord.create_pairing_offer(vec!["127.0.0.1:9999".into()]);
        let (peer_id, peer_token) = match coord.handle_pair_request(&offer.pair_token, "Phone") {
            ServerMessage::PairResult {
                peer_id: Some(id),
                peer_token: Some(tok),
                ..
            } => (id, tok),
            _ => unreachable!(),
        };
        let t0 = Instant::now();
        let (tx, mut rx) = mpsc::channel(16);
        let (sid, _) = coord
            .claim_control(&peer_id, &peer_token, "Phone", tx, t0)
            .unwrap();

        // 1. Mobile sends `deck.apply_preset` JSON
        let wire_msg: ClientMessage = serde_json::from_value(serde_json::json!({
            "type": "deck.apply_preset",
            "sessionId": sid,
            "requestId": "preset-req-1",
            "preset": "presentation-media",
            "voicePreset": "system-win-h"
        }))
        .unwrap();
        let reply = coord
            .handle_session_message(&sid, wire_msg, t0 + Duration::from_millis(20))
            .unwrap();
        match reply {
            ServerMessage::DeckUpdateResult {
                request_id,
                ok,
                conflict,
                deck_revision,
                deck_snapshot: Some(snap),
                error,
            } => {
                assert_eq!(request_id, "preset-req-1");
                assert!(ok);
                assert_eq!(conflict, None);
                assert_eq!(deck_revision, 2);
                assert_eq!(snap.active_page_id, "presentation-main");
                assert_eq!(snap.voice_binding_summary.as_deref(), Some("Win+H"));
                assert_eq!(error, None);
            }
            other => panic!("Expected DeckUpdateResult, got {other:?}"),
        }

        let deck_evt1 = deck_rx.try_recv().unwrap();
        assert_eq!(deck_evt1.revision, 2);
        let preset_evt1 = preset_rx.try_recv().unwrap();
        assert_eq!(preset_evt1.revision, 2);
        assert!(preset_evt1.behaviors.contains_key("ppt.next"));
        assert!(preset_evt1.behaviors.contains_key(VOICE_KEY_ID));

        // Simulate Desktop writing back `preset_evt1.behaviors` via `sync_from_managed_instance_with_gain`
        // -> MUST NOT bump revision or emit another deck-changed event (zero infinite loop!)
        coord.sync_from_managed_instance_with_gain(
            "默认配置".into(),
            0,
            &super::super::deck::dto_map_to_trigger_behaviors(&preset_evt1.behaviors),
        );
        assert_eq!(coord.deck_state().0, 2);
        assert!(deck_rx.try_recv().is_err());

        // 2. Desktop calls `apply_preset_from_desktop(BlankCanvas, None)`
        let (rev3, snap3) = coord
            .apply_preset_from_desktop(StarterPresetId::BlankCanvas, None)
            .unwrap();
        assert_eq!(rev3, 3);
        assert_eq!(snap3.active_page_id, "custom-canvas");
        assert_eq!(snap3.voice_binding_summary, None);

        let preset_evt2 = preset_rx.try_recv().unwrap();
        assert_eq!(preset_evt2.revision, 3);
        assert!(preset_evt2.bindings.is_empty());
        assert!(preset_evt2.behaviors.is_empty());
        let _ = deck_rx.try_recv().unwrap();

        // Active mobile session received DeckSnapshotPush for rev 3
        let mut saw_push_rev3 = false;
        while let Ok(m) = rx.try_recv() {
            if let ServerMessage::DeckSnapshotPush { deck_revision, .. } = m {
                if deck_revision == 3 {
                    saw_push_rev3 = true;
                }
            }
        }
        assert!(saw_push_rev3);

        // Desktop syncing back empty behaviors `{}` -> MUST also be idempotent!
        coord.sync_from_managed_instance_with_gain(
            "默认配置".into(),
            0,
            &super::super::deck::dto_map_to_trigger_behaviors(&preset_evt2.behaviors),
        );
        assert_eq!(coord.deck_state().0, 3);
        assert!(deck_rx.try_recv().is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
