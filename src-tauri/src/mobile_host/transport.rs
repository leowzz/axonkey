use super::protocol::{
    ClientMessage, ServerMessage, DEFAULT_IDLE_DISCONNECT_MS, DEFAULT_TICK_INTERVAL_MS,
    MAX_WS_FRAME_BYTES, MOBILE_SUBPROTOCOL,
};
use super::session::MobileCoordinator;
use crate::input_service::mobile::MobileInputBackend;
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

pub async fn run_wss_server<B: MobileInputBackend + 'static>(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    coordinator: Arc<Mutex<MobileCoordinator<B>>>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let mut tick_interval = tokio::time::interval(Duration::from_millis(DEFAULT_TICK_INTERVAL_MS));
    let mut last_fg_gen: u64 = 0;

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                if let Ok(mut guard) = coordinator.lock() {
                    guard.revoke_active_session("host_shutdown");
                }
                break;
            }
            _ = tick_interval.tick() => {
                let fg = crate::foreground::foreground_applications();
                if let Ok(mut guard) = coordinator.lock() {
                    if fg.generation != last_fg_gen {
                        last_fg_gen = fg.generation;
                        let (app_id, app_name) = match fg.current {
                            Some(app) => (Some(app.id), Some(app.name)),
                            None => (None, None),
                        };
                        guard.update_foreground_context(app_id, app_name);
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
    #[cfg(windows)]
    let mut audio_source: Option<crate::windows_vmic::AudioSource> = None;
    #[cfg(windows)]
    let mut audio_active = false;

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
                #[cfg(windows)]
                if authenticated_session.is_some()
                    && audio_active
                    && !bin.is_empty()
                    && bin.len() <= 2560
                    && bin.len() % 2 == 0
                {
                    if let Some(src) = &audio_source {
                        let samples: Vec<i16> = bin
                            .chunks_exact(2)
                            .map(|c| i16::from_le_bytes([c[0], c[1]]))
                            .collect();
                        src.push_pcm(&samples);
                    }
                }
                #[cfg(not(windows))]
                let _ = bin;
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
                } => {
                    let reply = coordinator
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .handle_pair_request(&pair_token, &device_name);
                    let _ = out_tx.send(reply).await;
                }
                ClientMessage::ClientAuth {
                    peer_id,
                    peer_token,
                    device_name,
                } => {
                    let result = coordinator
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .claim_control(&peer_id, &peer_token, &device_name, out_tx.clone(), now);
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
                        })
                        .await;
                    break;
                }
            },
            Some(sid) => match parsed {
                ClientMessage::AudioStart {
                    session_id,
                    sample_rate,
                    channels,
                } if session_id == *sid && sample_rate == 16_000 && channels == 1 => {
                    #[cfg(windows)]
                    {
                        if audio_source.is_none() {
                            audio_source = Some(crate::windows_vmic::source());
                        }
                        if let Some(src) = &audio_source {
                            src.clear();
                        }
                        audio_active = true;
                        log::info!(target: "axonkey::mobile", "Mobile voice stream started (16kHz mono PCM -> Quarbor Virtual Microphone)");
                    }
                }
                ClientMessage::AudioStop { session_id } if session_id == *sid => {
                    #[cfg(windows)]
                    {
                        audio_active = false;
                        if let Some(src) = &audio_source {
                            src.clear();
                        }
                        log::info!(target: "axonkey::mobile", "Mobile voice stream stopped");
                    }
                }
                other => {
                    #[cfg(windows)]
                    if matches!(other, ClientMessage::InputCancel { .. }) {
                        audio_active = false;
                        if let Some(src) = &audio_source {
                            src.clear();
                        }
                    }
                    let reply = coordinator
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .handle_session_message(sid, other, now);
                    if let Some(msg) = reply {
                        if out_tx.send(msg).await.is_err() {
                            break;
                        }
                    }
                }
            },
        }
    }

    #[cfg(windows)]
    if let Some(src) = &audio_source {
        src.clear();
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
