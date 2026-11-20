use base64::Engine;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::fs;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

pub struct HostTlsIdentity {
    pub host_id: String,
    pub host_name: String,
    pub ca_cert_der: Vec<u8>,
    pub ca_cert_der_b64: String,
    pub server_config: Arc<rustls::ServerConfig>,
}

fn ensure_rustls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn discover_lan_ipv4s() -> Vec<Ipv4Addr> {
    let mut ips = Vec::new();
    // Best-effort primary outbound LAN IP via non-connecting UDP socket.
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                if let IpAddr::V4(v4) = addr.ip() {
                    if !v4.is_loopback() && !v4.is_unspecified() {
                        ips.push(v4);
                    }
                }
            }
        }
    }
    ips
}

pub fn host_display_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Axonkey Desktop".to_owned())
}

pub fn load_or_create_identity(dir: &Path) -> Result<HostTlsIdentity, String> {
    ensure_rustls_provider();
    fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create mobile host identity dir: {e}"))?;

    let host_id_path = dir.join("host-id.txt");
    let ca_key_path = dir.join("ca-key.pem");
    let ca_cert_path = dir.join("ca-cert.der");

    let host_id = if host_id_path.exists() {
        fs::read_to_string(&host_id_path)
            .map_err(|e| format!("Failed to read host-id: {e}"))?
            .trim()
            .to_owned()
    } else {
        let id = UdpOrUuid::new_v4();
        fs::write(&host_id_path, &id).map_err(|e| format!("Failed to write host-id: {e}"))?;
        id
    };

    let (ca_key, ca_cert) = if ca_key_path.exists() && ca_cert_path.exists() {
        let key_pem = fs::read_to_string(&ca_key_path)
            .map_err(|e| format!("Failed to read CA key: {e}"))?;
        let key_pair =
            KeyPair::from_pem(&key_pem).map_err(|e| format!("Invalid persisted CA key: {e}"))?;
        let params = build_ca_params(&host_id)?;
        let ca_cert = params
            .self_signed(&key_pair)
            .map_err(|e| format!("CA reconstruction failed: {e}"))?;
        (key_pair, ca_cert)
    } else {
        let key_pair = KeyPair::generate().map_err(|e| format!("CA keygen failed: {e}"))?;
        let params = build_ca_params(&host_id)?;
        let ca_cert = params
            .self_signed(&key_pair)
            .map_err(|e| format!("CA self-sign failed: {e}"))?;
        let cert_der = ca_cert.der().to_vec();
        fs::write(&ca_key_path, key_pair.serialize_pem())
            .map_err(|e| format!("Failed to persist CA key: {e}"))?;
        fs::write(&ca_cert_path, &cert_der)
            .map_err(|e| format!("Failed to persist CA cert: {e}"))?;
        (key_pair, ca_cert)
    };
    let ca_cert_der_actual = ca_cert.der().to_vec();

    // Sign leaf cert for `<host_id>.axonkey.local`, `localhost`, `127.0.0.1`, and LAN IPv4s.
    let leaf_key = KeyPair::generate().map_err(|e| format!("Leaf keygen failed: {e}"))?;
    let mut leaf_params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("{host_id}.axonkey.local"));
    leaf_params.distinguished_name = dn;
    leaf_params.is_ca = IsCa::NoCa;
    leaf_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];

    let mut sans = vec![
        SanType::DnsName(
            format!("{host_id}.axonkey.local")
                .try_into()
                .map_err(|e| format!("Invalid host SAN: {e}"))?,
        ),
        SanType::DnsName(
            "localhost"
                .to_owned()
                .try_into()
                .map_err(|e| format!("Invalid localhost SAN: {e}"))?,
        ),
        SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)),
    ];
    for ip in discover_lan_ipv4s() {
        sans.push(SanType::IpAddress(IpAddr::V4(ip)));
    }
    leaf_params.subject_alt_names = sans;

    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .map_err(|e| format!("Leaf cert signing failed: {e}"))?;

    let cert_chain = vec![
        CertificateDer::from(leaf_cert.der().to_vec()),
        CertificateDer::from(ca_cert.der().to_vec()),
    ];
    let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));

    let mut server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, key_der)
        .map_err(|e| format!("rustls ServerConfig failed: {e}"))?;
    // Disable TLS 0-RTT early data so control frames cannot be replayed.
    server_config.max_early_data_size = 0;

    let ca_b64 = base64::engine::general_purpose::STANDARD.encode(ca_cert.der().as_ref());
    let _ = ca_cert_der_actual;

    Ok(HostTlsIdentity {
        host_id,
        host_name: host_display_name(),
        ca_cert_der: ca_cert.der().to_vec(),
        ca_cert_der_b64: ca_b64,
        server_config: Arc::new(server_config),
    })
}

fn build_ca_params(host_id: &str) -> Result<CertificateParams, String> {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("Axonkey Mobile CA ({host_id})"));
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    Ok(params)
}

struct UdpOrUuid;
impl UdpOrUuid {
    fn new_v4() -> String {
        Uuid::new_v4().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_and_persists_install_scoped_ca_identity() {
        let dir = std::env::temp_dir().join(format!("axonkey-tls-test-{}", Uuid::new_v4()));
        let first = load_or_create_identity(&dir).expect("create identity");
        let second = load_or_create_identity(&dir).expect("reload identity");
        assert_eq!(first.host_id, second.host_id);
        assert!(!first.ca_cert_der.is_empty());
        assert!(!first.ca_cert_der_b64.is_empty());
        assert_eq!(first.server_config.max_early_data_size, 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
