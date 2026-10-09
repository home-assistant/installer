//! Normal TLS validation, or a session-only pin on a certificate the user trusted.

use crate::error::{Error, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

const CERTIFICATE_CHANGED: &str =
    "Proxmox certificate changed. Reconnect and verify its fingerprint.";

pub(super) fn certificate_error(error: &reqwest::Error) -> Option<Error> {
    let mut source: &(dyn std::error::Error + 'static) = error;
    loop {
        let tls = source.downcast_ref::<rustls::Error>();
        if matches!(tls, Some(rustls::Error::General(message)) if message == CERTIFICATE_CHANGED) {
            return Some(Error::ProxmoxCertificateChanged);
        }
        // io::Error::source skips its wrapped error, so inspect it explicitly.
        source = if let Some(inner) = source
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
        {
            inner
        } else {
            source.source()?
        };
    }
}

/// Only bare HTTPS origins are accepted, including normalized scheme casing.
pub fn server_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| Error::ProxmoxActionRequired("Enter a valid HTTPS server URL".into()))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::ProxmoxActionRequired(
            "Use an HTTPS server URL without credentials, a path, query, or fragment".into(),
        ));
    }
    Ok(url)
}

fn fingerprint(cert: &CertificateDer<'_>) -> String {
    Sha256::digest(cert.as_ref())
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

fn client_builder(timeout: u64) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        // A TLS proxy would present its own certificate to the same verifier.
        // Probe and authenticate directly so approval always identifies Proxmox.
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(timeout))
}

fn config(verifier: Arc<dyn ServerCertVerifier>) -> rustls::ClientConfig {
    rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("default TLS protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
}

/// Build the client for a login/session. An absent pin uses normal platform trust.
pub(super) fn client(url: &str, pin: Option<&str>, timeout: u64) -> Result<reqwest::Client> {
    // Existing HTTP API fixtures are restricted to loopback in unit-test builds.
    #[cfg(test)]
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1") {
            return reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(timeout))
                .build()
                .map_err(|e| Error::ProxmoxApi(e.to_string()));
        }
    }
    let url = server_url(url)?;
    let mut builder = client_builder(timeout);
    if let Some(pin) = pin {
        let bytes = hex::decode(pin.replace(':', ""))
            .map_err(|_| Error::ProxmoxApi("Invalid SHA-256 certificate fingerprint".into()))?;
        let pin: [u8; 32] = bytes.try_into().map_err(|_| {
            Error::ProxmoxApi("Invalid SHA-256 certificate fingerprint length".into())
        })?;
        let host = url
            .host_str()
            .expect("validated host")
            .trim_matches(['[', ']']);
        let verifier = PinnedVerifier {
            pin,
            server_name: ServerName::try_from(host.to_owned())
                .map_err(|_| Error::ProxmoxApi("Invalid server hostname".into()))?,
        };
        let mut tls = config(Arc::new(verifier));
        // Resumed handshakes omit the current certificate and would bypass the pin.
        tls.resumption = rustls::client::Resumption::disabled();
        builder = builder.use_preconfigured_tls(tls);
    }
    builder
        .build()
        .map_err(|e| Error::ProxmoxApi(e.to_string()))
}

#[derive(Debug)]
struct PinnedVerifier {
    pin: [u8; 32],
    server_name: ServerName<'static>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        // Explicit approval vouches for this exact leaf, rather than its issuer/name.
        if server_name != &self.server_name || Sha256::digest(cert.as_ref())[..] != self.pin {
            return Err(rustls::Error::General(CERTIFICATE_CHANGED.into()));
        }
        Ok(ServerCertVerified::assertion())
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
            &provider().signature_verification_algorithms,
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
            &provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[derive(Debug)]
struct ProbeVerifier {
    normal: Arc<dyn ServerCertVerifier>,
    /// `Some(None)` when the platform trusts the certificate, `Some(fingerprint)`
    /// when it does not, and `None` when no certificate was seen at all.
    result: Mutex<Option<Option<String>>>,
}

impl ServerCertVerifier for ProbeVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let result =
            match self
                .normal
                .verify_server_cert(cert, intermediates, server_name, ocsp, now)
            {
                Ok(_) => None,
                // Any reason is the user's call: Proxmox ships its own certificate,
                // and home servers are reached by IP, alias, or VPN address. What
                // they confirm is pinned exactly, so no other certificate passes.
                Err(_) => Some(fingerprint(cert)),
            };
        *self.result.lock().expect("probe result lock") = Some(result);
        // Always abort here: even a trusted certificate probe must send no HTTP.
        Err(rustls::Error::General("certificate probe complete".into()))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.normal.supported_verify_schemes()
    }
}

/// Inspect trust without sending HTTP or credentials. None means normal TLS trust;
/// a fingerprint requires explicit comparison and approval before authentication.
pub async fn certificate_fingerprint(url: &str) -> Result<Option<String>> {
    let url = server_url(url)?;
    let normal = rustls_platform_verifier::Verifier::new(provider())
        .map_err(|e| Error::ProxmoxApi(e.to_string()))?;
    probe(url, Arc::new(normal)).await
}

async fn probe(url: reqwest::Url, normal: Arc<dyn ServerCertVerifier>) -> Result<Option<String>> {
    let verifier = Arc::new(ProbeVerifier {
        normal,
        result: Mutex::new(None),
    });
    let client = client_builder(30)
        .use_preconfigured_tls(config(verifier.clone()))
        .build()
        .map_err(|e| Error::ProxmoxApi(e.to_string()))?;
    // The verifier aborts every handshake, so this never returns a response
    let error = client.get(url).send().await.err();
    if let Some(result) = verifier.result.lock().expect("probe result lock").take() {
        return Ok(result);
    }

    // No certificate was seen: the same guidance as a failed login
    Err(Error::ProxmoxActionRequired(
        match error {
            Some(error) if error.is_timeout() => {
                "Connection timed out. Please check the server URL and network connectivity."
            }
            _ => "Failed to connect to Proxmox server. Please verify the URL is correct.",
        }
        .into(),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ProxmoxCredentials, ProxmoxSession};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct TlsServer {
        url: String,
        cert: CertificateDer<'static>,
        requests: Arc<Mutex<Vec<String>>>,
        handshakes: Arc<Mutex<Vec<rustls::HandshakeKind>>>,
        acceptor: tokio_rustls::TlsAcceptor,
        rotate_to: Arc<Mutex<Option<tokio_rustls::TlsAcceptor>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TlsServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl TlsServer {
        async fn start(redirect: Option<String>, tls12: bool) -> Self {
            Self::start_at("127.0.0.1:0", redirect, tls12).await
        }

        async fn start_at(bind: &str, redirect: Option<String>, tls12: bool) -> Self {
            let rcgen::CertifiedKey { cert, signing_key } =
                rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()])
                    .unwrap();
            let cert = cert.der().clone();
            let versions = if tls12 {
                vec![&rustls::version::TLS12]
            } else {
                vec![&rustls::version::TLS13]
            };
            let config = rustls::ServerConfig::builder_with_provider(provider())
                .with_protocol_versions(&versions)
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![cert.clone()],
                    rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
                )
                .unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
            let listener = tokio::net::TcpListener::bind(bind).await.unwrap();
            let url = format!("https://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let received = requests.clone();
            let handshakes = Arc::new(Mutex::new(Vec::new()));
            let completed_handshakes = handshakes.clone();
            let rotate_to = Arc::new(Mutex::new(None));
            let next_acceptor = rotate_to.clone();
            let mut current_acceptor = acceptor.clone();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let Ok(Ok(mut tls)) = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        current_acceptor.accept(stream),
                    )
                    .await
                    else {
                        continue;
                    };
                    completed_handshakes
                        .lock()
                        .unwrap()
                        .push(tls.get_ref().1.handshake_kind().unwrap());
                    let mut request = Vec::new();
                    loop {
                        let mut buf = [0; 4096];
                        let Ok(Ok(size)) = tokio::time::timeout(
                            std::time::Duration::from_secs(3),
                            tls.read(&mut buf),
                        )
                        .await
                        else {
                            break;
                        };
                        if size == 0 {
                            break;
                        }
                        request.extend_from_slice(&buf[..size]);
                        let text = String::from_utf8_lossy(&request);
                        if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                            let len: usize = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length: ")
                                        .and_then(|value| value.parse().ok())
                                })
                                .unwrap_or(0);
                            if body.len() >= len {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8(request).unwrap();
                    let body = if request.starts_with("POST /api2/json/access/ticket ") {
                        r#"{"data":{"ticket":"fixture-ticket","CSRFPreventionToken":"fixture-csrf"}}"#
                    } else if request.starts_with("GET /api2/json/version ") {
                        r#"{"data":{"version":"8.4.1"}}"#
                    } else {
                        r#"{"data":[]}"#
                    };
                    received.lock().unwrap().push(request);
                    let response = if let Some(location) = &redirect {
                        format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    } else {
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                    };
                    let _ = tls.write_all(response.as_bytes()).await;
                    let _ = tls.shutdown().await;
                    if let Some(replacement) = next_acceptor.lock().unwrap().take() {
                        current_acceptor = replacement;
                    }
                }
            });
            Self {
                url,
                cert,
                requests,
                handshakes,
                acceptor,
                rotate_to,
                task,
            }
        }

        fn credentials(&self, approved: bool) -> ProxmoxCredentials {
            ProxmoxCredentials {
                server_url: self.url.clone(),
                username: "fixture@pam".into(),
                password: "fixture-password".into(),
                totp: None,
                certificate_sha256: approved.then(|| fingerprint(&self.cert)),
            }
        }

        fn normal_verifier(&self) -> Arc<dyn ServerCertVerifier> {
            Arc::new(
                rustls_platform_verifier::Verifier::new_with_extra_roots(
                    [self.cert.clone()],
                    provider(),
                )
                .unwrap(),
            )
        }
    }

    #[test]
    fn validates_and_normalizes_server_origins() {
        for invalid in [
            "http://localhost",
            "ftp://localhost",
            "not a URL",
            "https://user:pass@localhost",
            "https://localhost/api",
            "https://localhost?foo",
            "https://localhost#foo",
        ] {
            assert!(server_url(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            server_url("HTTPS://PVE.EXAMPLE:8006").unwrap().as_str(),
            "https://pve.example:8006/"
        );
        assert!(server_url("https://[::1]:8006").is_ok());
        assert!(client("https://localhost", Some("01:02"), 1).is_err());
    }

    #[tokio::test]
    async fn untrusted_probe_sends_no_http_and_direct_login_sends_no_credentials() {
        let server = TlsServer::start(None, false).await;
        assert_eq!(
            certificate_fingerprint(&server.url).await.unwrap(),
            Some(fingerprint(&server.cert))
        );
        assert!(super::super::authenticate(&server.credentials(false))
            .await
            .is_err());
        assert!(server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn trusted_probe_uses_normal_validation_and_sends_no_http() {
        let server = TlsServer::start(None, false).await;
        assert_eq!(
            probe(server_url(&server.url).unwrap(), server.normal_verifier())
                .await
                .unwrap(),
            None
        );
        assert!(server.requests.lock().unwrap().is_empty());
    }

    fn expired_certificate() -> CertificateDer<'static> {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
        params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        params.not_after = rcgen::date_time_ymd(2021, 1, 1);
        params.self_signed(&key).unwrap().der().clone()
    }

    // `openssl req -x509` marks its self-signed certificate as a CA by default
    fn self_signed_ca_certificate() -> CertificateDer<'static> {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.self_signed(&key).unwrap().der().clone()
    }

    #[test]
    fn every_untrusted_certificate_is_offered_for_confirmation() {
        let trusted = rcgen::generate_simple_self_signed(vec!["localhost".into()])
            .unwrap()
            .cert
            .der()
            .clone();
        let expired = expired_certificate();
        let self_signed_ca = self_signed_ca_certificate();
        let verifier = ProbeVerifier {
            normal: Arc::new(
                rustls_platform_verifier::Verifier::new_with_extra_roots(
                    [trusted.clone()],
                    provider(),
                )
                .unwrap(),
            ),
            result: Mutex::new(None),
        };
        for (cert, name) in [
            // Reached by an address the certificate doesn't name
            (&trusted, "192.0.2.10"),
            (&expired, "localhost"),
            (&self_signed_ca, "localhost"),
        ] {
            // The probe always aborts the handshake, trusted or not
            assert!(verifier
                .verify_server_cert(
                    cert,
                    &[],
                    &ServerName::try_from(name).unwrap(),
                    &[],
                    UnixTime::now()
                )
                .is_err());
            assert_eq!(
                verifier.result.lock().unwrap().take(),
                Some(Some(fingerprint(cert))),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn unreachable_server_gets_connection_guidance() {
        let error = certificate_fingerprint("https://127.0.0.1:1")
            .await
            .unwrap_err();
        assert!(
            matches!(&error, Error::ProxmoxActionRequired(message) if message.contains("verify the URL")),
            "{error}"
        );
    }

    #[tokio::test]
    async fn confirmed_certificate_authenticates_and_pins_subsequent_requests() {
        for tls12 in [false, true] {
            let server = TlsServer::start(None, tls12).await;
            let session = super::super::authenticate(&server.credentials(true))
                .await
                .unwrap();
            assert_eq!(session.certificate_sha256, Some(fingerprint(&server.cert)));
            assert!(super::super::list_nodes(&session).await.unwrap().is_empty());
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests[0].contains("password=fixture-password"));
            assert!(requests[2].contains("PVEAuthCookie=fixture-ticket"));
            assert_eq!(
                *server.handshakes.lock().unwrap(),
                vec![rustls::HandshakeKind::Full; 3]
            );
        }
    }

    #[tokio::test]
    async fn ipv6_certificate_pin_survives_credentials_and_session_serialization() {
        let server = TlsServer::start_at("[::1]:0", None, false).await;
        let credentials: ProxmoxCredentials =
            serde_json::from_value(serde_json::to_value(server.credentials(true)).unwrap())
                .unwrap();
        let session = super::super::authenticate(&credentials).await.unwrap();
        let session: ProxmoxSession =
            serde_json::from_value(serde_json::to_value(session).unwrap()).unwrap();
        assert_eq!(session.certificate_sha256, credentials.certificate_sha256);
        assert!(super::super::list_nodes(&session).await.is_ok());
        assert_eq!(server.requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn certificate_change_before_version_check_preserves_reconnect_message() {
        let original = TlsServer::start(None, false).await;
        let changed = TlsServer::start(None, false).await;
        *original.rotate_to.lock().unwrap() = Some(changed.acceptor.clone());

        let error = super::super::authenticate(&original.credentials(true))
            .await
            .unwrap_err();
        assert!(matches!(error, Error::ProxmoxCertificateChanged), "{error}");
        let requests = original.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /api2/json/access/ticket "));
    }

    async fn rejects_rotation_with_retained_sessions(tls12: bool) {
        let original = TlsServer::start(None, tls12).await;
        let changed = TlsServer::start(None, tls12).await;
        let mut rotated = changed.acceptor.config().as_ref().clone();
        rotated.session_storage = original.acceptor.config().session_storage.clone();
        rotated.ticketer = original.acceptor.config().ticketer.clone();
        *original.rotate_to.lock().unwrap() =
            Some(tokio_rustls::TlsAcceptor::from(Arc::new(rotated)));

        let result = super::super::authenticate(&original.credentials(true)).await;
        assert!(
            result.is_err(),
            "rotated certificate accepted; handshakes: {:?}",
            original.handshakes.lock().unwrap()
        );
        let error = result.unwrap_err();
        assert!(matches!(error, Error::ProxmoxCertificateChanged), "{error}");
        let requests = original.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /api2/json/access/ticket "));
    }

    #[tokio::test]
    async fn tls12_rotation_with_retained_sessions_rejects_new_certificate() {
        rejects_rotation_with_retained_sessions(true).await;
    }

    #[tokio::test]
    async fn tls13_rotation_with_retained_sessions_rejects_new_certificate() {
        rejects_rotation_with_retained_sessions(false).await;
    }

    #[tokio::test]
    async fn changed_certificate_rejects_password_and_session_ticket() {
        let original = TlsServer::start(None, false).await;
        let changed = TlsServer::start(None, false).await;
        let mut credentials = changed.credentials(true);
        credentials.certificate_sha256 = Some(fingerprint(&original.cert));
        assert!(matches!(
            super::super::authenticate(&credentials).await.unwrap_err(),
            Error::ProxmoxCertificateChanged
        ));
        let session = ProxmoxSession {
            server_url: changed.url.clone(),
            ticket: "fixture-ticket".into(),
            csrf_token: "fixture-csrf".into(),
            certificate_sha256: credentials.certificate_sha256,
        };
        let errors = [
            super::super::list_nodes(&session).await.unwrap_err(),
            super::super::list_storage(&session, "pve")
                .await
                .unwrap_err(),
            super::super::get_next_vm_id(&session).await.unwrap_err(),
            super::super::fetch_privileges(&session, "/")
                .await
                .unwrap_err(),
            super::super::wait_for_task(&session, "pve", "fixture-task", 1)
                .await
                .unwrap_err(),
            super::super::start_vm(&session, "pve", 100)
                .await
                .unwrap_err(),
            super::super::delete_import_image(&session, "pve", "local", "fixture.qcow2")
                .await
                .unwrap_err(),
            super::super::vm_status(&session, "pve", 100)
                .await
                .unwrap_err(),
        ];
        for error in errors {
            assert!(matches!(error, Error::ProxmoxCertificateChanged), "{error}");
        }
        let config = crate::types::ProxmoxVmConfig {
            node: "pve".into(),
            storage: "local".into(),
            bridge: "vmbr0".into(),
            vm_id: 100,
            name: "fixture".into(),
            cpu_cores: 2,
            memory_mb: 2048,
            disk_size_gb: 32,
            auto_start: false,
        };
        let mut source_unused = false;
        let error = super::super::create_vm_with_disk(
            &session,
            &config,
            "fixture.qcow2",
            "local",
            &mut source_unused,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::ProxmoxCertificateChanged), "{error}");
        // The bridge check fails before the create request is sent.
        assert!(source_unused);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"fake fixture image").unwrap();
        let error = super::super::upload_image_to_proxmox(
            &session,
            "pve",
            &file.path().to_path_buf(),
            &crate::NoOpProgress,
            "local",
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::ProxmoxCertificateChanged), "{error}");
        assert!(changed.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn redirects_do_not_forward_passwords_or_tickets() {
        let destination = TlsServer::start(None, false).await;
        let server = TlsServer::start(Some(destination.url.clone()), false).await;
        assert!(super::super::authenticate(&server.credentials(true))
            .await
            .is_err());
        let session = ProxmoxSession {
            server_url: server.url.clone(),
            ticket: "fixture-ticket".into(),
            csrf_token: "fixture-csrf".into(),
            certificate_sha256: Some(fingerprint(&server.cert)),
        };
        assert!(super::super::list_nodes(&session).await.is_err());
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        assert!(destination.requests.lock().unwrap().is_empty());
    }
}
