pub mod deck;
pub mod pairing;
pub mod protocol;
pub mod session;
pub mod tls;
pub mod transport;

use crate::input_service::mobile::{MobileInputBackend, MobileInputController, SystemMobileBackend};
use deck::{DeckStore, DeckUpdateError};
use pairing::{PairedPeerSummary, PairingStore};
use protocol::{DeckLayoutPatch, DeckSnapshot, PairingOfferQr};
use serde::Serialize;
use session::{ActiveSessionInfo, MobileCoordinator};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tokio_rustls::TlsAcceptor;

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

pub struct MobileHostHandle<B: MobileInputBackend + 'static = SystemMobileBackend> {
    coordinator: Arc<Mutex<MobileCoordinator<B>>>,
    port: u16,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    _runtime: Arc<tokio::runtime::Runtime>,
}

impl MobileHostHandle<SystemMobileBackend> {
    pub fn start(app_data_dir: PathBuf) -> Result<Self, String> {
        Self::start_with_backend(app_data_dir, Arc::new(MobileInputController::default()), 0)
    }
}

impl<B: MobileInputBackend + 'static> MobileHostHandle<B> {
    pub fn start_with_backend(
        app_data_dir: PathBuf,
        input: Arc<MobileInputController<B>>,
        bind_port: u16,
    ) -> Result<Self, String> {
        let mobile_dir = app_data_dir.join("mobile-host");
        let identity = tls::load_or_create_identity(&mobile_dir)?;
        let pairing = PairingStore::load(mobile_dir.join("peers.json"))?;
        let deck = DeckStore::load(mobile_dir.join("mobile-deck.json"))?;

        let coordinator = Arc::new(Mutex::new(MobileCoordinator::new(
            identity.host_id,
            identity.host_name,
            identity.ca_cert_der_b64,
            pairing,
            deck,
            input,
        )));

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
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let coord_clone = Arc::clone(&coordinator);
        runtime.spawn(async move {
            transport::run_wss_server(listener, acceptor, coord_clone, shutdown_rx).await;
        });

        log::info!(target: "axonkey::mobile", "Axonkey Mobile WSS host listening on port {port}");

        Ok(Self {
            coordinator,
            port,
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
            _runtime: runtime,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn lan_addrs(&self) -> Vec<String> {
        let mut addrs: Vec<String> = tls::discover_lan_ipv4s()
            .into_iter()
            .map(|ip| format!("{ip}:{}", self.port))
            .collect();
        if addrs.is_empty() {
            addrs.push(format!("127.0.0.1:{}", self.port));
        }
        addrs
    }

    pub fn status(&self) -> MobileHostStatus {
        let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
        MobileHostStatus {
            running: true,
            host_id: guard.host_id().to_owned(),
            host_name: guard.host_name().to_owned(),
            port: self.port,
            addrs: self.lan_addrs(),
            paired_count: guard.list_peers().len(),
            active_session: guard.active_session_info(),
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

    /// Syncs mappings & active profile name from the first-class `axonkeyMobile` managed device.
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
            .sync_from_managed_instance(profile.name.clone(), &behaviors);
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
        if let Some(tx) = self.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(());
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
    use protocol::{ClientMessage, ServerMessage, TileGestureKind, MOBILE_SUBPROTOCOL};
    use rustls::pki_types::{CertificateDer, ServerName};
    use std::sync::Mutex as StdMutex;
    use tokio::net::TcpStream;
    use tokio_rustls::TlsConnector;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    use tokio_tungstenite::tungstenite::Message;
    use uuid::Uuid;

    #[derive(Default)]
    struct RecordingBackend {
        log: StdMutex<Vec<String>>,
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
    fn end_to_end_wss_private_ca_pair_auth_input_and_deck_sync() {
        let dir = std::env::temp_dir().join(format!("axonkey-e2e-{}", Uuid::new_v4()));
        let backend = RecordingBackend::default();
        let input = Arc::new(MobileInputController::new(backend));
        let host = MobileHostHandle::start_with_backend(dir.clone(), Arc::clone(&input), 0)
            .expect("start mobile host");
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

            // 2. Authenticate and receive server.ready
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
            let (session_id, input_epoch, lease_id, deck_rev) = match ready {
                ServerMessage::ServerReady {
                    session_id,
                    input_epoch,
                    lease_id,
                    deck_revision,
                    ..
                } => (session_id, input_epoch, lease_id, deck_revision),
                other => panic!("Expected server.ready, got {other:?}"),
            };

            // 3. Activate tile + send relative motion
            let tap = serde_json::to_string(&ClientMessage::TileActivate {
                session_id: session_id.clone(),
                input_epoch,
                seq: 1,
                lease_id,
                request_id: "req-1".into(),
                tile_id: "tile.enter".into(),
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

            // 4. Optimistic-lock deck update
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
            for _ in 0..4 {
                if let Some(Ok(Message::Text(t))) = ws.next().await {
                    let msg: ServerMessage = serde_json::from_str(&t).unwrap();
                    if matches!(msg, ServerMessage::DeckUpdateResult { ref request_id, ok: true, deck_revision: 2, .. } if request_id == "deck-1")
                    {
                        got_deck_ok = true;
                        break;
                    }
                }
            }
            assert!(got_deck_ok);

            let _ = ws.close(None).await;
        });

        host.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
