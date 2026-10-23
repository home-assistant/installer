//! The SHA-256 of each file of a HAOS release, from the release's
//! `SHA256SUMS`. It is trusted only with a Sigstore signature from the HAOS
//! release build, never because GitHub serves it.

use super::{github_unreachable, metadata_request_error, METADATA_TIMEOUT};
use crate::error::{Error, Result};
use sigstore_trust_root::{TrustedRoot, TufConfig, SIGSTORE_PRODUCTION_TRUSTED_ROOT};
use sigstore_types::Bundle;
use sigstore_verify::crypto::FulcioCiClaims;
use sigstore_verify::{IdentityMatcher, VerificationPolicy, Verifier};
use std::collections::HashMap;
use std::time::Duration;

/// The workflow that signs `SHA256SUMS`, and where its identity comes from.
const SIGNER: &str =
    "https://github.com/home-assistant/operating-system/.github/workflows/build.yaml";
const SIGNER_ISSUER: &str = "https://token.actions.githubusercontent.com";
/// GitHub's ID of home-assistant/operating-system, which survives a rename.
const HAOS_REPOSITORY_ID: &str = "115992009";

/// Releases from before `SHA256SUMS` was signed, in its format. The digests are
/// GitHub's asset digests. Remove a release once stable.json no longer lists it.
const UNSIGNED_RELEASES: &[(&str, &str)] = &[(
    "18.3",
    "\
93440a136e1e6b660e0b01dd27d3ecc858b4deacc68f7effcf1a32f34e266b9b  haos_generic-aarch64-18.3.img.xz\n\
f54b659f12c665038134bdf9d4235903048056257368f82369dc230131f5a675  haos_generic-aarch64-18.3.qcow2.xz\n\
121fcf49d373e6cfa68ce2176d740980b8856de263e876b9f6dfb299cbd51ef8  haos_generic-x86-64-18.3.img.xz\n\
92fdf276bb94c67794ef96729f5fe6ee04b617598ef1b3a5b8cca52b0aee4b0d  haos_green-18.3.img.xz\n\
c3e5581b5cd7a54a9a51c7fc070adf895fc2c76ecf36249aa09a377488303f8a  haos_khadas-vim3-18.3.img.xz\n\
c951c21281c8bfb26a96ec0035e97f2cf40b2ac9dd3b18159122ca725938b6d3  haos_odroid-c2-18.3.img.xz\n\
d9005b8735106d0b3a61a2f8c3368b29b5986ad18f3424667763e8dbeaf568e8  haos_odroid-c4-18.3.img.xz\n\
0b35df3b53b687dee31918533138544b389d64e46d767d1b225ead6e4fc5b4ce  haos_odroid-m1-18.3.img.xz\n\
c6682a5cc54fd917f8400428c8f12002c024aaade1c2ef93698de3e40cfc79c5  haos_odroid-m1s-18.3.img.xz\n\
b762f8a50e9cad82f3a65649235ae6ca8d894ebdbfdc5535bd2b8f1618a17f18  haos_odroid-n2-18.3.img.xz\n\
fae6a728768cc10aff60d4820bfcd40d64cd77fab82c8bd92af13b3d9d414090  haos_ova-18.3.qcow2.xz\n\
46f95b9fc6acac6a8ec414291769ee2c5724850e2bc34f8139e856e8ea5c75ee  haos_rpi3-64-18.3.img.xz\n\
611acc2d7437332dde18c2175134c5a9f859c7647ef6334a5b93b7278e67b185  haos_rpi4-64-18.3.img.xz\n\
e148a92595059d71c8bbf4c80d66fcb9166b647e10024641936316402863c60f  haos_rpi5-64-18.3.img.xz\n\
c5e599f7c23164cd9115ed7c233b89265d3a6ca680c1caaadde793fe4848b176  haos_yellow-18.3.img.xz\n\
",
)];

/// The trust root Sigstore publishes now, fetched at most once per session.
static CURRENT_VERIFIER: tokio::sync::OnceCell<Verifier> = tokio::sync::OnceCell::const_new();
/// The client limits each request; this limits the several a TUF update makes.
const TRUST_ROOT_TIMEOUT: Duration = Duration::from_secs(30);

/// File name → `sha256:<hex>` digest of each file of release `version`,
/// whose files are at `<downloads_url>/<version>/<file>`.
pub(crate) async fn verified(
    client: &reqwest::Client,
    downloads_url: &str,
    version: &str,
) -> Result<HashMap<String, String>> {
    if let Some((_, sums)) = UNSIGNED_RELEASES
        .iter()
        .find(|(unsigned, _)| *unsigned == version)
    {
        return Ok(parse(sums));
    }
    let release_file =
        |file: &str| fetch(client, format!("{downloads_url}/{version}/{file}"), version);
    let sums = release_file("SHA256SUMS").await?;
    let bundle = release_file("SHA256SUMS.sigstore.json").await?;
    verify_signature(client, version, &sums, &bundle).await?;
    // Lines that aren't valid UTF-8 can't name an image, so parse skips them.
    Ok(parse(&String::from_utf8_lossy(&sums)))
}

async fn fetch(client: &reqwest::Client, url: String, version: &str) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .map_err(|error| metadata_request_error(error, github_unreachable))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(Error::VerificationFailed(format!(
            "Release {version} has no signed checksums"
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

/// Fails unless `bundle` is a Sigstore signature of `data` by the build of
/// release `version`. The trust root built into sigstore-trust-root decides;
/// the current one is fetched only when it could decide differently.
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
    let identity = format!("{SIGNER}@refs/tags/{version}");
    let policy = VerificationPolicy::new(IdentityMatcher::Uri(identity.clone()), SIGNER_ISSUER);

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
    if !claims.is_some_and(|claims| from_release_build(claims, &identity)) {
        return Err(invalid(&"signed by a build of another repository"));
    }
    Ok(())
}

/// Whether the HAOS repository itself ran the workflow `identity` names. The
/// identity alone also matches when another repository calls that workflow.
fn from_release_build(claims: &FulcioCiClaims, identity: &str) -> bool {
    claims.build_config_uri.as_deref() == Some(identity)
        && claims.source_repository_identifier.as_deref() == Some(HAOS_REPOSITORY_ID)
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

    const VERSION: &str = "18.4.rc1";
    const SUMS: &[u8] = include_bytes!("../../testdata/18.4.rc1/SHA256SUMS");
    const BUNDLE: &[u8] = include_bytes!("../../testdata/18.4.rc1/SHA256SUMS.sigstore.json");
    const RELEASE_BUILD: &str =
        "https://github.com/home-assistant/operating-system/.github/workflows/build.yaml@refs/tags/18.4.rc1";

    fn client() -> reqwest::Client {
        super::super::http_client(Duration::from_secs(30)).unwrap()
    }

    /// A server with the signed 18.4.rc1 files at `/<path>/`.
    async fn release_server(path: &str) -> mockito::ServerGuard {
        let mut server = mockito::Server::new_async().await;
        for (file, body) in [("SHA256SUMS", SUMS), ("SHA256SUMS.sigstore.json", BUNDLE)] {
            server
                .mock("GET", format!("/{path}/{file}").as_str())
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
    async fn a_pinned_release_needs_no_request() {
        let sums = verified(&client(), "http://127.0.0.1:9", "18.3")
            .await
            .unwrap();

        assert_eq!(sums.len(), 15);
        assert_eq!(
            sums["haos_ova-18.3.qcow2.xz"],
            "sha256:fae6a728768cc10aff60d4820bfcd40d64cd77fab82c8bd92af13b3d9d414090"
        );
    }

    #[tokio::test]
    async fn a_signed_release_gives_its_digests() {
        let server = release_server(VERSION).await;

        let sums = verified(&client(), &server.url(), VERSION).await.unwrap();

        assert_eq!(
            sums["haos_ova-18.4.rc1.qcow2.xz"],
            "sha256:40d5d343e8ef5d93ae859e18c0dc41a08ce55647e7107eccf4d819577224ca1f"
        );
    }

    #[tokio::test]
    async fn another_releases_signature_is_refused() {
        let server = release_server("18.4").await;

        let result = verified(&client(), &server.url(), "18.4").await;

        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    /// `verified` for release 18.4, whose `SHA256SUMS` answers `status`.
    async fn verified_with_sums_answering(status: usize) -> Result<HashMap<String, String>> {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/18.4/SHA256SUMS")
            .with_status(status)
            .create_async()
            .await;

        verified(&client(), &server.url(), "18.4").await
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

        let result = verify_signature(&client(), VERSION, &changed, BUNDLE).await;

        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    #[test]
    fn only_the_haos_repository_running_the_workflow_itself_may_sign() {
        let policy =
            VerificationPolicy::new(IdentityMatcher::Uri(RELEASE_BUILD.into()), SIGNER_ISSUER);
        let bundle = Bundle::from_json(std::str::from_utf8(BUNDLE).unwrap()).unwrap();
        let result = built_in_verifier()
            .unwrap()
            .verify(SUMS, &bundle, &policy)
            .unwrap();
        let claims = &result.certificate().unwrap().ci_claims;
        assert!(from_release_build(claims, RELEASE_BUILD));

        let mut called = claims.clone();
        called.build_config_uri = Some(
            "https://github.com/someone/fork/.github/workflows/call.yaml@refs/tags/18.4.rc1".into(),
        );
        assert!(!from_release_build(&called, RELEASE_BUILD));

        let mut recreated = claims.clone();
        recreated.source_repository_identifier = Some("1".into());
        assert!(!from_release_build(&recreated, RELEASE_BUILD));
    }

    #[test]
    fn the_log_entry_is_checked() {
        let forged = std::str::from_utf8(BUNDLE).unwrap().replace(
            r#""integratedTime":"1792500619""#,
            r#""integratedTime":"1792500620""#,
        );
        let policy =
            VerificationPolicy::new(IdentityMatcher::Uri(RELEASE_BUILD.into()), SIGNER_ISSUER);

        let result = built_in_verifier().unwrap().verify(
            SUMS,
            &Bundle::from_json(&forged).unwrap(),
            &policy,
        );

        assert!(matches!(
            result,
            Err(sigstore_verify::Error::TransparencyLog(_))
        ));
    }
}
