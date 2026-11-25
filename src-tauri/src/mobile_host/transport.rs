use super::protocol::{
    parse_aka1_frame, parse_akp1_frame, ClientMessage, ClientVersionHandshake, ServerMessage,
    AKA1_MAGIC, AKP1_MAGIC, DEFAULT_IDLE_DISCONNECT_MS, DEFAULT_TICK_INTERVAL_MS,
    MAX_WS_FRAME_BYTES, MOBILE_SUBPROTOCOL,
};
use super::session::{drain_voice_stream, MobileCoordinator};
use crate::input_service::mobile::MobileInputBackend;
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

pub type SnapshotProvider =
    Arc<dyn Fn() -> Option<crate::input_service::managed::Snapshot> + Send + Sync>;

pub async fn run_wss_server<B: MobileInputBackend + 'static>(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    coordinator: Arc<Mutex<MobileCoordinator<B>>>,
    snapshot_provider: Arc<Mutex<Option<SnapshotProvider>>>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut tick_interval = tokio::time::interval(Duration::from_millis(DEFAULT_TICK_INTERVAL_MS));
    let mut last_fg_gen: u64 = 0;
    let mut last_synced_sig: Option<(String, u64, String, i16)> = None;

    loop {
        if *shutdown_rx.borrow() {
            if let Ok(mut guard) = coordinator.lock() {
                guard.revoke_active_session("host_shutdown");
            }
            break;
        }
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    if let Ok(mut guard) = coordinator.lock() {
                        guard.revoke_active_session("host_shutdown");
                    }
                    break;
                }
            }
            _ = tick_interval.tick() => {
                let fg = crate::foreground::foreground_applications();
                let provider = snapshot_provider
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                let maybe_dev_snapshot = provider.and_then(|f| f());

                let mut parsed_sync = None;
                if let Some(ref snap) = maybe_dev_snapshot {
                    if let Some(instance) = snap
                        .store
                        .instances
                        .iter()
                        .find(|i| i.kind == "axonkeyMobile" && i.enabled)
                    {
                        let active_id = snap
                            .runtime
                            .get(&instance.id)
                            .and_then(|r| r.effective_profile_id.as_deref())
                            .unwrap_or(&instance.active_profile_id)
                            .to_owned();
                        let sig = (
                            instance.id.clone(),
                            snap.store.revision,
                            active_id.clone(),
                            instance.audio_gain_db,
                        );
                        if last_synced_sig.as_ref() != Some(&sig) {
                            if let Some(profile) = instance
                                .profiles
                                .iter()
                                .find(|p| p.id == active_id)
                                .or_else(|| instance.profiles.first())
                            {
                                let raw_map: std::collections::HashMap<String, serde_json::Value> =
                                    profile
                                        .behaviors
                                        .as_object()
                                        .map(|obj| {
                                            obj.iter()
                                                .map(|(k, v)| (k.clone(), v.clone()))
                                                .collect()
                                        })
                                        .unwrap_or_default();
                                let behaviors =
                                    crate::input_service::parse_tolerant_behavior_map(&raw_map);
                                parsed_sync = Some((
                                    profile.name.clone(),
                                    instance.audio_gain_db,
                                    behaviors,
                                ));
                                last_synced_sig = Some(sig);
                            }
                        }
                    } else {
                        last_synced_sig = None;
                    }
                }

                if let Ok(mut guard) = coordinator.lock() {
                    if fg.generation != last_fg_gen {
                        last_fg_gen = fg.generation;
                        let (app_id, app_name) = match fg.current {
                            Some(app) => (Some(app.id), Some(app.name)),
                            None => (None, None),
                        };
                        guard.update_foreground_context(app_id, app_name);
                    }
                    if let Some((profile_name, gain_db, behaviors)) = parsed_sync {
                        guard.sync_from_managed_instance_with_gain(
                            profile_name,
                            gain_db,
                            &behaviors,
                        );
                    }
                    guard.tick(Instant::now());
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer_addr)) => {
                        let acceptor = acceptor.clone();
                        let coord = Arc::clone(&coordinator);
                        tokio::spawn(async move {
                            handle_connection(stream, peer_addr, acceptor, coord).await;
                        });
                    }
                    Err(err) => {
                        log::warn!(target: "axonkey::mobile", "Mobile WSS accept error: {err}");
                    }
                }
            }
        }
    }
}

async fn handle_connection<B: MobileInputBackend + 'static>(
    stream: TcpStream,
    peer_addr: SocketAddr,
    acceptor: TlsAcceptor,
    coordinator: Arc<Mutex<MobileCoordinator<B>>>,
) {
    let _ = stream.set_nodelay(true);
    let tls_stream = match acceptor.accept(stream).await {
        Ok(s) => s,
        Err(err) => {
            log::debug!(target: "axonkey::mobile", "TLS handshake failed from {peer_addr}: {err}");
            return;
        }
    };

    let mut ws_config = WebSocketConfig::default();
    ws_config.max_message_size = Some(MAX_WS_FRAME_BYTES);
    ws_config.max_frame_size = Some(MAX_WS_FRAME_BYTES);

    let ws_stream = match tokio_tungstenite::accept_hdr_async_with_config(
        tls_stream,
        |req: &Request, mut resp: Response| {
            let offered = req
                .headers()
                .get("Sec-WebSocket-Protocol")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let matches = offered
                .split(',')
                .any(|p| p.trim().eq_ignore_ascii_case(MOBILE_SUBPROTOCOL));
            if matches {
                resp.headers_mut().insert(
                    "Sec-WebSocket-Protocol",
                    HeaderValue::from_static(MOBILE_SUBPROTOCOL),
                );
            }
            Ok(resp)
        },
        Some(ws_config),
    )
    .await
    {
        Ok(ws) => ws,
        Err(err) => {
            log::debug!(target: "axonkey::mobile", "WS upgrade failed from {peer_addr}: {err}");
            return;
        }
    };

    let (mut sink, mut source) = ws_stream.split();
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(64);

    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            let Ok(text) = serde_json::to_string(&msg) else {
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let mut authenticated_session: Option<String> = None;
    let idle_limit = Duration::from_millis(DEFAULT_IDLE_DISCONNECT_MS);

    loop {
        let next_frame = tokio::time::timeout(idle_limit, source.next()).await;
        let frame = match next_frame {
            Ok(Some(Ok(msg))) => msg,
            Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
        };

        let text = match frame {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Binary(bin) => {
                let Some(sid) = authenticated_session.as_deref() else {
                    continue;
                };
                let now = Instant::now();
                if bin.starts_with(AKP1_MAGIC) {
                    if let Some(ptr) = parse_akp1_frame(&bin) {
                        coordinator
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .handle_binary_pointer(sid, ptr, now);
                    }
                } else if bin.starts_with(AKA1_MAGIC) {
                    if let Some(audio) = parse_aka1_frame(&bin) {
                        coordinator
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .handle_binary_audio(sid, audio, now);
                    }
                } else {
                    coordinator
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .handle_legacy_binary_pcm(sid, &bin, now);
                }
                continue;
            }
            _ => continue,
        };

        let parsed: ClientMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(err) => {
                let _ = out_tx.try_send(ServerMessage::Error {
                    code: "invalid_message".into(),
                    message: format!("消息格式无效: {err}"),
                    version_notice: None,
                });
                continue;
            }
        };

        let now = Instant::now();
        match &authenticated_session {
            None => match parsed {
                ClientMessage::PairRequest {
                    pair_token,
                    device_name,
                    client_version,
                    protocol_api,
                    min_required_host_api,
                    min_recommended_host_version,
                } => {
                    let hs = ClientVersionHandshake {
                        client_version,
                        protocol_api,
                        min_required_host_api,
                        min_recommended_host_version,
                    };
                    let reply = coordinator
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .handle_pair_request_with_handshake(&pair_token, &device_name, &hs);
                    let _ = out_tx.send(reply).await;
                }
                ClientMessage::ClientAuth {
                    peer_id,
                    peer_token,
                    device_name,
                    client_version,
                    protocol_api,
                    min_required_host_api,
                    min_recommended_host_version,
                } => {
                    let hs = ClientVersionHandshake {
                        client_version,
                        protocol_api,
                        min_required_host_api,
                        min_recommended_host_version,
                    };
                    let result = coordinator
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .claim_control_with_handshake(
                            &peer_id,
                            &peer_token,
                            &device_name,
                            &hs,
                            out_tx.clone(),
                            now,
                        );
                    match result {
                        Ok((sid, ready)) => {
                            authenticated_session = Some(sid);
                            let _ = out_tx.send(ready).await;
                        }
                        Err(err_msg) => {
                            let _ = out_tx.send(err_msg).await;
                            break;
                        }
                    }
                }
                _ => {
                    let _ = out_tx
                        .send(ServerMessage::Error {
                            code: "unauthenticated".into(),
                            message: "请先完成配对或设备鉴权".into(),
                            version_notice: None,
                        })
                        .await;
                    break;
                }
            },
            Some(sid) => {
                let outcome = coordinator
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .handle_session_message_with_effects(sid, parsed, now);

                if let Some((drain_sid, stream_id)) = outcome.voice_drain {
                    tokio::spawn(drain_voice_stream(
                        Arc::clone(&coordinator),
                        drain_sid,
                        stream_id,
                    ));
                }
                if let Some((flash_token, delay_ms)) = outcome.ui_flash_release {
                    let coord_flash = Arc::clone(&coordinator);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        coord_flash
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .finish_ui_flash(&flash_token);
                    });
                }
                if let Some(msg) = outcome.reply {
                    if out_tx.send(msg).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    if let Some(sid) = authenticated_session {
        coordinator
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .disconnect_session(&sid, "transport_closed");
    }
    drop(out_tx);
    let _ = writer.await;
}
