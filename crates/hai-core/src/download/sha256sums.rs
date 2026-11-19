//! The SHA-256 of each file of a full-images release, from the release's
//! `SHA256SUMS`. It is trusted only with a Sigstore signature from the build
//! that made the release, never because GitHub serves it.

use super::{github_unreachable, metadata_request_error, METADATA_TIMEOUT};
use crate::error::{Error, Result};
use sigstore_trust_root::{TrustedRoot, TufConfig, SIGSTORE_PRODUCTION_TRUSTED_ROOT};
use sigstore_types::Bundle;
use sigstore_verify::crypto::FulcioCiClaims;
use sigstore_verify::{IdentityMatcher, VerificationPolicy, Verifier};
use std::collections::HashMap;
use std::time::Duration;

/// The workflow that signs `SHA256SUMS`, and where its identity comes from.
/// It runs from `main` and tags the release itself, so its signature names no
/// release: which one is current is decided against stable.json instead.
const SIGNER: &str = "https://github.com/home-assistant/operating-system-full-images/.github/workflows/build-channel.yml@refs/heads/main";
const SIGNER_ISSUER: &str = "https://token.actions.githubusercontent.com";
/// GitHub's ID of home-assistant/operating-system-full-images, which survives
/// a rename.
const SIGNER_REPOSITORY_ID: &str = "1139931741";

/// The trust root Sigstore publishes now, fetched at most once per session.
static CURRENT_VERIFIER: tokio::sync::OnceCell<Verifier> = tokio::sync::OnceCell::const_new();
/// The client limits each request; this limits the several a TUF update makes.
const TRUST_ROOT_TIMEOUT: Duration = Duration::from_secs(30);

/// File name → `sha256:<hex>` digest of each file of release `tag`, whose
/// files are at `<downloads_url>/<tag>/<file>`.
pub(crate) async fn verified(
    client: &reqwest::Client,
    downloads_url: &str,
    tag: &str,
) -> Result<HashMap<String, String>> {
    let sums = fetch(client, downloads_url, tag, "SHA256SUMS").await?;
    let bundle = fetch(client, downloads_url, tag, "SHA256SUMS.sigstore.json").await?;
    verify_signature(client, tag, &sums, &bundle).await?;
    // Lines that aren't valid UTF-8 can't name an image, so parse skips them.
    Ok(parse(&String::from_utf8_lossy(&sums)))
}

/// `file` of release `version`, from `<downloads_url>/<version>/<file>`.
pub(super) async fn fetch(
    client: &reqwest::Client,
    downloads_url: &str,
    version: &str,
    file: &str,
) -> Result<Vec<u8>> {
    let response = client
        .get(format!("{downloads_url}/{version}/{file}"))
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .map_err(|error| metadata_request_error(error, github_unreachable))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(Error::VerificationFailed(format!(
            "Release {version} has no {file}"
        )));
    }
    if !status.is_success() {
        return Err(Error::ServiceUnavailable(crate::message!(
            "backend.download.github_release_unavailable",
            version = version,
            status = status.as_u16(),
        )));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| metadata_request_error(error, github_unreachable))?;
    Ok(body.to_vec())
}

/// Fails unless `bundle` is a Sigstore signature of `data` by the full-images
/// build; `version` names the release in errors. The trust root built into
/// sigstore-trust-root decides; the current one is fetched only when it could
/// decide differently.
async fn verify_signature(
    client: &reqwest::Client,
    version: &str,
    data: &[u8],
    bundle: &[u8],
) -> Result<()> {
    let invalid = |error: &dyn std::fmt::Display| {
        Error::VerificationFailed(format!(
            "No valid signature on the checksums of release {version}: {error}"
        ))
    };
    let json = std::str::from_utf8(bundle).map_err(|error| invalid(&error))?;
    let bundle = Bundle::from_json(json).map_err(|error| invalid(&error))?;
    let policy = VerificationPolicy::new(IdentityMatcher::Uri(SIGNER.into()), SIGNER_ISSUER);

    let result = match built_in_verifier()?.verify(data, &bundle, &policy) {
        Ok(result) => result,
        Err(error) if !newer_root_may_pass(&error) => return Err(invalid(&error)),
        Err(_) => current_verifier(client)
            .await?
            .verify(data, &bundle, &policy)
            .map_err(|error| invalid(&error))?,
    };
    let claims = result
        .certificate()
        .map(|certificate| &certificate.ci_claims);
    if !claims.is_some_and(from_release_build) {
        return Err(invalid(&"signed by a build of another repository"));
    }
    Ok(())
}

/// Whether the full-images repository itself ran the signing workflow. The
/// identity alone also matches when another repository calls that workflow.
fn from_release_build(claims: &FulcioCiClaims) -> bool {
    claims.build_config_uri.as_deref() == Some(SIGNER)
        && claims.source_repository_identifier.as_deref() == Some(SIGNER_REPOSITORY_ID)
}

/// Whether `error` could go away with a newer trust root: the bundle may use a
/// log, authority or key the built-in root doesn't have yet.
fn newer_root_may_pass(error: &sigstore_verify::Error) -> bool {
    !matches!(
        error,
        sigstore_verify::Error::IdentityMismatch { .. }
            | sigstore_verify::Error::IssuerMismatch { .. }
            | sigstore_verify::Error::SignatureInvalid(_)
            | sigstore_verify::Error::ArtifactMismatch(_)
    )
}

/// The trust root shipped with sigstore-trust-root, updated with its releases.
fn built_in_verifier() -> Result<Verifier> {
    TrustedRoot::from_json(SIGSTORE_PRODUCTION_TRUSTED_ROOT)
        .map_err(sigstore_verify::Error::from)
        .and_then(|root| Verifier::new(&root))
        .map_err(|error| {
            Error::VerificationFailed(format!(
                "Sigstore's built-in trust root is unusable: {error}"
            ))
        })
}

/// The trust root Sigstore publishes now, through TUF.
async fn current_verifier(client: &reqwest::Client) -> Result<&'static Verifier> {
    CURRENT_VERIFIER
        .get_or_try_init(|| async {
            let unreachable = || {
                Error::ServiceUnavailable(crate::message!("backend.download.sigstore_unreachable"))
            };
            let tuf = TufConfig::production()
                .without_cache()
                .with_http_client(client.clone());
            let root = tokio::time::timeout(TRUST_ROOT_TIMEOUT, TrustedRoot::from_tuf(tuf))
                .await
                .map_err(|_| unreachable())?
                .map_err(|_| unreachable())?;
            Verifier::new(&root).map_err(|_| unreachable())
        })
        .await
}

/// The `<sha256>  <file>` lines of a `SHA256SUMS`; malformed ones are skipped.
fn parse(sums: &str) -> HashMap<String, String> {
    sums.lines()
        .filter_map(|line| {
            let (hash, name) = line.split_once("  ")?;
            let mut digest = [0; 32];
            hex::decode_to_slice(hash, &mut digest).ok()?;
            Some((name.to_string(), format!("sha256:{}", hex::encode(digest))))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG: &str = "stable-3a2161e70d5f79e84a03f0e1c15598a8e2d9df88";
    const SUMS: &[u8] =
        include_bytes!("../../testdata/stable-3a2161e70d5f79e84a03f0e1c15598a8e2d9df88/SHA256SUMS");
    const BUNDLE: &[u8] = include_bytes!(
        "../../testdata/stable-3a2161e70d5f79e84a03f0e1c15598a8e2d9df88/SHA256SUMS.sigstore.json"
    );
    /// Signed by the HAOS release build, which isn't trusted here.
    const HAOS_SUMS: &[u8] = include_bytes!("../../testdata/18.4.rc1/SHA256SUMS");
    const HAOS_BUNDLE: &[u8] = include_bytes!("../../testdata/18.4.rc1/SHA256SUMS.sigstore.json");

    fn client() -> reqwest::Client {
        super::super::http_client(Duration::from_secs(30)).unwrap()
    }

    /// A server with `sums` and `bundle` as the signed files of `TAG`.
    async fn release_server(sums: &[u8], bundle: &[u8]) -> mockito::ServerGuard {
        let mut server = mockito::Server::new_async().await;
        for (file, body) in [("SHA256SUMS", sums), ("SHA256SUMS.sigstore.json", bundle)] {
            server
                .mock("GET", format!("/{TAG}/{file}").as_str())
                .with_body(body)
                .create_async()
                .await;
        }
        server
    }

    #[test]
    fn parses_only_well_formed_lines() {
        let hash = "AB".repeat(32);
        let sums = format!(
            "{hash}  haos_ova-18.3.qcow2.xz\nnot-hex  haos_green-18.3.img.xz\n{hash} haos_rpi5-64-18.3.img.xz\n"
        );

        let parsed = parse(&sums);

        let lowercase = format!("sha256:{}", "ab".repeat(32));
        assert_eq!(
            parsed,
            HashMap::from([("haos_ova-18.3.qcow2.xz".to_string(), lowercase)])
        );
    }

    #[tokio::test]
    async fn a_signed_release_gives_its_digests() {
        let server = release_server(SUMS, BUNDLE).await;

        let sums = verified(&client(), &server.url(), TAG).await.unwrap();

        assert_eq!(
            sums["build-inputs.json"],
            "sha256:84782cee64ee56a43decbf123ad98de0538f353a9d975d535cddc5ffe0d87224"
        );
    }

    #[tokio::test]
    async fn a_signature_by_another_build_is_refused() {
        let server = release_server(HAOS_SUMS, HAOS_BUNDLE).await;

        let result = verified(&client(), &server.url(), TAG).await;

        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    /// `verified` for `TAG`, whose `SHA256SUMS` answers `status`.
    async fn verified_with_sums_answering(status: usize) -> Result<HashMap<String, String>> {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", format!("/{TAG}/SHA256SUMS").as_str())
            .with_status(status)
            .create_async()
            .await;

        verified(&client(), &server.url(), TAG).await
    }

    #[tokio::test]
    async fn a_release_without_checksums_cant_be_verified() {
        let result = verified_with_sums_answering(404).await;

        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    #[tokio::test]
    async fn an_unavailable_download_can_be_retried() {
        let result = verified_with_sums_answering(503).await;

        assert!(matches!(result, Err(Error::ServiceUnavailable(_))));
    }

    // These check against the built-in trust root only, so they run offline.
    #[tokio::test]
    async fn changed_sums_are_refused() {
        let mut changed = SUMS.to_vec();
        changed[0] ^= 1;

        let result = verify_signature(&client(), TAG, &changed, BUNDLE).await;

        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    fn policy() -> VerificationPolicy {
        VerificationPolicy::new(IdentityMatcher::Uri(SIGNER.into()), SIGNER_ISSUER)
    }

    #[test]
    fn only_the_full_images_repository_running_the_workflow_itself_may_sign() {
        let bundle = Bundle::from_json(std::str::from_utf8(BUNDLE).unwrap()).unwrap();
        let result = built_in_verifier()
            .unwrap()
            .verify(SUMS, &bundle, &policy())
            .unwrap();
        let claims = &result.certificate().unwrap().ci_claims;
        assert!(from_release_build(claims));

        let mut called = claims.clone();
        called.build_config_uri = Some(
            "https://github.com/someone/fork/.github/workflows/call.yaml@refs/heads/main".into(),
        );
        assert!(!from_release_build(&called));

        let mut recreated = claims.clone();
        recreated.source_repository_identifier = Some("1".into());
        assert!(!from_release_build(&recreated));
    }

    #[test]
    fn the_log_entry_is_checked() {
        let forged = std::str::from_utf8(BUNDLE).unwrap().replace(
            r#""integratedTime":"1794412734""#,
            r#""integratedTime":"1794412735""#,
        );

        let result = built_in_verifier().unwrap().verify(
            SUMS,
            &Bundle::from_json(&forged).unwrap(),
            &policy(),
        );

        assert!(matches!(
            result,
            Err(sigstore_verify::Error::TransparencyLog(_))
        ));
    }
}
