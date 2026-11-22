pub mod deck;
pub mod discovery;
pub mod pairing;
pub mod protocol;
pub mod session;
pub mod tls;
pub mod transport;

use crate::input_service::mobile::{
    MobileInputBackend, MobileInputController, SystemMobileBackend,
};
use deck::{DeckStore, DeckUpdateError};
use pairing::{PairedPeerSummary, PairingStore};
use protocol::{DeckLayoutPatch, DeckSnapshot, PairingOfferQr, UDP_DISCOVERY_PORT};
use serde::Serialize;
use session::{ActiveSessionInfo, MobileCoordinator};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, watch};
use tokio_rustls::TlsAcceptor;
use transport::SnapshotProvider;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileHostStatus {
    pub running: bool,
    pub host_id: String,
    pub host_name: String,
    pub port: u16,
    pub addrs: Vec<String>,
    pub paired_count: usize,
    pub active_session: Option<ActiveSessionInfo>,
    pub voice_active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingOfferResponse {
    pub offer: PairingOfferQr,
    pub qr_payload: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDeckResponse {
    pub revision: u64,
    pub snapshot: DeckSnapshot,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileDeviceInputPayload {
    pub instance_id: String,
    pub pressed: Vec<String>,
    pub values: BTreeMap<String, f64>,
}

pub type UiInputSink = Arc<dyn Fn(Vec<String>) + Send + Sync>;

pub struct MobileHostHandle<B: MobileInputBackend + 'static = SystemMobileBackend> {
    coordinator: Arc<Mutex<MobileCoordinator<B>>>,
    port: u16,
    snapshot_provider: Arc<Mutex<Option<SnapshotProvider>>>,
    ui_sink: Arc<Mutex<Option<UiInputSink>>>,
    shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    _runtime: Arc<tokio::runtime::Runtime>,
}

impl MobileHostHandle<SystemMobileBackend> {
    pub fn start(app_data_dir: PathBuf) -> Result<Self, String> {
        Self::start_with_backend_and_discovery(
            app_data_dir,
            Arc::new(MobileInputController::default()),
            0,
            Some(UDP_DISCOVERY_PORT),
        )
    }
}

impl<B: MobileInputBackend + 'static> MobileHostHandle<B> {
    pub fn start_with_backend(
        app_data_dir: PathBuf,
        input: Arc<MobileInputController<B>>,
        bind_port: u16,
    ) -> Result<Self, String> {
        // In test / custom backend invocations with bind_port == 0, avoid colliding on fixed UDP 49671
        // unless requested explicitly via start_with_backend_and_discovery.
        let udp_port = if bind_port == 0 {
            None
        } else {
            Some(UDP_DISCOVERY_PORT)
        };
        Self::start_with_backend_and_discovery(app_data_dir, input, bind_port, udp_port)
    }

    pub fn start_with_backend_and_discovery(
        app_data_dir: PathBuf,
        input: Arc<MobileInputController<B>>,
        bind_port: u16,
        udp_discovery_port: Option<u16>,
    ) -> Result<Self, String> {
        let mobile_dir = app_data_dir.join("mobile-host");
        let identity = tls::load_or_create_identity(&mobile_dir)?;
        let pairing = PairingStore::load(mobile_dir.join("peers.json"))?;
        let deck = DeckStore::load(mobile_dir.join("mobile-deck.json"))?;

        let host_id_for_udp = identity.host_id.clone();
        let host_name_for_udp = identity.host_name.clone();

        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<Vec<String>>();
        let mut coord_inner = MobileCoordinator::new(
            identity.host_id,
            identity.host_name,
            identity.ca_cert_der_b64,
            pairing,
            deck,
            input,
        );
        coord_inner.set_ui_event_sender(ui_tx);
        let coordinator = Arc::new(Mutex::new(coord_inner));

        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("axonkey-mobile-host")
                .enable_all()
                .build()
                .map_err(|e| format!("Failed to build mobile host runtime: {e}"))?,
        );

        let bind_addr = format!("0.0.0.0:{bind_port}");
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind(&bind_addr))
            .map_err(|e| format!("Failed to bind mobile host on {bind_addr}: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to inspect mobile host local_addr: {e}"))?
            .port();

        let acceptor = TlsAcceptor::from(identity.server_config);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let snapshot_provider: Arc<Mutex<Option<SnapshotProvider>>> = Arc::new(Mutex::new(None));
        let ui_sink: Arc<Mutex<Option<UiInputSink>>> = Arc::new(Mutex::new(None));

        // Spawn UI pressed-keys forwarder (`'axonkey-device-input'`)
        let ui_sink_for_task = Arc::clone(&ui_sink);
        runtime.spawn(async move {
            while let Some(pressed) = ui_rx.recv().await {
                let sink = ui_sink_for_task
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Some(cb) = sink {
                    cb(pressed);
                }
            }
        });

        // Spawn WSS server
        let coord_clone = Arc::clone(&coordinator);
        let snap_clone = Arc::clone(&snapshot_provider);
        let wss_shutdown = shutdown_rx.clone();
        runtime.spawn(async move {
            transport::run_wss_server(listener, acceptor, coord_clone, snap_clone, wss_shutdown)
                .await;
        });

        // Spawn best-effort UDP LAN auto-discovery responder on 0.0.0.0:49671
        if let Some(disc_port) = udp_discovery_port {
            let udp_addr = format!("0.0.0.0:{disc_port}");
            let udp_shutdown = shutdown_rx.clone();
            runtime.spawn(async move {
                match tokio::net::UdpSocket::bind(&udp_addr).await {
                    Ok(sock) => {
                        log::info!(
                            target: "axonkey::mobile",
                            "Axonkey Mobile UDP discovery responder listening on {udp_addr}"
                        );
                        discovery::run_udp_discovery_responder(
                            sock,
                            host_id_for_udp,
                            host_name_for_udp,
                            port,
                            udp_shutdown,
                        )
                        .await;
                    }
                    Err(err) => {
                        log::warn!(
                            target: "axonkey::mobile",
                            "Best-effort UDP discovery bind on {udp_addr} skipped: {err}"
                        );
                    }
                }
            });
        }

        log::info!(target: "axonkey::mobile", "Axonkey Mobile WSS host listening on port {port}");

        Ok(Self {
            coordinator,
            port,
            snapshot_provider,
            ui_sink,
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
            _runtime: runtime,
        })
    }

    /// Connects the live Tauri `AppHandle` so:
    /// 1. Mobile button/tile/voice presses emit `'axonkey-device-input'` `{ instanceId, pressed, values: {} }`
    ///    for all enabled `axonkeyMobile` instances (flashing green in the PC SVG!), and
    /// 2. Foreground app automatic profile switching (`effective_profile_id` changes) is polled on
    ///    `run_wss_server`'s 250ms tick.
    pub fn attach_app_handle(&self, app: tauri::AppHandle) {
        let app_for_snap = app.clone();
        self.set_snapshot_provider(Arc::new(move || {
            app_for_snap
                .try_state::<crate::DeviceManager>()
                .map(|m| m.snapshot())
        }));

        let app_for_emit = app;
        self.set_ui_input_sink(Arc::new(move |pressed: Vec<String>| {
            let Some(manager) = app_for_emit.try_state::<crate::DeviceManager>() else {
                return;
            };
            let snapshot = manager.snapshot();
            for instance in snapshot
                .store
                .instances
                .iter()
                .filter(|i| i.kind == "axonkeyMobile" && i.enabled)
            {
                let _ = app_for_emit.emit(
                    "axonkey-device-input",
                    MobileDeviceInputPayload {
                        instance_id: instance.id.clone(),
                        pressed: pressed.clone(),
                        values: BTreeMap::new(),
                    },
                );
            }
        }));
    }

    pub fn set_snapshot_provider(&self, provider: SnapshotProvider) {
        *self
            .snapshot_provider
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(provider);
    }

    pub fn set_ui_input_sink(&self, sink: UiInputSink) {
        *self.ui_sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn lan_addrs(&self) -> Vec<String> {
        discovery::compute_announce_addrs(self.port)
    }

    pub fn status(&self) -> MobileHostStatus {
        let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
        MobileHostStatus {
            running: true,
            host_id: guard.host_id().to_owned(),
            host_name: guard.host_name().to_owned(),
            port: self.port,
            addrs: self.lan_addrs(),
            paired_count: guard.paired_count(),
            active_session: guard.active_session_info(),
            voice_active: guard.is_voice_active(),
        }
    }

    pub fn set_audio_gain_db(&self, gain_db: i16) {
        self.coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_audio_gain_db(gain_db);
    }

    pub fn audio_status_and_level(
        &self,
    ) -> (
        crate::audio_service::AudioServiceStatus,
        crate::audio_service::AudioLevel,
    ) {
        let (has_active, voice_active, received_data, level) = {
            let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            (
                guard.active_session_info().is_some(),
                guard.is_voice_active(),
                guard.has_received_audio(),
                guard.audio_level(),
            )
        };
        #[cfg(target_os = "windows")]
        let (driver_installed, output_ready, error) = {
            let snap = crate::windows_vmic::snapshot();
            let ready = snap.installed && !snap.microphone_driver_abnormal;
            (snap.installed, ready, snap.error)
        };
        #[cfg(not(target_os = "windows"))]
        let (driver_installed, output_ready, error) = (false, false, None);

        let status = crate::audio_service::AudioServiceStatus {
            driver_installed,
            state: if voice_active {
                "running".into()
            } else if has_active {
                "ready".into()
            } else {
                "idle".into()
            },
            bluetooth_connected: has_active,
            forwarding: voice_active,
            received_data: voice_active || received_data,
            output_ready,
            event_version: 0,
            error,
        };
        (status, level)
    }

    /// Enriches `DeviceSnapshot.runtime` for `axonkeyMobile` instances with real WSS & voice status:
    /// - `state`: `"exclusive"` when `active_session.is_some()`, `"disconnected"` when `paired_count > 0`,
    ///   `"unbound"` when `paired_count == 0` (or `"paused"` when `!instance.enabled`).
    /// - `recording`: `voice_active` when `instance.enabled && active_session.is_some()`.
    pub fn enrich_device_snapshot(&self, snapshot: &mut crate::input_service::managed::Snapshot) {
        let (has_active, paired_count, voice_active) = {
            let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            (
                guard.active_session_info().is_some(),
                guard.paired_count(),
                guard.is_voice_active(),
            )
        };
        for instance in &snapshot.store.instances {
            if instance.kind != "axonkeyMobile" {
                continue;
            }
            let runtime = snapshot.runtime.entry(instance.id.clone()).or_default();
            if !instance.enabled {
                runtime.state = "paused".into();
                runtime.recording = false;
                runtime.error = None;
                continue;
            }
            runtime.state = if has_active {
                "exclusive"
            } else if paired_count > 0 {
                "disconnected"
            } else {
                "unbound"
            }
            .into();
            runtime.recording = has_active && voice_active;
            runtime.error = None;
        }
    }

    pub fn start_pairing(&self) -> Result<MobilePairingOfferResponse, String> {
        let addrs = self.lan_addrs();
        let offer = self
            .coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .create_pairing_offer(addrs);
        let qr_payload = serde_json::to_string(&offer)
            .map_err(|e| format!("Failed to encode pairing QR payload: {e}"))?;
        Ok(MobilePairingOfferResponse { offer, qr_payload })
    }

    pub fn list_peers(&self) -> Vec<PairedPeerSummary> {
        self.coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .list_peers()
    }

    pub fn revoke_peer(&self, peer_id: &str) -> Result<bool, String> {
        self.coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revoke_peer(peer_id)
    }

    pub fn get_deck(&self) -> MobileDeckResponse {
        let (revision, snapshot) = self
            .coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .deck_state();
        MobileDeckResponse { revision, snapshot }
    }

    pub fn get_bindings(&self) -> std::collections::HashMap<String, deck::TileActionBindings> {
        self.coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .bindings()
    }

    pub fn set_tile_binding(
        &self,
        tile_id: String,
        binding: deck::TileActionBindings,
    ) -> Result<MobileDeckResponse, String> {
        let (revision, snapshot) = self
            .coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_tile_binding_from_desktop(tile_id, binding)?;
        Ok(MobileDeckResponse { revision, snapshot })
    }

    /// Syncs mappings, audio gain, & active profile name from the first-class `axonkeyMobile` managed device.
    pub fn sync_from_device_snapshot(&self, snapshot: &crate::input_service::managed::Snapshot) {
        let Some(instance) = snapshot
            .store
            .instances
            .iter()
            .find(|i| i.kind == "axonkeyMobile" && i.enabled)
        else {
            return;
        };
        let active_id = snapshot
            .runtime
            .get(&instance.id)
            .and_then(|r| r.effective_profile_id.as_deref())
            .unwrap_or(&instance.active_profile_id);
        let Some(profile) = instance
            .profiles
            .iter()
            .find(|p| p.id == active_id)
            .or_else(|| instance.profiles.first())
        else {
            return;
        };
        let raw_map: std::collections::HashMap<String, serde_json::Value> = profile
            .behaviors
            .as_object()
            .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let behaviors = crate::input_service::parse_tolerant_behavior_map(&raw_map);
        self.coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sync_from_managed_instance_with_gain(
                profile.name.clone(),
                instance.audio_gain_db,
                &behaviors,
            );
    }

    pub fn update_deck(
        &self,
        base_revision: u64,
        patch: DeckLayoutPatch,
    ) -> Result<MobileDeckResponse, String> {
        let result = self
            .coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .update_deck_from_desktop(base_revision, patch);
        match result {
            Ok((revision, snapshot)) => Ok(MobileDeckResponse { revision, snapshot }),
            Err(DeckUpdateError::Conflict(c)) => Err(format!(
                "Deck 版本冲突（当前版本 {}），请刷新后重试",
                c.revision
            )),
            Err(DeckUpdateError::Invalid(e) | DeckUpdateError::Io(e)) => Err(e),
        }
    }

    pub fn shutdown(&self) {
        if let Some(tx) = self
            .shutdown_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = tx.send(true);
        }
        self.coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revoke_active_session("host_shutdown");
    }
}

impl<B: MobileInputBackend + 'static> Drop for MobileHostHandle<B> {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn mobile_host_status(
    host: tauri::State<'_, MobileHostHandle>,
) -> Result<MobileHostStatus, String> {
    Ok(host.status())
}

#[tauri::command]
pub fn mobile_host_start_pairing(
    host: tauri::State<'_, MobileHostHandle>,
) -> Result<MobilePairingOfferResponse, String> {
    host.start_pairing()
}

#[tauri::command]
pub fn mobile_host_list_peers(
    host: tauri::State<'_, MobileHostHandle>,
) -> Result<Vec<PairedPeerSummary>, String> {
    Ok(host.list_peers())
}

#[tauri::command]
pub fn mobile_host_revoke_peer(
    host: tauri::State<'_, MobileHostHandle>,
    peer_id: String,
) -> Result<bool, String> {
    host.revoke_peer(&peer_id)
}

#[tauri::command]
pub fn mobile_host_get_deck(
    host: tauri::State<'_, MobileHostHandle>,
) -> Result<MobileDeckResponse, String> {
    Ok(host.get_deck())
}

#[tauri::command]
pub fn mobile_host_update_deck(
    host: tauri::State<'_, MobileHostHandle>,
    base_revision: u64,
    patch: DeckLayoutPatch,
) -> Result<MobileDeckResponse, String> {
    host.update_deck(base_revision, patch)
}

#[tauri::command]
pub fn mobile_host_get_bindings(
    host: tauri::State<'_, MobileHostHandle>,
) -> Result<std::collections::HashMap<String, deck::TileActionBindings>, String> {
    Ok(host.get_bindings())
}

#[tauri::command]
pub fn mobile_host_set_tile_binding(
    host: tauri::State<'_, MobileHostHandle>,
    tile_id: String,
    binding: deck::TileActionBindings,
) -> Result<MobileDeckResponse, String> {
    host.set_tile_binding(tile_id, binding)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input_service::{MouseButton, NativeBehavior};
    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use protocol::{
        encode_aka1_frame, encode_akp1_frame, Akp1PointerKind, ClientMessage, ServerMessage,
        TileGestureKind, MOBILE_SUBPROTOCOL,
    };
    use rustls::pki_types::{CertificateDer, ServerName};
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;
    use tokio::net::TcpStream;
    use tokio_rustls::TlsConnector;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    use tokio_tungstenite::tungstenite::Message;
    use uuid::Uuid;

    #[derive(Default)]
    struct RecordingBackend {
        log: Arc<StdMutex<Vec<String>>>,
    }

    impl MobileInputBackend for RecordingBackend {
        fn execute_behaviors(&self, behaviors: &[NativeBehavior]) -> Result<(), String> {
            self.log
                .lock()
                .unwrap()
                .push(format!("behaviors:{}", behaviors.len()));
            Ok(())
        }
        fn inject_relative_motion(&self, dx: i32, dy: i32) -> Result<(), String> {
            self.log.lock().unwrap().push(format!("move:{dx},{dy}"));
            Ok(())
        }
        fn inject_absolute_pointer(&self, u: f64, v: f64) -> Result<(), String> {
            self.log.lock().unwrap().push(format!("abs:{u:.2},{v:.2}"));
            Ok(())
        }
        fn inject_wheel(&self, delta: i32, horizontal: bool) -> Result<(), String> {
            self.log
                .lock()
                .unwrap()
                .push(format!("wheel:{delta}:{horizontal}"));
            Ok(())
        }
        fn inject_mouse_button(&self, button: MouseButton, down: bool) -> Result<(), String> {
            self.log
                .lock()
                .unwrap()
                .push(format!("btn:{button:?}:{down}"));
            Ok(())
        }
        fn inject_key_edge(&self, key: &str, down: bool) -> Result<(), String> {
            self.log.lock().unwrap().push(format!("key:{key}:{down}"));
            Ok(())
        }
    }

    #[test]
    fn end_to_end_wss_v2_akp1_aka1_voice_flash_snapshot_enrichment_and_auto_profile_switch() {
        let dir = std::env::temp_dir().join(format!("axonkey-e2e-{}", Uuid::new_v4()));
        let backend = RecordingBackend::default();
        let backend_log = Arc::clone(&backend.log);
        let input = Arc::new(MobileInputController::new(backend));
        let host = MobileHostHandle::start_with_backend(dir.clone(), Arc::clone(&input), 0)
            .expect("start mobile host");

        // Capture UI pressed-key emissions (`'axonkey-device-input'`)
        let ui_events: Arc<StdMutex<Vec<Vec<String>>>> = Arc::new(StdMutex::new(Vec::new()));
        let ui_events_sink = Arc::clone(&ui_events);
        host.set_ui_input_sink(Arc::new(move |pressed| {
            ui_events_sink.lock().unwrap().push(pressed);
        }));

        // Verify unbound snapshot state before pairing
        let make_mobile_snapshot =
            |rev: u64, effective_profile: &str| -> crate::input_service::managed::Snapshot {
                let inst: crate::input_service::managed::Instance =
                    serde_json::from_value(serde_json::json!({
                        "id": "mob-inst-1",
                        "kind": "axonkeyMobile",
                        "name": "Axonkey Mobile",
                        "binding": null,
                        "audioGainDb": 3,
                        "enabled": true,
                        "activeProfileId": "default",
                        "profiles": [
                            {
                                "id": "default",
                                "name": "默认配置",
                                "behaviors": {}
                            },
                            {
                                "id": "cursor-prof",
                                "name": "Cursor 编程",
                                "behaviors": {
                                    "mobile.voice": {
                                        "click": [{ "type": "shortcut", "keys": ["Win", "H"] }],
                                        "doubleClick": [],
                                        "longPress": []
                                    }
                                }
                            }
                        ]
                    }))
                    .unwrap();
                let mut runtime = BTreeMap::new();
                runtime.insert(
                    "mob-inst-1".into(),
                    crate::input_service::managed::RuntimeStatus {
                        effective_profile_id: Some(effective_profile.into()),
                        ..Default::default()
                    },
                );
                crate::input_service::managed::Snapshot {
                    store: crate::input_service::managed::Store {
                        version: 1,
                        revision: rev,
                        instances: vec![inst],
                    },
                    discovered: vec![],
                    runtime,
                    error: None,
                    scan_error: None,
                    scanning: false,
                }
            };

        let mut snap0 = make_mobile_snapshot(1, "default");
        host.enrich_device_snapshot(&mut snap0);
        assert_eq!(snap0.runtime["mob-inst-1"].state, "unbound");
        assert!(!snap0.runtime["mob-inst-1"].recording);

        let shared_snap = Arc::new(StdMutex::new(make_mobile_snapshot(1, "default")));
        let shared_snap_provider = Arc::clone(&shared_snap);
        host.set_snapshot_provider(Arc::new(move || {
            Some(shared_snap_provider.lock().unwrap().clone())
        }));

        let offer_resp = host.start_pairing().expect("start pairing");
        let port = host.port();

        let ca_der = base64::engine::general_purpose::STANDARD
            .decode(&offer_resp.offer.ca_cert_der_b64)
            .expect("decode CA");
        let mut root_store = rustls::RootCertStore::empty();
        root_store
            .add(CertificateDer::from(ca_der))
            .expect("add private CA to app trust store");
        let client_cfg = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        let connector = TlsConnector::from(Arc::new(client_cfg));

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let server_name =
                ServerName::try_from(format!("{}.axonkey.local", offer_resp.offer.host_id))
                    .unwrap();
            let tls = connector.connect(server_name, tcp).await.unwrap();

            let mut req = format!("wss://127.0.0.1:{port}/ws")
                .into_client_request()
                .unwrap();
            req.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_static(MOBILE_SUBPROTOCOL),
            );
            let (mut ws, _resp) = tokio_tungstenite::client_async(req, tls).await.unwrap();

            // 1. Pair using one-time token from QR
            let pair_msg = serde_json::to_string(&ClientMessage::PairRequest {
                pair_token: offer_resp.offer.pair_token.clone(),
                device_name: "Test Phone".into(),
            })
            .unwrap();
            ws.send(Message::Text(pair_msg.into())).await.unwrap();
            let pair_reply: ServerMessage = match ws.next().await.unwrap().unwrap() {
                Message::Text(t) => serde_json::from_str(&t).unwrap(),
                other => panic!("Unexpected frame: {other:?}"),
            };
            let (peer_id, peer_token) = match pair_reply {
                ServerMessage::PairResult {
                    ok: true,
                    peer_id: Some(id),
                    peer_token: Some(tok),
                    ..
                } => (id, tok),
                other => panic!("Pair failed: {other:?}"),
            };

            // Paired but before ClientAuth -> state must be "disconnected"
            let mut snap_paired = make_mobile_snapshot(1, "default");
            host.enrich_device_snapshot(&mut snap_paired);
            assert_eq!(snap_paired.runtime["mob-inst-1"].state, "disconnected");

            // 2. Authenticate and receive server.ready with v2 capabilities & inputGeneration
            let auth_msg = serde_json::to_string(&ClientMessage::ClientAuth {
                peer_id,
                peer_token,
                device_name: "Test Phone".into(),
            })
            .unwrap();
            ws.send(Message::Text(auth_msg.into())).await.unwrap();
            let ready: ServerMessage = match ws.next().await.unwrap().unwrap() {
                Message::Text(t) => serde_json::from_str(&t).unwrap(),
                other => panic!("Unexpected frame: {other:?}"),
            };
            let (session_id, input_epoch, input_gen, lease_id, deck_rev) = match ready {
                ServerMessage::ServerReady {
                    session_id,
                    input_epoch,
                    input_generation,
                    lease_id,
                    deck_revision,
                    capabilities,
                    deck_snapshot,
                    ..
                } => {
                    assert!(capabilities.binary_pointer_v1);
                    assert_eq!(capabilities.udp_discovery_port, UDP_DISCOVERY_PORT);
                    assert_eq!(deck_snapshot.voice_binding_summary.as_deref(), Some("Alt"));
                    assert!(input_generation >= 1);
                    (
                        session_id,
                        input_epoch,
                        input_generation,
                        lease_id,
                        deck_revision,
                    )
                }
                other => panic!("Expected server.ready, got {other:?}"),
            };

            // Active WSS session -> state must be "exclusive"
            let mut snap_active = make_mobile_snapshot(1, "default");
            host.enrich_device_snapshot(&mut snap_active);
            assert_eq!(snap_active.runtime["mob-inst-1"].state, "exclusive");

            // 3. Activate tile -> verify 120ms SVG flash press + delayed release!
            let tap = serde_json::to_string(&ClientMessage::TileActivate {
                session_id: session_id.clone(),
                input_epoch,
                seq: 1,
                lease_id,
                request_id: "req-1".into(),
                tile_id: "remote.ok".into(),
                gesture: TileGestureKind::Tap,
            })
            .unwrap();
            ws.send(Message::Text(tap.into())).await.unwrap();

            let mut got_cmd_ok = false;
            for _ in 0..4 {
                if let Some(Ok(Message::Text(t))) = ws.next().await {
                    let msg: ServerMessage = serde_json::from_str(&t).unwrap();
                    if matches!(msg, ServerMessage::CommandResult { ref request_id, ok: true, .. } if request_id == "req-1")
                    {
                        got_cmd_ok = true;
                        break;
                    }
                }
            }
            assert!(got_cmd_ok);
            tokio::time::sleep(Duration::from_millis(160)).await;
            {
                let flashes = ui_events.lock().unwrap();
                assert!(flashes.iter().any(|p| p == &vec!["remote.ok".to_owned()]));
                assert_eq!(flashes.last().unwrap(), &Vec::<String>::new());
            }

            // 4. Send binary AKP1 frames (kind=1 trackpad relative & kind=3 gyro absolute)
            let akp1_rel = encode_akp1_frame(
                Akp1PointerKind::TrackpadRelative,
                input_gen,
                2,
                10_000,
                10.0,
                0.0,
            );
            ws.send(Message::Binary(akp1_rel.to_vec().into()))
                .await
                .unwrap();
            let akp1_abs = encode_akp1_frame(
                Akp1PointerKind::GyroAbsolute,
                input_gen,
                3,
                20_000,
                0.5,
                0.25,
            );
            ws.send(Message::Binary(akp1_abs.to_vec().into()))
                .await
                .unwrap();

            // 5. VoiceBegin -> AKA1 -> VoiceEnd
            let v_begin = serde_json::to_string(&ClientMessage::VoiceBegin {
                session_id: session_id.clone(),
                input_epoch,
                input_generation: input_gen,
                seq: 4,
                lease_id,
                request_id: "vb-e2e".into(),
                stream_id: 1,
            })
            .unwrap();
            ws.send(Message::Text(v_begin.into())).await.unwrap();
            let aka1 = encode_aka1_frame(input_gen, 1, 0, &[2000i16; 160]);
            ws.send(Message::Binary(aka1.into())).await.unwrap();
            let v_end = serde_json::to_string(&ClientMessage::VoiceEnd {
                session_id: session_id.clone(),
                input_epoch,
                input_generation: input_gen,
                seq: 5,
                request_id: "ve-e2e".into(),
                stream_id: 1,
                final_sample_exclusive: 160,
            })
            .unwrap();
            ws.send(Message::Text(v_end.into())).await.unwrap();

            // Wait for drain (up to 200ms cap since no hardware driver capture is open in test)
            tokio::time::sleep(Duration::from_millis(240)).await;
            {
                let log = backend_log.lock().unwrap();
                assert!(log.contains(&"move:14,0".to_owned()));
                assert!(log.contains(&"abs:0.50,0.25".to_owned()));
                assert!(log.contains(&"key:Alt:true".to_owned()));
                assert!(log.contains(&"key:Alt:false".to_owned()));
            }

            // 6. Optimistic-lock deck update
            let update = serde_json::to_string(&ClientMessage::DeckUpdate {
                session_id: session_id.clone(),
                request_id: "deck-1".into(),
                base_revision: deck_rev,
                layout_patch: DeckLayoutPatch {
                    trackpad_split: Some(0.45),
                    ..Default::default()
                },
            })
            .unwrap();
            ws.send(Message::Text(update.into())).await.unwrap();
            let mut got_deck_ok = false;
            for _ in 0..6 {
                if let Some(Ok(Message::Text(t))) = ws.next().await {
                    let msg: ServerMessage = serde_json::from_str(&t).unwrap();
                    if matches!(msg, ServerMessage::DeckUpdateResult { ref request_id, ok: true, .. } if request_id == "deck-1")
                    {
                        got_deck_ok = true;
                        break;
                    }
                }
            }
            assert!(got_deck_ok);

            // 7. Foreground automatic profile switch (`effective_profile_id` -> `"cursor-prof"`)
            //    must trigger sync on `run_wss_server`'s 250ms tick and push Win+H voice summary!
            *shared_snap.lock().unwrap() = make_mobile_snapshot(1, "cursor-prof");
            let mut saw_profile_push = false;
            for _ in 0..8 {
                if let Ok(Some(Ok(Message::Text(t)))) =
                    tokio::time::timeout(Duration::from_millis(400), ws.next()).await
                {
                    let msg: ServerMessage = serde_json::from_str(&t).unwrap();
                    if let ServerMessage::DeckSnapshotPush {
                        deck_snapshot,
                        input_generation: next_gen,
                        ..
                    } = msg
                    {
                        if deck_snapshot.voice_binding_summary.as_deref() == Some("Win+H") {
                            assert!(next_gen > input_gen);
                            saw_profile_push = true;
                            break;
                        }
                    }
                }
            }
            assert!(saw_profile_push);

            let _ = ws.close(None).await;
        });

        host.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
