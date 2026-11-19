//! Home Assistant OS images with Home Assistant already on them, built by
//! home-assistant/operating-system-full-images from a stable.json snapshot.
//! A device started from one skips downloading Home Assistant on first boot.
//!
//! A board gets one only when the latest release was built from the HAOS
//! version stable.json lists for the board now. The release's signature names
//! no release, so this check is also what keeps an older one from being
//! offered. Until a release built from that version is out, the board has
//! nothing to install.

use super::sha256sums;
use super::{parse_version, request_github_release, shared_client, version_service_invalid};
use crate::error::{Error, Result};
use crate::types::{GitHubAsset, HaosImage, HaosRelease, ImageFormat};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::LazyLock;
use tokio::sync::Mutex;

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/home-assistant/operating-system-full-images/releases/latest";

/// Images are only ever downloaded from the full-images repository.
const DOWNLOADS: &str =
    "https://github.com/home-assistant/operating-system-full-images/releases/download";

/// The part of the stable.json snapshot that the images were built from.
const BUILD_INPUTS: &str = "build-inputs.json";

/// Stable releases are tagged with the home-assistant/version commit they were
/// built from; image names carry its first 12 digits.
const TAG_PREFIX: &str = "stable-";
const REVISION_DIGITS: usize = 12;

static LATEST: LazyLock<Mutex<Option<FullRelease>>> = LazyLock::new(|| Mutex::new(None));

/// The latest full release, with what its signature vouches for.
#[derive(Debug, Clone)]
struct FullRelease {
    tag: String,
    /// HAOS version of each board, as the release was built from.
    hassos: HashMap<String, String>,
    assets: Vec<GitHubAsset>,
    /// File name → verified `sha256:<hex>` digest.
    sums: HashMap<String, String>,
}

#[derive(serde::Deserialize)]
struct BuildInputs {
    hassos: HashMap<String, String>,
}

/// The full images of `board`, built from HAOS `version`, the one stable.json
/// lists for it.
pub(crate) async fn release_for_board(board: &str, version: &str) -> Result<HaosRelease> {
    release_for_board_from(&LATEST, LATEST_RELEASE_API, DOWNLOADS, board, version).await
}

async fn release_for_board_from(
    cache: &Mutex<Option<FullRelease>>,
    api_url: &str,
    downloads_url: &str,
    board: &str,
    version: &str,
) -> Result<HaosRelease> {
    // stable.json supplies the version, and it becomes part of image names
    if parse_version(version).is_none() {
        return Err(Error::ServiceUnavailable(version_service_invalid()));
    }
    // Serialize misses so concurrent installations do not spend multiple API requests.
    let mut cache = cache.lock().await;
    // A release built before stable.json moved on may have a successor by now
    if cache
        .as_ref()
        .is_some_and(|release| release.hassos.get(board).map(String::as_str) != Some(version))
    {
        *cache = None;
    }
    let release = match &*cache {
        Some(release) => release.clone(),
        None => {
            let release = fetch_latest(api_url, downloads_url).await?;
            cache.insert(release).clone()
        }
    };
    drop(cache);
    release.for_board(board, version)
}

/// The latest release, once its checksums and build inputs are verified.
async fn fetch_latest(api_url: &str, downloads_url: &str) -> Result<FullRelease> {
    let release = request_github_release(api_url, "latest full images").await?;
    let tag = release.tag_name;
    // The tag becomes part of every URL below
    if revision(&tag).is_none() {
        return Err(Error::UnexpectedRelease(format!(
            "full images tagged {tag}"
        )));
    }
    let client = shared_client()?;
    let sums = sha256sums::verified(client, downloads_url, &tag).await?;
    let inputs = sha256sums::fetch(client, downloads_url, &tag, BUILD_INPUTS).await?;
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(&inputs)));
    if sums.get(BUILD_INPUTS) != Some(&digest) {
        return Err(Error::VerificationFailed(format!(
            "The {BUILD_INPUTS} of full images {tag} doesn't match its signed checksum"
        )));
    }
    let inputs: BuildInputs = serde_json::from_slice(&inputs).map_err(|error| {
        Error::UnexpectedRelease(format!("{BUILD_INPUTS} of full images {tag}: {error}"))
    })?;
    Ok(FullRelease {
        tag,
        hassos: inputs.hassos,
        assets: release.assets,
        sums,
    })
}

/// The revision image names carry, from a tag like `stable-<commit>`.
fn revision(tag: &str) -> Option<&str> {
    let commit = tag.strip_prefix(TAG_PREFIX)?;
    let valid = commit.len() == 40
        && commit
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    valid.then(|| &commit[..REVISION_DIGITS])
}

impl FullRelease {
    /// Its images of `board`, if they were built from HAOS `version`.
    fn for_board(&self, board: &str, version: &str) -> Result<HaosRelease> {
        match self.hassos.get(board) {
            Some(built) if built == version => {}
            Some(built) => {
                return Err(not_ready(
                    version,
                    &format!("full images {} have {board} {built}", self.tag),
                ))
            }
            None => {
                return Err(not_ready(
                    version,
                    &format!("full images {} have no {board}", self.tag),
                ))
            }
        }
        // `haos_<board>-<os>-full-core-<core>-stable-<revision>.<format>`
        let prefix = format!("haos_{board}-{version}-full-core-");
        let revision = revision(&self.tag).expect("the tag was checked when fetched");
        let suffix = format!("-stable-{revision}");
        let mut images = Vec::new();
        for asset in &self.assets {
            let Some((extension, format)) = [
                (".img.xz", ImageFormat::Raw),
                (".qcow2.xz", ImageFormat::Qcow2),
            ]
            .into_iter()
            .find(|(extension, _)| asset.name.ends_with(extension)) else {
                continue;
            };
            let core = asset
                .name
                .strip_prefix(&prefix)
                .and_then(|rest| rest.strip_suffix(extension))
                .and_then(|rest| rest.strip_suffix(&suffix));
            if !core.is_some_and(is_core_version) {
                continue;
            }
            // Exact match: a prefix check could be escaped with dot segments.
            let expected_url = format!("{DOWNLOADS}/{}/{}", self.tag, asset.name);
            if asset.browser_download_url != expected_url {
                return Err(Error::UnexpectedRelease(format!(
                    "download location for {}",
                    asset.name
                )));
            }
            // Without a signed digest, the download would be refused
            let Some(digest) = self.sums.get(&asset.name) else {
                continue;
            };
            images.push(HaosImage {
                board: board.to_string(),
                format,
                download_url: asset.browser_download_url.clone(),
                size: asset.size,
                digest: Some(digest.clone()),
            });
        }
        if images.is_empty() {
            return Err(not_ready(
                version,
                &format!("full images {} have no signed {board} image", self.tag),
            ));
        }
        Ok(HaosRelease {
            version: version.to_string(),
            images,
        })
    }
}

/// No full image of HAOS `version` for the board yet: the build after a
/// stable.json change takes a while, or failed. Asking again later can find it,
/// as the cached release is replaced then.
fn not_ready(version: &str, detail: &str) -> Error {
    eprintln!("No full image of Home Assistant OS {version}: {detail}");
    Error::ServiceUnavailable(crate::message!(
        "backend.download.full_images_not_ready",
        version = version,
    ))
}

/// A Home Assistant version like `2026.11.1`.
fn is_core_version(core: &str) -> bool {
    !core.is_empty() && core.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.')
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
    const INPUTS: &[u8] = include_bytes!(
        "../../testdata/stable-3a2161e70d5f79e84a03f0e1c15598a8e2d9df88/build-inputs.json"
    );
    const RPI5_IMAGE: &str = "haos_rpi5-64-18.5-full-core-2026.11.1-stable-3a2161e70d5f.img.xz";
    const OVA_IMAGE: &str = "haos_ova-18.4-full-core-2026.11.1-stable-3a2161e70d5f.qcow2.xz";

    fn asset(name: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "size": 954_000_000,
            "browser_download_url": format!("{DOWNLOADS}/{TAG}/{name}"),
        })
    }

    fn release_json(tag: &str, assets: Vec<serde_json::Value>) -> String {
        serde_json::json!({ "tag_name": tag, "assets": assets }).to_string()
    }

    /// A server with the signed files of the 3a2161e7 snapshot, its build
    /// inputs answering `inputs`.
    async fn files_server(inputs: &[u8]) -> mockito::ServerGuard {
        let mut server = mockito::Server::new_async().await;
        for (file, body) in [
            ("SHA256SUMS", SUMS),
            ("SHA256SUMS.sigstore.json", BUNDLE),
            (BUILD_INPUTS, inputs),
        ] {
            server
                .mock("GET", format!("/{TAG}/{file}").as_str())
                .with_body(body)
                .create_async()
                .await;
        }
        server
    }

    /// `files_server`, with the latest release answering `release`.
    async fn server(release: String, inputs: &[u8]) -> mockito::ServerGuard {
        let mut server = files_server(inputs).await;
        server
            .mock("GET", "/latest")
            .with_body(release)
            .create_async()
            .await;
        server
    }

    async fn lookup(
        server: &mockito::ServerGuard,
        board: &str,
        version: &str,
    ) -> Result<HaosRelease> {
        let cache = Mutex::new(None);
        let api = format!("{}/latest", server.url());
        release_for_board_from(&cache, &api, &server.url(), board, version).await
    }

    fn current_assets() -> Vec<serde_json::Value> {
        vec![
            asset(RPI5_IMAGE),
            asset(OVA_IMAGE),
            asset("haos_ova-18.4-full-core-2026.11.1-stable-3a2161e70d5f.img.xz"),
            asset("haos_ova-18.4-full-core-2026.11.1-stable-3a2161e70d5f.vmdk.zip"),
            asset(BUILD_INPUTS),
        ]
    }

    #[tokio::test]
    async fn a_board_on_the_version_it_was_built_from_gets_its_signed_full_images() {
        let server = server(release_json(TAG, current_assets()), INPUTS).await;

        let release = lookup(&server, "rpi5-64", "18.5").await.unwrap();

        assert_eq!(release.version, "18.5");
        let image = release.require_image("rpi5-64", ImageFormat::Raw).unwrap();
        assert_eq!(
            image.download_url,
            format!("{DOWNLOADS}/{TAG}/{RPI5_IMAGE}")
        );
        assert_eq!(image.size, 954_000_000);
        assert_eq!(
            image.digest.as_deref(),
            Some("sha256:5e2100a9c013aa31573969e23c7856843c7028ac28944a25e17302fdf769f02a")
        );
    }

    #[tokio::test]
    async fn a_vm_board_gets_raw_and_qcow2_but_no_other_format() {
        let server = server(release_json(TAG, current_assets()), INPUTS).await;

        let release = lookup(&server, "ova", "18.4").await.unwrap();

        let formats: Vec<_> = release.images.iter().map(|image| image.format).collect();
        assert_eq!(formats, [ImageFormat::Qcow2, ImageFormat::Raw]);
        assert!(release.images.iter().all(|image| image.board == "ova"));
    }

    #[tokio::test]
    async fn a_board_stable_json_has_moved_on_gets_none() {
        let server = server(release_json(TAG, current_assets()), INPUTS).await;

        let newer = lookup(&server, "rpi5-64", "18.6").await;
        let older = lookup(&server, "rpi5-64", "18.4").await;

        assert!(matches!(newer, Err(Error::ServiceUnavailable(_))));
        assert!(matches!(older, Err(Error::ServiceUnavailable(_))));
    }

    #[tokio::test]
    async fn a_board_without_images_in_the_release_gets_none() {
        let server = server(release_json(TAG, current_assets()), INPUTS).await;

        let unbuilt = lookup(&server, "tinker", "18.4").await;
        // Built from the right version, but no image was uploaded
        let unlisted = lookup(&server, "green", "18.4").await;

        assert!(matches!(unbuilt, Err(Error::ServiceUnavailable(_))));
        assert!(matches!(unlisted, Err(Error::ServiceUnavailable(_))));
    }

    #[tokio::test]
    async fn build_inputs_that_differ_from_the_signed_ones_are_refused() {
        let changed = String::from_utf8(INPUTS.to_vec())
            .unwrap()
            .replace(r#""rpi5-64": "18.5""#, r#""rpi5-64": "18.6""#);
        let server = server(release_json(TAG, current_assets()), changed.as_bytes()).await;

        let result = lookup(&server, "rpi5-64", "18.6").await;

        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    #[tokio::test]
    async fn an_image_downloaded_from_elsewhere_refuses_the_release() {
        let mut moved = asset(RPI5_IMAGE);
        moved["browser_download_url"] =
            format!("https://github.com/attacker/images/releases/download/{TAG}/{RPI5_IMAGE}")
                .into();
        let server = server(release_json(TAG, vec![moved]), INPUTS).await;

        let result = lookup(&server, "rpi5-64", "18.5").await;

        assert!(matches!(result, Err(Error::UnexpectedRelease(_))));
    }

    #[tokio::test]
    async fn an_image_of_another_revision_is_not_offered() {
        let other = "haos_rpi5-64-18.5-full-core-2026.11.1-stable-000000000000.img.xz";
        let server = server(release_json(TAG, vec![asset(other)]), INPUTS).await;

        let result = lookup(&server, "rpi5-64", "18.5").await;

        assert!(matches!(result, Err(Error::ServiceUnavailable(_))));
    }

    #[tokio::test]
    async fn a_release_that_is_no_stable_snapshot_is_refused() {
        for tag in [
            "beta-3a2161e70d5f79e84a03f0e1c15598a8e2d9df88",
            "stable-../../x",
            "stable-3a2161e7",
        ] {
            let server = server(release_json(tag, current_assets()), INPUTS).await;

            let result = lookup(&server, "rpi5-64", "18.5").await;

            assert!(matches!(result, Err(Error::UnexpectedRelease(_))), "{tag}");
        }
    }

    #[tokio::test]
    async fn the_release_is_asked_for_again_once_a_board_finds_it_outdated() {
        let mut server = files_server(INPUTS).await;
        let latest = server
            .mock("GET", "/latest")
            .with_body(release_json(TAG, current_assets()))
            .expect(2)
            .create_async()
            .await;
        let cache = Mutex::new(None);
        let (api, downloads) = (format!("{}/latest", server.url()), server.url());

        for version in ["18.5", "18.5"] {
            release_for_board_from(&cache, &api, &downloads, "rpi5-64", version)
                .await
                .unwrap();
        }
        let outdated = release_for_board_from(&cache, &api, &downloads, "rpi5-64", "18.6").await;

        assert!(outdated.is_err());
        latest.assert_async().await;
    }

    #[tokio::test]
    async fn a_version_that_is_no_plain_number_is_refused_before_any_request() {
        for version in ["", "18", "18.5/../x", "18.5-full"] {
            let cache = Mutex::new(None);

            let result = release_for_board_from(
                &cache,
                "http://127.0.0.1:0",
                "http://127.0.0.1:0",
                "rpi5-64",
                version,
            )
            .await;

            assert!(
                matches!(&result, Err(Error::ServiceUnavailable(message))
                    if message.key == "backend.download.version_service_invalid_response"),
                "{version}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_board_waiting_for_its_build_is_told_to_try_again() {
        let server = server(release_json(TAG, current_assets()), INPUTS).await;

        let result = lookup(&server, "rpi5-64", "18.6").await;

        assert!(
            matches!(&result, Err(Error::ServiceUnavailable(message))
                if message.key == "backend.download.full_images_not_ready"),
            "{result:?}"
        );
    }

    #[test]
    fn image_names_carry_the_first_digits_of_the_snapshot_commit() {
        assert_eq!(revision(TAG), Some("3a2161e70d5f"));
        assert_eq!(
            revision("stable-3A2161E70D5F79E84A03F0E1C15598A8E2D9DF88"),
            None
        );
        assert_eq!(revision("3a2161e70d5f79e84a03f0e1c15598a8e2d9df88"), None);
    }
}
