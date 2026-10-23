//! Proxmox VE integration
//!
//! This module provides functionality for creating Home Assistant VMs
//! on Proxmox VE servers via the Proxmox API.
//!
//! ## HAOS Installation Workflow
//!
//! The correct procedure for installing HAOS on Proxmox via API:
//! 1. Download the qcow2.xz image locally
//! 2. Extract to qcow2
//! 3. Select an active storage that supports the "import" content type
//! 4. Upload the qcow2 to that storage
//! 5. Wait for upload task to complete
//! 6. Create VM with UEFI/OVMF, EFI disk, and import-from to import the disk
//! 7. Wait for VM creation task to complete
//! 8. Resize the imported disk to the selected size and wait for completion
//! 9. Start VM and wait for IP via QEMU guest agent
//!
//! References:
//! - https://forum.proxmox.com/threads/api-equivalent-of-qm-importdisk.157457/
//! - https://forum.proxmox.com/threads/guide-install-home-assistant-os-in-a-vm.143251/

mod api;
pub mod tls;

use crate::error::{Error, Result};
use crate::types::{
    FlashProgress, FlashStage, HaosImage, HaosRelease, ImageFormat, ProxmoxBridge,
    ProxmoxCredentials, ProxmoxNode, ProxmoxSession, ProxmoxStorage, ProxmoxVmConfig,
    ProxmoxVmResult, VmStatusInfo,
};
use crate::{Backend, ProgressCallback, ProxmoxBackend, ReleaseSource};
use api::{send, send_change, task_upid, Api};
use std::collections::HashSet;

/// Minimum required Proxmox VE version for disk image import via API.
/// Version 8.4.1 added support for uploading qcow2/raw/img/vmdk files with content=import.
const MIN_PROXMOX_VERSION: (u32, u32, u32) = (8, 4, 1);

/// Minimum size of the HAOS OVA disk, matching the configure view.
const MIN_DISK_SIZE_GB: u32 = 32;

fn validate_disk_size(disk_size_gb: u32) -> Result<()> {
    if disk_size_gb < MIN_DISK_SIZE_GB {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.disk_too_small",
            size = MIN_DISK_SIZE_GB,
        )));
    }
    Ok(())
}

/// Proxmox's `dns-name` format for VM names: dot-separated labels of ASCII
/// letters, digits and dashes, each starting and ending with a letter or digit.
/// Proxmox only checks it when the VM is created, after the download.
fn validate_vm_name(name: &str) -> Result<()> {
    let valid = name.split('.').all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    if !valid {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.invalid_vm_name"
        )));
    }
    Ok(())
}

/// How often to send progress updates (every N bytes)
const PROGRESS_UPDATE_INTERVAL: u64 = 10 * 1024 * 1024; // 10 MB

fn request_error(error: reqwest::Error, context: &str) -> Error {
    tls::certificate_error(&error)
        .unwrap_or_else(|| Error::ProxmoxApi(format!("{}: {}", context, error)))
}

/// Parse a Proxmox version string like "8.4.1" into (major, minor, patch).
fn parse_version(version_str: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = version_str.split('.').collect();
    if parts.len() >= 2 {
        let major = parts[0].parse().ok()?;
        let minor = parts[1].parse().ok()?;
        let patch = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
        Some((major, minor, patch))
    } else {
        None
    }
}

/// Check if version meets minimum requirements.
fn version_meets_minimum(version: (u32, u32, u32), minimum: (u32, u32, u32)) -> bool {
    version.0 > minimum.0
        || (version.0 == minimum.0 && version.1 > minimum.1)
        || (version.0 == minimum.0 && version.1 == minimum.1 && version.2 >= minimum.2)
}

fn needs_second_factor(data: &serde_json::Value) -> bool {
    let flagged = data.get("NeedTFA").is_some_and(|value| {
        !matches!(
            value,
            serde_json::Value::Null | serde_json::Value::Bool(false)
        ) && value != &serde_json::json!(0)
    });
    flagged
        || data["ticket"]
            .as_str()
            .is_some_and(|ticket| ticket.starts_with("PVE:!"))
}

async fn complete_second_factor(
    client: &reqwest::Client,
    auth_url: &str,
    credentials: &ProxmoxCredentials,
    data: serde_json::Value,
) -> Result<serde_json::Value> {
    if !needs_second_factor(&data) {
        return Ok(data);
    }

    // PVE embeds URL-encoded JSON in the signed ticket, as used by its web UI.
    let ticket = data["ticket"].as_str().unwrap_or_default();
    let challenge = ticket
        .strip_prefix("PVE:!tfa!")
        .and_then(|rest| rest.split(':').next())
        .and_then(|encoded| urlencoding::decode(encoded).ok())
        .and_then(|decoded| serde_json::from_str::<serde_json::Value>(&decoded).ok());
    if challenge.as_ref().and_then(|value| value["totp"].as_bool()) != Some(true) {
        return Err(Error::ProxmoxTwoFactor(crate::message!(
            "backend.proxmox.two_factor_totp_unavailable"
        )));
    }

    let code = credentials.totp.as_deref().unwrap_or_default().trim();
    if code.is_empty() {
        return Err(Error::ProxmoxTwoFactor(crate::message!(
            "backend.proxmox.two_factor_code_required"
        )));
    }
    if !(2..=16).contains(&code.len()) || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Error::ProxmoxTwoFactor(crate::message!(
            "backend.proxmox.two_factor_code_invalid"
        )));
    }

    let password = format!("totp:{code}");
    let response = client
        .post(auth_url)
        .form(&[
            ("username", credentials.username.as_str()),
            ("password", password.as_str()),
            ("tfa-challenge", ticket),
        ])
        .send()
        .await
        .map_err(|error| {
            tls::certificate_error(&error).unwrap_or_else(|| {
                Error::ProxmoxTwoFactor(crate::message!(
                    "backend.proxmox.two_factor_request_failed"
                ))
            })
        })?;
    if !response.status().is_success() {
        if response.status().as_u16() != 401 {
            return Err(Error::ProxmoxTwoFactor(crate::message!(
                "backend.proxmox.two_factor_http_error",
                status = response.status().as_u16(),
            )));
        }
        return Err(Error::ProxmoxTwoFactor(crate::message!(
            "backend.proxmox.two_factor_rejected"
        )));
    }

    let response: serde_json::Value = response.json().await.map_err(|_| {
        Error::ProxmoxTwoFactor(crate::message!(
            "backend.proxmox.two_factor_invalid_response"
        ))
    })?;
    let data = response.get("data").ok_or_else(|| {
        Error::ProxmoxTwoFactor(crate::message!(
            "backend.proxmox.two_factor_missing_response"
        ))
    })?;
    if needs_second_factor(data) {
        return Err(Error::ProxmoxTwoFactor(crate::message!(
            "backend.proxmox.two_factor_incomplete"
        )));
    }
    Ok(data.clone())
}

/// Authenticate with a Proxmox server and verify version requirements.
///
/// This function also verifies the Proxmox version is at least 8.4.1,
/// which is required for disk image import via the API.
async fn authenticate(credentials: &ProxmoxCredentials) -> Result<ProxmoxSession> {
    let base_url = credentials.server_url.trim_end_matches('/');
    let client = tls::client(
        &credentials.server_url,
        credentials.certificate_sha256.as_deref(),
        30,
    )?;

    // Step 1: Authenticate
    let auth_url = format!("{}/api2/json/access/ticket", base_url);

    let response = client
        .post(&auth_url)
        .form(&[
            ("username", credentials.username.as_str()),
            ("password", credentials.password.as_str()),
            ("new-format", "1"),
        ])
        .send()
        .await
        .map_err(|e| {
            if let Some(error) = tls::certificate_error(&e) {
                error
            } else if e.is_timeout() {
                Error::ProxmoxActionRequired(crate::message!(
                    "backend.proxmox.connection_timed_out"
                ))
            } else if e.is_connect() {
                Error::ProxmoxActionRequired(crate::message!("backend.proxmox.connection_failed"))
            } else {
                Error::ProxmoxApi(format!("Connection error: {}", e))
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err(Error::ProxmoxActionRequired(crate::message!(
                "backend.proxmox.authentication_failed"
            )));
        } else if status.as_u16() == 403 {
            return Err(Error::ProxmoxActionRequired(crate::message!(
                "backend.proxmox.access_denied"
            )));
        }
        return Err(Error::ProxmoxApi(format!(
            "Server returned error: {}",
            status
        )));
    }

    // Parse the authentication response
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse server response: {}", e)))?;

    let data = json.get("data").ok_or_else(|| {
        Error::ProxmoxApi("Invalid response from server: missing 'data' field".to_string())
    })?;
    let data = complete_second_factor(&client, &auth_url, credentials, data.clone()).await?;

    let ticket = data
        .get("ticket")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            Error::ProxmoxApi("Invalid response from server: missing 'ticket' field".to_string())
        })?
        .to_string();

    let csrf_token = data
        .get("CSRFPreventionToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            Error::ProxmoxApi(
                "Invalid response from server: missing 'CSRFPreventionToken' field".to_string(),
            )
        })?
        .to_string();

    // Step 2: Check Proxmox version
    let version_url = format!("{}/api2/json/version", base_url);

    let version_response = client
        .get(&version_url)
        .header("Cookie", format!("PVEAuthCookie={}", ticket))
        .send()
        .await
        .map_err(|e| request_error(e, "Failed to get Proxmox version"))?;

    if !version_response.status().is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to get Proxmox version: {}",
            version_response.status()
        )));
    }

    let version_json: serde_json::Value = version_response
        .json()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse version response: {}", e)))?;

    let version_str = version_json
        .get("data")
        .and_then(|d| d.get("version"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            Error::ProxmoxApi("Failed to get Proxmox version from response".to_string())
        })?;

    let version = parse_version(version_str).ok_or_else(|| {
        Error::ProxmoxApi(format!("Failed to parse Proxmox version: {}", version_str))
    })?;

    if !version_meets_minimum(version, MIN_PROXMOX_VERSION) {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.unsupported_version",
            version = format!("{}.{}.{}", version.0, version.1, version.2),
            minimum = format!(
                "{}.{}.{}",
                MIN_PROXMOX_VERSION.0, MIN_PROXMOX_VERSION.1, MIN_PROXMOX_VERSION.2
            ),
        )));
    }

    Ok(ProxmoxSession {
        server_url: credentials.server_url.clone(),
        ticket,
        csrf_token,
        certificate_sha256: credentials.certificate_sha256.clone(),
    })
}

/// List available nodes on the Proxmox cluster
async fn list_nodes(session: &ProxmoxSession) -> Result<Vec<ProxmoxNode>> {
    let api = Api::new(session, 30)?;
    let response = api.get(&api.url("/nodes")).send().await.map_err(|e| {
        if let Some(error) = tls::certificate_error(&e) {
            error
        } else if e.is_timeout() {
            Error::ProxmoxActionRequired(crate::message!("backend.proxmox.list_nodes_timed_out"))
        } else if e.is_connect() {
            Error::ProxmoxActionRequired(crate::message!("backend.proxmox.unreachable"))
        } else {
            Error::ProxmoxApi(format!("Network error while listing nodes: {}", e))
        }
    })?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err(Error::ProxmoxSessionExpired);
        } else if status.as_u16() == 403 {
            return Err(Error::ProxmoxActionRequired(crate::message!(
                "backend.proxmox.list_nodes_denied"
            )));
        }
        return Err(Error::ProxmoxApi(format!(
            "Proxmox server returned error: {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        )));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse Proxmox response: {}", e)))?;

    let data = json.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
        Error::ProxmoxApi("Unexpected response from Proxmox: missing node data".to_string())
    })?;

    let nodes: Vec<ProxmoxNode> = data
        .iter()
        .filter_map(|node| {
            Some(ProxmoxNode {
                name: node.get("node")?.as_str()?.to_string(),
                status: node
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                cpu_usage: node.get("cpu").and_then(|v| v.as_f64()),
                cpu_count: node
                    .get("maxcpu")
                    .and_then(|v| v.as_u64())
                    .and_then(|v| u32::try_from(v).ok()),
            })
        })
        .collect();

    Ok(nodes)
}

/// Proxmox's pve-bridge-id format, restricted to ASCII identifiers.
fn valid_bridge_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && name != "."
        && name != ".."
}

fn valid_sdn_zone(zone: &str) -> bool {
    (2..=8).contains(&zone.len())
        && zone.as_bytes()[0].is_ascii_alphabetic()
        && zone.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn api_flag(value: Option<&serde_json::Value>) -> bool {
    matches!(value, Some(serde_json::Value::Bool(true)))
        || value.and_then(serde_json::Value::as_u64) == Some(1)
        || value.and_then(serde_json::Value::as_str) == Some("1")
}

/// `any_bridge` includes Linux/OVS bridges and access-filtered, node-local running SDN VNets.
async fn list_bridges(session: &ProxmoxSession, node: &str) -> Result<Vec<ProxmoxBridge>> {
    let api = Api::new(session, 30)?;
    let json = api
        .get_json(
            &api.node_url(node, "/network?type=any_bridge"),
            "Failed to list network bridges",
            "Failed to parse network bridges",
            None,
        )
        .await?;
    let data = json.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
        Error::ProxmoxApi("Invalid network response: missing 'data' array".to_string())
    })?;
    let mut bridges = Vec::new();
    for item in data {
        let network_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(network_type, "bridge" | "OVSBridge" | "vnet") {
            continue;
        }
        let name = item
            .get("iface")
            .and_then(|v| v.as_str())
            .filter(|name| valid_bridge_name(name))
            .ok_or_else(|| {
                Error::ProxmoxApi(
                    "Invalid network bridge identifier returned by Proxmox".to_string(),
                )
            })?;
        bridges.push(ProxmoxBridge {
            name: name.to_string(),
            network_type: network_type.to_string(),
            vlan_aware: network_type == "OVSBridge"
                || api_flag(item.get(if network_type == "vnet" {
                    "vlanaware"
                } else {
                    "bridge_vlan_aware"
                })),
            comments: item
                .get("comments")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        });
    }
    bridges.sort_by(|a, b| a.name.cmp(&b.name));
    bridges.dedup_by(|a, b| a.name == b.name);
    Ok(bridges)
}

async fn ensure_bridge_available(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
) -> Result<ProxmoxBridge> {
    if config
        .vlan_tag
        .is_some_and(|tag| !(1..=4094).contains(&tag))
    {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.vlan_tag_out_of_range"
        )));
    }
    list_bridges(session, &config.node)
        .await?
        .into_iter()
        .find(|bridge| bridge.name == config.bridge)
        .ok_or_else(|| {
            Error::ProxmoxActionRequired(crate::message!(
                "backend.proxmox.bridge_unavailable",
                bridge = config.bridge,
                node = config.node,
            ))
        })
}

/// List available storage on a node
async fn list_storage(session: &ProxmoxSession, node: &str) -> Result<Vec<ProxmoxStorage>> {
    let api = Api::new(session, 30)?;
    let json = api
        .get_json(
            &api.node_url(node, "/storage"),
            "Failed to list storage",
            "Failed to parse storage list",
            None,
        )
        .await?;

    let data = json
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| Error::ProxmoxApi("Invalid response: missing 'data' array".to_string()))?;

    let storage: Vec<ProxmoxStorage> = data
        .iter()
        .filter_map(|s| {
            // Parse content types from comma-separated string
            let content_str = s.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let content: Vec<String> = content_str
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            Some(ProxmoxStorage {
                name: s.get("storage")?.as_str()?.to_string(),
                storage_type: s
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                content,
                available: s.get("avail").and_then(|v| v.as_u64()).unwrap_or(0),
                active: s.get("active").and_then(|v| v.as_u64()).unwrap_or(0) == 1,
            })
        })
        .collect();

    Ok(storage)
}

/// Explicitly enable import on the selected directory storage. Never called during installation.
async fn enable_storage_import(
    session: &ProxmoxSession,
    node: &str,
    storage: &str,
) -> Result<bool> {
    #[derive(serde::Deserialize)]
    struct StorageConfig {
        #[serde(rename = "type")]
        storage_type: String,
        content: String,
        digest: String,
    }

    let api = Api::new(session, 30)?;
    let url = api.url(&format!("/storage/{}", urlencoding::encode(storage)));
    let json = api
        .get_json(
            &url,
            "Failed to read storage configuration",
            "Failed to parse storage configuration",
            // PVE only shows a storage's configuration to users who may also change it.
            Some(Error::ProxmoxActionRequired(crate::message!(
                "backend.proxmox.missing_datastore_allocate",
                storage = storage,
            ))),
        )
        .await?;
    let config: StorageConfig = serde_json::from_value(json["data"].clone())
        .map_err(|e| Error::ProxmoxApi(format!("Invalid storage configuration: {}", e)))?;
    if config.digest.len() != 40 || !config.digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::ProxmoxApi(
            "Invalid storage configuration digest".to_string(),
        ));
    }
    if config.content.split(',').any(|part| part.trim().is_empty()) {
        return Err(Error::ProxmoxApi(
            "Invalid storage configuration content".to_string(),
        ));
    }

    // Read availability after the configuration. A later configuration change is
    // rejected atomically by PVE's digest check when processing the PUT.
    let available = list_storage(session, node).await?;
    if config.storage_type != "dir"
        || !available
            .iter()
            .any(|entry| entry.name == storage && entry.active && entry.storage_type == "dir")
    {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.storage_not_directory",
            storage = storage,
            node = node,
        )));
    }
    if config
        .content
        .split(',')
        .any(|part| part.trim() == "import")
    {
        return Ok(false);
    }

    ensure_privileges(
        &fetch_privileges(session, "/storage").await?,
        "/storage",
        &["Datastore.Allocate"],
    )?;

    // Update only content; paths, node restrictions, and all other options stay intact.
    // PVE encodes an empty content set as "none", which cannot be combined with import.
    let content = if config.content == "none" {
        "import".to_string()
    } else {
        format!("{},import", config.content)
    };
    let response = send(
        api.put(&url)
            .form(&[("content", content), ("digest", config.digest)]),
        "Failed to enable storage import",
    )
    .await?;
    if !response.status().is_success() {
        // A changed digest or revoked permission both land here; the response
        // body is the server's, so the guidance stays installer-authored.
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.import_not_enabled",
            storage = storage,
        )));
    }

    // This synchronous endpoint writes configuration before returning success.
    // Its unused response body must not erase attribution of an accepted change.
    Ok(true)
}

/// Pick the first active storage that accepts `import` content and has room for the upload.
fn select_import_storage(storage_list: &[ProxmoxStorage], required_bytes: u64) -> Result<String> {
    let mut too_small = Vec::new();

    for storage in storage_list {
        if is_import_candidate(storage) {
            if storage.available >= required_bytes {
                return Ok(storage.name.clone());
            }
            too_small.push(storage.name.as_str());
        }
    }

    if !too_small.is_empty() {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.import_storage_too_small",
            size_mb = required_bytes / 1_000_000,
            storages = too_small.join(", "),
        )));
    }

    Err(Error::ProxmoxActionRequired(crate::message!(
        "backend.proxmox.no_import_storage"
    )))
}

/// Whether the image could be uploaded to this storage, ignoring free space and permissions.
fn is_import_candidate(storage: &ProxmoxStorage) -> bool {
    // ESXi advertises `import` but is a source-only backend with no path, so uploads to it fail.
    storage.active
        && storage.storage_type != "esxi"
        && storage.content.iter().any(|content| content == "import")
}

/// Keep only the import storages the logged-in user is allowed to upload to and import from.
async fn uploadable_import_storages(
    session: &ProxmoxSession,
    storage_list: &[ProxmoxStorage],
) -> Result<Vec<ProxmoxStorage>> {
    let mut allowed = Vec::new();
    let mut denied = Vec::new();

    for storage in storage_list.iter().filter(|s| is_import_candidate(s)) {
        let path = format!("/storage/{}", storage.name);
        let privileges = fetch_privileges(session, &path).await?;
        let can_upload = privileges.contains("Datastore.AllocateTemplate");
        // VM creation reads the uploaded image, which needs one of these (Storage.pm check_volume_access).
        let can_read = [
            "Datastore.Allocate",
            "Datastore.AllocateSpace",
            "Datastore.Audit",
        ]
        .iter()
        .any(|privilege| privileges.contains(*privilege));

        if can_upload && can_read {
            allowed.push(storage.clone());
        } else {
            denied.push(storage.name.as_str());
        }
    }

    if allowed.is_empty() && !denied.is_empty() {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.import_storage_denied",
            storages = denied.join(", "),
        )));
    }

    Ok(allowed)
}

/// Fail early if the storage chosen for the VM disk is missing, inactive, can't hold disks,
/// or doesn't have room for the disk.
fn check_disk_storage(
    storage_list: &[ProxmoxStorage],
    disk_storage: &str,
    disk_size_gb: u32,
) -> Result<()> {
    let storage = storage_list
        .iter()
        .find(|storage| storage.name == disk_storage)
        .ok_or_else(|| {
            Error::ProxmoxActionRequired(crate::message!(
                "backend.proxmox.storage_not_found",
                storage = disk_storage,
            ))
        })?;

    if !storage.active {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.storage_inactive",
            storage = disk_storage,
        )));
    }

    if !storage.content.iter().any(|content| content == "images") {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.storage_no_disk_images",
            storage = disk_storage,
        )));
    }

    // Proxmox disk sizes like "32G" are GiB.
    let required_bytes = u64::from(disk_size_gb) * 1024 * 1024 * 1024;
    if storage.available < required_bytes {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.storage_too_small",
            storage = disk_storage,
            size_gb = disk_size_gb,
            free_gb = storage.available / (1024 * 1024 * 1024),
        )));
    }

    Ok(())
}

/// Fail early if `vm_id` is already taken anywhere in the cluster.
async fn ensure_vm_id_free(session: &ProxmoxSession, vm_id: u32) -> Result<()> {
    let response = send_nextid_request(session, Some(vm_id)).await?;

    // Also runs right before the upload, after a download that can outlast the
    // ticket: an expired one is already an error by now
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    if status != reqwest::StatusCode::BAD_REQUEST {
        return Err(Error::ProxmoxApi(format!(
            "Failed to check VM ID: {}",
            status
        )));
    }

    // Keep the corrective action without exposing arbitrary server response data.
    Err(Error::ProxmoxActionRequired(crate::message!(
        "backend.proxmox.vm_id_unavailable",
        vm_id = vm_id,
    )))
}

/// Call `/cluster/nextid`; with `vm_id` set, Proxmox checks that ID cluster-wide instead of picking one.
/// An expired session is an error; every other status is the caller's to judge.
async fn send_nextid_request(
    session: &ProxmoxSession,
    vm_id: Option<u32>,
) -> Result<reqwest::Response> {
    let api = Api::new(session, 30)?;
    let mut url = api.url("/cluster/nextid");
    if let Some(vm_id) = vm_id {
        url.push_str(&format!("?vmid={}", vm_id));
    }

    send(api.get(&url), "Failed to query VM ID").await
}

/// Fail early if the node is missing from the cluster or not online.
fn check_node_online(nodes: &[ProxmoxNode], node: &str) -> Result<()> {
    let found = nodes.iter().find(|n| n.name == node).ok_or_else(|| {
        Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.node_not_found",
            node = node
        ))
    })?;

    if found.status != "online" {
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.node_offline",
            node = node,
        )));
    }

    Ok(())
}

/// Proxmox creates a VM with more cores than its node has, but then refuses
/// to start it, after the download and the import.
fn check_node_cores(nodes: &[ProxmoxNode], node: &str, cores: u32) -> Result<()> {
    let cpus = nodes
        .iter()
        .find(|n| n.name == node)
        .and_then(|n| n.cpu_count);
    match cpus {
        Some(cpus) if cores > cpus => Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.too_many_cores",
            node = node,
            cpus = cpus,
        ))),
        _ => Ok(()),
    }
}

/// Privileges Proxmox checks on `/vms/{id}` to create the VM as `create_vm_with_disk` does and start it.
const VM_CREATE_PRIVILEGES: &[&str] = &[
    "VM.Allocate",
    "VM.Config.CPU",
    "VM.Config.Memory",
    "VM.Config.Options",
    "VM.Config.HWType",
    "VM.Config.Network",
    "VM.Config.Disk",
    "VM.PowerMgmt",
];

/// Privileges the logged-in user has on `path`, including inherited ones.
async fn fetch_privileges(session: &ProxmoxSession, path: &str) -> Result<HashSet<String>> {
    let api = Api::new(session, 30)?;
    let url = api.url(&format!(
        "/access/permissions?path={}",
        urlencoding::encode(path)
    ));
    let json = api
        .get_json(
            &url,
            "Failed to check permissions",
            "Failed to parse permissions",
            None,
        )
        .await?;

    Ok(json
        .get("data")
        .and_then(|data| data.get(path))
        .and_then(|privileges| privileges.as_object())
        .map(|privileges| privileges.keys().cloned().collect())
        .unwrap_or_default())
}

/// Fail with the list of missing privileges if `granted` lacks any of `required`.
fn ensure_privileges(granted: &HashSet<String>, path: &str, required: &[&str]) -> Result<()> {
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|privilege| !granted.contains(*privilege))
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    Err(Error::ProxmoxActionRequired(crate::message!(
        "backend.proxmox.missing_privileges",
        privileges = missing.join(", "),
        path = path,
    )))
}

/// Fail early if the logged-in user isn't allowed to create, configure, and start this VM.
async fn ensure_user_can_create_vm(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
) -> Result<()> {
    let vm_path = format!("/vms/{}", config.vm_id);
    ensure_privileges(
        &fetch_privileges(session, &vm_path).await?,
        &vm_path,
        VM_CREATE_PRIVILEGES,
    )?;

    ensure_bridge_access(session, config).await
}

async fn ensure_bridge_access(session: &ProxmoxSession, config: &ProxmoxVmConfig) -> Result<()> {
    let bridge = ensure_bridge_available(session, config).await?;
    if config.vlan_tag.is_some() && !bridge.vlan_aware {
        // Installer-authored guidance, shown as is instead of a generic API error
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.bridge_not_vlan_aware",
            bridge = bridge.name,
        )));
    }
    let zone = if bridge.network_type == "vnet" {
        // GuestHelpers::check_vnet_access checks the edited config, even when
        // a zone move has not been applied. Do not request running=1 here.
        let api = Api::new(session, 30)?;
        let url = api.url(&format!(
            "/cluster/sdn/vnets/{}",
            urlencoding::encode(&bridge.name)
        ));
        let json = api
            .get_json(
                &url,
                "Failed to check SDN VNet configuration",
                "Failed to parse SDN VNet configuration",
                Some(Error::ProxmoxActionRequired(crate::message!(
                    "backend.proxmox.missing_sdn_audit",
                    vnet = bridge.name,
                ))),
            )
            .await?;
        json.get("data")
            .and_then(|v| v.get("zone"))
            .and_then(|v| v.as_str())
            .filter(|zone| valid_sdn_zone(zone))
            .ok_or_else(|| {
                Error::ProxmoxApi("Missing or invalid SDN zone for the selected VNet".to_string())
            })?
            .to_string()
    } else {
        "localnetwork".to_string()
    };
    let mut bridge_path = format!("/sdn/zones/{}/{}", zone, bridge.name);
    if let Some(tag) = config.vlan_tag {
        bridge_path.push_str(&format!("/{tag}"));
    }
    ensure_privileges(
        &fetch_privileges(session, &bridge_path).await?,
        &bridge_path,
        &["SDN.Use"],
    )
}

/// Estimate the extracted qcow2 size from the `.xz` download size, which is all we know up front.
fn estimated_extracted_size(compressed_bytes: u64) -> u64 {
    // Measured 2026-10: HAOS 18.3 1.90x, 17.3 1.98x, 16.3 2.73x. 2.75x covers all of them so the
    // storage isn't left completely full; the exact size is rechecked after extraction.
    compressed_bytes.saturating_mul(11) / 4 // 2.75x
}

/// Everything that can be checked before the download starts.
async fn pre_install_checks(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    download_bytes: u64,
) -> Result<()> {
    let nodes = list_nodes(session).await?;
    check_node_online(&nodes, &config.node)?;
    check_node_cores(&nodes, &config.node, config.cpu_cores)?;

    ensure_user_can_create_vm(session, config).await?;

    // Fetch storage once and run every storage check against it.
    let storage_list = list_storage(session, &config.node).await?;

    check_disk_storage(&storage_list, &config.storage, config.disk_size_gb)?;
    let disk_path = format!("/storage/{}", config.storage);
    ensure_privileges(
        &fetch_privileges(session, &disk_path).await?,
        &disk_path,
        &["Datastore.AllocateSpace"],
    )?;

    let upload_candidates = uploadable_import_storages(session, &storage_list).await?;
    select_import_storage(&upload_candidates, estimated_extracted_size(download_bytes))?;

    ensure_vm_id_free(session, config.vm_id).await?;

    Ok(())
}

/// Everything an install checks before it downloads, and the OVA image it would download.
async fn check_install<B: ReleaseSource>(
    backend: &B,
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
) -> Result<HaosImage> {
    validate_disk_size(config.disk_size_gb)?;
    validate_vm_name(&config.name)?;

    let release: HaosRelease = backend.get_latest_haos_release_for_board("ova").await?;
    let image = release
        .image_for("ova", ImageFormat::Qcow2)
        .cloned()
        .ok_or_else(|| {
            Error::DownloadFailed(format!("No OVA image in HAOS release {}", release.version))
        })?;

    pre_install_checks(session, config, image.size).await?;
    Ok(image)
}

/// Repeat the checks that may have changed during the download, now the exact upload size is known.
async fn recheck_before_upload(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    extracted_path: &std::path::Path,
) -> Result<String> {
    ensure_vm_id_free(session, config.vm_id).await?;

    // This can be removed if Proxmox reports the size error correctly, otherwise it may only
    // fail at the 30 minute timeout.
    let extracted_size = tokio::fs::metadata(extracted_path).await?.len();
    let storage_list = list_storage(session, &config.node).await?;
    let upload_candidates = uploadable_import_storages(session, &storage_list).await?;
    select_import_storage(&upload_candidates, extracted_size)
}

/// Get the next available VM ID on the Proxmox server.
async fn get_next_vm_id(session: &ProxmoxSession) -> Result<u32> {
    let response = send_nextid_request(session, None).await?;

    if !response.status().is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to get next VM ID: {}",
            response.status()
        )));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse VM ID response: {}", e)))?;

    let data = json
        .get("data")
        .ok_or_else(|| Error::ProxmoxApi("Invalid response: missing 'data' field".to_string()))?;

    // Proxmox returns the VM ID as a string (e.g., "100"), not a number
    let vm_id = if let Some(n) = data.as_u64() {
        n as u32
    } else if let Some(s) = data.as_str() {
        s.parse::<u32>()
            .map_err(|_| Error::ProxmoxApi(format!("Invalid VM ID format: {}", s)))?
    } else {
        return Err(Error::ProxmoxApi(format!(
            "Unexpected VM ID type: {:?}",
            data
        )));
    };

    Ok(vm_id)
}

/// The node a task runs on, from its UPID (`UPID:<node>:<pid>:...`).
///
/// A task's status can only be read on the node that ran it. In a cluster
/// that isn't always the node the request was sent to, so the UPID is the
/// one place to trust.
fn task_node(upid: &str) -> Option<&str> {
    upid.strip_prefix("UPID:")?
        .split(':')
        .next()
        .filter(|node| !node.is_empty())
}

/// How long to wait between two task status checks. Tests poll mock
/// servers, which answer right away.
const TASK_POLL_INTERVAL: std::time::Duration = if cfg!(test) {
    std::time::Duration::from_millis(10)
} else {
    std::time::Duration::from_secs(2)
};

/// Failed task status checks in a row before giving up on a task.
const MAX_TASK_POLL_FAILURES: u32 = 3;

/// One task status check.
enum TaskPoll {
    Status(serde_json::Value),
    /// A failure that asking again can fix
    Retry(Error),
}

/// Check a task's status once. The body is read in here too: headers can
/// arrive and the connection still drop before the body does, which is the
/// same hiccup as a failed request.
async fn poll_task_status(api: &Api<'_>, url: &str) -> Result<TaskPoll> {
    let response = match api.get(url).send().await {
        Ok(response) => response,
        Err(error) => {
            return match request_error(error, "Failed to check task status") {
                // A changed certificate doesn't change back by asking again.
                Error::ProxmoxCertificateChanged => Err(Error::ProxmoxCertificateChanged),
                error => Ok(TaskPoll::Retry(error)),
            };
        }
    };

    let status = response.status();
    // A busy API (5xx) may answer next time, a rejection won't change.
    let retryable = status.is_success() || status.is_server_error();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) if retryable => {
            return Ok(TaskPoll::Retry(request_error(
                error,
                "Failed to read task status",
            )));
        }
        // Still a rejection when its explanation got lost on the way
        Err(_) => String::new(),
    };

    // The ticket ran out during a long wait. Asking again won't help, logging
    // in again does.
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::ProxmoxSessionExpired);
    }

    if !status.is_success() {
        // Proxmox explains a 400 in the body ("no such task", a parameter
        // that failed verification); the status line alone hides it.
        let error = Error::ProxmoxApi(format!(
            "Failed to check task status ({}): {}",
            status,
            body.trim()
        ));
        return if retryable {
            Ok(TaskPoll::Retry(error))
        } else {
            Err(error)
        };
    }

    serde_json::from_str(&body)
        .map(TaskPoll::Status)
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse task status: {}", e)))
}

/// Wait for a Proxmox task to complete.
async fn wait_for_task(
    session: &ProxmoxSession,
    node: &str,
    upid: &str,
    timeout_secs: u64,
) -> Result<()> {
    wait_for_task_completion(session, node, upid, timeout_secs, &mut false).await
}

async fn wait_for_task_completion(
    session: &ProxmoxSession,
    node: &str,
    upid: &str,
    timeout_secs: u64,
    stopped: &mut bool,
) -> Result<()> {
    let api = Api::new(session, 30)?;
    let url = api.node_url(
        task_node(upid).unwrap_or(node),
        &format!("/tasks/{}/status", urlencoding::encode(upid)),
    );

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);
    let mut failed_polls = 0;

    loop {
        if start.elapsed() > timeout {
            return Err(Error::ProxmoxApi(format!(
                "Task timed out after {} seconds",
                timeout_secs
            )));
        }

        // The task keeps running on Proxmox whatever happens to one status
        // check. Giving up on a single network hiccup or a busy API (5xx)
        // leaves a VM behind that is never resized or started.
        let json = match poll_task_status(&api, &url).await? {
            TaskPoll::Status(json) => json,
            TaskPoll::Retry(error) => {
                failed_polls += 1;
                if failed_polls >= MAX_TASK_POLL_FAILURES {
                    return Err(error);
                }

                eprintln!(
                    "Task status check {failed_polls} of {MAX_TASK_POLL_FAILURES} failed, trying again: {error}"
                );
                tokio::time::sleep(TASK_POLL_INTERVAL).await;
                continue;
            }
        };
        failed_polls = 0;

        let data = json
            .get("data")
            .ok_or_else(|| Error::ProxmoxApi("Invalid task status response".to_string()))?;

        let status = data.get("status").and_then(|v| v.as_str()).unwrap_or("");

        if status == "stopped" {
            *stopped = true;
            // Task is complete, check if it succeeded
            let exitstatus = data
                .get("exitstatus")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if exitstatus == "OK" {
                return Ok(());
            }

            // Proxmox ends a task that logged warnings with "WARNINGS: <count>"
            // and shows it as succeeded, so the work is done.
            if exitstatus.starts_with("WARNINGS: ") {
                eprintln!("Proxmox task {upid} finished with {exitstatus}");
                return Ok(());
            }

            return Err(Error::ProxmoxApi(format!(
                "Task failed with status: {}",
                exitstatus
            )));
        }

        // Task still running, wait a bit before checking again
        tokio::time::sleep(TASK_POLL_INTERVAL).await;
    }
}

/// Upload a disk image to Proxmox storage with progress reporting.
///
/// Uploads to `storage_name` with content type "import".
async fn upload_image_to_proxmox<P: ProgressCallback>(
    session: &ProxmoxSession,
    node: &str,
    local_path: &std::path::PathBuf,
    progress_callback: &P,
    storage_name: &str,
) -> Result<String> {
    use futures_util::TryStreamExt;
    use tokio::fs::File;
    use tokio::io::AsyncReadExt;
    use tokio::sync::watch;
    use tokio_util::io::ReaderStream;

    // Get the filename from the path
    let filename = local_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::ProxmoxApi("Invalid file path".to_string()))?
        .to_string();

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Uploading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: format!("Preparing {} for upload...", filename),
    });

    let file = File::open(local_path)
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to open image file: {}", e)))?;

    let file_size = file
        .metadata()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to get file metadata: {}", e)))?
        .len();

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Uploading,
        progress: 5,
        bytes_processed: 0,
        total_bytes: file_size,
        message: format!(
            "Uploading {} ({:.1} MB) to Proxmox...",
            filename,
            file_size as f64 / 1_000_000.0
        ),
    });

    // Upload to Proxmox using multipart form
    let api = Api::new(session, upload_timeout(file_size))?;
    let url = api.node_url(
        node,
        &format!("/storage/{}/upload", urlencoding::encode(storage_name)),
    );

    // The body owns the file; a watch channel keeps progress bounded while the
    // caller retains its borrowed callback. Reads follow HTTP backpressure.
    let (progress_tx, mut progress_rx) = watch::channel(0_u64);
    let mut bytes_sent = 0;
    let mut last_progress_bytes = 0;
    let progress_stream =
        ReaderStream::with_capacity(file.take(file_size), 256 * 1024).inspect_ok(move |chunk| {
            bytes_sent += chunk.len() as u64;
            if bytes_sent - last_progress_bytes >= PROGRESS_UPDATE_INTERVAL
                || bytes_sent == file_size
            {
                progress_tx.send_replace(bytes_sent);
                last_progress_bytes = bytes_sent;
            }
        });

    // Create the multipart part with streaming body
    let body = reqwest::Body::wrap_stream(progress_stream);
    let file_part = reqwest::multipart::Part::stream_with_length(body, file_size)
        .file_name(filename.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| Error::ProxmoxApi(format!("Failed to create file part: {}", e)))?;

    let form = reqwest::multipart::Form::new()
        .text("content", "import")
        .part("filename", file_part);

    let request = api.post(&url).multipart(form).send();
    tokio::pin!(request);
    let mut progress_open = true;
    // A stop must land even while the server reads nothing
    let mut cancel_check = tokio::time::interval(std::time::Duration::from_millis(250));
    let response = loop {
        tokio::select! {
            biased;
            _ = cancel_check.tick() => {
                // Dropping the request closes the connection, and Proxmox
                // throws a partial upload away. Once the whole body is out,
                // Proxmox may already be storing it, and closing the socket
                // won't undo that: wait for the answer, so the caller can
                // delete the image again.
                if progress_callback.is_cancelled() && *progress_rx.borrow() < file_size {
                    return Err(Error::Cancelled);
                }
            }
            changed = progress_rx.changed(), if progress_open => {
                if changed.is_err() {
                    progress_open = false;
                    continue;
                }
                let bytes_sent = *progress_rx.borrow_and_update();
                progress_callback.on_progress(FlashProgress {
                    stage: FlashStage::Uploading,
                    progress: 5 + (bytes_sent as f64 / file_size.max(1) as f64 * 90.0) as u8,
                    bytes_processed: bytes_sent,
                    total_bytes: file_size,
                    message: format!("Uploading {} to Proxmox...", filename),
                });
            }
            response = &mut request => {
                break response.map_err(|error| {
                    if let Some(error) = tls::certificate_error(&error) {
                        return error;
                    }
                    let mut message = format!("Failed to upload image: {error}");
                    let mut source = std::error::Error::source(&error);
                    while let Some(cause) = source {
                        message.push_str(&format!(": {cause}"));
                        source = cause.source();
                    }
                    Error::ProxmoxApi(message)
                })?;
            }
        }
    };

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::ProxmoxSessionExpired);
    }

    if !status.is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to upload image to Proxmox ({}): {}",
            status, response_text
        )));
    }

    let upid = task_upid(&response_text, "upload")?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Uploading,
        progress: 95,
        bytes_processed: file_size,
        total_bytes: file_size,
        message: "Waiting for Proxmox to process upload...".to_string(),
    });

    // Wait for the upload task to complete
    wait_for_task(session, node, &upid, 1800)
        .await
        .map_err(|error| upload_unconfirmed(error, node, storage_name, &filename))?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Uploading,
        progress: 100,
        bytes_processed: file_size,
        total_bytes: file_size,
        message: "Upload complete".to_string(),
    });

    Ok(filename)
}

/// The slowest upload still worth waiting for, in bytes per second: 1 Mbit/s.
const SLOWEST_UPLOAD: u64 = 125_000;

/// How long uploading `size` bytes may take, in seconds. Never under half an
/// hour, and longer for a big image over a slow link, like a VPN to a remote
/// node. A stop ends it any time before that.
fn upload_timeout(size: u64) -> u64 {
    (size / SLOWEST_UPLOAD).max(1800)
}

/// Proxmox accepted the upload, but didn't confirm it stored the image. A
/// lost session or changed certificate keeps its own error, so the user is
/// offered to log in again. Anything else names the image that may be left
/// behind, because installing again uploads a new one next to it.
fn upload_unconfirmed(error: Error, node: &str, storage: &str, filename: &str) -> Error {
    if matches!(
        error,
        Error::ProxmoxSessionExpired | Error::ProxmoxCertificateChanged
    ) {
        return error;
    }

    eprintln!("The upload task did not finish: {error}");
    Error::ProxmoxActionRequired(crate::message!(
        "backend.proxmox.upload_unconfirmed",
        volume = format!("{storage}:import/{filename}"),
        node = node,
    ))
}

/// Create a VM with the disk imported during creation.
///
/// Uses the `import-from` parameter on scsi0 to import the uploaded
/// disk image during VM creation, then grows it to the selected size.
async fn create_vm_with_disk(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    image_filename: &str,
    storage_name: &str,
    source_unused: &mut bool,
) -> Result<()> {
    // Networks, ACLs and free VM IDs can all change during the download and
    // upload, which take long enough for someone to create a VM meanwhile.
    let still_possible = async {
        ensure_vm_id_free(session, config.vm_id).await?;
        ensure_bridge_access(session, config).await
    };
    if let Err(error) = still_possible.await {
        // No create request was sent, so the uploaded source is unused.
        *source_unused = true;
        return Err(error);
    }
    let api = Api::new(session, 300)?; // 5 minutes for VM creation with disk import
    let url = api.node_url(&config.node, "/qemu");

    // Build the disk import specification
    // Format: storage:0,import-from="storage name":import/filename.qcow2
    let scsi0_spec = format!(
        "{}:0,import-from={}:import/{}",
        config.storage, storage_name, image_filename
    );

    // EFI disk specification for UEFI boot
    let efidisk0_spec = format!("{}:1,efitype=4m,pre-enrolled-keys=0", config.storage);

    let response = api
        .post(&url)
        .form(&[
            ("vmid", config.vm_id.to_string()),
            ("name", config.name.clone()),
            ("cores", config.cpu_cores.to_string()),
            ("memory", config.memory_mb.to_string()),
            ("bios", "ovmf".to_string()), // UEFI boot (required for HAOS)
            ("machine", "q35".to_string()), // Modern PCIe chipset
            ("cpu", "host".to_string()),  // Best CPU performance
            ("scsihw", "virtio-scsi-pci".to_string()), // VirtIO SCSI controller
            ("ostype", "l26".to_string()), // Linux 2.6/3.x/4.x/5.x/6.x kernel
            ("efidisk0", efidisk0_spec),  // EFI disk for UEFI
            ("scsi0", scsi0_spec),        // Main disk with import
            (
                "net0",
                match config.vlan_tag {
                    Some(tag) => format!("virtio,bridge={},tag={tag}", config.bridge),
                    None => format!("virtio,bridge={}", config.bridge),
                },
            ),
            ("agent", "enabled=1".to_string()), // QEMU guest agent
            ("boot", "order=scsi0".to_string()), // Boot from main disk
            ("onboot", "1".to_string()),        // Start when the Proxmox host boots
        ])
        .send()
        .await
        .map_err(|e| request_error(e, "Failed to create VM"))?;

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        // A client rejection cannot have started an import. Server errors or
        // a timeout can hide a task which is still running, so retain those.
        *source_unused = status.is_client_error() && status != reqwest::StatusCode::REQUEST_TIMEOUT;
        // Still a client rejection, so the flag above stays set
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(Error::ProxmoxSessionExpired);
        }
        return Err(Error::ProxmoxApi(format!(
            "Failed to create VM ({}): {}",
            status, response_text
        )));
    }

    // VM creation returns a task UPID since it involves disk import
    let upid = task_upid(&response_text, "VM creation")?;
    // Deleting the source is only safe after confirmed import completion.
    wait_for_task_completion(session, &config.node, &upid, 600, source_unused)
        .await
        .map_err(|error| creation_unconfirmed(config, error))?;

    resize_vm_disk(session, config)
        .await
        .map_err(|error| resize_error(config, error))
}

/// Proxmox accepted the request to create the VM, but didn't confirm it was
/// made. It may exist, whole or half way, and installing again with its ID
/// fails until it's removed. A lost session or changed certificate keeps its
/// own error: the app already says the VM may be incomplete for those.
fn creation_unconfirmed(config: &ProxmoxVmConfig, error: Error) -> Error {
    if matches!(
        error,
        Error::ProxmoxSessionExpired | Error::ProxmoxCertificateChanged
    ) {
        return error;
    }

    eprintln!("Creating VM {} was not confirmed: {error}", config.vm_id);
    Error::ProxmoxActionRequired(crate::message!(
        "backend.proxmox.vm_creation_unconfirmed",
        vm_id = config.vm_id,
    ))
}

/// The VM is complete, it only didn't start. Starting it in Proxmox is all
/// that's left, so say that instead of a generic API error.
fn start_error(config: &ProxmoxVmConfig, error: Error) -> Error {
    // Keep its own code, so the user is told to reconnect
    if matches!(error, Error::ProxmoxCertificateChanged) {
        return error;
    }

    eprintln!("Starting VM {} failed: {error}", config.vm_id);
    Error::ProxmoxActionRequired(crate::message!(
        "backend.proxmox.vm_created_start_failed",
        vm_id = config.vm_id,
    ))
}

fn resize_error(config: &ProxmoxVmConfig, error: Error) -> Error {
    // Keep its own code, so the user is told to reconnect
    if matches!(error, Error::ProxmoxCertificateChanged) {
        return error;
    }

    // The VM exists now, so installing again with its ID fails until it's
    // removed.
    Error::ProxmoxActionRequired(crate::message!(
        "backend.proxmox.vm_created_resize_failed",
        vm_id = config.vm_id,
        size_gb = config.disk_size_gb,
    ))
}

/// Apply an absolute size, including the minimum, so Proxmox checks the actual
/// imported volume and rejects shrinking if a future HAOS image is larger.
async fn resize_vm_disk(session: &ProxmoxSession, config: &ProxmoxVmConfig) -> Result<()> {
    let api = Api::new(session, 60)?;
    let url = api.node_url(&config.node, &format!("/qemu/{}/resize", config.vm_id));
    let body = send_change(
        api.put(&url).form(&[
            ("disk", "scsi0".to_string()),
            ("size", format!("{}G", config.disk_size_gb)),
        ]),
        "Failed to resize VM disk",
    )
    .await?;

    let upid = task_upid(&body, "disk resize")?;
    wait_for_task(session, &config.node, &upid, 600).await
}

async fn delete_import_image(
    session: &ProxmoxSession,
    node: &str,
    storage: &str,
    filename: &str,
) -> Result<()> {
    let volume = format!("{storage}:import/{filename}");
    let api = Api::new(session, 60)?;
    let url = api.node_url(
        node,
        &format!(
            "/storage/{}/content/{}",
            urlencoding::encode(storage),
            urlencoding::encode(&volume)
        ),
    );
    let response = send(api.delete(&url), "Could not delete import volume").await?;
    if !response.status().is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Could not delete import volume {volume}: HTTP {}",
            response.status()
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|error| request_error(error, "Could not read the import deletion response"))?;
    let upid = task_upid(&body, "import deletion")?;
    wait_for_task(session, node, &upid, 120).await
}

async fn import_and_cleanup_image(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    image_filename: &str,
    storage_name: &str,
) -> Result<()> {
    let mut source_unused = false;
    let result = create_vm_with_disk(
        session,
        config,
        image_filename,
        storage_name,
        &mut source_unused,
    )
    .await;
    // Creation was prevented/rejected or the import task stopped. Cleanup is
    // best effort and must never hide why the installation failed.
    if source_unused {
        if let Err(error) =
            delete_import_image(session, &config.node, storage_name, image_filename).await
        {
            eprintln!(
                "Temporary import cleanup for VM {} failed: {error}",
                config.vm_id
            );
            // Proxmox's own rejection tells the user nothing to act on, the
            // image left behind does. Installer guidance and reconnecting keep
            // their own error.
            if matches!(result, Err(Error::ProxmoxApi(_))) {
                return Err(Error::ProxmoxActionRequired(crate::message!(
                    "backend.proxmox.create_failed_image_left",
                    vm_id = config.vm_id,
                    volume = format!("{storage_name}:import/{image_filename}"),
                    node = config.node,
                )));
            }
        }
    }
    result
}

/// Start a VM.
async fn start_vm(session: &ProxmoxSession, node: &str, vm_id: u32) -> Result<()> {
    let api = Api::new(session, 60)?;
    let url = api.node_url(node, &format!("/qemu/{vm_id}/status/start"));
    let body = send_change(api.post(&url), "Failed to start VM").await?;

    let upid = task_upid(&body, "VM start")?;
    wait_for_task(session, node, &upid, 120).await
}

/// Get a VM's run status and, while it runs, its IP address.
///
/// The address comes from the QEMU guest agent and stays `None` until the
/// agent reports one.
async fn vm_status(session: &ProxmoxSession, node: &str, vm_id: u32) -> Result<VmStatusInfo> {
    let api = Api::new(session, 10)?;
    let vm_url = api.node_url(node, &format!("/qemu/{vm_id}"));

    // The frontend polls this. Login and permission problems need their own
    // errors, so it can stop and say what to fix instead of waiting out its
    // timeout on a request that can never succeed.
    let json = api
        .get_json(
            &format!("{vm_url}/status/current"),
            "Failed to get VM status",
            "Failed to parse VM status",
            Some(Error::ProxmoxActionRequired(crate::message!(
                "backend.proxmox.vm_status_denied"
            ))),
        )
        .await?;

    let status = json
        .get("data")
        .and_then(|d| d.get("status"))
        .and_then(|s| s.as_str())
        .ok_or_else(|| Error::ProxmoxApi("Invalid VM status response".to_string()))?
        .to_string();

    // A stopped VM has no guest agent to ask
    let ip_address = if status == "running" {
        get_vm_ip(&api, &vm_url).await?
    } else {
        None
    };

    Ok(VmStatusInfo { status, ip_address })
}

/// Ask the VM's guest agent for its IP address once.
///
/// Most failures mean "not yet": right after boot the guest agent is often not
/// running, so requests fail or return an error until it is. A lost session,
/// a changed certificate or missing permission never fix themselves, so those
/// are errors: the frontend stops waiting and says what to fix.
async fn get_vm_ip(api: &Api<'_>, vm_url: &str) -> Result<Option<String>> {
    let response = match api
        .get(&format!("{vm_url}/agent/network-get-interfaces"))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return tls::certificate_error(&error).map_or(Ok(None), Err),
    };

    match response.status() {
        reqwest::StatusCode::UNAUTHORIZED => Err(Error::ProxmoxSessionExpired),
        reqwest::StatusCode::FORBIDDEN => Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.guest_agent_denied"
        ))),
        // Proxmox answers 500 while the guest agent isn't running yet
        status if !status.is_success() => Ok(None),
        _ => Ok(response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|json| find_vm_ip(&json))),
    }
}

/// The first reachable IPv4 address on a non-loopback interface in a guest
/// agent `network-get-interfaces` reply.
fn find_vm_ip(json: &serde_json::Value) -> Option<String> {
    let interfaces = json.get("data")?.get("result")?.as_array()?;

    for iface in interfaces {
        let name = iface.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name == "lo" {
            continue;
        }

        let Some(ip_addresses) = iface.get("ip-addresses").and_then(|a| a.as_array()) else {
            continue;
        };
        for addr in ip_addresses {
            if addr.get("ip-address-type").and_then(|t| t.as_str()) != Some("ipv4") {
                continue;
            }
            // Parsed, so only an address ever reaches the http:// links
            let ip = addr
                .get("ip-address")
                .and_then(|i| i.as_str())
                .and_then(|i| i.parse::<std::net::Ipv4Addr>().ok());
            if let Some(ip) = ip.filter(|ip| crate::host::is_reachable_vm_address(*ip)) {
                return Some(ip.to_string());
            }
        }
    }

    None
}

/// Stop with the uploaded image deleted again when the user stopped.
async fn discard_upload_if_stopped<P: ProgressCallback>(
    session: &ProxmoxSession,
    node: &str,
    storage_name: &str,
    image_filename: &str,
    progress_callback: &P,
) -> Result<()> {
    if !progress_callback.is_cancelled() {
        return Ok(());
    }

    // The stop holds either way, but a left-behind image is the user's to
    // clean up, so name it rather than claim nothing was created
    if let Err(error) = delete_import_image(session, node, storage_name, image_filename).await {
        eprintln!("Temporary import cleanup after a stop failed: {error}");
        return Err(Error::ProxmoxActionRequired(crate::message!(
            "backend.proxmox.leftover_import_image",
            volume = format!("{storage_name}:import/{image_filename}"),
            node = node,
        )));
    }
    Err(Error::Cancelled)
}

fn stop_if_cancelled<P: ProgressCallback>(progress_callback: &P) -> Result<()> {
    if progress_callback.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(())
}

/// Create and start a Home Assistant VM on Proxmox.
///
/// A stop is honored until the VM is about to be created. It deletes the
/// uploaded image again, and when that fails, the error names the image to
/// delete by hand. Once creation starts, it runs to the end.
async fn create_vm<B: ReleaseSource, P: ProgressCallback>(
    backend: &B,
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    progress_callback: &P,
) -> Result<ProxmoxVmResult> {
    // Step 1: Get HAOS release info
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    // Catch anything that would fail later before spending time on the download
    let image = check_install(backend, session, config).await?;
    stop_if_cancelled(progress_callback)?;

    // Step 2: Download the compressed image locally
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 5,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Downloading HAOS image...".to_string(),
    });

    let cache_dir = backend.cache_dir()?;
    let temporary_image =
        crate::download::TemporaryImage::new(&cache_dir, crate::ImageFormat::Qcow2)?;
    let compressed_path = temporary_image.archive_path();

    // Download the image
    backend
        .download_image(&image, &compressed_path, progress_callback)
        .await?;

    // Step 3: Extract the compressed image
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Extracting,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Extracting image...".to_string(),
    });

    let extracted_path = temporary_image.path();

    backend
        .extract_temporary_image(&temporary_image, progress_callback)
        .await?;

    let storage_name = recheck_before_upload(session, config, &extracted_path).await?;
    stop_if_cancelled(progress_callback)?;

    // Step 4: Upload the extracted image to Proxmox storage, fetched dynamically with import flag
    let image_filename = upload_image_to_proxmox(
        session,
        &config.node,
        &extracted_path,
        progress_callback,
        &storage_name,
    )
    .await?;
    drop(temporary_image);

    // The last moment a stop leaves nothing behind: past this, the VM exists
    discard_upload_if_stopped(
        session,
        &config.node,
        &storage_name,
        &image_filename,
        progress_callback,
    )
    .await?;

    // Step 5: Create the VM with disk import and apply the selected size
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::CreatingVm,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Creating virtual machine...".to_string(),
    });

    import_and_cleanup_image(session, config, &image_filename, &storage_name).await?;

    // Step 6: Start the VM
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::StartingVm,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Starting virtual machine...".to_string(),
    });
    start_vm(session, &config.node, config.vm_id)
        .await
        .map_err(|error| start_error(config, error))?;

    Ok(ProxmoxVmResult {
        vm_id: config.vm_id,
        node: config.node.clone(),
    })
}

impl ProxmoxBackend for Backend {
    async fn certificate_fingerprint(&self, server_url: &str) -> Result<Option<String>> {
        tls::certificate_fingerprint(server_url).await
    }

    async fn authenticate(&self, credentials: &ProxmoxCredentials) -> Result<ProxmoxSession> {
        authenticate(credentials).await
    }

    async fn list_nodes(&self, session: &ProxmoxSession) -> Result<Vec<ProxmoxNode>> {
        list_nodes(session).await
    }

    async fn list_storage(
        &self,
        session: &ProxmoxSession,
        node: &str,
    ) -> Result<Vec<ProxmoxStorage>> {
        list_storage(session, node).await
    }

    async fn enable_storage_import(
        &self,
        session: &ProxmoxSession,
        node: &str,
        storage: &str,
    ) -> Result<bool> {
        enable_storage_import(session, node, storage).await
    }

    async fn get_next_vm_id(&self, session: &ProxmoxSession) -> Result<u32> {
        get_next_vm_id(session).await
    }

    async fn list_bridges(
        &self,
        session: &ProxmoxSession,
        node: &str,
    ) -> Result<Vec<ProxmoxBridge>> {
        list_bridges(session, node).await
    }

    async fn vm_status(
        &self,
        session: &ProxmoxSession,
        node: &str,
        vm_id: u32,
    ) -> Result<VmStatusInfo> {
        vm_status(session, node, vm_id).await
    }

    async fn check_vm_config(
        &self,
        session: &ProxmoxSession,
        config: &ProxmoxVmConfig,
    ) -> Result<()> {
        check_install(self, session, config).await.map(drop)
    }

    async fn create_vm<P: ProgressCallback>(
        &self,
        session: &ProxmoxSession,
        config: &ProxmoxVmConfig,
        progress_callback: &P,
    ) -> Result<ProxmoxVmResult> {
        create_vm(self, session, config, progress_callback).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message;

    // Version parsing tests
    #[test]
    fn test_parse_version_valid_standard() {
        assert_eq!(parse_version("8.4.1"), Some((8, 4, 1)));
        assert_eq!(parse_version("8.0.0"), Some((8, 0, 0)));
        assert_eq!(parse_version("10.2.3"), Some((10, 2, 3)));
    }

    #[test]
    fn test_parse_version_valid_two_parts() {
        assert_eq!(parse_version("8.4"), Some((8, 4, 0)));
        assert_eq!(parse_version("10.2"), Some((10, 2, 0)));
    }

    #[test]
    fn test_parse_version_invalid() {
        assert_eq!(parse_version("8"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("invalid"), None);
    }

    #[test]
    fn test_parse_version_edge_cases() {
        // Just one number
        assert_eq!(parse_version("8"), None);

        // Empty string
        assert_eq!(parse_version(""), None);

        // Four parts - should still work (take first 3)
        assert_eq!(parse_version("8.4.1.2"), Some((8, 4, 1)));

        // Non-numeric parts - major or minor fails, but patch defaults to 0
        assert_eq!(parse_version("8.x.1"), None); // minor fails
        assert_eq!(parse_version("x.4.1"), None); // major fails
        assert_eq!(parse_version("8.4.x"), Some((8, 4, 0))); // patch defaults to 0
    }

    // Version comparison tests
    #[test]
    fn test_version_meets_minimum_equal() {
        assert!(version_meets_minimum((8, 4, 1), (8, 4, 1)));
    }

    #[test]
    fn test_version_meets_minimum_higher() {
        assert!(version_meets_minimum((9, 0, 0), (8, 4, 1)));
        assert!(version_meets_minimum((8, 5, 0), (8, 4, 1)));
        assert!(version_meets_minimum((8, 4, 2), (8, 4, 1)));
    }

    #[test]
    fn test_version_meets_minimum_lower() {
        assert!(!version_meets_minimum((7, 9, 9), (8, 4, 1)));
        assert!(!version_meets_minimum((8, 3, 9), (8, 4, 1)));
        assert!(!version_meets_minimum((8, 4, 0), (8, 4, 1)));
    }

    #[test]
    fn test_version_meets_minimum_major_version_boundary() {
        // 9.0.0 should meet 8.99.99
        assert!(version_meets_minimum((9, 0, 0), (8, 99, 99)));
        // 8.99.99 should not meet 9.0.0
        assert!(!version_meets_minimum((8, 99, 99), (9, 0, 0)));
    }

    #[test]
    fn test_version_meets_minimum_minor_version_boundary() {
        // 8.5.0 should meet 8.4.99
        assert!(version_meets_minimum((8, 5, 0), (8, 4, 99)));
        // 8.4.99 should not meet 8.5.0
        assert!(!version_meets_minimum((8, 4, 99), (8, 5, 0)));
    }

    /// Whether two messages have the same key and parameters. The frontend gets
    /// the parameters as a JSON object, so their order doesn't count.
    fn same_message(left: &crate::Message, right: &crate::Message) -> bool {
        left.key == right.key && left.params_json() == right.params_json()
    }

    /// A message that equals a `message!` by `same_message`.
    #[derive(Debug)]
    struct AnyOrder(crate::Message);

    impl PartialEq<crate::Message> for AnyOrder {
        fn eq(&self, other: &crate::Message) -> bool {
            same_message(&self.0, other)
        }
    }

    /// The message of an `Error::ProxmoxActionRequired`, or a panic naming what came instead.
    #[track_caller]
    fn action_required<T: std::fmt::Debug>(result: Result<T>) -> AnyOrder {
        match result {
            Err(Error::ProxmoxActionRequired(message)) => AnyOrder(message),
            other => panic!("expected ProxmoxActionRequired, got {other:?}"),
        }
    }

    fn storage(name: &str, active: bool, content: &[&str]) -> ProxmoxStorage {
        ProxmoxStorage {
            name: name.to_string(),
            storage_type: "dir".to_string(),
            content: content.iter().map(|c| c.to_string()).collect(),
            available: 100_000_000_000,
            active,
        }
    }

    #[test]
    fn test_check_disk_storage_accepts_active_images_storage() {
        let storage_list = vec![
            storage("local", true, &["iso", "import"]),
            storage("local-lvm", true, &["images", "rootdir"]),
        ];
        assert!(check_disk_storage(&storage_list, "local-lvm", 32).is_ok());
    }

    #[test]
    fn test_check_disk_storage_rejects_storage_without_enough_space() {
        let storage_list = vec![ProxmoxStorage {
            available: 20 * 1024 * 1024 * 1024,
            ..storage("local-lvm", true, &["images"])
        }];
        assert_eq!(
            action_required(check_disk_storage(&storage_list, "local-lvm", 32)),
            message!(
                "backend.proxmox.storage_too_small",
                storage = "local-lvm",
                size_gb = 32,
                free_gb = 20,
            )
        );
    }

    #[test]
    fn test_check_disk_storage_rejects_missing_storage() {
        let storage_list = vec![storage("local-lvm", true, &["images"])];
        assert_eq!(
            action_required(check_disk_storage(&storage_list, "ceph-pool", 32)),
            message!("backend.proxmox.storage_not_found", storage = "ceph-pool")
        );
    }

    #[test]
    fn test_check_disk_storage_rejects_inactive_storage() {
        let storage_list = vec![storage("local-lvm", false, &["images"])];
        assert_eq!(
            action_required(check_disk_storage(&storage_list, "local-lvm", 32)),
            message!("backend.proxmox.storage_inactive", storage = "local-lvm")
        );
    }

    #[test]
    fn test_check_disk_storage_rejects_storage_without_images() {
        // The import storage is a common wrong pick: it's active but can't hold VM disks.
        let storage_list = vec![storage("local", true, &["iso", "import"])];
        assert_eq!(
            action_required(check_disk_storage(&storage_list, "local", 32)),
            message!("backend.proxmox.storage_no_disk_images", storage = "local")
        );
    }

    #[test]
    fn test_select_import_storage_selects_first_eligible_storage() {
        let storage_list = vec![
            storage("local", true, &["images", "rootdir", "iso"]),
            storage("offline-import", false, &["import", "iso"]),
            ProxmoxStorage {
                storage_type: "esxi".to_string(),
                ..storage("esxi-import", true, &["import"])
            },
            storage("local-import", true, &["iso", "import"]),
            storage("other-import", true, &["import"]),
        ];

        // "local" lacks import, "offline-import" is inactive and "esxi-import"
        // cannot receive uploads, so the first eligible storage wins.
        assert_eq!(
            select_import_storage(&storage_list, 0).unwrap(),
            "local-import"
        );
    }

    #[test]
    fn test_select_import_storage_no_active_import_storage() {
        let storage_list = vec![
            storage("local", true, &["images", "rootdir", "iso"]),
            storage("offline-import", false, &["import"]),
            ProxmoxStorage {
                storage_type: "esxi".to_string(),
                ..storage("esxi-import", true, &["import"])
            },
        ];

        assert_eq!(
            action_required(select_import_storage(&storage_list, 0)),
            message!("backend.proxmox.no_import_storage")
        );
    }

    #[test]
    fn test_estimated_extracted_size_rejects_import_storage_that_only_fits_the_download() {
        // 510 MB download (HAOS 18.3) with 600 MB free: fits the .xz, not the ~970 MB qcow2.
        let storage_list = vec![ProxmoxStorage {
            available: 600_000_000,
            ..storage("local", true, &["import"])
        }];
        assert!(select_import_storage(&storage_list, 510_000_000).is_ok());
        assert!(
            select_import_storage(&storage_list, estimated_extracted_size(510_000_000)).is_err()
        );
    }

    #[test]
    fn test_select_import_storage_skips_storage_without_enough_space() {
        let storage_list = vec![
            ProxmoxStorage {
                available: 500_000_000,
                ..storage("small-import", true, &["import"])
            },
            ProxmoxStorage {
                available: 50_000_000_000,
                ..storage("big-import", true, &["import"])
            },
        ];
        let result = select_import_storage(&storage_list, 1_000_000_000);
        assert_eq!(result.unwrap(), "big-import");
    }

    #[test]
    fn test_select_import_storage_reports_full_import_storage() {
        let storage_list = vec![ProxmoxStorage {
            available: 500_000_000,
            ..storage("small-import", true, &["import"])
        }];
        assert_eq!(
            action_required(select_import_storage(&storage_list, 1_000_000_000)),
            message!(
                "backend.proxmox.import_storage_too_small",
                size_mb = 1000,
                storages = "small-import",
            )
        );
    }

    #[test]
    fn test_ensure_privileges_lists_only_missing_privileges() {
        let granted: HashSet<String> = ["VM.Allocate", "VM.Audit"]
            .iter()
            .map(|p| p.to_string())
            .collect();

        assert!(ensure_privileges(&granted, "/vms/100", &["VM.Allocate"]).is_ok());

        assert_eq!(
            action_required(ensure_privileges(
                &granted,
                "/vms/100",
                &["VM.Allocate", "VM.Config.CPU"]
            )),
            message!(
                "backend.proxmox.missing_privileges",
                privileges = "VM.Config.CPU",
                path = "/vms/100",
            )
        );
    }

    fn node(name: &str, status: &str) -> ProxmoxNode {
        ProxmoxNode {
            name: name.to_string(),
            status: status.to_string(),
            cpu_usage: None,
            cpu_count: None,
        }
    }

    #[test]
    fn test_check_node_cores_against_the_node_cpus() {
        let nodes = vec![
            ProxmoxNode {
                cpu_count: Some(4),
                ..node("pve", "online")
            },
            node("unknown", "online"),
        ];
        assert!(check_node_cores(&nodes, "pve", 4).is_ok());
        assert_eq!(
            action_required(check_node_cores(&nodes, "pve", 6)),
            message!("backend.proxmox.too_many_cores", node = "pve", cpus = 4)
        );
        // Without a CPU count only Proxmox can tell
        assert!(check_node_cores(&nodes, "unknown", 16).is_ok());
    }

    #[test]
    fn test_vm_names_follow_the_proxmox_dns_name_format() {
        for name in ["homeassistant", "home-assistant", "ha.lan", "HA-2", "a"] {
            assert!(validate_vm_name(name).is_ok(), "{name}");
        }
        for name in [
            "",
            "home_assistant",
            "home assistant",
            "-ha",
            "ha-",
            "ha.",
            ".ha",
            "ha..lan",
            "ha.-lan",
        ] {
            assert!(
                matches!(validate_vm_name(name), Err(Error::ProxmoxActionRequired(_))),
                "{name}"
            );
        }
    }

    #[test]
    fn test_check_node_online_accepts_online_node() {
        let nodes = vec![node("pve", "online"), node("pve2", "offline")];
        assert!(check_node_online(&nodes, "pve").is_ok());
    }

    #[test]
    fn test_check_node_online_rejects_offline_node() {
        let nodes = vec![node("pve", "online"), node("pve2", "offline")];
        assert_eq!(
            action_required(check_node_online(&nodes, "pve2")),
            message!("backend.proxmox.node_offline", node = "pve2")
        );
    }

    #[test]
    fn test_check_node_online_rejects_missing_node() {
        let nodes = vec![node("pve", "online")];
        assert_eq!(
            action_required(check_node_online(&nodes, "pve3")),
            message!("backend.proxmox.node_not_found", node = "pve3")
        );
    }

    // =========================================================================
    // HTTP Mocking tests using mockito
    // =========================================================================

    /// How an endpoint handles each answer is a row in `test_authenticate_failures`,
    /// `test_lookup_answers` or `test_write_answers_without_a_task`, and task polling
    /// a row in `test_wait_for_task_answers`. Multi-step flows get their own tests.
    mod http_mock_tests {
        use super::*;
        use mockito::{Matcher, Mock, Server};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Mutex;

        const UPID: &str = "UPID:pve:00000001:00000002:00000003:test:root@pam:";
        const TASK_OK: &str = r#"{"data":{"status":"stopped","exitstatus":"OK"}}"#;
        /// A login Proxmox accepts, without a second factor.
        const LOGIN: &str = r#"{"data":{"ticket":"PVE:root@pam:12345678::abcdef","CSRFPreventionToken":"12345678:csrf-token"}}"#;

        fn session(server_url: String) -> ProxmoxSession {
            ProxmoxSession {
                server_url,
                ticket: "test-ticket".into(),
                csrf_token: "test-csrf".into(),
                certificate_sha256: None,
            }
        }

        fn credentials(server: &Server) -> ProxmoxCredentials {
            ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".into(),
                password: "password".into(),
                totp: None,
                certificate_sha256: None,
            }
        }

        fn vm_config() -> ProxmoxVmConfig {
            ProxmoxVmConfig {
                vm_id: 100,
                name: "homeassistant".into(),
                node: "pve".into(),
                storage: "local-lvm".into(),
                bridge: "vmbr0".into(),
                vlan_tag: None,
                cpu_cores: 2,
                memory_mb: 4096,
                disk_size_gb: 32,
            }
        }

        /// Where the status of task `upid` on node pve is read.
        fn task_path(upid: &str) -> String {
            format!(
                "/api2/json/nodes/pve/tasks/{}/status",
                urlencoding::encode(upid)
            )
        }

        async fn mock_task(server: &mut Server, upid: &str, body: &str) -> Mock {
            server
                .mock("GET", task_path(upid).as_str())
                .with_body(body)
                .create_async()
                .await
        }

        /// Answers one connection per response with its raw bytes and hangs up.
        /// Resolves to whether no further connection came, as a retry would.
        async fn raw_server(responses: Vec<String>) -> (String, tokio::task::JoinHandle<bool>) {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                for response in responses {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let _ = stream.read(&mut [0; 4096]).await.unwrap();
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
                let next = listener.accept();
                tokio::time::timeout(std::time::Duration::from_millis(200), next)
                    .await
                    .is_err()
            });
            (url, server)
        }

        /// A raw response that promises all of `body`; `cut_off` sends half of it.
        fn raw_response(status: &str, body: &str, cut_off: bool) -> String {
            let sent = if cut_off {
                &body[..body.len() / 2]
            } else {
                body
            };
            format!(
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{sent}",
                body.len()
            )
        }

        /// Records progress, and stops once `stop` is called, like the desktop callback.
        #[derive(Default)]
        struct TestProgress {
            updates: Mutex<Vec<FlashProgress>>,
            stopped: AtomicBool,
        }

        impl TestProgress {
            fn updates(&self) -> Vec<FlashProgress> {
                self.updates.lock().unwrap().clone()
            }

            fn stop(&self) {
                self.stopped.store(true, Ordering::Relaxed);
            }
        }

        impl ProgressCallback for TestProgress {
            fn on_progress(&self, progress: FlashProgress) {
                self.updates.lock().unwrap().push(progress);
            }

            fn is_cancelled(&self) -> bool {
                self.stopped.load(Ordering::Relaxed)
            }
        }

        /// Offers one OVA image, and downloads it only when it has a cache.
        struct OvaRelease {
            image: HaosImage,
            cache: Option<tempfile::TempDir>,
        }

        impl ReleaseSource for OvaRelease {
            async fn check_connection(&self) -> Result<()> {
                unreachable!()
            }
            async fn get_device_manifest(&self) -> Result<crate::DeviceManifest> {
                unreachable!()
            }
            async fn get_haos_release(&self, _: &str) -> Result<HaosRelease> {
                unreachable!("must use OVA's board-specific release")
            }
            async fn get_latest_haos_release_for_board(&self, board: &str) -> Result<HaosRelease> {
                assert_eq!(board, "ova");
                Ok(HaosRelease {
                    version: "18.2".into(),
                    images: vec![self.image.clone()],
                })
            }
            async fn download_image<P: ProgressCallback>(
                &self,
                image: &HaosImage,
                dest: &std::path::Path,
                callback: &P,
            ) -> Result<()> {
                assert!(self.cache.is_some(), "must not download");
                assert_eq!(image.board, "ova");
                assert_eq!(image.format, ImageFormat::Qcow2);
                Backend.download_image(image, dest, callback).await
            }
            async fn extract_xz<P: ProgressCallback>(
                &self,
                _: &std::path::Path,
                _: &std::path::Path,
                _: &P,
            ) -> Result<()> {
                unreachable!("must not extract")
            }
            fn cache_dir(&self) -> Result<std::path::PathBuf> {
                let cache = self.cache.as_ref().expect("must not download");
                Ok(cache.path().to_path_buf())
            }
        }

        /// How a table row expects a call to end.
        #[derive(Debug, Clone)]
        enum Outcome {
            /// Success, with this debug text
            Returns(&'static str),
            /// `Error::ProxmoxApi`, with text containing this
            Api(&'static str),
            Action(crate::Message),
            SessionExpired,
        }
        use Outcome::*;

        #[track_caller]
        fn assert_outcome<T: std::fmt::Debug>(row: &str, result: Result<T>, expected: &Outcome) {
            let matched = match (&result, expected) {
                (Ok(value), Returns(text)) => format!("{value:?}") == *text,
                (Err(Error::ProxmoxApi(message)), Api(part)) => message.contains(part),
                (Err(Error::ProxmoxActionRequired(message)), Action(want)) => {
                    same_message(message, want)
                }
                (Err(Error::ProxmoxSessionExpired), SessionExpired) => true,
                _ => false,
            };
            assert!(matched, "{row}: expected {expected:?}, got {result:?}");
        }

        #[tokio::test]
        async fn test_authenticate_success() {
            let mut server = Server::new_async().await;
            let ticket = server
                .mock("POST", "/api2/json/access/ticket")
                .with_body(LOGIN)
                .create_async()
                .await;
            let version = server
                .mock("GET", "/api2/json/version")
                .with_body(r#"{"data":{"version":"8.4.1","release":"8.4","repoid":"abcd1234"}}"#)
                .create_async()
                .await;

            let session = authenticate(&credentials(&server)).await.unwrap();
            assert_eq!(session.ticket, "PVE:root@pam:12345678::abcdef");
            assert_eq!(session.csrf_token, "12345678:csrf-token");
            assert_eq!(session.server_url, server.url());

            ticket.assert_async().await;
            version.assert_async().await;
        }

        #[tokio::test]
        async fn test_authenticate_two_factor() {
            let challenge = format!(
                "PVE:!tfa!{}:12345678::signature",
                urlencoding::encode(r#"{"totp":true,"recovery":[1,2]}"#)
            );
            let unsupported = format!(
                "PVE:!tfa!{}:12345678::signature",
                urlencoding::encode(r#"{"webauthn":{},"recovery":[1]}"#)
            );
            let complete = serde_json::json!({
                "ticket": "PVE:root@pam:12345678::complete",
                "CSRFPreventionToken": "final-csrf",
            });
            let partial = serde_json::json!({"ticket": challenge, "NeedTFA": 1});
            let no_totp = || Some(message!("backend.proxmox.two_factor_totp_unavailable"));
            let incomplete = || Some(message!("backend.proxmox.two_factor_incomplete"));

            for (initial, code, second_status, second_data, error) in [
                (
                    partial.clone(),
                    None,
                    200,
                    complete.clone(),
                    Some(message!("backend.proxmox.two_factor_code_required")),
                ),
                (
                    partial.clone(),
                    Some("abc123"),
                    200,
                    complete.clone(),
                    Some(message!("backend.proxmox.two_factor_code_invalid")),
                ),
                (partial.clone(), Some("123456"), 200, complete.clone(), None),
                (
                    serde_json::json!({"ticket": challenge}),
                    Some("123456"),
                    200,
                    complete.clone(),
                    None,
                ),
                (
                    serde_json::json!({"NeedTFA": true}),
                    None,
                    200,
                    complete.clone(),
                    no_totp(),
                ),
                (
                    serde_json::json!({"NeedTFA": 1, "ticket": unsupported}),
                    Some("123456"),
                    200,
                    complete.clone(),
                    no_totp(),
                ),
                (
                    serde_json::json!({"ticket": "PVE:!tfa!malformed:time::sig"}),
                    Some("123456"),
                    200,
                    complete.clone(),
                    no_totp(),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    401,
                    serde_json::Value::Null,
                    Some(message!("backend.proxmox.two_factor_rejected")),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    503,
                    serde_json::Value::Null,
                    Some(message!(
                        "backend.proxmox.two_factor_http_error",
                        status = 503
                    )),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    200,
                    partial.clone(),
                    incomplete(),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    200,
                    serde_json::json!({"ticket": challenge}),
                    incomplete(),
                ),
                (
                    serde_json::json!({"NeedTFA": 1, "ticket": "PVE:root@pam:time::partial", "CSRFPreventionToken": "partial-csrf"}),
                    None,
                    200,
                    complete.clone(),
                    no_totp(),
                ),
            ] {
                let mut server = Server::new_async().await;
                let first = server
                    .mock("POST", "/api2/json/access/ticket")
                    .match_body(Matcher::AllOf(vec![
                        Matcher::UrlEncoded("username".into(), "root@pam".into()),
                        Matcher::UrlEncoded("password".into(), "password".into()),
                        Matcher::UrlEncoded("new-format".into(), "1".into()),
                    ]))
                    .with_body(serde_json::json!({"data": initial}).to_string())
                    .create_async()
                    .await;
                let sends_code = initial["ticket"] == challenge && code == Some("123456");
                let second = server
                    .mock("POST", "/api2/json/access/ticket")
                    .match_header("cookie", Matcher::Missing)
                    .match_body(Matcher::AllOf(vec![
                        Matcher::UrlEncoded("username".into(), "root@pam".into()),
                        Matcher::UrlEncoded("password".into(), "totp:123456".into()),
                        Matcher::UrlEncoded("tfa-challenge".into(), challenge.clone()),
                    ]))
                    .with_status(second_status)
                    .with_body(serde_json::json!({"data": second_data}).to_string())
                    .expect(usize::from(sends_code))
                    .create_async()
                    .await;
                let version = server
                    .mock("GET", "/api2/json/version")
                    .match_header("cookie", "PVEAuthCookie=PVE:root@pam:12345678::complete")
                    .with_body(r#"{"data":{"version":"8.4.1"}}"#)
                    .expect(usize::from(error.is_none()))
                    .create_async()
                    .await;
                // Catch any attempt to send the partial ticket to the version API.
                let partial_version = server
                    .mock("GET", "/api2/json/version")
                    .match_header("cookie", format!("PVEAuthCookie={challenge}").as_str())
                    .expect(0)
                    .create_async()
                    .await;
                let credentials = ProxmoxCredentials {
                    totp: code.map(str::to_string),
                    ..credentials(&server)
                };
                // The whole message also shows that neither ticket nor code leaks into it
                match (authenticate(&credentials).await, error) {
                    (Err(Error::ProxmoxTwoFactor(message)), Some(expected)) => {
                        assert_eq!(AnyOrder(message), expected)
                    }
                    (Ok(session), None) => {
                        assert_eq!(session.ticket, complete["ticket"]);
                        assert_eq!(session.csrf_token, "final-csrf");
                    }
                    (result, expected) => panic!("expected {expected:?}, got {result:?}"),
                }
                first.assert_async().await;
                second.assert_async().await;
                version.assert_async().await;
                partial_version.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_authenticate_failures() {
            let too_old = message!(
                "backend.proxmox.unsupported_version",
                version = "7.4.0",
                minimum = "8.4.1",
            );
            // (row, login answer, version answer if asked, outcome)
            for (row, (login_status, login_body), version, expected) in [
                (
                    "wrong password",
                    (401, "authentication failure"),
                    None,
                    Action(message!("backend.proxmox.authentication_failed")),
                ),
                (
                    "access denied",
                    (403, "access denied"),
                    None,
                    Action(message!("backend.proxmox.access_denied")),
                ),
                (
                    "login server error",
                    (500, "Internal Server Error"),
                    None,
                    Api("Server returned error: 500"),
                ),
                (
                    "login not JSON",
                    (200, "not json"),
                    None,
                    Api("Failed to parse server response"),
                ),
                (
                    "login without data",
                    (200, "{}"),
                    None,
                    Api("missing 'data' field"),
                ),
                (
                    "login without ticket",
                    (200, r#"{"data":{"username":"root@pam"}}"#),
                    None,
                    Api("missing 'ticket' field"),
                ),
                (
                    "login without CSRF token",
                    (
                        200,
                        r#"{"data":{"ticket":"PVE:root@pam:12345678::abcdef"}}"#,
                    ),
                    None,
                    Api("missing 'CSRFPreventionToken' field"),
                ),
                (
                    "version server error",
                    (200, LOGIN),
                    Some((500, "")),
                    Api("Failed to get Proxmox version: 500"),
                ),
                (
                    "version missing",
                    (200, LOGIN),
                    Some((200, r#"{"data":{"release":"8.4"}}"#)),
                    Api("Failed to get Proxmox version from response"),
                ),
                (
                    "version unreadable",
                    (200, LOGIN),
                    Some((200, r#"{"data":{"version":"invalid"}}"#)),
                    Api("Failed to parse Proxmox version: invalid"),
                ),
                (
                    "version too old",
                    (200, LOGIN),
                    Some((200, r#"{"data":{"version":"7.4.0","release":"7.4"}}"#)),
                    Action(too_old),
                ),
            ] {
                let mut server = Server::new_async().await;
                let login = server
                    .mock("POST", "/api2/json/access/ticket")
                    .with_status(login_status)
                    .with_body(login_body)
                    .create_async()
                    .await;
                let (version_status, version_body) = version.unwrap_or((200, ""));
                let version_mock = server
                    .mock("GET", "/api2/json/version")
                    .with_status(version_status)
                    .with_body(version_body)
                    .expect(usize::from(version.is_some()))
                    .create_async()
                    .await;
                assert_outcome(row, authenticate(&credentials(&server)).await, &expected);
                assert!(login.matched_async().await, "{row}: login");
                assert!(version_mock.matched_async().await, "{row}: version");
            }
        }

        #[tokio::test]
        async fn test_list_nodes_success() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .match_header("Cookie", Matcher::Regex("PVEAuthCookie=.*".to_string()))
                .with_body(
                    r#"{
                        "data": [
                            {
                                "node": "pve",
                                "status": "online",
                                "cpu": 0.15,
                                "maxcpu": 4,
                                "mem": 4000000000,
                                "maxmem": 16000000000
                            },
                            {
                                "node": "pve2",
                                "status": "online",
                                "cpu": 0.25,
                                "mem": 8000000000,
                                "maxmem": 32000000000
                            }
                        ]
                    }"#,
                )
                .create_async()
                .await;

            let nodes = list_nodes(&session(server.url())).await.unwrap();
            assert_eq!(nodes.len(), 2);
            assert_eq!(nodes[0].name, "pve");
            assert_eq!(nodes[0].status, "online");
            assert_eq!(nodes[0].cpu_count, Some(4));
            assert_eq!(nodes[1].name, "pve2");
            // Proxmox leaves out the stats for users without Sys.Audit
            assert_eq!(nodes[1].cpu_count, None);

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_list_storage_success() {
            let mut server = Server::new_async().await;

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_body(
                    r#"{
                        "data": [
                            {
                                "storage": "local",
                                "type": "dir",
                                "content": "images,rootdir,iso",
                                "avail": 100000000000,
                                "total": 500000000000,
                                "active": 1
                            },
                            {
                                "storage": "local-lvm",
                                "type": "lvmthin",
                                "content": "images,rootdir",
                                "avail": 200000000000,
                                "total": 1000000000000,
                                "active": 1
                            }
                        ]
                    }"#,
                )
                .create_async()
                .await;

            let storage = list_storage(&session(server.url()), "pve").await.unwrap();
            assert_eq!(storage.len(), 2);
            assert_eq!(storage[0].name, "local");
            assert_eq!(storage[0].storage_type, "dir");
            assert!(storage[0].content.contains(&"images".to_string()));
            assert_eq!(storage[1].name, "local-lvm");

            storage_mock.assert_async().await;
        }

        /// How each read-only call handles one answer from Proxmox.
        #[tokio::test]
        async fn test_lookup_answers() {
            #[derive(Clone, Copy)]
            enum Lookup {
                Nodes,
                Storage,
                Bridges,
                NextId,
                VmIdFree,
                Privileges,
                VmStatus,
            }
            use Lookup::*;

            let vm_id_taken = || Action(message!("backend.proxmox.vm_id_unavailable", vm_id = 101));
            // (row, call, status, body, outcome)
            for (row, lookup, status, body, expected) in [
                ("nodes 401", Nodes, 401, "", SessionExpired),
                (
                    "nodes 403",
                    Nodes,
                    403,
                    "",
                    Action(message!("backend.proxmox.list_nodes_denied")),
                ),
                (
                    "nodes 500",
                    Nodes,
                    500,
                    "",
                    Api("Proxmox server returned error: 500 Internal Server Error"),
                ),
                (
                    "nodes not JSON",
                    Nodes,
                    200,
                    "not json",
                    Api("Failed to parse Proxmox response"),
                ),
                (
                    "nodes without data",
                    Nodes,
                    200,
                    "{}",
                    Api("missing node data"),
                ),
                ("storage 401", Storage, 401, "", SessionExpired),
                (
                    "storage on a missing node",
                    Storage,
                    404,
                    "node not found",
                    Api("Failed to list storage: 404"),
                ),
                ("no storage", Storage, 200, r#"{"data": []}"#, Returns("[]")),
                (
                    "storage not JSON",
                    Storage,
                    200,
                    "not json",
                    Api("Failed to parse storage list"),
                ),
                (
                    "storage without data",
                    Storage,
                    200,
                    "{}",
                    Api("missing 'data' array"),
                ),
                ("bridges 401", Bridges, 401, "", SessionExpired),
                (
                    "bridges 403",
                    Bridges,
                    403,
                    "",
                    Api("Failed to list network bridges: 403 Forbidden"),
                ),
                (
                    "bridges 500",
                    Bridges,
                    500,
                    "",
                    Api("Failed to list network bridges: 500 Internal Server Error"),
                ),
                (
                    "bridges without data",
                    Bridges,
                    200,
                    "{}",
                    Api("Invalid network response: missing 'data' array"),
                ),
                (
                    "bridges not JSON",
                    Bridges,
                    200,
                    "invalid",
                    Api("Failed to parse network bridges"),
                ),
                // The name ends up in net0, where a comma would add options
                (
                    "bridge name with options",
                    Bridges,
                    200,
                    r#"{"data":[{"iface":"vmbr0,tag=10","type":"bridge"}]}"#,
                    Api("Invalid network bridge identifier"),
                ),
                ("next ID 401", NextId, 401, "", SessionExpired),
                (
                    "next ID 500",
                    NextId,
                    500,
                    "",
                    Api("Failed to get next VM ID: 500"),
                ),
                // Proxmox answers with a string, some versions with a number
                ("next ID", NextId, 200, r#"{"data": "100"}"#, Returns("100")),
                (
                    "next ID as number",
                    NextId,
                    200,
                    r#"{"data": 105}"#,
                    Returns("105"),
                ),
                (
                    "next ID not a number",
                    NextId,
                    200,
                    r#"{"data": "not-a-number"}"#,
                    Api("Invalid VM ID format: not-a-number"),
                ),
                (
                    "next ID an object",
                    NextId,
                    200,
                    r#"{"data": {"invalid": "object"}}"#,
                    Api("Unexpected VM ID type"),
                ),
                (
                    "next ID without data",
                    NextId,
                    200,
                    "{}",
                    Api("missing 'data' field"),
                ),
                (
                    "VM ID free",
                    VmIdFree,
                    200,
                    r#"{"data": "101"}"#,
                    Returns("()"),
                ),
                // Proxmox's reason is not passed on
                (
                    "VM ID taken",
                    VmIdFree,
                    400,
                    r#"{"data": null}"#,
                    vm_id_taken(),
                ),
                (
                    "VM ID taken, with a reason",
                    VmIdFree,
                    400,
                    r#"{"errors": {"vmid": "VM 101 already exists"}, "data": null}"#,
                    vm_id_taken(),
                ),
                ("VM ID check 401", VmIdFree, 401, "", SessionExpired),
                (
                    "VM ID check 500",
                    VmIdFree,
                    500,
                    "Internal Server Error",
                    Api("Failed to check VM ID: 500"),
                ),
                ("privileges 401", Privileges, 401, "", SessionExpired),
                // The frontend polls VM status and stops on these, instead of
                // waiting for an address that can never be fetched
                ("VM status 401", VmStatus, 401, "", SessionExpired),
                (
                    "VM status 403",
                    VmStatus,
                    403,
                    "",
                    Action(message!("backend.proxmox.vm_status_denied")),
                ),
                (
                    "VM status 500",
                    VmStatus,
                    500,
                    "",
                    Api("Failed to get VM status: 500"),
                ),
            ] {
                let mut server = Server::new_async().await;
                let path = match lookup {
                    Nodes => "/api2/json/nodes",
                    Storage => "/api2/json/nodes/pve/storage",
                    Bridges => "/api2/json/nodes/pve/network?type=any_bridge",
                    NextId => "/api2/json/cluster/nextid",
                    VmIdFree => "/api2/json/cluster/nextid?vmid=101",
                    Privileges => "/api2/json/access/permissions?path=%2Fvms%2F100",
                    VmStatus => VM_STATUS_PATH,
                };
                let mock = server
                    .mock("GET", path)
                    .with_status(status)
                    .with_body(body)
                    .create_async()
                    .await;
                let session = session(server.url());
                match lookup {
                    Nodes => assert_outcome(row, list_nodes(&session).await, &expected),
                    Storage => assert_outcome(row, list_storage(&session, "pve").await, &expected),
                    Bridges => assert_outcome(row, list_bridges(&session, "pve").await, &expected),
                    NextId => assert_outcome(row, get_next_vm_id(&session).await, &expected),
                    VmIdFree => {
                        assert_outcome(row, ensure_vm_id_free(&session, 101).await, &expected)
                    }
                    Privileges => {
                        let privileges = fetch_privileges(&session, "/vms/100").await;
                        assert_outcome(row, privileges, &expected)
                    }
                    VmStatus => {
                        assert_outcome(row, vm_status(&session, "pve", 100).await, &expected)
                    }
                }
                assert!(mock.matched_async().await, "{row}: not asked once");
            }
        }

        async fn mock_bridges(server: &mut Server, data: serde_json::Value) -> Mock {
            server
                .mock("GET", "/api2/json/nodes/pve/network")
                .match_query(Matcher::UrlEncoded(
                    "type".to_string(),
                    "any_bridge".to_string(),
                ))
                .match_header("Cookie", "PVEAuthCookie=test-ticket")
                .with_body(serde_json::json!({"data": data}).to_string())
                .create_async()
                .await
        }

        /// Proxmox says VM ID 100 is still free; creating a VM checks that again.
        async fn mock_vm_id_free(server: &mut Server) -> Mock {
            server
                .mock("GET", "/api2/json/cluster/nextid")
                .match_query(Matcher::UrlEncoded("vmid".to_string(), "100".to_string()))
                .with_body(r#"{"data": "100"}"#)
                .create_async()
                .await
        }

        async fn mock_default_bridge(server: &mut Server) -> Mock {
            mock_bridges(
                server,
                serde_json::json!([{"iface":"vmbr0", "type":"bridge"}]),
            )
            .await
        }

        #[tokio::test]
        async fn test_list_bridges_includes_node_local_sdn_and_ovs() {
            let mut server = Server::new_async().await;
            let network = mock_bridges(
                &mut server,
                serde_json::json!([
                    {"iface":"vmbr1", "type":"OVSBridge"},
                    {"iface":"lan", "type":"vnet", "comments":"Home network", "active":"1"},
                    {"iface":"vmbr0", "type":"bridge"},
                    {"iface":"eth0", "type":"eth"}
                ]),
            )
            .await;
            let bridges = list_bridges(&session(server.url()), "pve").await.unwrap();
            assert_eq!(
                bridges.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
                ["lan", "vmbr0", "vmbr1"]
            );
            assert_eq!(bridges[0].network_type, "vnet");
            assert_eq!(bridges[0].comments.as_deref(), Some("Home network"));
            network.assert_async().await;
        }

        #[tokio::test]
        async fn test_list_bridges_empty_or_permission_filtered() {
            let mut server = Server::new_async().await;
            let network = mock_bridges(&mut server, serde_json::json!([])).await;
            assert!(list_bridges(&session(server.url()), "pve")
                .await
                .unwrap()
                .is_empty());
            let result = ensure_bridge_available(&session(server.url()), &vm_config()).await;
            assert_eq!(
                action_required(result),
                message!(
                    "backend.proxmox.bridge_unavailable",
                    bridge = "vmbr0",
                    node = "pve",
                )
            );
            network.expect(2).assert_async().await;
        }

        #[tokio::test]
        async fn test_bridge_validation_rejects_net0_and_path_injection_before_create() {
            let mut server = Server::new_async().await;
            mock_vm_id_free(&mut server).await;
            mock_default_bridge(&mut server).await;
            for name in [
                "",
                "vmbr0,tag=10",
                "vmbr0\n",
                "../vmbr0",
                "..",
                "vmbr0&firewall=0",
                "vmbr0/100",
            ] {
                let mut config = vm_config();
                config.bridge = name.to_string();
                let result = create_vm_with_disk(
                    &session(server.url()),
                    &config,
                    "image.qcow2",
                    "local",
                    &mut false,
                )
                .await;
                assert_eq!(
                    action_required(result),
                    message!(
                        "backend.proxmox.bridge_unavailable",
                        bridge = name,
                        node = "pve",
                    )
                );
            }
        }

        #[tokio::test]
        async fn test_selected_bridge_permission_path() {
            let mut server = Server::new_async().await;
            let network = mock_bridges(
                &mut server,
                serde_json::json!([{"iface":"vmbr1", "type":"bridge"}]),
            )
            .await;
            let permissions =
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr1", &["SDN.Use"]).await;
            let mut config = vm_config();
            config.bridge = "vmbr1".to_string();
            ensure_bridge_access(&session(server.url()), &config)
                .await
                .unwrap();
            network.assert_async().await;
            permissions.assert_async().await;
        }

        #[tokio::test]
        async fn test_vlan_capabilities_and_vlan_only_permissions() {
            for (network, supported, zone) in [
                (
                    serde_json::json!({"iface":"vmbr0","type":"bridge","bridge_vlan_aware":1}),
                    true,
                    "localnetwork",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"bridge","bridge_vlan_aware":"1"}),
                    true,
                    "localnetwork",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"bridge","bridge_vlan_aware":true}),
                    true,
                    "localnetwork",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"bridge","bridge_vlan_aware":0}),
                    false,
                    "localnetwork",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"bridge","bridge_vlan_aware":"0"}),
                    false,
                    "localnetwork",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"bridge"}),
                    false,
                    "localnetwork",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"OVSBridge"}),
                    true,
                    "localnetwork",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"vnet","vlanaware":1}),
                    true,
                    "home",
                ),
                (
                    serde_json::json!({"iface":"vmbr0","type":"vnet","bridge_vlan_aware":1}),
                    false,
                    "home",
                ),
            ] {
                let mut server = Server::new_async().await;
                let networks = mock_bridges(&mut server, serde_json::json!([network])).await;
                let vnet = server
                    .mock("GET", "/api2/json/cluster/sdn/vnets/vmbr0")
                    .with_body(r#"{"data":{"zone":"home"}}"#)
                    .expect(usize::from(supported && zone == "home"))
                    .create_async()
                    .await;
                let parent = server
                    .mock("GET", "/api2/json/access/permissions")
                    .match_query(Matcher::UrlEncoded(
                        "path".to_string(),
                        format!("/sdn/zones/{zone}/vmbr0"),
                    ))
                    .expect(0)
                    .create_async()
                    .await;
                let permissions = mock_privileges(
                    &mut server,
                    &format!("/sdn/zones/{zone}/vmbr0/42"),
                    &["SDN.Use"],
                )
                .await;
                let mut config = vm_config();
                config.vlan_tag = Some(42);
                let result = ensure_bridge_access(&session(server.url()), &config).await;
                if supported {
                    assert!(result.is_ok(), "{result:?}");
                    permissions.assert_async().await;
                } else {
                    assert_eq!(
                        action_required(result),
                        message!("backend.proxmox.bridge_not_vlan_aware", bridge = "vmbr0")
                    );
                }
                networks.assert_async().await;
                parent.assert_async().await;
                vnet.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_invalid_vlan_and_changed_capability_never_create_vm() {
            for tag in [0, 4095, u16::MAX] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                let network = server
                    .mock("GET", "/api2/json/nodes/pve/network")
                    .match_query(Matcher::Any)
                    .expect(0)
                    .create_async()
                    .await;
                let create = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .expect(0)
                    .create_async()
                    .await;
                let mut config = vm_config();
                config.vlan_tag = Some(tag);
                let mut source_unused = false;
                let result = create_vm_with_disk(
                    &session(server.url()),
                    &config,
                    "image.qcow2",
                    "local",
                    &mut source_unused,
                )
                .await;
                // Shown to the user as is, not replaced by generic API guidance
                assert_eq!(
                    action_required(result),
                    message!("backend.proxmox.vlan_tag_out_of_range")
                );
                assert!(source_unused);
                network.assert_async().await;
                create.assert_async().await;
            }
            let mut server = Server::new_async().await;
            mock_vm_id_free(&mut server).await;
            let network = mock_default_bridge(&mut server).await;
            let create = server
                .mock("POST", "/api2/json/nodes/pve/qemu")
                .expect(0)
                .create_async()
                .await;
            let mut config = vm_config();
            config.vlan_tag = Some(42);
            let mut source_unused = false;
            let result = create_vm_with_disk(
                &session(server.url()),
                &config,
                "image.qcow2",
                "local",
                &mut source_unused,
            )
            .await;
            assert_eq!(
                action_required(result),
                message!("backend.proxmox.bridge_not_vlan_aware", bridge = "vmbr0")
            );
            assert!(source_unused);
            network.assert_async().await;
            create.assert_async().await;
        }

        #[tokio::test]
        async fn test_tagged_vm_net0_and_permission_denial() {
            for tag in [1, 42, 4094] {
                for allowed in [false, true] {
                    let mut server = Server::new_async().await;
                    mock_vm_id_free(&mut server).await;
                    let network = mock_bridges(&mut server, serde_json::json!([{"iface":"vmbr0","type":"bridge","bridge_vlan_aware":1}])).await;
                    let permissions = mock_privileges(
                        &mut server,
                        &format!("/sdn/zones/localnetwork/vmbr0/{tag}"),
                        if allowed { &["SDN.Use"] } else { &[] },
                    )
                    .await;
                    let create = server
                        .mock("POST", "/api2/json/nodes/pve/qemu")
                        .match_body(Matcher::UrlEncoded(
                            "net0".to_string(),
                            format!("virtio,bridge=vmbr0,tag={tag}"),
                        ))
                        .with_body(serde_json::json!({ "data": UPID }).to_string())
                        .expect(usize::from(allowed))
                        .create_async()
                        .await;
                    let task = server
                        .mock("GET", task_path(UPID).as_str())
                        .with_body(TASK_OK)
                        .expect(usize::from(allowed))
                        .create_async()
                        .await;
                    let resize = server
                        .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                        .with_body(r#"{"data":"resize-task"}"#)
                        .expect(usize::from(allowed))
                        .create_async()
                        .await;
                    let resize_task = server
                        .mock("GET", task_path("resize-task").as_str())
                        .with_body(TASK_OK)
                        .expect(usize::from(allowed))
                        .create_async()
                        .await;
                    let mut config = vm_config();
                    config.vlan_tag = Some(tag);
                    let result = create_vm_with_disk(
                        &session(server.url()),
                        &config,
                        "image.qcow2",
                        "local",
                        &mut false,
                    )
                    .await;
                    if allowed {
                        assert!(result.is_ok(), "{result:?}");
                    } else {
                        assert_eq!(
                            action_required(result),
                            message!(
                                "backend.proxmox.missing_privileges",
                                privileges = "SDN.Use",
                                path = format!("/sdn/zones/localnetwork/vmbr0/{tag}"),
                            )
                        );
                    }
                    network.assert_async().await;
                    permissions.assert_async().await;
                    create.assert_async().await;
                    task.assert_async().await;
                    resize.assert_async().await;
                    resize_task.assert_async().await;
                }
            }
        }

        #[tokio::test]
        async fn test_sdn_permission_uses_edited_zone_and_requires_use() {
            for privileges in [vec!["SDN.Use"], vec!["SDN.Audit"], vec![]] {
                let mut server = Server::new_async().await;
                let network = mock_bridges(
                    &mut server,
                    serde_json::json!([{"iface":"lan", "type":"vnet"}]),
                )
                .await;
                // A pending move means the running zone differs from the
                // edited zone that Proxmox checks during VM creation.
                let running = server
                    .mock("GET", "/api2/json/cluster/sdn/vnets/lan")
                    .match_query(Matcher::UrlEncoded("running".to_string(), "1".to_string()))
                    .with_body(r#"{"data":{"zone":"oldzone"}}"#)
                    .expect(0)
                    .create_async()
                    .await;
                let vnet = server
                    .mock("GET", "/api2/json/cluster/sdn/vnets/lan")
                    .with_body(r#"{"data":{"vnet":"lan","type":"vnet","zone":"home"}}"#)
                    .create_async()
                    .await;
                let permissions =
                    mock_privileges(&mut server, "/sdn/zones/home/lan", &privileges).await;
                let mut config = vm_config();
                config.bridge = "lan".to_string();
                let result = ensure_bridge_access(&session(server.url()), &config).await;
                assert_eq!(result.is_ok(), privileges.contains(&"SDN.Use"));
                network.assert_async().await;
                vnet.assert_async().await;
                running.assert_async().await;
                permissions.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_sdn_metadata_failure_is_not_treated_as_local_bridge() {
            for status in [401, 403, 500] {
                let mut server = Server::new_async().await;
                let network = mock_bridges(
                    &mut server,
                    serde_json::json!([{"iface":"lan", "type":"vnet"}]),
                )
                .await;
                let vnet = server
                    .mock("GET", "/api2/json/cluster/sdn/vnets/lan")
                    .match_query(Matcher::Any)
                    .with_status(status)
                    .create_async()
                    .await;
                let mut config = vm_config();
                config.bridge = "lan".to_string();
                let result = ensure_bridge_access(&session(server.url()), &config).await;
                match status {
                    401 => assert!(matches!(result, Err(Error::ProxmoxSessionExpired))),
                    403 => assert_eq!(
                        action_required(result),
                        message!("backend.proxmox.missing_sdn_audit", vnet = "lan")
                    ),
                    _ => assert!(matches!(result, Err(Error::ProxmoxApi(_)))),
                }
                network.assert_async().await;
                vnet.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_invalid_sdn_zone_never_reaches_permissions_or_create() {
            for zone in [
                "",
                "..",
                "../home",
                "home/lan",
                "home,tag=10",
                "localnetwork",
            ] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                let network = mock_bridges(
                    &mut server,
                    serde_json::json!([{"iface":"lan", "type":"vnet"}]),
                )
                .await;
                let vnet = server
                    .mock("GET", "/api2/json/cluster/sdn/vnets/lan")
                    .match_query(Matcher::Any)
                    .with_body(serde_json::json!({"data":{"zone":zone}}).to_string())
                    .create_async()
                    .await;
                let mut config = vm_config();
                config.bridge = "lan".to_string();
                let error = create_vm_with_disk(
                    &session(server.url()),
                    &config,
                    "image.qcow2",
                    "local",
                    &mut false,
                )
                .await
                .unwrap_err();
                assert!(error.to_string().contains("invalid SDN zone"), "{error}");
                network.assert_async().await;
                vnet.assert_async().await;
            }
        }

        /// Mock `/access/permissions` for one path, in the shape Proxmox returns.
        async fn mock_privileges(server: &mut Server, path: &str, privileges: &[&str]) -> Mock {
            let granted: serde_json::Map<String, serde_json::Value> = privileges
                .iter()
                .map(|privilege| (privilege.to_string(), serde_json::json!(1)))
                .collect();
            server
                .mock("GET", "/api2/json/access/permissions")
                .match_query(Matcher::UrlEncoded("path".to_string(), path.to_string()))
                .with_body(serde_json::json!({ "data": { path: granted } }).to_string())
                .create_async()
                .await
        }

        async fn mock_import_config(server: &mut Server, data: serde_json::Value) -> Mock {
            server
                .mock("GET", "/api2/json/storage/local")
                .match_header("Cookie", "PVEAuthCookie=test-ticket")
                .with_body(serde_json::json!({ "data": data }).to_string())
                .create_async()
                .await
        }

        fn import_config(content: &str) -> serde_json::Value {
            serde_json::json!({
                "type": "dir", "content": content,
                "digest": "0123456789abcdef0123456789abcdef01234567",
                "path": "/var/lib/vz", "nodes": "pve,pve2", "shared": 0,
                "prune-backups": "keep-last=3"
            })
        }

        async fn mock_import_availability(server: &mut Server, entries: serde_json::Value) -> Mock {
            server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_body(serde_json::json!({ "data": entries }).to_string())
                .create_async()
                .await
        }

        #[tokio::test]
        async fn test_enable_storage_import_preserves_config_and_guards_update() {
            let mut outcomes = Vec::new();
            for (status, body) in [
                (200, r#"{"data":null}"#),
                (200, r#"{"data":{"storage":"local","type":"dir"}}"#),
                (200, ""),
                (200, "not JSON"),
                (200, r#"{"data":"unexpected shape"}"#),
                (500, r#"{"message":"detected modified configuration"}"#),
                (403, r#"{"message":"permission check failed"}"#),
                (401, r#"{"message":"ticket expired"}"#),
                (200, r#"{"message":"unexpected response"}"#),
            ] {
                let mut server = Server::new_async().await;
                let config =
                    mock_import_config(&mut server, import_config("images,iso,backup,snippets"))
                        .await;
                let available = mock_import_availability(
                    &mut server,
                    serde_json::json!([
                        {"storage":"local", "type":"dir", "active":1}
                    ]),
                )
                .await;
                let permission =
                    mock_privileges(&mut server, "/storage", &["Datastore.Allocate"]).await;
                let update = server.mock("PUT", "/api2/json/storage/local")
                    .match_header("Cookie", "PVEAuthCookie=test-ticket")
                    .match_header("CSRFPreventionToken", "test-csrf")
                    // Exact body also proves unrelated configuration is not rewritten.
                    .match_body("content=images%2Ciso%2Cbackup%2Csnippets%2Cimport&digest=0123456789abcdef0123456789abcdef01234567")
                    .with_status(status).with_body(body).expect(1).create_async().await;
                let result = enable_storage_import(&session(server.url()), "pve", "local").await;
                outcomes.push((status, body, result.as_ref().is_ok_and(|changed| *changed)));
                if status == 401 {
                    assert!(matches!(result.unwrap_err(), Error::ProxmoxSessionExpired));
                } else if status != 200 {
                    assert_eq!(
                        action_required(result),
                        message!("backend.proxmox.import_not_enabled", storage = "local")
                    );
                }
                config.assert_async().await;
                available.assert_async().await;
                permission.assert_async().await;
                update.assert_async().await;
            }
            assert!(
                outcomes
                    .iter()
                    .all(|(status, _, changed)| *changed == (*status == 200)),
                "unexpected mutation attribution: {outcomes:?}"
            );
        }

        #[tokio::test]
        async fn test_enable_storage_import_already_enabled_does_not_write() {
            let mut server = Server::new_async().await;
            let config = mock_import_config(&mut server, import_config("iso,import,backup")).await;
            let available = mock_import_availability(
                &mut server,
                serde_json::json!([
                    {"storage":"local", "type":"dir", "active":1}
                ]),
            )
            .await;
            let update = server
                .mock("PUT", "/api2/json/storage/local")
                .expect(0)
                .create_async()
                .await;
            assert!(
                !enable_storage_import(&session(server.url()), "pve", "local")
                    .await
                    .unwrap()
            );
            config.assert_async().await;
            available.assert_async().await;
            update.assert_async().await;
        }

        #[tokio::test]
        async fn test_enable_storage_import_replaces_none_content_marker() {
            let mut server = Server::new_async().await;
            let config = mock_import_config(&mut server, import_config("none")).await;
            let available = mock_import_availability(
                &mut server,
                serde_json::json!([
                    {"storage":"local", "type":"dir", "active":1}
                ]),
            )
            .await;
            let permission =
                mock_privileges(&mut server, "/storage", &["Datastore.Allocate"]).await;
            let update = server
                .mock("PUT", "/api2/json/storage/local")
                .match_body("content=import&digest=0123456789abcdef0123456789abcdef01234567")
                .with_body(r#"{"data":null}"#)
                .create_async()
                .await;
            assert!(
                enable_storage_import(&session(server.url()), "pve", "local")
                    .await
                    .unwrap()
            );
            config.assert_async().await;
            available.assert_async().await;
            permission.assert_async().await;
            update.assert_async().await;
        }

        #[tokio::test]
        async fn test_enable_storage_import_rejects_unsuitable_node_storage() {
            for entries in [
                serde_json::json!([]),
                serde_json::json!([{"storage":"local", "type":"dir", "active":0}]),
                serde_json::json!([{"storage":"local", "type":"lvmthin", "active":1}]),
                serde_json::json!([{"storage":"other", "type":"dir", "active":1}]),
            ] {
                let mut server = Server::new_async().await;
                let config = mock_import_config(&mut server, import_config("iso")).await;
                let available = mock_import_availability(&mut server, entries).await;
                let update = server
                    .mock("PUT", "/api2/json/storage/local")
                    .expect(0)
                    .create_async()
                    .await;
                let result = enable_storage_import(&session(server.url()), "pve", "local").await;
                assert_eq!(
                    action_required(result),
                    message!(
                        "backend.proxmox.storage_not_directory",
                        storage = "local",
                        node = "pve",
                    )
                );
                config.assert_async().await;
                available.assert_async().await;
                update.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_enable_storage_import_requires_global_configuration_permission() {
            let mut server = Server::new_async().await;
            let config = mock_import_config(&mut server, import_config("iso")).await;
            let available = mock_import_availability(
                &mut server,
                serde_json::json!([
                    {"storage":"local", "type":"dir", "active":1}
                ]),
            )
            .await;
            let permission = mock_privileges(
                &mut server,
                "/storage",
                &["Datastore.AllocateTemplate", "Datastore.Audit"],
            )
            .await;
            let update = server
                .mock("PUT", "/api2/json/storage/local")
                .expect(0)
                .create_async()
                .await;
            let result = enable_storage_import(&session(server.url()), "pve", "local").await;
            assert_eq!(
                action_required(result),
                message!(
                    "backend.proxmox.missing_privileges",
                    privileges = "Datastore.Allocate",
                    path = "/storage",
                )
            );
            config.assert_async().await;
            available.assert_async().await;
            permission.assert_async().await;
            update.assert_async().await;
        }

        #[tokio::test]
        async fn test_enable_storage_import_rejects_invalid_config_without_writing() {
            let mut invalid_configs = vec![serde_json::Value::Null, serde_json::json!({})];
            for (field, value) in [
                ("digest", serde_json::json!("")),
                ("digest", serde_json::json!("bad")),
                ("content", serde_json::json!(null)),
                ("content", serde_json::json!("")),
                ("content", serde_json::json!("iso,,backup")),
            ] {
                let mut config = import_config("iso");
                config[field] = value;
                invalid_configs.push(config);
            }
            for invalid in invalid_configs {
                let mut server = Server::new_async().await;
                let config = mock_import_config(&mut server, invalid).await;
                let update = server
                    .mock("PUT", "/api2/json/storage/local")
                    .expect(0)
                    .create_async()
                    .await;
                let error = enable_storage_import(&session(server.url()), "pve", "local")
                    .await
                    .unwrap_err();
                assert!(error.to_string().contains("Invalid storage configuration"));
                config.assert_async().await;
                update.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_enable_storage_import_read_denied_or_session_expired() {
            for status in [401, 403, 404, 500] {
                let mut server = Server::new_async().await;
                let config = server
                    .mock("GET", "/api2/json/storage/local")
                    .with_status(status)
                    .create_async()
                    .await;
                let update = server
                    .mock("PUT", "/api2/json/storage/local")
                    .expect(0)
                    .create_async()
                    .await;
                let result = enable_storage_import(&session(server.url()), "pve", "local").await;
                match status {
                    401 => assert!(matches!(result, Err(Error::ProxmoxSessionExpired))),
                    403 => assert_eq!(
                        action_required(result),
                        message!(
                            "backend.proxmox.missing_datastore_allocate",
                            storage = "local"
                        )
                    ),
                    _ => assert!(
                        matches!(&result, Err(Error::ProxmoxApi(m)) if m.contains(&status.to_string())),
                        "{result:?}"
                    ),
                }
                config.assert_async().await;
                update.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_ensure_user_can_create_vm_allowed() {
            let mut server = Server::new_async().await;
            let _network = mock_default_bridge(&mut server).await;

            let vm_mock = mock_privileges(&mut server, "/vms/100", VM_CREATE_PRIVILEGES).await;
            let bridge_mock =
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"]).await;

            let result = ensure_user_can_create_vm(&session(server.url()), &vm_config()).await;
            assert!(result.is_ok(), "unexpected error: {:?}", result.err());

            vm_mock.assert_async().await;
            bridge_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_ensure_user_can_create_vm_denied() {
            let mut server = Server::new_async().await;

            // A read-only user can log in fine but only has audit rights.
            let vm_mock = mock_privileges(&mut server, "/vms/100", &["VM.Audit"]).await;

            let result = ensure_user_can_create_vm(&session(server.url()), &vm_config()).await;
            assert_eq!(
                action_required(result),
                message!(
                    "backend.proxmox.missing_privileges",
                    privileges = VM_CREATE_PRIVILEGES.join(", "),
                    path = "/vms/100",
                )
            );

            vm_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_ensure_user_can_create_vm_needs_bridge_access() {
            let mut server = Server::new_async().await;
            let _network = mock_default_bridge(&mut server).await;

            let vm_mock = mock_privileges(&mut server, "/vms/100", VM_CREATE_PRIVILEGES).await;
            let bridge_mock =
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &[]).await;

            let result = ensure_user_can_create_vm(&session(server.url()), &vm_config()).await;
            assert_eq!(
                action_required(result),
                message!(
                    "backend.proxmox.missing_privileges",
                    privileges = "SDN.Use",
                    path = "/sdn/zones/localnetwork/vmbr0",
                )
            );

            vm_mock.assert_async().await;
            bridge_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_uploadable_import_storages_skips_storage_without_upload_permission() {
            let mut server = Server::new_async().await;

            let denied_mock =
                mock_privileges(&mut server, "/storage/shared-import", &["Datastore.Audit"]).await;
            let upload_only_mock = mock_privileges(
                &mut server,
                "/storage/upload-only",
                &["Datastore.AllocateTemplate"],
            )
            .await;
            let allowed_mock = mock_privileges(
                &mut server,
                "/storage/local",
                &["Datastore.AllocateTemplate", "Datastore.Audit"],
            )
            .await;

            // local-lvm can't take uploads, so its permissions are never asked for.
            let storage_list = vec![
                storage("shared-import", true, &["import"]),
                storage("upload-only", true, &["import"]),
                storage("local", true, &["iso", "import"]),
                storage("local-lvm", true, &["images"]),
            ];

            let result = uploadable_import_storages(&session(server.url()), &storage_list)
                .await
                .unwrap();
            let names: Vec<&str> = result.iter().map(|s| s.name.as_str()).collect();
            assert_eq!(names, vec!["local"]);

            denied_mock.assert_async().await;
            upload_only_mock.assert_async().await;
            allowed_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_uploadable_import_storages_reports_when_none_allowed() {
            let mut server = Server::new_async().await;

            let denied_mock =
                mock_privileges(&mut server, "/storage/local", &["Datastore.Audit"]).await;

            let storage_list = vec![storage("local", true, &["iso", "import"])];

            let result = uploadable_import_storages(&session(server.url()), &storage_list).await;
            assert_eq!(
                action_required(result),
                message!("backend.proxmox.import_storage_denied", storages = "local")
            );

            denied_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_create_vm_digest_failure_after_healthy_preflight() {
            let mut server = Server::new_async().await;
            let _network = mock_default_bridge(&mut server).await;

            let backend = OvaRelease {
                image: HaosImage {
                    board: "ova".into(),
                    format: ImageFormat::Qcow2,
                    download_url: format!("{}/image.xz", server.url()),
                    size: 8,
                    digest: Some(format!("sha256:{}", "0".repeat(64))),
                },
                cache: Some(tempfile::tempdir().unwrap()),
            };
            let asset_mock = server
                .mock("GET", "/image.xz")
                .with_body("tampered")
                .create_async()
                .await;
            let no_upload = server
                .mock("POST", Matcher::Any)
                .expect(0)
                .create_async()
                .await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_body(r#"{"data": [{"node": "pve", "status": "online"}]}"#)
                .create_async()
                .await;

            let permission_mocks = vec![
                mock_privileges(&mut server, "/vms/100", VM_CREATE_PRIVILEGES).await,
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"]).await,
                mock_privileges(
                    &mut server,
                    "/storage/local-lvm",
                    &["Datastore.AllocateSpace"],
                )
                .await,
                mock_privileges(
                    &mut server,
                    "/storage/local",
                    &["Datastore.AllocateTemplate", "Datastore.Audit"],
                )
                .await,
            ];

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_body(
                    r#"{
                        "data": [
                            {"storage": "local", "type": "dir", "content": "iso,import",
                             "avail": 100000000000, "total": 500000000000, "active": 1},
                            {"storage": "local-lvm", "type": "lvmthin", "content": "images,rootdir",
                             "avail": 200000000000, "total": 1000000000000, "active": 1}
                        ]
                    }"#,
                )
                .create_async()
                .await;

            let nextid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .match_query(Matcher::UrlEncoded("vmid".to_string(), "100".to_string()))
                .with_body(r#"{"data": "100"}"#)
                .create_async()
                .await;

            let result = create_vm(
                &backend,
                &session(server.url()),
                &vm_config(),
                &crate::NoOpProgress,
            )
            .await;
            assert!(
                matches!(result, Err(Error::ChecksumMismatch { .. })),
                "unexpected result: {result:?}"
            );
            let cache = backend.cache.unwrap();
            assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
            asset_mock.assert_async().await;
            no_upload.assert_async().await;

            nodes_mock.assert_async().await;
            for mock in permission_mocks {
                mock.assert_async().await;
            }
            storage_mock.assert_async().await;
            nextid_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_pre_install_checks_stop_at_offline_node() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_body(r#"{"data": [{"node": "pve", "status": "offline"}]}"#)
                .create_async()
                .await;

            // Nothing after the node check should run once it fails.
            let permissions_mock = server
                .mock("GET", "/api2/json/access/permissions")
                .match_query(Matcher::Any)
                .expect(0)
                .create_async()
                .await;

            let session = session(server.url());
            assert_eq!(
                action_required(pre_install_checks(&session, &vm_config(), 400_000_000).await),
                message!("backend.proxmox.node_offline", node = "pve")
            );

            nodes_mock.assert_async().await;
            permissions_mock.assert_async().await;
        }

        // The check before confirming runs the install's checks, and nothing past them.
        #[tokio::test]
        async fn test_check_install_runs_the_install_checks_without_downloading() {
            let mut server = Server::new_async().await;
            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_body(r#"{"data": [{"node": "pve", "status": "offline"}]}"#)
                .create_async()
                .await;
            let release = OvaRelease {
                image: HaosImage {
                    board: "ova".into(),
                    format: ImageFormat::Qcow2,
                    download_url: format!("{}/image.xz", server.url()),
                    size: 400_000_000,
                    digest: None,
                },
                cache: None,
            };

            let result = check_install(&release, &session(server.url()), &vm_config()).await;
            assert_eq!(
                action_required(result),
                message!("backend.proxmox.node_offline", node = "pve")
            );
            nodes_mock.assert_async().await;
        }

        /// How waiting for a task handles each answer to its status check.
        #[tokio::test]
        async fn test_wait_for_task_answers() {
            let warnings = r#"{"data":{"status":"stopped","exitstatus":"WARNINGS: 1"}}"#;
            let failed = r#"{"data":{"status":"stopped","exitstatus":"ERROR"}}"#;
            let no_such_task = r#"{"errors":{"upid":"no such task"},"data":null}"#;
            let retries = MAX_TASK_POLL_FAILURES as usize;
            // (row, status, body, status checks, task stopped, outcome)
            for (row, status, body, polls, stopped, expected) in [
                ("done", 200, TASK_OK, 1, true, Returns("()")),
                // Proxmox shows a task that ended with warnings as succeeded
                ("done with warnings", 200, warnings, 1, true, Returns("()")),
                (
                    "task failed",
                    200,
                    failed,
                    1,
                    true,
                    Api("Task failed with status: ERROR"),
                ),
                // A busy API may answer next time, but it isn't asked forever
                (
                    "server error",
                    500,
                    "",
                    retries,
                    false,
                    Api("(500 Internal Server Error)"),
                ),
                // Asking again won't change a rejection, so it says what Proxmox said
                (
                    "no such task",
                    400,
                    no_such_task,
                    1,
                    false,
                    Api(r#"(400 Bad Request): {"errors":{"upid":"no such task"}"#),
                ),
                // The ticket ran out during the wait: logging in again is the way out
                ("401", 401, "", 1, false, SessionExpired),
                ("403", 403, "", 1, false, Api("(403 Forbidden)")),
                ("404", 404, "", 1, false, Api("(404 Not Found)")),
                (
                    "without data",
                    200,
                    "{}",
                    1,
                    false,
                    Api("Invalid task status response"),
                ),
                // A complete answer that isn't JSON won't parse the next time either
                (
                    "not JSON",
                    200,
                    "not json",
                    1,
                    false,
                    Api("Failed to parse task status"),
                ),
            ] {
                let mut server = Server::new_async().await;
                let task = server
                    .mock("GET", task_path(UPID).as_str())
                    .with_status(status)
                    .with_body(body)
                    .expect(polls)
                    .create_async()
                    .await;
                let mut task_stopped = false;
                let session = session(server.url());
                let result =
                    wait_for_task_completion(&session, "pve", UPID, 10, &mut task_stopped).await;
                assert_outcome(row, result, &expected);
                assert_eq!(task_stopped, stopped, "{row}: task stopped");
                assert!(task.matched_async().await, "{row}: not asked {polls} times");
            }
        }

        #[tokio::test]
        async fn test_wait_for_task_timeout() {
            let mut server = Server::new_async().await;
            let task_mock = server
                .mock("GET", task_path(UPID).as_str())
                .with_body(r#"{"data": {"status": "running"}}"#)
                .expect_at_least(1)
                .create_async()
                .await;

            let result = wait_for_task(&session(server.url()), "pve", UPID, 1).await;
            assert!(
                matches!(&result, Err(Error::ProxmoxApi(msg)) if msg.contains("timed out")),
                "{result:?}"
            );

            task_mock.assert_async().await;
        }

        #[test]
        fn test_task_node_comes_from_the_upid() {
            assert_eq!(
                task_node("UPID:pve2:0012ABCD:00ABCDEF:6703A1B2:imgcopy::root@pam:"),
                Some("pve2")
            );
            assert_eq!(task_node("UPID::00000001:"), None);
            assert_eq!(task_node("not a upid"), None);
        }

        /// In a cluster the task can run on another node than the one the
        /// request went to; its status only exists on the node in the UPID.
        #[tokio::test]
        async fn test_wait_for_task_polls_the_node_from_the_upid() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve2/tasks/UPID%3Apve2%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_body(TASK_OK)
                .create_async()
                .await;

            let result = wait_for_task(
                &session(server.url()),
                "pve1",
                "UPID:pve2:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;
            assert!(result.is_ok(), "{result:?}");

            task_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_wait_for_task_survives_a_few_server_errors() {
            let mut server = Server::new_async().await;

            // mockito serves the first mock until its expected hits are used up.
            let failing = server
                .mock("GET", task_path(UPID).as_str())
                .with_status(503)
                .expect(MAX_TASK_POLL_FAILURES as usize - 1)
                .create_async()
                .await;
            let done = mock_task(&mut server, UPID, TASK_OK).await;

            let result = wait_for_task(&session(server.url()), "pve", UPID, 10).await;
            assert!(result.is_ok(), "{result:?}");

            failing.assert_async().await;
            done.assert_async().await;
        }

        /// Failures only count while they're in a row; a good poll in
        /// between starts the count over.
        #[tokio::test]
        async fn test_wait_for_task_resets_failures_after_a_good_poll() {
            let mut server = Server::new_async().await;
            let path = task_path(UPID);
            let below_limit = MAX_TASK_POLL_FAILURES as usize - 1;

            let first_failures = server
                .mock("GET", path.as_str())
                .with_status(500)
                .expect(below_limit)
                .create_async()
                .await;
            let running = server
                .mock("GET", path.as_str())
                .with_body(r#"{"data":{"status":"running"}}"#)
                .expect(1)
                .create_async()
                .await;
            let second_failures = server
                .mock("GET", path.as_str())
                .with_status(500)
                .expect(below_limit)
                .create_async()
                .await;
            let done = mock_task(&mut server, UPID, TASK_OK).await;

            let result = wait_for_task(&session(server.url()), "pve", UPID, 10).await;
            assert!(result.is_ok(), "{result:?}");

            first_failures.assert_async().await;
            running.assert_async().await;
            second_failures.assert_async().await;
            done.assert_async().await;
        }

        /// A dropped connection is a network error, the same path a request
        /// timeout takes, without waiting 30 seconds for one.
        #[tokio::test]
        async fn test_wait_for_task_survives_a_dropped_connection() {
            let (url, server) =
                raw_server(vec![String::new(), raw_response("200 OK", TASK_OK, false)]).await;

            let result = wait_for_task(&session(url), "pve", UPID, 10).await;
            assert!(result.is_ok(), "{result:?}");
            assert!(server.await.unwrap(), "asked again after the task was done");
        }

        /// The headers can arrive and the connection still drop before the
        /// whole body does. That is the same hiccup, so it is retried too.
        #[tokio::test]
        async fn test_wait_for_task_survives_a_cut_off_body() {
            let (url, server) = raw_server(vec![
                raw_response("200 OK", TASK_OK, true),
                raw_response("200 OK", TASK_OK, false),
            ])
            .await;

            let result = wait_for_task(&session(url), "pve", UPID, 10).await;
            assert!(result.is_ok(), "{result:?}");
            assert!(server.await.unwrap(), "asked again after the task was done");
        }

        /// A rejection stays a rejection when its body gets cut off, and the
        /// error still names the status.
        #[tokio::test]
        async fn test_wait_for_task_cut_off_rejection_is_not_retried() {
            let body = r#"{"errors":{"upid":"no such task"},"data":null}"#;
            let (url, server) = raw_server(vec![raw_response("404 Not Found", body, true)]).await;

            let result = wait_for_task(&session(url), "pve", UPID, 10).await;
            assert!(
                matches!(&result, Err(Error::ProxmoxApi(message)) if message.contains("404")),
                "{result:?}"
            );
            assert!(server.await.unwrap(), "the rejection was retried");
        }

        #[tokio::test]
        async fn test_create_vm_with_disk_success() {
            for disk_size_gb in [32, 64, 128, 256, 512] {
                check_create_vm_with_disk_size(disk_size_gb).await;
            }
        }

        async fn check_create_vm_with_disk_size(disk_size_gb: u32) {
            let mut server = Server::new_async().await;
            mock_vm_id_free(&mut server).await;
            let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
            let network = mock_bridges(
                &mut server,
                serde_json::json!([{"iface":"vmbr1", "type":"bridge"}]),
            )
            .await;
            let permissions =
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr1", &["SDN.Use"]).await;

            let vm_create_mock = server
                .mock("POST", "/api2/json/nodes/pve/qemu")
                .match_header("Cookie", Matcher::Regex("PVEAuthCookie=.*".to_string()))
                .match_header(
                    "CSRFPreventionToken",
                    Matcher::Regex("test-csrf".to_string()),
                )
                // The import source must use the selected storage, not a hardcoded "local".
                .match_body(Matcher::AllOf(vec![
                    Matcher::UrlEncoded(
                        "scsi0".to_string(),
                        "local-lvm:0,import-from=local-import:import/test-image.qcow2".to_string(),
                    ),
                    Matcher::UrlEncoded("net0".to_string(), "virtio,bridge=vmbr1".to_string()),
                    // The success screen promises the VM starts with the host
                    Matcher::UrlEncoded("onboot".to_string(), "1".to_string()),
                ]))
                .with_body(serde_json::json!({ "data": UPID }).to_string())
                .create_async()
                .await;

            let create_requests = requests.clone();
            let task_mock = server
                .mock("GET", task_path(UPID).as_str())
                .with_body_from_request(move |_| {
                    create_requests.lock().unwrap().push("import complete");
                    TASK_OK.into()
                })
                .expect_at_least(1)
                .create_async()
                .await;

            let resize_requests = requests.clone();
            let resize_mock = server
                .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                .match_header("Cookie", "PVEAuthCookie=test-ticket")
                .match_header("CSRFPreventionToken", "test-csrf")
                .match_body(Matcher::AllOf(vec![
                    Matcher::UrlEncoded("disk".into(), "scsi0".into()),
                    Matcher::UrlEncoded("size".into(), format!("{}G", disk_size_gb)),
                ]))
                .with_body_from_request(move |_| {
                    resize_requests.lock().unwrap().push("resize requested");
                    r#"{"data":"resize-task"}"#.into()
                })
                .create_async()
                .await;
            let resize_task_requests = requests.clone();
            let resize_task_mock = server
                .mock("GET", task_path("resize-task").as_str())
                .with_body_from_request(move |_| {
                    resize_task_requests.lock().unwrap().push("resize complete");
                    TASK_OK.into()
                })
                .create_async()
                .await;

            let config = ProxmoxVmConfig {
                bridge: "vmbr1".into(),
                disk_size_gb,
                ..vm_config()
            };
            let result = create_vm_with_disk(
                &session(server.url()),
                &config,
                "test-image.qcow2",
                "local-import",
                &mut false,
            )
            .await;
            assert!(result.is_ok(), "{result:?}");

            vm_create_mock.assert_async().await;
            network.assert_async().await;
            permissions.assert_async().await;
            task_mock.assert_async().await;
            resize_mock.assert_async().await;
            resize_task_mock.assert_async().await;
            assert_eq!(
                *requests.lock().unwrap(),
                ["import complete", "resize requested", "resize complete"]
            );
        }

        #[tokio::test]
        async fn test_disk_minimum_rejected_before_download_or_creation() {
            let session = session("http://127.0.0.1:1".into());
            for size in [0, 1, 31] {
                let config = ProxmoxVmConfig {
                    disk_size_gb: size,
                    ..vm_config()
                };
                let too_small = message!("backend.proxmox.disk_too_small", size = 32);
                let result = create_vm(&Backend, &session, &config, &crate::NoOpProgress).await;
                assert_eq!(action_required(result), too_small);
                // The check before confirming rejects it the same way
                let result = Backend.check_vm_config(&session, &config).await;
                assert_eq!(action_required(result), too_small);
            }
        }

        #[test]
        fn test_disk_resize_keeps_a_certificate_change() {
            let config = vm_config();
            assert!(matches!(
                resize_error(&config, Error::ProxmoxCertificateChanged),
                Error::ProxmoxCertificateChanged
            ));
            for error in [
                Error::ProxmoxApi("HTTP 500".into()),
                Error::ProxmoxSessionExpired,
            ] {
                assert_eq!(
                    action_required::<()>(Err(resize_error(&config, error))),
                    message!(
                        "backend.proxmox.vm_created_resize_failed",
                        vm_id = 100,
                        size_gb = 32,
                    )
                );
            }
        }

        #[tokio::test]
        async fn test_disk_resize_failures_propagate_from_creation() {
            for (status, body, task_status) in [
                (500, "Insufficient storage", None),
                (403, "Permission denied", None),
                (200, "invalid json", None),
                (200, r#"{"data":null}"#, None),
                (200, r#"{"data":""}"#, None),
                (200, r#"{"data":12}"#, None),
                (
                    200,
                    r#"{"data":"resize-task"}"#,
                    Some("shrinking disks is not supported"),
                ),
            ] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                // Creating the VM first rechecks the selected bridge
                let _network = mock_default_bridge(&mut server).await;
                let _permissions =
                    mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"])
                        .await;
                let create_mock = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_body(r#"{"data":"create-task"}"#)
                    .create_async()
                    .await;
                let create_task = mock_task(&mut server, "create-task", TASK_OK).await;
                let resize_mock = server
                    .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                    .with_status(status)
                    .with_body(body)
                    .create_async()
                    .await;
                let resize_task = server
                    .mock("GET", task_path("resize-task").as_str())
                    .with_body(
                        serde_json::json!({
                            "data": {"status": "stopped", "exitstatus": task_status}
                        })
                        .to_string(),
                    )
                    .expect(usize::from(task_status.is_some()))
                    .create_async()
                    .await;
                let delete = server
                    .mock(
                        "DELETE",
                        "/api2/json/nodes/pve/storage/local/content/local%3Aimport%2Fhaos.qcow2",
                    )
                    .with_status(500)
                    .create_async()
                    .await;
                let result = import_and_cleanup_image(
                    &session(server.url()),
                    &vm_config(),
                    "haos.qcow2",
                    "local",
                )
                .await;
                // Every resize failure leaves the VM behind, so each one tells
                // the user to remove it, without the server's response
                assert_eq!(
                    action_required(result),
                    message!(
                        "backend.proxmox.vm_created_resize_failed",
                        vm_id = 100,
                        size_gb = 32,
                    )
                );
                create_mock.assert_async().await;
                create_task.assert_async().await;
                resize_mock.assert_async().await;
                resize_task.assert_async().await;
                delete.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_disk_resize_requires_successful_import() {
            for body in [r#"{"data":null}"#, r#"{"data":"create-task"}"#] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                // Creating the VM first rechecks the selected bridge
                let _network = mock_default_bridge(&mut server).await;
                let _permissions =
                    mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"])
                        .await;
                let create_mock = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_body(body)
                    .create_async()
                    .await;
                let create_task = server
                    .mock("GET", task_path("create-task").as_str())
                    .with_body(r#"{"data":{"status":"stopped","exitstatus":"import failed"}}"#)
                    .expect(usize::from(body.contains("create-task")))
                    .create_async()
                    .await;
                let resize_mock = server
                    .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                    .expect(0)
                    .create_async()
                    .await;
                let config = ProxmoxVmConfig {
                    disk_size_gb: 64,
                    ..vm_config()
                };
                let session = session(server.url());
                let result =
                    create_vm_with_disk(&session, &config, "haos.qcow2", "local", &mut false).await;
                assert!(result.is_err());
                create_mock.assert_async().await;
                create_task.assert_async().await;
                resize_mock.assert_async().await;
            }
        }

        /// A write call whose answer can't be used never waits for a task.
        #[tokio::test]
        async fn test_write_answers_without_a_task() {
            #[derive(Clone, Copy)]
            enum Call {
                Upload,
                Start,
                Create,
                Delete,
            }
            use Call::*;

            let temp_dir = tempfile::tempdir().unwrap();
            let image = temp_dir.path().join("image.qcow2");
            std::fs::write(&image, b"test image content").unwrap();
            let no_upid = || Api("The import deletion response has no task UPID");
            // (row, call, status, body, outcome)
            for (row, call, status, body, expected) in [
                (
                    "upload 500",
                    Upload,
                    500,
                    "Internal Server Error",
                    Api("Failed to upload image to Proxmox (500 Internal Server Error)"),
                ),
                ("upload 401", Upload, 401, "", SessionExpired),
                (
                    "upload not JSON",
                    Upload,
                    200,
                    "not json",
                    Api("Failed to parse upload response"),
                ),
                (
                    "upload without UPID",
                    Upload,
                    200,
                    r#"{"data": null}"#,
                    Api("The upload response has no task UPID"),
                ),
                (
                    "start 500",
                    Start,
                    500,
                    "Failed to start VM",
                    Api("Failed to start VM (500 Internal Server Error): Failed to start VM"),
                ),
                ("start 401", Start, 401, "", SessionExpired),
                // Like every other write, a start is only done once its task is
                (
                    "start without UPID",
                    Start,
                    200,
                    r#"{"data":null}"#,
                    Api("The VM start response has no task UPID"),
                ),
                (
                    "create 500",
                    Create,
                    500,
                    "Internal server error",
                    Api("Failed to create VM (500 Internal Server Error)"),
                ),
                ("create 401", Create, 401, "", SessionExpired),
                ("delete without data", Delete, 200, "{}", no_upid()),
                (
                    "delete without UPID",
                    Delete,
                    200,
                    r#"{"data":null}"#,
                    no_upid(),
                ),
                (
                    "delete with empty UPID",
                    Delete,
                    200,
                    r#"{"data":""}"#,
                    no_upid(),
                ),
                (
                    "delete with a number",
                    Delete,
                    200,
                    r#"{"data":42}"#,
                    no_upid(),
                ),
            ] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                if matches!(call, Create) {
                    // Creating the VM first rechecks the selected bridge
                    mock_default_bridge(&mut server).await;
                    mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"])
                        .await;
                }
                let (method, path) = match call {
                    Upload => ("POST", "/api2/json/nodes/pve/storage/local/upload"),
                    Start => ("POST", "/api2/json/nodes/pve/qemu/100/status/start"),
                    Create => ("POST", "/api2/json/nodes/pve/qemu"),
                    Delete => (
                        "DELETE",
                        "/api2/json/nodes/pve/storage/local/content/local%3Aimport%2Fimage.qcow2",
                    ),
                };
                let request = server
                    .mock(method, path)
                    .with_status(status)
                    .with_body(body)
                    .create_async()
                    .await;
                let task = server
                    .mock("GET", Matcher::Regex("/tasks/".into()))
                    .expect(0)
                    .create_async()
                    .await;
                let session = session(server.url());
                let result = match call {
                    Upload => upload_image_to_proxmox(
                        &session,
                        "pve",
                        &image,
                        &crate::NoOpProgress,
                        "local",
                    )
                    .await
                    .map(drop),
                    Start => start_vm(&session, "pve", 100).await,
                    Create => {
                        create_vm_with_disk(
                            &session,
                            &vm_config(),
                            "image.qcow2",
                            "local",
                            &mut false,
                        )
                        .await
                    }
                    Delete => delete_import_image(&session, "pve", "local", "image.qcow2").await,
                };
                assert_outcome(row, result, &expected);
                assert!(request.matched_async().await, "{row}: not sent once");
                assert!(task.matched_async().await, "{row}: waited for a task");
            }
        }

        #[tokio::test]
        async fn stop_after_upload_deletes_the_image() {
            let mut server = Server::new_async().await;
            let session = session(server.url());

            // Without a stop, nothing is deleted
            let untouched = server
                .mock("DELETE", Matcher::Any)
                .expect(0)
                .create_async()
                .await;
            let progress = TestProgress::default();
            discard_upload_if_stopped(&session, "pve", "local-import", "hai.qcow2", &progress)
                .await
                .unwrap();
            untouched.assert_async().await;
            untouched.remove_async().await;

            // A failed cleanup still stops, but names what was left behind
            let delete = server
                .mock(
                    "DELETE",
                    "/api2/json/nodes/pve/storage/local-import/content/local-import%3Aimport%2Fhai.qcow2",
                )
                .with_status(500)
                .create_async()
                .await;
            progress.stop();
            let result =
                discard_upload_if_stopped(&session, "pve", "local-import", "hai.qcow2", &progress)
                    .await;
            assert_eq!(
                action_required(result),
                message!(
                    "backend.proxmox.leftover_import_image",
                    volume = "local-import:import/hai.qcow2",
                    node = "pve",
                )
            );
            delete.assert_async().await;
            delete.remove_async().await;

            // A cleanup that works ends as a plain stop
            let delete = server
                .mock(
                    "DELETE",
                    "/api2/json/nodes/pve/storage/local-import/content/local-import%3Aimport%2Fhai.qcow2",
                )
                .with_body(serde_json::json!({ "data": UPID }).to_string())
                .create_async()
                .await;
            let task = mock_task(&mut server, UPID, TASK_OK).await;
            let error =
                discard_upload_if_stopped(&session, "pve", "local-import", "hai.qcow2", &progress)
                    .await
                    .unwrap_err();
            assert!(matches!(error, Error::Cancelled), "{error:?}");
            delete.assert_async().await;
            task.assert_async().await;
        }

        #[tokio::test]
        async fn stop_after_the_body_is_sent_waits_for_proxmox() {
            use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let session = session(format!("http://{}", listener.local_addr().unwrap()));
            let temp_dir = tempfile::tempdir().unwrap();
            let path = temp_dir.path().join("hai.qcow2");
            std::fs::write(&path, vec![0; 1024 * 1024]).unwrap();
            let progress = TestProgress::default();

            let server = async {
                let mut task_polled = false;
                while !task_polled {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut socket = tokio::io::BufReader::new(socket);
                    let mut request_line = String::new();
                    socket.read_line(&mut request_line).await.unwrap();
                    let mut content_length = 0;
                    loop {
                        let mut header = String::new();
                        socket.read_line(&mut header).await.unwrap();
                        if header == "\r\n" {
                            break;
                        }
                        if let Some(length) =
                            header.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            content_length = length.trim().parse().unwrap();
                        }
                    }

                    let body = if request_line.starts_with("POST") {
                        // Proxmox has the whole image and starts storing it;
                        // the stop lands well before its answer does
                        let mut upload = vec![0; content_length];
                        socket.read_exact(&mut upload).await.unwrap();
                        progress.stop();
                        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                        r#"{"data":"UPID:pve:00000001:00000002:00000003:imgcopy:root@pam:"}"#
                    } else {
                        assert!(request_line.contains("imgcopy"), "{request_line}");
                        task_polled = true;
                        TASK_OK
                    };
                    let response = raw_response("200 OK", body, false);
                    socket.write_all(response.as_bytes()).await.unwrap();
                }
            };

            // The upload must wait for Proxmox, so the image can be deleted
            let upload = upload_image_to_proxmox(&session, "pve", &path, &progress, "local-import");
            let (_, result) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                tokio::join!(server, upload)
            })
            .await
            .expect("the upload must finish once Proxmox answers");
            assert_eq!(result.unwrap(), "hai.qcow2");
        }

        #[tokio::test]
        async fn stop_during_upload_drops_the_request() {
            use tokio::io::AsyncReadExt;

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let session = session(format!("http://{}", listener.local_addr().unwrap()));
            let temp_dir = tempfile::tempdir().unwrap();
            let path = temp_dir.path().join("large.qcow2");
            std::fs::File::create(&path)
                .unwrap()
                .set_len(128 * 1024 * 1024)
                .unwrap();
            let progress = TestProgress::default();

            let server = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 64 * 1024];
                let mut received = 0;
                while received < 1024 * 1024 {
                    received += socket.read(&mut buffer).await.unwrap();
                }

                // Stall without ever answering; only the stop can end this.
                // Reading nothing for a while keeps most of the body unsent.
                progress.stop();
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                while socket.read(&mut buffer).await.unwrap_or(0) > 0 {}
            };
            let upload = upload_image_to_proxmox(&session, "pve", &path, &progress, "local");
            let (_, result) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                tokio::join!(server, upload)
            })
            .await
            .expect("a stop must end the upload, and close the connection");
            assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
        }

        #[tokio::test]
        async fn failed_bridge_recheck_deletes_unused_import_without_creating_vm() {
            for bridge_removed in [true, false] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                let session = session(server.url());
                let config = vm_config();
                let initial_network = mock_default_bridge(&mut server).await;
                let initial_permissions =
                    mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"])
                        .await;
                ensure_bridge_access(&session, &config).await.unwrap();
                initial_network.assert_async().await;
                initial_permissions.assert_async().await;
                initial_network.remove_async().await;
                initial_permissions.remove_async().await;

                // Simulate a network change after the image has been uploaded.
                let network = mock_bridges(
                    &mut server,
                    if bridge_removed {
                        serde_json::json!([])
                    } else {
                        serde_json::json!([{"iface":"vmbr0", "type":"bridge"}])
                    },
                )
                .await;
                let permissions =
                    mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &[]).await;
                let create = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .expect(0)
                    .create_async()
                    .await;
                let delete = server.mock("DELETE", "/api2/json/nodes/pve/storage/local-import/content/local-import%3Aimport%2Fhai-image-unique.qcow2")
                    .match_header("cookie", "PVEAuthCookie=test-ticket")
                    .match_header("CSRFPreventionToken", "test-csrf")
                    .with_body(r#"{"data":"delete-task"}"#).create_async().await;
                let cleanup_task = mock_task(&mut server, "delete-task", TASK_OK).await;
                let result = import_and_cleanup_image(
                    &session,
                    &config,
                    "hai-image-unique.qcow2",
                    "local-import",
                )
                .await;
                let expected = if bridge_removed {
                    message!(
                        "backend.proxmox.bridge_unavailable",
                        bridge = "vmbr0",
                        node = "pve",
                    )
                } else {
                    message!(
                        "backend.proxmox.missing_privileges",
                        privileges = "SDN.Use",
                        path = "/sdn/zones/localnetwork/vmbr0",
                    )
                };
                assert_eq!(action_required(result), expected);
                network.assert_async().await;
                if !bridge_removed {
                    permissions.assert_async().await;
                }
                create.assert_async().await;
                delete.assert_async().await;
                cleanup_task.assert_async().await;
            }
        }

        #[tokio::test]
        async fn vm_id_taken_during_the_upload_deletes_the_image_without_creating_a_vm() {
            let mut server = Server::new_async().await;
            let session = session(server.url());
            // Someone created VM 100 while the image was being uploaded
            let vm_id = server
                .mock("GET", "/api2/json/cluster/nextid")
                .match_query(Matcher::UrlEncoded("vmid".to_string(), "100".to_string()))
                .with_status(400)
                .with_body(r#"{"errors": {"vmid": "VM 100 already exists"}, "data": null}"#)
                .create_async()
                .await;
            let create = server
                .mock("POST", "/api2/json/nodes/pve/qemu")
                .expect(0)
                .create_async()
                .await;
            let delete = server
                .mock(
                    "DELETE",
                    "/api2/json/nodes/pve/storage/local-import/content/local-import%3Aimport%2Fhai.qcow2",
                )
                .with_body(r#"{"data":"delete-task"}"#)
                .create_async()
                .await;
            let cleanup_task = mock_task(&mut server, "delete-task", TASK_OK).await;

            let result =
                import_and_cleanup_image(&session, &vm_config(), "hai.qcow2", "local-import").await;
            assert_eq!(
                action_required(result),
                message!("backend.proxmox.vm_id_unavailable", vm_id = 100)
            );
            vm_id.assert_async().await;
            create.assert_async().await;
            delete.assert_async().await;
            cleanup_task.assert_async().await;
        }

        #[tokio::test]
        async fn a_rejected_create_names_the_image_it_could_not_remove() {
            // (row, create status, outcome)
            for (row, status, expected) in [
                // Proxmox's rejection says nothing to act on; the image does
                (
                    "rejected",
                    400,
                    Action(message!(
                        "backend.proxmox.create_failed_image_left",
                        vm_id = 100,
                        volume = "local-import:import/hai.qcow2",
                        node = "pve",
                    )),
                ),
                // Logging in again is offered instead
                ("session expired", 401, SessionExpired),
            ] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                mock_default_bridge(&mut server).await;
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"]).await;
                server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_status(status)
                    .create_async()
                    .await;
                let delete = server
                    .mock("DELETE", Matcher::Any)
                    .with_status(500)
                    .create_async()
                    .await;

                let result = import_and_cleanup_image(
                    &session(server.url()),
                    &vm_config(),
                    "hai.qcow2",
                    "local-import",
                )
                .await;
                assert_outcome(row, result, &expected);
                assert!(delete.matched_async().await, "{row}: no cleanup tried");
            }
        }

        #[test]
        fn a_slow_link_gets_more_time_for_a_big_image() {
            assert_eq!(upload_timeout(0), 1800);
            assert_eq!(upload_timeout(100_000_000), 1800);
            // A 1 GB image at 1 Mbit/s takes over two hours
            assert_eq!(upload_timeout(1_000_000_000), 8000);
        }

        #[tokio::test]
        async fn import_cleanup_waits_for_completion_and_preserves_install_result() {
            use std::sync::Arc;
            for cleanup_status in [200, 403, 500] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                let network = mock_default_bridge(&mut server).await;
                let permissions =
                    mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"])
                        .await;
                let completed = Arc::new(AtomicBool::new(false));
                let task_completed = completed.clone();
                let create = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_body(r#"{"data":"import-task"}"#)
                    .create_async()
                    .await;
                let task = server
                    .mock("GET", task_path("import-task").as_str())
                    .with_chunked_body(move |writer| {
                        task_completed.store(true, Ordering::SeqCst);
                        writer.write_all(TASK_OK.as_bytes())
                    })
                    .create_async()
                    .await;
                let resize = server
                    .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                    .with_body(r#"{"data":"resize-task"}"#)
                    .create_async()
                    .await;
                let resize_task = mock_task(&mut server, "resize-task", TASK_OK).await;
                let delete = server.mock("DELETE", "/api2/json/nodes/pve/storage/local-import/content/local-import%3Aimport%2Fhai-image-unique.qcow2")
                    .match_header("cookie", "PVEAuthCookie=test-ticket")
                    .match_header("CSRFPreventionToken", "test-csrf")
                    .with_status(cleanup_status)
                    .with_chunked_body(move |writer| {
                        assert!(completed.load(Ordering::SeqCst), "deleted before import completion");
                        writer.write_all(br#"{"data":"delete-task"}"#)
                    }).create_async().await;
                let cleanup_task = server
                    .mock("GET", task_path("delete-task").as_str())
                    .with_body(TASK_OK)
                    .expect(if cleanup_status == 200 { 1 } else { 0 })
                    .create_async()
                    .await;
                import_and_cleanup_image(
                    &session(server.url()),
                    &vm_config(),
                    "hai-image-unique.qcow2",
                    "local-import",
                )
                .await
                .unwrap();
                create.assert_async().await;
                task.assert_async().await;
                resize.assert_async().await;
                resize_task.assert_async().await;
                delete.assert_async().await;
                cleanup_task.assert_async().await;
                network.assert_async().await;
                permissions.assert_async().await;
            }
        }

        #[tokio::test]
        async fn failed_import_cleanup_requires_a_known_terminal_outcome() {
            for (create_status, response, task_status, task_body, deletes) in [
                (200, r#"{"data":null}"#, 200, "{}", 0),
                (200, r#"{"data":""}"#, 200, "{}", 0),
                (200, r#"{"data":"import-task"}"#, 503, "unavailable", 0),
                // A rejected session started no import, so the image goes
                (401, "", 200, "{}", 1),
                (403, "denied", 200, "{}", 1),
                (500, "unknown", 200, "{}", 0),
                (408, "timeout", 200, "{}", 0),
                (
                    200,
                    r#"{"data":"import-task"}"#,
                    200,
                    r#"{"data":{"status":"stopped","exitstatus":"disk full"}}"#,
                    1,
                ),
            ] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                let network = mock_default_bridge(&mut server).await;
                let permissions =
                    mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"])
                        .await;
                server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_status(create_status)
                    .with_body(response)
                    .create_async()
                    .await;
                server
                    .mock("GET", task_path("import-task").as_str())
                    .with_status(task_status)
                    .with_body(task_body)
                    .create_async()
                    .await;
                let delete = server
                    .mock("DELETE", Matcher::Any)
                    .with_status(500)
                    .expect(deletes)
                    .create_async()
                    .await;
                assert!(import_and_cleanup_image(
                    &session(server.url()),
                    &vm_config(),
                    "hai-image-unique.qcow2",
                    "local-import"
                )
                .await
                .is_err());
                delete.assert_async().await;
                network.assert_async().await;
                permissions.assert_async().await;
            }
        }

        #[tokio::test]
        async fn test_start_vm_success() {
            let mut server = Server::new_async().await;

            let start_mock = server
                .mock("POST", "/api2/json/nodes/pve/qemu/100/status/start")
                .match_header("cookie", "PVEAuthCookie=test-ticket")
                .match_header("CSRFPreventionToken", "test-csrf")
                .with_body(serde_json::json!({ "data": UPID }).to_string())
                .create_async()
                .await;
            let task_mock = mock_task(&mut server, UPID, TASK_OK).await;

            let result = start_vm(&session(server.url()), "pve", 100).await;
            assert!(result.is_ok(), "{result:?}");

            start_mock.assert_async().await;
            task_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_node_name_is_encoded_in_every_request() {
            let mut server = Server::new_async().await;
            let session = session(server.url());
            let node = "pve/node";

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve%2Fnode/storage")
                .with_body(r#"{"data": []}"#)
                .create_async()
                .await;
            let start_mock = server
                .mock("POST", "/api2/json/nodes/pve%2Fnode/qemu/100/status/start")
                .with_body(
                    r#"{"data": "UPID:pve/node:00000001:00000002:00000003:qmstart:100:root@pam:"}"#,
                )
                .create_async()
                .await;
            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve%2Fnode/tasks/UPID%3Apve%2Fnode%3A00000001%3A00000002%3A00000003%3Aqmstart%3A100%3Aroot%40pam%3A/status",
                )
                .with_body(TASK_OK)
                .create_async()
                .await;
            let status_mock = server
                .mock("GET", "/api2/json/nodes/pve%2Fnode/qemu/100/status/current")
                .with_body(r#"{"data": {"status": "stopped"}}"#)
                .create_async()
                .await;

            list_storage(&session, node).await.unwrap();
            start_vm(&session, node, 100).await.unwrap();
            vm_status(&session, node, 100).await.unwrap();

            storage_mock.assert_async().await;
            start_mock.assert_async().await;
            task_mock.assert_async().await;
            status_mock.assert_async().await;
        }

        const VM_STATUS_PATH: &str = "/api2/json/nodes/pve/qemu/100/status/current";
        const VM_AGENT_PATH: &str = "/api2/json/nodes/pve/qemu/100/agent/network-get-interfaces";

        async fn mock_vm_run_status(server: &mut Server, status: &str) -> Mock {
            server
                .mock("GET", VM_STATUS_PATH)
                .with_body(format!(r#"{{"data": {{"status": "{}"}}}}"#, status))
                .expect_at_least(1)
                .create_async()
                .await
        }

        #[tokio::test]
        async fn test_vm_status_running_with_ip() {
            let mut server = Server::new_async().await;
            let status_mock = mock_vm_run_status(&mut server, "running").await;
            let agent_mock = server
                .mock("GET", VM_AGENT_PATH)
                .with_body(
                    r#"{"data": {"result": [
                        {"name": "lo", "ip-addresses": []},
                        {"name": "eth0", "ip-addresses": [
                            {"ip-address-type": "ipv4", "ip-address": "192.168.1.100"}
                        ]}
                    ]}}"#,
                )
                .create_async()
                .await;

            let status = vm_status(&session(server.url()), "pve", 100).await.unwrap();
            assert_eq!(status.status, "running");
            assert_eq!(status.ip_address.as_deref(), Some("192.168.1.100"));

            status_mock.assert_async().await;
            agent_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_vm_status_no_ip_while_agent_is_not_up() {
            let mut server = Server::new_async().await;
            let session = session(server.url());
            let _status_mock = mock_vm_run_status(&mut server, "running").await;

            // What Proxmox answers while the guest agent is not running yet
            let error_mock = server
                .mock("GET", VM_AGENT_PATH)
                .with_status(500)
                .with_body(r#"{"data": null, "message": "QEMU guest agent is not running"}"#)
                .create_async()
                .await;
            let status = vm_status(&session, "pve", 100).await.unwrap();
            assert_eq!(status.status, "running");
            assert_eq!(status.ip_address, None);
            error_mock.assert_async().await;
            error_mock.remove_async().await;

            let unreadable_mock = server
                .mock("GET", VM_AGENT_PATH)
                .with_body("not json")
                .create_async()
                .await;
            let status = vm_status(&session, "pve", 100).await.unwrap();
            assert_eq!(status.ip_address, None);
            unreadable_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_vm_status_stops_on_what_waiting_cannot_fix() {
            // (row, agent status, outcome)
            for (row, status, expected) in [
                (
                    "no permission",
                    403,
                    Action(message!("backend.proxmox.guest_agent_denied")),
                ),
                ("session expired", 401, SessionExpired),
            ] {
                let mut server = Server::new_async().await;
                let _status_mock = mock_vm_run_status(&mut server, "running").await;
                server
                    .mock("GET", VM_AGENT_PATH)
                    .with_status(status)
                    .create_async()
                    .await;

                let result = vm_status(&session(server.url()), "pve", 100).await;
                assert_outcome(row, result, &expected);
            }
        }

        #[tokio::test]
        async fn test_vm_status_stopped_does_not_ask_the_agent() {
            let mut server = Server::new_async().await;
            let _status_mock = mock_vm_run_status(&mut server, "stopped").await;
            let agent_mock = server
                .mock("GET", VM_AGENT_PATH)
                .expect(0)
                .create_async()
                .await;

            let status = vm_status(&session(server.url()), "pve", 100).await.unwrap();
            assert_eq!(status.status, "stopped");
            assert_eq!(status.ip_address, None);

            agent_mock.assert_async().await;
        }

        #[test]
        fn test_find_vm_ip_skips_loopback_addresses() {
            let json = serde_json::json!({"data": {"result": [
                {"name": "eth0", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "127.0.0.1"},
                    {"ip-address-type": "ipv4", "ip-address": "192.168.1.100"}
                ]}
            ]}});

            assert_eq!(find_vm_ip(&json).as_deref(), Some("192.168.1.100"));
        }

        #[test]
        fn test_find_vm_ip_without_usable_address() {
            // Only loopback and IPv6: what a VM reports before DHCP finishes
            let json = serde_json::json!({"data": {"result": [
                {"name": "lo", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "127.0.0.1"}
                ]},
                {"name": "eth0", "ip-addresses": [
                    {"ip-address-type": "ipv6", "ip-address": "fe80::1"}
                ]}
            ]}});

            assert_eq!(find_vm_ip(&json), None);
        }

        #[test]
        fn test_find_vm_ip_skips_haos_docker_networks() {
            // Before the LAN lease only HAOS's own bridges have an IPv4
            let mut json = serde_json::json!({"data": {"result": [
                {"name": "enp0s18", "ip-addresses": [
                    {"ip-address-type": "ipv6", "ip-address": "fe80::1"}
                ]},
                {"name": "hassio", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "172.30.32.1"}
                ]},
                {"name": "docker0", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "172.30.232.1"}
                ]}
            ]}});
            assert_eq!(find_vm_ip(&json), None);

            json["data"]["result"][0]["ip-addresses"]
                .as_array_mut()
                .unwrap()
                .push(
                    serde_json::json!({"ip-address-type": "ipv4", "ip-address": "192.168.1.100"}),
                );
            assert_eq!(find_vm_ip(&json).as_deref(), Some("192.168.1.100"));
        }

        #[test]
        fn test_find_vm_ip_ignores_values_that_are_not_addresses() {
            let json = serde_json::json!({"data": {"result": [
                {"name": "eth0", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "10.0.0.5@example.org"},
                    {"ip-address-type": "ipv4", "ip-address": "10.0.0.6"}
                ]}
            ]}});

            assert_eq!(find_vm_ip(&json).as_deref(), Some("10.0.0.6"));
        }

        #[tokio::test]
        async fn test_upload_image_to_proxmox_success() {
            let mut server = Server::new_async().await;

            let temp_dir = tempfile::tempdir().unwrap();
            let temp_file = temp_dir.path().join("test-image.qcow2");
            std::fs::write(&temp_file, b"test image content").unwrap();

            // Mocking a non-default storage proves the upload URL uses the supplied name.
            let upload_mock = server
                .mock("POST", "/api2/json/nodes/pve/storage/local-import/upload")
                .match_header("cookie", "PVEAuthCookie=test-ticket")
                .match_header("CSRFPreventionToken", "test-csrf")
                .match_request(|request| {
                    let body = request.body().unwrap();
                    request
                        .header("content-length")
                        .first()
                        .and_then(|value| value.to_str().ok())
                        == Some(body.len().to_string().as_str())
                        && String::from_utf8_lossy(body).contains("test image content")
                        && String::from_utf8_lossy(body).contains("filename=\"test-image.qcow2\"")
                        && String::from_utf8_lossy(body).contains("\r\n\r\nimport\r\n")
                })
                .with_body(serde_json::json!({ "data": UPID }).to_string())
                .create_async()
                .await;
            let task_mock = mock_task(&mut server, UPID, TASK_OK).await;

            let callback = TestProgress::default();
            let result = upload_image_to_proxmox(
                &session(server.url()),
                "pve",
                &temp_file,
                &callback,
                "local-import",
            )
            .await;
            assert_eq!(result.unwrap(), "test-image.qcow2");

            let updates = callback.updates();
            assert!(updates.iter().any(|update| {
                update.bytes_processed == 18 && update.message.starts_with("Uploading ")
            }));
            crate::types::assert_progress_shape(&updates, &[FlashStage::Uploading]);

            upload_mock.assert_async().await;
            task_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_unconfirmed_upload_names_the_image_left_behind() {
            let temp_dir = tempfile::tempdir().unwrap();
            let image = temp_dir.path().join("hai.qcow2");
            std::fs::write(&image, b"test image content").unwrap();
            let failed = r#"{"data":{"status":"stopped","exitstatus":"ERROR"}}"#;
            let left_behind = Action(message!(
                "backend.proxmox.upload_unconfirmed",
                volume = "local-import:import/hai.qcow2",
                node = "pve",
            ));
            // (row, task status, task body, outcome)
            for (row, status, body, expected) in [
                ("task failed", 200, failed, left_behind.clone()),
                ("task unreadable", 500, "", left_behind),
                // Logging in again is offered instead
                ("session expired", 401, "", SessionExpired),
            ] {
                let mut server = Server::new_async().await;
                server
                    .mock("POST", "/api2/json/nodes/pve/storage/local-import/upload")
                    .with_body(serde_json::json!({ "data": UPID }).to_string())
                    .create_async()
                    .await;
                server
                    .mock("GET", task_path(UPID).as_str())
                    .with_status(status)
                    .with_body(body)
                    .create_async()
                    .await;

                let result = upload_image_to_proxmox(
                    &session(server.url()),
                    "pve",
                    &image,
                    &crate::NoOpProgress,
                    "local-import",
                )
                .await;
                assert_outcome(row, result, &expected);
            }
        }

        #[tokio::test]
        async fn test_unconfirmed_creation_says_the_vm_may_exist() {
            let failed = r#"{"data":{"status":"stopped","exitstatus":"ERROR"}}"#;
            let may_exist = Action(message!(
                "backend.proxmox.vm_creation_unconfirmed",
                vm_id = 100
            ));
            // (row, task status, task body, outcome)
            for (row, status, body, expected) in [
                ("task failed", 200, failed, may_exist.clone()),
                ("task unreadable", 500, "", may_exist),
                // The app says the VM may be incomplete, and offers to log in again
                ("session expired", 401, "", SessionExpired),
            ] {
                let mut server = Server::new_async().await;
                mock_vm_id_free(&mut server).await;
                mock_default_bridge(&mut server).await;
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"]).await;
                server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_body(serde_json::json!({ "data": UPID }).to_string())
                    .create_async()
                    .await;
                server
                    .mock("GET", task_path(UPID).as_str())
                    .with_status(status)
                    .with_body(body)
                    .create_async()
                    .await;

                let result = create_vm_with_disk(
                    &session(server.url()),
                    &vm_config(),
                    "hai.qcow2",
                    "local-import",
                    &mut false,
                )
                .await;
                assert_outcome(row, result, &expected);
            }
        }

        #[test]
        fn test_a_failed_start_says_to_start_the_vm() {
            let config = vm_config();
            for error in [
                Error::ProxmoxApi("Task failed with status: ERROR".into()),
                Error::ProxmoxSessionExpired,
            ] {
                assert_eq!(
                    action_required::<()>(Err(start_error(&config, error))),
                    message!("backend.proxmox.vm_created_start_failed", vm_id = 100)
                );
            }
            assert!(matches!(
                start_error(&config, Error::ProxmoxCertificateChanged),
                Error::ProxmoxCertificateChanged
            ));
        }

        #[tokio::test]
        async fn test_upload_image_to_proxmox_backpressure_and_disconnect() {
            use tokio::io::AsyncReadExt;

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let session = session(format!("http://{}", listener.local_addr().unwrap()));
            let temp_dir = tempfile::tempdir().unwrap();
            let path = temp_dir.path().join("large.qcow2");
            let size = 128 * 1024 * 1024;
            std::fs::File::create(&path).unwrap().set_len(size).unwrap();
            let callback = TestProgress::default();

            let server = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut received = 0;
                let mut buffer = [0; 64 * 1024];
                while received < PROGRESS_UPDATE_INTERVAL + 1024 * 1024 {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    received += count as u64;
                }
                // Stop consuming the body, leaving most of the file unsent.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let updates = callback.updates();
                let live: Vec<_> = updates
                    .iter()
                    .filter(|update| update.bytes_processed > 0)
                    .collect();
                assert!(!live.is_empty(), "progress must arrive before a response");
                assert!(live.iter().all(|update| update.bytes_processed < size / 2));
                assert!(live.iter().all(|update| update.total_bytes == size));
                assert!(live
                    .iter()
                    .all(|update| update.progress > 5 && update.progress < 95));
                // Dropping the socket makes the in-flight request fail.
            };
            let upload = upload_image_to_proxmox(&session, "pve", &path, &callback, "local");
            let (_, result) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                tokio::join!(server, upload)
            })
            .await
            .expect("upload must not hang after the peer disconnects");
            assert!(
                matches!(result, Err(Error::ProxmoxApi(message)) if message.contains("Failed to upload image"))
            );
            let updates = callback.updates();
            assert!(updates.iter().all(|update| update.progress < 100));
            assert!(updates.windows(2).all(|pair| {
                pair[0].bytes_processed <= pair[1].bytes_processed
                    && pair[0].progress <= pair[1].progress
            }));
        }

        #[tokio::test]
        async fn test_upload_image_to_proxmox_short_file() {
            struct TruncateOnUpload<'a>(&'a std::path::Path);
            impl ProgressCallback for TruncateOnUpload<'_> {
                fn on_progress(&self, progress: FlashProgress) {
                    assert!(progress.progress < 100);
                    if progress.progress == 5 {
                        std::fs::OpenOptions::new()
                            .write(true)
                            .open(self.0)
                            .unwrap()
                            .set_len(0)
                            .unwrap();
                    }
                }
            }

            let mut server = Server::new_async().await;
            let upload_mock = server
                .mock("POST", "/api2/json/nodes/pve/storage/local/upload")
                .expect(0)
                .create_async()
                .await;
            let session = session(server.url());
            let temp_dir = tempfile::tempdir().unwrap();
            let path = temp_dir.path().join("short.qcow2");
            std::fs::write(&path, b"test image content").unwrap();
            let callback = TruncateOnUpload(&path);
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                upload_image_to_proxmox(&session, "pve", &path, &callback, "local"),
            )
            .await
            .expect("short body must fail without waiting for the upload timeout");
            assert!(
                matches!(result, Err(Error::ProxmoxApi(message)) if message.contains("Failed to upload image"))
            );
            upload_mock.assert_async().await;
        }

        #[cfg(target_os = "linux")]
        #[tokio::test]
        async fn test_upload_image_to_proxmox_read_error() {
            let server = Server::new_async().await;
            let session = session(server.url());
            // Linux can open a directory as a file, but reading it fails.
            let temp_dir = tempfile::tempdir().unwrap();
            std::fs::write(temp_dir.path().join("image.qcow2"), b"image").unwrap();
            let path = temp_dir.path().to_path_buf();
            let callback = TestProgress::default();
            let error = upload_image_to_proxmox(&session, "pve", &path, &callback, "local")
                .await
                .unwrap_err();
            let cause = std::io::Error::from_raw_os_error(libc::EISDIR).to_string();
            assert!(error.to_string().contains(&cause), "{error}");
            assert!(callback
                .updates()
                .iter()
                .all(|update| update.progress < 100));
        }

        #[tokio::test]
        async fn test_upload_image_to_proxmox_file_not_found() {
            let server = Server::new_async().await;

            let nonexistent_file = std::path::PathBuf::from("/nonexistent/path/to/image.qcow2");

            let session = session(server.url());
            let progress = crate::NoOpProgress;
            let result =
                upload_image_to_proxmox(&session, "pve", &nonexistent_file, &progress, "local")
                    .await;
            assert!(
                matches!(&result, Err(Error::ProxmoxApi(msg)) if msg.contains("Failed to open image file")),
                "{result:?}"
            );
        }
    }
}
