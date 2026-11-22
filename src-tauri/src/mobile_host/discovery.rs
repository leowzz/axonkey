use super::tls;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use tokio::net::UdpSocket;
use tokio::sync::watch;

const MAX_DISCOVERY_PACKET_BYTES: usize = 2048;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverRequest {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(default)]
    v: Option<u32>,
    #[serde(default)]
    host_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnounceResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub v: u32,
    pub host_id: String,
    pub host_name: String,
    pub port: u16,
    pub addrs: Vec<String>,
}

pub fn compute_announce_addrs(wss_port: u16) -> Vec<String> {
    let mut addrs: Vec<String> = tls::discover_lan_ipv4s()
        .into_iter()
        .map(|ip| format!("{ip}:{wss_port}"))
        .collect();
    if addrs.is_empty() {
        addrs.push(format!("127.0.0.1:{wss_port}"));
    }
    addrs
}

pub fn build_announce_reply(
    raw_request: &[u8],
    host_id: &str,
    host_name: &str,
    wss_port: u16,
    addrs: Vec<String>,
) -> Option<Vec<u8>> {
    if raw_request.is_empty() || raw_request.len() > MAX_DISCOVERY_PACKET_BYTES {
        return None;
    }
    let req: DiscoverRequest = serde_json::from_slice(raw_request).ok()?;
    if req.msg_type != "axonkey.discover" {
        return None;
    }
    if req.v.is_some_and(|v| v == 0 || v > 2) {
        return None;
    }
    if let Some(target_id) = req.host_id.as_deref().map(str::trim) {
        if !target_id.is_empty() && target_id != host_id {
            return None;
        }
    }
    let reply = AnnounceResponse {
        msg_type: "axonkey.announce".into(),
        v: 1,
        host_id: host_id.to_owned(),
        host_name: host_name.to_owned(),
        port: wss_port,
        addrs,
    };
    serde_json::to_vec(&reply).ok()
}

pub async fn run_udp_discovery_responder(
    socket: UdpSocket,
    host_id: String,
    host_name: String,
    wss_port: u16,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut buf = [0u8; MAX_DISCOVERY_PACKET_BYTES];
    loop {
        if *shutdown_rx.borrow() {
            break;
        }
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
            }
            recv_res = socket.recv_from(&mut buf) => {
                let Ok((len, peer)): Result<(usize, SocketAddr), _> = recv_res else {
                    continue;
                };
                let addrs = compute_announce_addrs(wss_port);
                if let Some(payload) = build_announce_reply(&buf[..len], &host_id, &host_name, wss_port, addrs) {
                    let _ = socket.send_to(&payload, peer).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn udp_discovery_replies_to_broadcast_and_matching_host_id_only() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let server_sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let server_addr = server_sock.local_addr().unwrap();
            let (shutdown_tx, shutdown_rx) = watch::channel(false);

            let task = tokio::spawn(run_udp_discovery_responder(
                server_sock,
                "host-abc-123".into(),
                "StudioPC".into(),
                54321,
                shutdown_rx,
            ));

            let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();

            // 1. Non-matching hostId must be ignored
            client
                .send_to(
                    br#"{"type":"axonkey.discover","v":1,"hostId":"other-host"}"#,
                    server_addr,
                )
                .await
                .unwrap();

            // 2. Wildcard null hostId must receive axonkey.announce
            client
                .send_to(
                    br#"{"type":"axonkey.discover","v":1,"hostId":null}"#,
                    server_addr,
                )
                .await
                .unwrap();

            let mut recv_buf = [0u8; 2048];
            let (n, _) =
                tokio::time::timeout(Duration::from_secs(2), client.recv_from(&mut recv_buf))
                    .await
                    .expect("UDP announce timeout")
                    .unwrap();
            let announce: AnnounceResponse = serde_json::from_slice(&recv_buf[..n]).unwrap();
            assert_eq!(announce.msg_type, "axonkey.announce");
            assert_eq!(announce.v, 1);
            assert_eq!(announce.host_id, "host-abc-123");
            assert_eq!(announce.host_name, "StudioPC");
            assert_eq!(announce.port, 54321);
            assert!(!announce.addrs.is_empty());
            assert!(announce.addrs.iter().all(|a| a.ends_with(":54321")));

            // 3. Matching hostId also succeeds
            client
                .send_to(
                    br#"{"type":"axonkey.discover","v":1,"hostId":"host-abc-123"}"#,
                    server_addr,
                )
                .await
                .unwrap();
            let (n2, _) =
                tokio::time::timeout(Duration::from_secs(2), client.recv_from(&mut recv_buf))
                    .await
                    .unwrap()
                    .unwrap();
            let announce2: AnnounceResponse = serde_json::from_slice(&recv_buf[..n2]).unwrap();
            assert_eq!(announce2.host_id, "host-abc-123");

            let _ = shutdown_tx.send(true);
            let _ = task.await;
        });
    }
}
