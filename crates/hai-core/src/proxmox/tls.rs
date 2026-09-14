//! TLS certificate trust for Proxmox API connections.
//!
//! A default Proxmox VE install serves its API under a self-signed certificate
//! that no public CA vouches for, so ordinary certificate validation rejects
//! it. Accepting *any* certificate instead (which is what this module replaces)
//! left the API password and the returned auth ticket exposed to anyone able to
//! intercept the connection.
//!
//! Instead this module implements trust-on-first-use, the same model SSH uses:
//!
//! 1. Before any credentials are sent, [`probe`] opens a TLS connection purely
//!    to read the SHA-256 fingerprint of the certificate the server presents.
//!    The handshake is deliberately aborted during certificate verification, so
//!    not a single byte of the HTTP request is written.
//! 2. The caller shows that fingerprint to the user, who compares it against
//!    the one Proxmox itself reports (Datacenter -> Certificates in the web UI,
//!    or `pvenode cert info` on the node) and confirms.
//! 3. [`TrustStore::set`] pins the fingerprint for that server, and every later
//!    connection made through [`pinned_client`] accepts only that exact
//!    certificate.
//!
//! Because the pin identifies one specific certificate, ordinary chain and
//! hostname validation would add nothing and are intentionally not performed:
//! the user vouched for this certificate for this server, not for a name inside
//! it. For the same reason the certificate's validity period is not checked --
//! a renewed certificate has a new fingerprint, which surfaces as
//! [`CertificateStatus::Mismatch`] and sends the user back through the
//! confirmation step.
//!
//! Pins are keyed by `host:port`, so a certificate trusted for one server is
//! never accepted for another.

use crate::error::{Error, Result};
use crate::types::{ProxmoxCertificate, ProxmoxCertificateStatus};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Environment variable that overrides the trust store location.
///
/// Used by the test suite so it never reads or writes the real user store.
const TRUST_STORE_ENV: &str = "HA_INSTALLER_PROXMOX_TRUST_STORE";

/// File name of the trust store inside the application config directory.
const TRUST_STORE_FILE: &str = "proxmox-certificates.json";

/// Marker used to abort the handshake once a fingerprint has been read.
const PROBE_ABORT: &str = "certificate fingerprint probe";

/// Fingerprint reported in mock mode, where there is no server to ask.
#[cfg(feature = "mock")]
const MOCK_FINGERPRINT: &str =
    "4D:4F:43:4B:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00";

/// SHA-256 fingerprint of a DER-encoded certificate.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct CertificateFingerprint([u8; 32]);

impl CertificateFingerprint {
    /// Fingerprint the DER bytes of a certificate.
    ///
    /// This hashes the whole certificate, which is what Proxmox reports and
    /// what OpenSSL prints as `-fingerprint -sha256`.
    pub fn from_der(der: &[u8]) -> Self {
        let digest = Sha256::digest(der);
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&digest);
        Self(bytes)
    }

    /// Parse a fingerprint written as hex, with or without `:` separators.
    ///
    /// Accepts either case so a fingerprint can be pasted straight out of the
    /// Proxmox web UI or `pvenode cert info`.
    pub fn parse(text: &str) -> Result<Self> {
        let cleaned: String = text
            .chars()
            .filter(|c| !matches!(c, ':' | ' ' | '-' | '\n' | '\r' | '\t'))
            .collect();

        let decoded = hex::decode(&cleaned)
            .map_err(|_| Error::ProxmoxApi(format!("Not a valid SHA-256 fingerprint: {}", text)))?;

        if decoded.len() != 32 {
            return Err(Error::ProxmoxApi(format!(
                "A SHA-256 fingerprint is 32 bytes, got {}",
                decoded.len()
            )));
        }

        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&decoded);
        Ok(Self(bytes))
    }
}

impl std::fmt::Display for CertificateFingerprint {
    /// Formats as uppercase hex byte pairs joined by `:`, matching how Proxmox
    /// presents fingerprints so the two can be compared character by character.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, byte) in self.0.iter().enumerate() {
            if index > 0 {
                write!(f, ":")?;
            }
            write!(f, "{:02X}", byte)?;
        }
        Ok(())
    }
}

impl std::fmt::Debug for CertificateFingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CertificateFingerprint({})", self)
    }
}

/// How the certificate a server presented relates to the local pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertificateStatus {
    /// The presented certificate is the pinned one.
    Trusted,
    /// Nothing is pinned for this server yet -- this is a first connection.
    Unknown,
    /// A different certificate is pinned for this server.
    ///
    /// Either the server's certificate was legitimately replaced, or the
    /// connection is being intercepted.
    Mismatch {
        /// The fingerprint that is currently pinned.
        pinned: CertificateFingerprint,
    },
}

/// On-disk representation of the trust store.
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreContents {
    /// Format version, so the file can be migrated if the layout ever changes.
    version: u32,
    /// Pinned fingerprints keyed by `host:port`.
    servers: BTreeMap<String, String>,
}

/// Locally pinned Proxmox server certificates.
///
/// Reads and writes are done per operation rather than cached, so a pin added
/// by one part of the app is immediately visible to the rest.
#[derive(Debug, Clone)]
pub struct TrustStore {
    path: PathBuf,
}

impl TrustStore {
    /// Open the store at its default location.
    pub fn open() -> Result<Self> {
        Ok(Self {
            path: Self::default_path()?,
        })
    }

    /// Open the store backed by a specific file.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Path of the default store: `<config dir>/proxmox-certificates.json`,
    /// unless overridden by `HA_INSTALLER_PROXMOX_TRUST_STORE`.
    pub fn default_path() -> Result<PathBuf> {
        if let Some(path) = std::env::var_os(TRUST_STORE_ENV) {
            return Ok(PathBuf::from(path));
        }

        let project_dirs = directories::ProjectDirs::from("io", "home-assistant", "installer")
            .ok_or_else(|| {
                Error::InvalidConfig("Could not determine the configuration directory".to_string())
            })?;

        Ok(project_dirs.config_dir().join(TRUST_STORE_FILE))
    }

    /// The file backing this store.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// The fingerprint pinned for `server` (a `host:port` key), if any.
    pub fn get(&self, server: &str) -> Result<Option<CertificateFingerprint>> {
        match self.read()?.servers.get(server) {
            Some(pinned) => Ok(Some(CertificateFingerprint::parse(pinned)?)),
            None => Ok(None),
        }
    }

    /// Pin `fingerprint` for `server`, replacing any previous pin.
    pub fn set(&self, server: &str, fingerprint: &CertificateFingerprint) -> Result<()> {
        let mut contents = self.read()?;
        contents.version = 1;
        contents
            .servers
            .insert(server.to_string(), fingerprint.to_string());
        self.write(&contents)
    }

    /// Drop the pin for `server`. Returns whether there was one.
    pub fn remove(&self, server: &str) -> Result<bool> {
        let mut contents = self.read()?;
        if contents.servers.remove(server).is_none() {
            return Ok(false);
        }
        self.write(&contents)?;
        Ok(true)
    }

    fn read(&self) -> Result<StoreContents> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoreContents::default())
            }
            Err(e) => return Err(Error::Io(e)),
        };

        // A store we cannot read is reported rather than silently discarded:
        // starting over from empty would quietly downgrade pinned servers back
        // to "first connection".
        serde_json::from_str(&raw).map_err(|e| {
            Error::InvalidConfig(format!(
                "Could not read the trusted certificate store at {}: {}. \
                 Fix or remove the file to continue.",
                self.path.display(),
                e
            ))
        })
    }

    fn write(&self, contents: &StoreContents) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let serialized = serde_json::to_string_pretty(contents)?;
        std::fs::write(&self.path, serialized)?;

        // The pins are not secret, but they are security relevant: another
        // local user who can rewrite them can point a pin at their own
        // certificate.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
        }

        Ok(())
    }
}

/// Normalise a server URL to the `host:port` key used by the trust store.
pub fn server_key(server_url: &str) -> Result<String> {
    let url = reqwest::Url::parse(server_url)
        .map_err(|e| Error::ProxmoxApi(format!("Invalid server URL {}: {}", server_url, e)))?;

    let host = url
        .host_str()
        .ok_or_else(|| Error::ProxmoxApi(format!("Server URL {} has no host", server_url)))?;

    let port = url.port_or_known_default().ok_or_else(|| {
        Error::ProxmoxApi(format!("Could not determine a port for {}", server_url))
    })?;

    Ok(format!("{}:{}", host.to_lowercase(), port))
}

/// What a [`PinningVerifier`] should do with the certificate it is shown.
#[derive(Debug)]
enum VerifierMode {
    /// Accept the connection only if the leaf certificate has this fingerprint.
    Pin(CertificateFingerprint),
    /// Record the leaf fingerprint and abort, so nothing is ever sent.
    Probe(Arc<Mutex<Option<CertificateFingerprint>>>),
}

/// A rustls certificate verifier that trusts one specific certificate.
#[derive(Debug)]
struct PinningVerifier {
    mode: VerifierMode,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let presented = CertificateFingerprint::from_der(end_entity.as_ref());

        match &self.mode {
            VerifierMode::Pin(expected) => {
                if &presented == expected {
                    Ok(ServerCertVerified::assertion())
                } else {
                    // The fingerprints are public data, so a plain comparison
                    // leaks nothing worth protecting against timing analysis.
                    Err(rustls::Error::General(format!(
                        "Proxmox server presented certificate {} but {} is trusted",
                        presented, expected
                    )))
                }
            }
            VerifierMode::Probe(slot) => {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(presented);
                }
                // Refusing here ends the handshake before the request body or
                // any header is written, which is the whole point of the probe.
                Err(rustls::Error::General(PROBE_ABORT.to_string()))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// The crypto provider to build TLS configuration from.
///
/// Prefers a provider the host application installed process-wide, so the
/// installer follows it rather than quietly using a second implementation.
fn crypto_provider() -> Arc<CryptoProvider> {
    CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
}

/// Build an HTTP client whose TLS trust is decided by `mode`.
fn client_with_mode(mode: VerifierMode, timeout_secs: u64) -> Result<reqwest::Client> {
    let provider = crypto_provider();

    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::ProxmoxApi(format!("Could not configure TLS: {}", e)))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinningVerifier { mode, provider }))
        .with_no_client_auth();

    reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| Error::ProxmoxApi(format!("Failed to create HTTP client: {}", e)))
}

/// An HTTP client that accepts only the certificate pinned for `server_url`.
///
/// Fails if nothing is pinned yet, so no Proxmox request can go out over a
/// connection the user has not vouched for.
pub fn pinned_client(server_url: &str, timeout_secs: u64) -> Result<reqwest::Client> {
    let server = server_key(server_url)?;

    let fingerprint = TrustStore::open()?.get(&server)?.ok_or_else(|| {
        Error::ProxmoxApi(format!(
            "The certificate of {} has not been confirmed yet. \
             Check its fingerprint and trust it before connecting.",
            server
        ))
    })?;

    client_with_mode(VerifierMode::Pin(fingerprint), timeout_secs)
}

/// Read the fingerprint of the certificate `server_url` presents.
///
/// The TLS handshake is aborted as soon as the certificate has been read, so
/// this sends no credentials and no request.
pub async fn probe(server_url: &str, timeout_secs: u64) -> Result<CertificateFingerprint> {
    let slot = Arc::new(Mutex::new(None));
    let client = client_with_mode(VerifierMode::Probe(slot.clone()), timeout_secs)?;

    // Nothing of this request reaches the network: the handshake is refused
    // during certificate verification. The path is a harmless unauthenticated
    // endpoint regardless.
    let url = format!("{}/api2/json/version", server_url.trim_end_matches('/'));
    let outcome = client.get(&url).send().await;

    let seen = slot.lock().ok().and_then(|mut slot| slot.take());
    if let Some(fingerprint) = seen {
        return Ok(fingerprint);
    }

    match outcome {
        // Unreachable: the probe verifier never accepts a certificate.
        Ok(_) => Err(Error::ProxmoxApi(
            "Could not read the server's certificate".to_string(),
        )),
        Err(e) if e.is_timeout() => Err(Error::ProxmoxApi(
            "Connection timed out. Please check the server URL and network connectivity."
                .to_string(),
        )),
        Err(e) if e.is_connect() => Err(Error::ProxmoxApi(format!(
            "Failed to connect to {}. Please verify the URL is correct.",
            server_url
        ))),
        Err(e) => Err(Error::ProxmoxApi(format!(
            "Could not read the server's certificate: {}",
            e
        ))),
    }
}

/// Compare a presented fingerprint against what is pinned for `server`.
pub fn status_of(
    store: &TrustStore,
    server: &str,
    presented: &CertificateFingerprint,
) -> Result<CertificateStatus> {
    match store.get(server)? {
        None => Ok(CertificateStatus::Unknown),
        Some(pinned) if &pinned == presented => Ok(CertificateStatus::Trusted),
        Some(pinned) => Ok(CertificateStatus::Mismatch { pinned }),
    }
}

/// Fetch a server's certificate fingerprint and report how it is trusted.
///
/// This is the step that runs before any credentials are collected or sent.
pub async fn certificate_status(server_url: &str) -> Result<ProxmoxCertificate> {
    let server = server_key(server_url)?;

    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(ProxmoxCertificate {
                server,
                fingerprint: MOCK_FINGERPRINT.to_string(),
                status: ProxmoxCertificateStatus::Trusted,
                pinned_fingerprint: None,
            });
        }
    }

    let presented = probe(server_url, 30).await?;
    let status = status_of(&TrustStore::open()?, &server, &presented)?;

    Ok(ProxmoxCertificate {
        server,
        fingerprint: presented.to_string(),
        status: match &status {
            CertificateStatus::Trusted => ProxmoxCertificateStatus::Trusted,
            CertificateStatus::Unknown => ProxmoxCertificateStatus::Unknown,
            CertificateStatus::Mismatch { .. } => ProxmoxCertificateStatus::Mismatch,
        },
        pinned_fingerprint: match status {
            CertificateStatus::Mismatch { pinned } => Some(pinned.to_string()),
            _ => None,
        },
    })
}

/// Pin `fingerprint` as the certificate to accept for `server_url`.
///
/// Call this only with a fingerprint the user has confirmed. The value is
/// pinned as given and enforced on the next connection, so a fingerprint that
/// does not match the server makes that connection fail rather than fall back
/// to trusting anything.
pub fn trust_certificate(server_url: &str, fingerprint: &str) -> Result<()> {
    let server = server_key(server_url)?;
    let fingerprint = CertificateFingerprint::parse(fingerprint)?;

    // Mock runs have no real server, so nothing should reach the user's store.
    #[cfg(feature = "mock")]
    if crate::is_mock_enabled() {
        return Ok(());
    }

    TrustStore::open()?.set(&server, &fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// A fingerprint with every byte distinct, so ordering mistakes show up.
    fn sample_fingerprint() -> CertificateFingerprint {
        let mut bytes = [0u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = index as u8;
        }
        CertificateFingerprint(bytes)
    }

    fn other_fingerprint() -> CertificateFingerprint {
        CertificateFingerprint([0xAB; 32])
    }

    // CertificateFingerprint tests

    #[test]
    fn test_fingerprint_of_der_matches_sha256() {
        // Same value `openssl x509 -fingerprint -sha256` would print, i.e. the
        // digest of the DER bytes rather than of anything parsed out of them.
        let fingerprint = CertificateFingerprint::from_der(b"not really a certificate");
        let expected = hex::encode(Sha256::digest(b"not really a certificate")).to_uppercase();
        assert_eq!(fingerprint.to_string().replace(':', ""), expected);
    }

    #[test]
    fn test_fingerprint_display_is_uppercase_colon_separated() {
        let text = sample_fingerprint().to_string();
        assert!(text.starts_with("00:01:02:03:"));
        assert!(text.ends_with(":1F"));
        // 32 bytes as pairs plus 31 separators.
        assert_eq!(text.len(), 32 * 2 + 31);
    }

    #[test]
    fn test_fingerprint_parse_accepts_colon_separated() {
        let parsed = CertificateFingerprint::parse(&sample_fingerprint().to_string()).unwrap();
        assert_eq!(parsed, sample_fingerprint());
    }

    #[test]
    fn test_fingerprint_parse_accepts_bare_hex_and_mixed_case() {
        let bare = hex::encode(sample_fingerprint().0);
        assert_eq!(
            CertificateFingerprint::parse(&bare).unwrap(),
            sample_fingerprint()
        );
        assert_eq!(
            CertificateFingerprint::parse(&bare.to_uppercase()).unwrap(),
            sample_fingerprint()
        );
    }

    #[test]
    fn test_fingerprint_parse_tolerates_whitespace_and_dashes() {
        assert_eq!(
            CertificateFingerprint::parse(" AB-AB AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB\n")
                .unwrap(),
            other_fingerprint()
        );
    }

    #[test]
    fn test_fingerprint_parse_rejects_wrong_length() {
        // A SHA-1 fingerprint, which Proxmox used to show, must not be accepted
        // as if it were SHA-256.
        let sha1 = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01";
        let error = CertificateFingerprint::parse(sha1).unwrap_err();
        assert!(error.to_string().contains("32 bytes"), "{}", error);
    }

    #[test]
    fn test_fingerprint_parse_rejects_non_hex() {
        assert!(CertificateFingerprint::parse("not a fingerprint").is_err());
        assert!(CertificateFingerprint::parse("").is_err());
    }

    #[test]
    fn test_fingerprint_round_trips_through_display_and_parse() {
        let original = CertificateFingerprint::from_der(b"some certificate bytes");
        let parsed = CertificateFingerprint::parse(&original.to_string()).unwrap();
        assert_eq!(parsed, original);
    }

    // server_key() tests

    #[test]
    fn test_server_key_keeps_explicit_port() {
        assert_eq!(
            server_key("https://192.168.1.100:8006").unwrap(),
            "192.168.1.100:8006"
        );
    }

    #[test]
    fn test_server_key_fills_in_default_port() {
        assert_eq!(server_key("https://pve.local").unwrap(), "pve.local:443");
    }

    #[test]
    fn test_server_key_ignores_path_and_case() {
        assert_eq!(
            server_key("https://PVE.Local:8006/api2/json/").unwrap(),
            "pve.local:8006"
        );
    }

    #[test]
    fn test_server_key_distinguishes_ports() {
        // A certificate trusted for one port must not be reused for another.
        assert_ne!(
            server_key("https://pve.local:8006").unwrap(),
            server_key("https://pve.local:8007").unwrap()
        );
    }

    #[test]
    fn test_server_key_rejects_garbage() {
        assert!(server_key("not a url").is_err());
        assert!(server_key("").is_err());
    }

    // TrustStore tests

    #[test]
    fn test_trust_store_missing_file_has_no_pins() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("absent.json"));
        assert_eq!(store.get("pve.local:8006").unwrap(), None);
    }

    #[test]
    fn test_trust_store_round_trips_a_pin() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));

        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        assert_eq!(
            store.get("pve.local:8006").unwrap(),
            Some(sample_fingerprint())
        );
    }

    #[test]
    fn test_trust_store_creates_missing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("nested/deeper/certs.json"));

        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        assert!(store.path().exists());
    }

    #[test]
    fn test_trust_store_pins_are_per_server() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));

        store.set("a.local:8006", &sample_fingerprint()).unwrap();
        store.set("b.local:8006", &other_fingerprint()).unwrap();

        assert_eq!(
            store.get("a.local:8006").unwrap(),
            Some(sample_fingerprint())
        );
        assert_eq!(
            store.get("b.local:8006").unwrap(),
            Some(other_fingerprint())
        );
        assert_eq!(store.get("c.local:8006").unwrap(), None);
    }

    #[test]
    fn test_trust_store_replaces_an_existing_pin() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));

        store.set("pve.local:8006", &sample_fingerprint()).unwrap();
        store.set("pve.local:8006", &other_fingerprint()).unwrap();

        assert_eq!(
            store.get("pve.local:8006").unwrap(),
            Some(other_fingerprint())
        );
    }

    #[test]
    fn test_trust_store_remove_reports_whether_a_pin_existed() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));

        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        assert!(store.remove("pve.local:8006").unwrap());
        assert!(!store.remove("pve.local:8006").unwrap());
        assert_eq!(store.get("pve.local:8006").unwrap(), None);
    }

    #[test]
    fn test_trust_store_stores_fingerprints_in_readable_form() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));
        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        let raw = std::fs::read_to_string(store.path()).unwrap();

        // The file is meant to be inspectable by hand, so the fingerprint is
        // written exactly as the app displays it.
        assert!(raw.contains(&sample_fingerprint().to_string()), "{}", raw);
        assert!(raw.contains("pve.local:8006"), "{}", raw);
    }

    #[test]
    fn test_trust_store_reports_unreadable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("certs.json");
        std::fs::write(&path, "{ this is not json").unwrap();
        let store = TrustStore::at(&path);

        // Treating a damaged store as empty would silently downgrade pinned
        // servers back to "first connection", so it must be an error.
        let error = store.get("pve.local:8006").unwrap_err();
        assert!(error.to_string().contains("certs.json"), "{}", error);
    }

    #[cfg(unix)]
    #[test]
    fn test_trust_store_file_is_not_world_writable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));
        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        let mode = std::fs::metadata(store.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "unexpected mode {:o}", mode);
    }

    #[test]
    #[serial]
    fn test_default_path_honours_environment_override() {
        std::env::set_var(TRUST_STORE_ENV, "/tmp/hai-test-trust-store.json");
        let path = TrustStore::default_path().unwrap();
        std::env::remove_var(TRUST_STORE_ENV);

        assert_eq!(path, PathBuf::from("/tmp/hai-test-trust-store.json"));
    }

    #[test]
    #[serial]
    fn test_default_path_without_override_is_in_config_dir() {
        std::env::remove_var(TRUST_STORE_ENV);
        let path = TrustStore::default_path().unwrap();

        assert!(path.ends_with(TRUST_STORE_FILE), "{}", path.display());
    }

    // status_of() tests

    #[test]
    fn test_status_is_unknown_on_first_contact() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));

        assert_eq!(
            status_of(&store, "pve.local:8006", &sample_fingerprint()).unwrap(),
            CertificateStatus::Unknown
        );
    }

    #[test]
    fn test_status_is_trusted_when_fingerprint_matches() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));
        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        assert_eq!(
            status_of(&store, "pve.local:8006", &sample_fingerprint()).unwrap(),
            CertificateStatus::Trusted
        );
    }

    #[test]
    fn test_status_is_mismatch_and_reports_the_pinned_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));
        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        assert_eq!(
            status_of(&store, "pve.local:8006", &other_fingerprint()).unwrap(),
            CertificateStatus::Mismatch {
                pinned: sample_fingerprint()
            }
        );
    }

    #[test]
    fn test_status_does_not_carry_over_between_servers() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::at(dir.path().join("certs.json"));
        store.set("pve.local:8006", &sample_fingerprint()).unwrap();

        // Same certificate, different server: still a first connection.
        assert_eq!(
            status_of(&store, "other.local:8006", &sample_fingerprint()).unwrap(),
            CertificateStatus::Unknown
        );
    }

    // Verifier tests

    /// Verify `presented` against a verifier pinned to `pinned`.
    fn verify_against_pin(
        pinned: CertificateFingerprint,
        presented: &[u8],
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let verifier = PinningVerifier {
            mode: VerifierMode::Pin(pinned),
            provider: crypto_provider(),
        };

        verifier.verify_server_cert(
            &CertificateDer::from(presented.to_vec()),
            &[],
            &ServerName::try_from("pve.local").unwrap(),
            &[],
            UnixTime::now(),
        )
    }

    #[test]
    fn test_verifier_accepts_the_pinned_certificate() {
        let der = b"the certificate the user confirmed";
        let result = verify_against_pin(CertificateFingerprint::from_der(der), der);
        assert!(result.is_ok());
    }

    #[test]
    fn test_verifier_rejects_any_other_certificate() {
        // This is the interception case: a valid handshake, wrong certificate.
        let result = verify_against_pin(
            CertificateFingerprint::from_der(b"the certificate the user confirmed"),
            b"a certificate from someone in the middle",
        );

        let error = result.unwrap_err();
        assert!(
            error.to_string().contains("is trusted"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn test_verifier_rejects_a_truncated_certificate() {
        let der = b"the certificate the user confirmed";
        assert!(verify_against_pin(CertificateFingerprint::from_der(der), &der[..10]).is_err());
    }

    #[test]
    fn test_probe_verifier_records_the_fingerprint_and_refuses() {
        let slot = Arc::new(Mutex::new(None));
        let verifier = PinningVerifier {
            mode: VerifierMode::Probe(slot.clone()),
            provider: crypto_provider(),
        };
        let der = b"whatever the server presented";

        let result = verifier.verify_server_cert(
            &CertificateDer::from(der.to_vec()),
            &[],
            &ServerName::try_from("pve.local").unwrap(),
            &[],
            UnixTime::now(),
        );

        // Refusing is what keeps the request from ever being written.
        assert!(result.is_err());
        assert_eq!(
            *slot.lock().unwrap(),
            Some(CertificateFingerprint::from_der(der))
        );
    }

    #[test]
    fn test_verifier_advertises_signature_schemes() {
        // An empty list would make the handshake fail before the certificate is
        // ever seen, which would break the probe.
        let verifier = PinningVerifier {
            mode: VerifierMode::Pin(sample_fingerprint()),
            provider: crypto_provider(),
        };

        assert!(!verifier.supported_verify_schemes().is_empty());
    }

    // Client construction tests

    #[test]
    #[serial]
    fn test_pinned_client_refuses_an_untrusted_server() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(TRUST_STORE_ENV, dir.path().join("certs.json"));

        let result = pinned_client("https://pve.local:8006", 30);

        std::env::remove_var(TRUST_STORE_ENV);

        let error = result.expect_err("an unpinned server must not get a client");
        assert!(
            error.to_string().contains("has not been confirmed"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    #[serial]
    fn test_pinned_client_is_built_for_a_trusted_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("certs.json");
        TrustStore::at(&path)
            .set("pve.local:8006", &sample_fingerprint())
            .unwrap();
        std::env::set_var(TRUST_STORE_ENV, &path);

        let result = pinned_client("https://pve.local:8006", 30);

        std::env::remove_var(TRUST_STORE_ENV);
        assert!(result.is_ok());
    }

    #[test]
    #[serial]
    fn test_trust_certificate_pins_what_the_user_confirmed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("certs.json");
        std::env::set_var(TRUST_STORE_ENV, &path);

        let outcome =
            trust_certificate("https://pve.local:8006/", &sample_fingerprint().to_string());

        std::env::remove_var(TRUST_STORE_ENV);
        outcome.unwrap();

        assert_eq!(
            TrustStore::at(&path).get("pve.local:8006").unwrap(),
            Some(sample_fingerprint())
        );
    }

    #[test]
    #[serial]
    fn test_trust_certificate_rejects_a_malformed_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("certs.json");
        std::env::set_var(TRUST_STORE_ENV, &path);

        let result = trust_certificate("https://pve.local:8006", "AB:CD");

        std::env::remove_var(TRUST_STORE_ENV);

        assert!(result.is_err());
        // Nothing may be written when the fingerprint does not parse.
        assert_eq!(TrustStore::at(&path).get("pve.local:8006").unwrap(), None);
    }

    // probe() tests
    //
    // Covering a real self-signed TLS server would mean generating a
    // certificate at test time; what is checked here is the part that can go
    // wrong silently -- that a failed handshake reports an error and sends
    // nothing -- plus the verifier behaviour covered above.

    #[tokio::test]
    async fn test_probe_reports_a_server_that_is_not_speaking_tls() {
        // A plain-HTTP server reached over https://, which is what happens when
        // the user points the installer at the wrong port.
        let mut server = mockito::Server::new_async().await;
        let endpoint = server
            .mock("GET", "/api2/json/version")
            .with_status(200)
            .create_async()
            .await;

        let https_url = server.url().replace("http://", "https://");
        let error = probe(&https_url, 5)
            .await
            .expect_err("a server without TLS cannot yield a fingerprint");

        // reqwest classifies a failed handshake as a connection failure, which
        // is also the most useful thing to tell the user here.
        assert!(
            error.to_string().contains("Failed to connect"),
            "unexpected error: {}",
            error
        );
        // The probe must not have reached the application layer.
        assert!(
            !endpoint.matched_async().await,
            "the probe sent a request instead of stopping at the handshake"
        );
    }

    #[tokio::test]
    async fn test_probe_reports_an_unreachable_server() {
        // Port 1 on loopback refuses connections.
        let error = probe("https://127.0.0.1:1", 5)
            .await
            .expect_err("an unreachable server cannot yield a fingerprint");

        assert!(
            error.to_string().contains("Failed to connect"),
            "unexpected error: {}",
            error
        );
    }

    #[tokio::test]
    async fn test_probe_rejects_a_malformed_url() {
        assert!(probe("https://", 5).await.is_err());
    }

    #[test]
    #[serial]
    fn test_trust_certificate_rejects_an_invalid_url() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(TRUST_STORE_ENV, dir.path().join("certs.json"));

        let result = trust_certificate("not a url", &sample_fingerprint().to_string());

        std::env::remove_var(TRUST_STORE_ENV);
        assert!(result.is_err());
    }
}
