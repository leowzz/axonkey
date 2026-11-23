use super::protocol::PairingOfferQr;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const DEFAULT_OFFER_TTL_SECS: u64 = 120;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPeerRecord {
    pub peer_id: String,
    pub device_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    pub token_sha256: String,
    pub paired_at_ms: u64,
    pub last_seen_ms: u64,
}

impl PairedPeerRecord {
    pub fn effective_name(&self) -> &str {
        self.remark
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.device_name)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPeerSummary {
    pub peer_id: String,
    /// Effective display name (`remark` if set on PC, otherwise phone-reported `hardware_name`).
    pub device_name: String,
    pub hardware_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    pub paired_at_ms: u64,
    pub last_seen_ms: u64,
}

impl From<&PairedPeerRecord> for PairedPeerSummary {
    fn from(r: &PairedPeerRecord) -> Self {
        Self {
            peer_id: r.peer_id.clone(),
            device_name: r.effective_name().to_owned(),
            hardware_name: r.device_name.clone(),
            remark: r.remark.clone(),
            paired_at_ms: r.paired_at_ms,
            last_seen_ms: r.last_seen_ms,
        }
    }
}

struct ActiveOffer {
    token_sha256: String,
    expires_at: Instant,
}

pub struct PairingStore {
    path: PathBuf,
    peers: Vec<PairedPeerRecord>,
    active_offer: Option<ActiveOffer>,
}

impl PairingStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let peers = if path.exists() {
            let bytes =
                fs::read(&path).map_err(|e| format!("Failed to read mobile peers store: {e}"))?;
            serde_json::from_slice::<Vec<PairedPeerRecord>>(&bytes)
                .map_err(|e| format!("Corrupt mobile peers store: {e}"))?
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            peers,
            active_offer: None,
        })
    }

    pub fn create_offer(
        &mut self,
        host_id: &str,
        host_name: &str,
        addrs: Vec<String>,
        ca_cert_der_b64: &str,
    ) -> PairingOfferQr {
        let token = random_hex_256();
        let expires_at = Instant::now() + Duration::from_secs(DEFAULT_OFFER_TTL_SECS);
        let expires_at_ms = now_unix_ms() + DEFAULT_OFFER_TTL_SECS * 1000;
        self.active_offer = Some(ActiveOffer {
            token_sha256: sha256_hex(&token),
            expires_at,
        });
        PairingOfferQr {
            v: 1,
            host_id: host_id.to_owned(),
            host_name: host_name.to_owned(),
            addrs,
            ca_cert_der_b64: ca_cert_der_b64.to_owned(),
            pair_token: token,
            expires_at_ms,
        }
    }

    /// Atomically consumes the active one-time pairing token and issues long-term peer credentials.
    pub fn consume_offer(
        &mut self,
        pair_token: &str,
        device_name: &str,
    ) -> Result<(String, String), String> {
        let offer = self
            .active_offer
            .take()
            .ok_or_else(|| "当前没有有效的配对请求".to_owned())?;
        if Instant::now() > offer.expires_at {
            return Err("配对二维码已过期，请在桌面端重新生成".to_owned());
        }
        let provided_hash = sha256_hex(pair_token.trim());
        if !constant_time_eq(provided_hash.as_bytes(), offer.token_sha256.as_bytes()) {
            // Restore offer? No — single-shot consumption prevents online brute-force.
            return Err("配对凭据无效，请重新扫码".to_owned());
        }

        let peer_id = Uuid::new_v4().to_string();
        let peer_token = random_hex_256();
        let now = now_unix_ms();
        let clean_name = sanitize_device_name(device_name);

        self.peers.push(PairedPeerRecord {
            peer_id: peer_id.clone(),
            device_name: clean_name,
            remark: None,
            token_sha256: sha256_hex(&peer_token),
            paired_at_ms: now,
            last_seen_ms: now,
        });
        self.save()?;
        Ok((peer_id, peer_token))
    }

    pub fn authenticate(
        &mut self,
        peer_id: &str,
        peer_token: &str,
        device_name: &str,
    ) -> Result<PairedPeerSummary, String> {
        let candidate_hash = sha256_hex(peer_token);
        let Some(record) = self.peers.iter_mut().find(|p| p.peer_id == peer_id) else {
            return Err("未知设备，请重新配对".to_owned());
        };
        if !constant_time_eq(candidate_hash.as_bytes(), record.token_sha256.as_bytes()) {
            return Err("设备凭据校验失败".to_owned());
        }
        record.last_seen_ms = now_unix_ms();
        let clean_name = sanitize_device_name(device_name);
        if !clean_name.is_empty() {
            record.device_name = clean_name;
        }
        let summary = PairedPeerSummary::from(&*record);
        let _ = self.save();
        Ok(summary)
    }

    pub fn update_reported_name(
        &mut self,
        peer_id: &str,
        device_name: &str,
    ) -> Option<PairedPeerSummary> {
        let record = self.peers.iter_mut().find(|p| p.peer_id == peer_id)?;
        let clean_name = sanitize_device_name(device_name);
        let changed = !clean_name.is_empty() && record.device_name != clean_name;
        if changed {
            record.device_name = clean_name;
        }
        let summary = PairedPeerSummary::from(&*record);
        if changed {
            let _ = self.save();
        }
        Some(summary)
    }

    pub fn set_peer_remark(
        &mut self,
        peer_id: &str,
        remark: Option<String>,
    ) -> Result<PairedPeerSummary, String> {
        let Some(record) = self.peers.iter_mut().find(|p| p.peer_id == peer_id) else {
            return Err("未找到已配对设备".to_owned());
        };
        record.remark = remark
            .map(|r| r.trim().chars().take(48).collect::<String>())
            .filter(|r| !r.is_empty());
        let summary = PairedPeerSummary::from(&*record);
        self.save()?;
        Ok(summary)
    }

    pub fn list(&self) -> Vec<PairedPeerSummary> {
        self.peers.iter().map(PairedPeerSummary::from).collect()
    }

    pub fn revoke(&mut self, peer_id: &str) -> Result<bool, String> {
        let before = self.peers.len();
        self.peers.retain(|p| p.peer_id != peer_id);
        let removed = self.peers.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create peers parent dir: {e}"))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let data = serde_json::to_vec_pretty(&self.peers)
            .map_err(|e| format!("Failed to serialize peers: {e}"))?;
        fs::write(&tmp, data).map_err(|e| format!("Failed to write peers tmp: {e}"))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("Failed to commit peers file: {e}"))?;
        Ok(())
    }
}

fn random_hex_256() -> String {
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn sanitize_device_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "Axonkey Mobile".to_owned()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_offer_is_single_use_and_peer_revocation_works() {
        let dir = std::env::temp_dir().join(format!("axonkey-pair-test-{}", Uuid::new_v4()));
        let path = dir.join("peers.json");
        let mut store = PairingStore::load(path.clone()).unwrap();

        let offer = store.create_offer("host-1", "PC", vec!["127.0.0.1:9000".into()], "CA");
        let (peer_id, peer_token) = store.consume_offer(&offer.pair_token, "Pixel 9").unwrap();

        // Second consume of the same token must fail.
        assert!(store.consume_offer(&offer.pair_token, "Replay").is_err());

        // Auth succeeds with issued credentials and persists to disk.
        let reloaded = PairingStore::load(path).unwrap();
        assert_eq!(reloaded.list().len(), 1);
        assert!(store.authenticate(&peer_id, &peer_token, "Pixel 9").is_ok());
        assert!(store
            .authenticate(&peer_id, "wrong-token", "Pixel 9")
            .is_err());

        // PC remark overrides display name across subsequent reconnects until cleared.
        let renamed = store
            .set_peer_remark(&peer_id, Some("书房遥控手机".into()))
            .unwrap();
        assert_eq!(renamed.device_name, "书房遥控手机");
        assert_eq!(renamed.hardware_name, "Pixel 9");
        let authed = store
            .authenticate(&peer_id, &peer_token, "Pixel 9 Pro")
            .unwrap();
        assert_eq!(authed.device_name, "书房遥控手机");
        assert_eq!(authed.hardware_name, "Pixel 9 Pro");

        let cleared = store.set_peer_remark(&peer_id, Some("   ".into())).unwrap();
        assert_eq!(cleared.device_name, "Pixel 9 Pro");
        assert!(cleared.remark.is_none());

        // Revoke removes peer and blocks subsequent auth.
        assert!(store.revoke(&peer_id).unwrap());
        assert!(store
            .authenticate(&peer_id, &peer_token, "Pixel 9")
            .is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
