use base64::Engine;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

pub struct HostTlsIdentity {
    pub host_id: String,
    pub host_name: String,
    #[cfg(test)]
    pub ca_cert_der: Vec<u8>,
    pub ca_cert_der_b64: String,
    pub server_config: Arc<rustls::ServerConfig>,
}

fn ensure_rustls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn is_clash_or_benchmark_ip(ip: Ipv4Addr) -> bool {
    // 198.18.0.0/15 is used by Clash / Mihomo / Sing-box TUN virtual adapters.
    let [a, b, _, _] = ip.octets();
    a == 198 && (b == 18 || b == 19)
}

fn is_cgnat_vpn_ip(ip: Ipv4Addr) -> bool {
    // 100.64.0.0/10 (Tailscale / CGNAT)
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

fn is_virtual_interface_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "vethernet",
        "wsl",
        "hyper-v",
        "vmware",
        "vmnet",
        "virtualbox",
        "vbox",
        "docker",
        "meta",
        "clash",
        "mihomo",
        "sing-box",
        "utun",
        "loopback",
    ]
    .iter()
    .any(|kw| lower.contains(kw))
}

fn interface_priority(name: &str, ip: Ipv4Addr) -> Option<u8> {
    if ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_link_local()
        || ip.is_multicast()
        || is_clash_or_benchmark_ip(ip)
    {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if is_virtual_interface_name(name) {
        return None;
    }
    // Prefer physical Wi-Fi / Ethernet RFC1918 LAN interfaces first.
    if ip.is_private() {
        if lower.contains("wi-fi")
            || lower.contains("wlan")
            || lower.contains("ethernet")
            || lower.contains("以太网")
            || lower.starts_with("en")
        {
            return Some(0);
        }
        return Some(1);
    }
    // Tailscale / overlay VPN as secondary reachable address.
    if is_cgnat_vpn_ip(ip) {
        return Some(2);
    }
    Some(3)
}

pub fn discover_lan_ipv4s() -> Vec<Ipv4Addr> {
    let mut ranked: Vec<(u8, Ipv4Addr)> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let IpAddr::V4(v4) = iface.ip() {
                if let Some(prio) = interface_priority(&iface.name, v4) {
                    if !ranked.iter().any(|(_, existing)| *existing == v4) {
                        ranked.push((prio, v4));
                    }
                }
            }
        }
    }
    ranked.sort_by_key(|(prio, _)| *prio);
    ranked.into_iter().map(|(_, ip)| ip).collect()
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
        let id = Uuid::new_v4().to_string();
        fs::write(&host_id_path, &id).map_err(|e| format!("Failed to write host-id: {e}"))?;
        id
    };

    let (ca_key, ca_cert) = if ca_key_path.exists() && ca_cert_path.exists() {
        let key_pem =
            fs::read_to_string(&ca_key_path).map_err(|e| format!("Failed to read CA key: {e}"))?;
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

    Ok(HostTlsIdentity {
        host_id,
        host_name: host_display_name(),
        #[cfg(test)]
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
