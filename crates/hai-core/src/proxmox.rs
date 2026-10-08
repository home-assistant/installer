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

use crate::error::{Error, Result};
use crate::types::{
    FlashProgress, FlashStage, HaosImage, HaosRelease, ImageFormat, ProxmoxCredentials,
    ProxmoxNode, ProxmoxSession, ProxmoxStorage, ProxmoxVmConfig, ProxmoxVmResult,
};
use crate::{Backend, ProgressCallback, ProxmoxBackend, ReleaseSource};
use std::collections::HashSet;

/// Minimum required Proxmox VE version for disk image import via API.
/// Version 8.4.1 added support for uploading qcow2/raw/img/vmdk files with content=import.
const MIN_PROXMOX_VERSION: (u32, u32, u32) = (8, 4, 1);

/// Minimum size of the HAOS OVA disk, matching the configure view.
const MIN_DISK_SIZE_GB: u32 = 32;

fn validate_disk_size(disk_size_gb: u32) -> Result<()> {
    if disk_size_gb < MIN_DISK_SIZE_GB {
        return Err(Error::ProxmoxApi(format!(
            "The HAOS disk must be at least {} GiB. Proxmox cannot shrink the imported disk.",
            MIN_DISK_SIZE_GB
        )));
    }
    Ok(())
}

/// How often to send progress updates (every N bytes)
const PROGRESS_UPDATE_INTERVAL: u64 = 10 * 1024 * 1024; // 10 MB

/// Create a configured HTTP client for Proxmox API calls.
/// Accepts self-signed certificates (common for Proxmox installations).
fn create_client(timeout_secs: u64) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| Error::ProxmoxApi(format!("Failed to create HTTP client: {}", e)))
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
        return Err(Error::ProxmoxTwoFactor(
            "This account requires a second factor, but Proxmox did not offer TOTP. \
             This installer supports authenticator app (TOTP) codes only; \
             WebAuthn, security keys, Yubico OTP, and recovery codes are not supported."
                .to_string(),
        ));
    }

    let code = credentials.totp.as_deref().unwrap_or_default().trim();
    if code.is_empty() {
        return Err(Error::ProxmoxTwoFactor(
            "This account requires an authenticator app code. Enter the current code and try again."
                .to_string(),
        ));
    }
    if !(2..=16).contains(&code.len()) || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Error::ProxmoxTwoFactor(
            "Enter a valid numeric authenticator app code.".to_string(),
        ));
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
        .map_err(|_| {
            Error::ProxmoxTwoFactor(
                "Could not complete the second-factor request. Check your connection and try again."
                    .to_string(),
            )
        })?;
    if !response.status().is_success() {
        if response.status().as_u16() != 401 {
            return Err(Error::ProxmoxTwoFactor(format!(
                "Proxmox returned HTTP {} while completing the second-factor login. \
                 Check the server and try again.",
                response.status()
            )));
        }
        return Err(Error::ProxmoxTwoFactor(
            "Proxmox rejected the second-factor login. Check your current authenticator app code \
             and try again. If it still fails, check the account in Proxmox."
                .to_string(),
        ));
    }

    let response: serde_json::Value = response.json().await.map_err(|_| {
        Error::ProxmoxTwoFactor("Invalid second-factor response from Proxmox.".to_string())
    })?;
    let data = response.get("data").ok_or_else(|| {
        Error::ProxmoxTwoFactor("Missing second-factor response from Proxmox.".to_string())
    })?;
    if needs_second_factor(data) {
        return Err(Error::ProxmoxTwoFactor(
            "The second-factor login is incomplete. Enter a current authenticator app code and try again."
                .to_string(),
        ));
    }
    Ok(data.clone())
}

/// Authenticate with a Proxmox server and verify version requirements.
///
/// This function also verifies the Proxmox version is at least 8.4.1,
/// which is required for disk image import via the API.
async fn authenticate(credentials: &ProxmoxCredentials) -> Result<ProxmoxSession> {
    // Validate URL format (skip in tests to allow mockito HTTP server)
    #[cfg(not(test))]
    if !credentials.server_url.starts_with("https://") {
        return Err(Error::ProxmoxApi(
            "Server URL must start with https://".to_string(),
        ));
    }

    let base_url = credentials.server_url.trim_end_matches('/');
    let client = create_client(30)?;

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
            if e.is_timeout() {
                Error::ProxmoxApi(
                    "Connection timed out. Please check the server URL and network connectivity."
                        .to_string(),
                )
            } else if e.is_connect() {
                Error::ProxmoxApi(
                    "Failed to connect to Proxmox server. Please verify the URL is correct."
                        .to_string(),
                )
            } else {
                Error::ProxmoxApi(format!("Connection error: {}", e))
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err(Error::ProxmoxApi(
                "Authentication failed. Please check your username and password.".to_string(),
            ));
        } else if status.as_u16() == 403 {
            return Err(Error::ProxmoxApi(
                "Access denied. The user may not have sufficient permissions.".to_string(),
            ));
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
        .map_err(|e| Error::ProxmoxApi(format!("Failed to get Proxmox version: {}", e)))?;

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
        return Err(Error::ProxmoxApi(format!(
            "Proxmox VE version {} is not supported. \
             This installer requires Proxmox VE {}.{}.{} or later for disk image import. \
             Please upgrade your Proxmox installation.",
            version_str, MIN_PROXMOX_VERSION.0, MIN_PROXMOX_VERSION.1, MIN_PROXMOX_VERSION.2
        )));
    }

    Ok(ProxmoxSession {
        server_url: credentials.server_url.clone(),
        ticket,
        csrf_token,
    })
}

/// List available nodes on the Proxmox cluster
async fn list_nodes(session: &ProxmoxSession) -> Result<Vec<ProxmoxNode>> {
    let client = create_client(30)?;

    let url = format!(
        "{}/api2/json/nodes",
        session.server_url.trim_end_matches('/')
    );

    let response = client
        .get(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                Error::ProxmoxApi(
                    "Connection timed out while listing nodes. Please check network connectivity."
                        .to_string(),
                )
            } else if e.is_connect() {
                Error::ProxmoxApi(format!(
                    "Failed to connect to Proxmox server at {}",
                    session.server_url
                ))
            } else {
                Error::ProxmoxApi(format!("Network error while listing nodes: {}", e))
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err(Error::ProxmoxSessionExpired);
        } else if status.as_u16() == 403 {
            return Err(Error::ProxmoxApi(
                "Access denied. Your user may not have permission to list nodes.".to_string(),
            ));
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
                memory_used: node.get("mem").and_then(|v| v.as_u64()),
                memory_total: node.get("maxmem").and_then(|v| v.as_u64()),
            })
        })
        .collect();

    Ok(nodes)
}

/// List available storage on a node
async fn list_storage(session: &ProxmoxSession, node: &str) -> Result<Vec<ProxmoxStorage>> {
    let client = create_client(30)?;

    let url = format!(
        "{}/api2/json/nodes/{}/storage",
        session.server_url.trim_end_matches('/'),
        node
    );

    let response = client
        .get(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .send()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to list storage: {}", e)))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::ProxmoxSessionExpired);
    }

    if !response.status().is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to list storage: {}",
            response.status()
        )));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse storage list: {}", e)))?;

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
                total: s.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
                active: s.get("active").and_then(|v| v.as_u64()).unwrap_or(0) == 1,
            })
        })
        .collect();

    Ok(storage)
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
        return Err(Error::ProxmoxApi(format!(
            "Not enough free space for the {} MB image on import storage: {}. Free up space or enable 'import' on another storage.",
            required_bytes / 1_000_000,
            too_small.join(", ")
        )));
    }

    Err(Error::ProxmoxApi(
        "No active storage with 'import' content type found. Enable 'import' on an active directory storage in PVE."
            .to_string(),
    ))
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
        return Err(Error::ProxmoxApi(format!(
            "Your Proxmox user cannot both upload to and read from any import storage (needs Datastore.AllocateTemplate plus one of Datastore.Allocate, Datastore.AllocateSpace, or Datastore.Audit on: {}).",
            denied.join(", ")
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
            Error::ProxmoxApi(format!(
                "Storage '{}' was not found on this node.",
                disk_storage
            ))
        })?;

    if !storage.active {
        return Err(Error::ProxmoxApi(format!(
            "Storage '{}' is not active.",
            disk_storage
        )));
    }

    if !storage.content.iter().any(|content| content == "images") {
        return Err(Error::ProxmoxApi(format!(
            "Storage '{}' cannot hold VM disks. Enable the 'Disk image' content type on it in PVE.",
            disk_storage
        )));
    }

    // Proxmox disk sizes like "32G" are GiB.
    let required_bytes = u64::from(disk_size_gb) * 1024 * 1024 * 1024;
    if storage.available < required_bytes {
        return Err(Error::ProxmoxApi(format!(
            "Not enough free space on '{}' for the {} GB disk ({} GB free).",
            disk_storage,
            disk_size_gb,
            storage.available / (1024 * 1024 * 1024)
        )));
    }

    Ok(())
}

/// Fail early if `vm_id` is already taken anywhere in the cluster.
async fn ensure_vm_id_free(session: &ProxmoxSession, vm_id: u32) -> Result<()> {
    let response = send_nextid_request(session, Some(vm_id)).await?;

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

    // Proxmox rejects a taken or invalid ID with 400; pass its reason on when it gives one.
    let body = response.text().await.unwrap_or_default();
    let reason = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|json| Some(json.get("errors")?.get("vmid")?.as_str()?.to_string()));

    Err(Error::ProxmoxApi(match reason {
        Some(reason) => format!(
            "VM ID {} can't be used ({}). Choose a different ID.",
            vm_id, reason
        ),
        None => format!("VM ID {} can't be used. Choose a different ID.", vm_id),
    }))
}

/// Call `/cluster/nextid`; with `vm_id` set, Proxmox checks that ID cluster-wide instead of picking one.
async fn send_nextid_request(
    session: &ProxmoxSession,
    vm_id: Option<u32>,
) -> Result<reqwest::Response> {
    let mut url = format!(
        "{}/api2/json/cluster/nextid",
        session.server_url.trim_end_matches('/')
    );
    if let Some(vm_id) = vm_id {
        url.push_str(&format!("?vmid={}", vm_id));
    }

    create_client(30)?
        .get(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .send()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to query VM ID: {}", e)))
}

/// Fail early if the node is missing from the cluster or not online.
fn check_node_online(nodes: &[ProxmoxNode], node: &str) -> Result<()> {
    let found = nodes.iter().find(|n| n.name == node).ok_or_else(|| {
        Error::ProxmoxApi(format!("Node '{}' was not found in the cluster.", node))
    })?;

    if found.status != "online" {
        return Err(Error::ProxmoxApi(format!(
            "Node '{}' is {}, not online.",
            node, found.status
        )));
    }

    Ok(())
}

/// Network bridge the VM's network card is attached to.
const VM_BRIDGE: &str = "vmbr0";

/// Privileges Proxmox checks on `/vms/{id}` for the options `create_vm_with_disk` sends.
const VM_CREATE_PRIVILEGES: &[&str] = &[
    "VM.Allocate",
    "VM.Config.CPU",
    "VM.Config.Memory",
    "VM.Config.Options",
    "VM.Config.HWType",
    "VM.Config.Network",
    "VM.Config.Disk",
];

/// Privileges the logged-in user has on `path`, including inherited ones.
async fn fetch_privileges(session: &ProxmoxSession, path: &str) -> Result<HashSet<String>> {
    let client = create_client(30)?;

    let url = format!(
        "{}/api2/json/access/permissions?path={}",
        session.server_url.trim_end_matches('/'),
        urlencoding::encode(path)
    );

    let response = client
        .get(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .send()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to check permissions: {}", e)))?;

    if !response.status().is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to check permissions: {}",
            response.status()
        )));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse permissions: {}", e)))?;

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

    Err(Error::ProxmoxApi(format!(
        "Your Proxmox user is missing {} on {}.",
        missing.join(", "),
        path
    )))
}

/// Fail early if the logged-in user isn't allowed to create, configure, and start this VM.
async fn ensure_user_can_create_vm(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
) -> Result<()> {
    let vm_path = format!("/vms/{}", config.vm_id);
    let mut required = VM_CREATE_PRIVILEGES.to_vec();
    if config.auto_start {
        required.push("VM.PowerMgmt");
    }
    ensure_privileges(
        &fetch_privileges(session, &vm_path).await?,
        &vm_path,
        &required,
    )?;

    // Plain bridges are checked under the built-in `localnetwork` SDN zone.
    let bridge_path = format!("/sdn/zones/localnetwork/{}", VM_BRIDGE);
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

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::ProxmoxSessionExpired);
    }

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
    let url = format!(
        "{}/api2/json/nodes/{}/tasks/{}/status",
        session.server_url.trim_end_matches('/'),
        task_node(upid).unwrap_or(node),
        urlencoding::encode(upid)
    );

    let client = create_client(30)?;
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    loop {
        if start.elapsed() > timeout {
            return Err(Error::ProxmoxApi(format!(
                "Task timed out after {} seconds",
                timeout_secs
            )));
        }

        let response = client
            .get(&url)
            .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
            .send()
            .await
            .map_err(|e| Error::ProxmoxApi(format!("Failed to check task status: {}", e)))?;

        let status = response.status();
        if !status.is_success() {
            // Proxmox explains a 400 in the body ("no such task", a parameter
            // that failed verification); the status line alone hides it.
            let body = response.text().await.unwrap_or_default();
            return Err(Error::ProxmoxApi(format!(
                "Failed to check task status ({}): {}",
                status,
                body.trim()
            )));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| Error::ProxmoxApi(format!("Failed to parse task status: {}", e)))?;

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
            } else {
                return Err(Error::ProxmoxApi(format!(
                    "Task failed with status: {}",
                    exitstatus
                )));
            }
        }

        // Task still running, wait a bit before checking again
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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
        stage: FlashStage::Writing,
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
        stage: FlashStage::Writing,
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
    let url = format!(
        "{}/api2/json/nodes/{}/storage/{}/upload",
        session.server_url.trim_end_matches('/'),
        node,
        storage_name
    );

    // Create client with longer timeout for large uploads
    let client = create_client(1800)?; // 30 minutes

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

    let request = client
        .post(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .header("CSRFPreventionToken", &session.csrf_token)
        .multipart(form)
        .send();
    tokio::pin!(request);
    let mut progress_open = true;
    let response = loop {
        tokio::select! {
            biased;
            changed = progress_rx.changed(), if progress_open => {
                if changed.is_err() {
                    progress_open = false;
                    continue;
                }
                let bytes_sent = *progress_rx.borrow_and_update();
                progress_callback.on_progress(FlashProgress {
                    stage: FlashStage::Writing,
                    progress: 5 + (bytes_sent as f64 / file_size.max(1) as f64 * 90.0) as u8,
                    bytes_processed: bytes_sent,
                    total_bytes: file_size,
                    message: format!("Uploading {} to Proxmox...", filename),
                });
            }
            response = &mut request => {
                break response.map_err(|error| {
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

    if !status.is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to upload image to Proxmox ({}): {}",
            status, response_text
        )));
    }

    // Parse the response to get the task UPID
    let json: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse upload response: {}", e)))?;

    let upid = json
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::ProxmoxApi("Upload response missing task UPID".to_string()))?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Writing,
        progress: 95,
        bytes_processed: file_size,
        total_bytes: file_size,
        message: "Waiting for Proxmox to process upload...".to_string(),
    });

    // Wait for the upload task to complete
    wait_for_task(session, node, upid, 1800).await?;

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Writing,
        progress: 100,
        bytes_processed: file_size,
        total_bytes: file_size,
        message: "Upload complete".to_string(),
    });

    Ok(filename)
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
    if let Err(error) = validate_disk_size(config.disk_size_gb) {
        *source_unused = true;
        return Err(error);
    }

    let url = format!(
        "{}/api2/json/nodes/{}/qemu",
        session.server_url.trim_end_matches('/'),
        config.node
    );

    let client = create_client(300)?; // 5 minutes for VM creation with disk import

    // Build the disk import specification
    // Format: storage:0,import-from="storage name":import/filename.qcow2
    let scsi0_spec = format!(
        "{}:0,import-from={}:import/{}",
        config.storage, storage_name, image_filename
    );

    // EFI disk specification for UEFI boot
    let efidisk0_spec = format!("{}:1,efitype=4m,pre-enrolled-keys=0", config.storage);

    let response = client
        .post(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .header("CSRFPreventionToken", &session.csrf_token)
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
            ("net0", format!("virtio,bridge={}", VM_BRIDGE)), // VirtIO network
            ("agent", "enabled=1".to_string()), // QEMU guest agent
            ("boot", "order=scsi0".to_string()), // Boot from main disk
        ])
        .send()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to create VM: {}", e)))?;

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        // A client rejection cannot have started an import. Server errors or
        // a timeout can hide a task which is still running, so retain those.
        *source_unused = status.is_client_error() && status != reqwest::StatusCode::REQUEST_TIMEOUT;
        return Err(Error::ProxmoxApi(format!(
            "Failed to create VM ({}): {}",
            status, response_text
        )));
    }

    // Parse the response to get the task UPID
    let json: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse VM creation response: {}", e)))?;

    // VM creation returns a task UPID since it involves disk import
    let upid = json
        .get("data")
        .and_then(|v| v.as_str())
        .filter(|upid| !upid.is_empty())
        .ok_or_else(|| Error::ProxmoxApi("VM creation response missing task UPID".to_string()))?;
    // Deleting the source is only safe after confirmed import completion.
    wait_for_task_completion(session, &config.node, upid, 600, source_unused).await?;

    resize_vm_disk(session, config).await.map_err(|error| {
        let message = match error {
            Error::ProxmoxApi(message) => message,
            other => other.to_string(),
        };
        Error::ProxmoxApi(format!(
            "VM {} was created but its disk could not be resized: {}",
            config.vm_id, message
        ))
    })
}

/// Apply an absolute size, including the minimum, so Proxmox checks the actual
/// imported volume and rejects shrinking if a future HAOS image is larger.
async fn resize_vm_disk(session: &ProxmoxSession, config: &ProxmoxVmConfig) -> Result<()> {
    let url = format!(
        "{}/api2/json/nodes/{}/qemu/{}/resize",
        session.server_url.trim_end_matches('/'),
        config.node,
        config.vm_id
    );
    let client = create_client(60)?;
    let response = client
        .put(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .header("CSRFPreventionToken", &session.csrf_token)
        .form(&[
            ("disk", "scsi0".to_string()),
            ("size", format!("{}G", config.disk_size_gb)),
        ])
        .send()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to resize VM disk: {}", e)))?;

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to resize VM disk ({}): {}",
            status, response_text
        )));
    }

    let json: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse disk resize response: {}", e)))?;
    let upid = json
        .get("data")
        .and_then(|v| v.as_str())
        .filter(|upid| !upid.is_empty())
        .ok_or_else(|| Error::ProxmoxApi("Disk resize response missing task UPID".to_string()))?;

    wait_for_task(session, &config.node, upid, 600).await
}

async fn delete_import_image(
    session: &ProxmoxSession,
    node: &str,
    storage: &str,
    filename: &str,
) -> Result<()> {
    let volume = format!("{storage}:import/{filename}");
    let url = format!(
        "{}/api2/json/nodes/{}/storage/{}/content/{}",
        session.server_url.trim_end_matches('/'),
        urlencoding::encode(node),
        urlencoding::encode(storage),
        urlencoding::encode(&volume)
    );
    let response = create_client(60)?
        .delete(url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .header("CSRFPreventionToken", &session.csrf_token)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Could not delete import volume {volume}: HTTP {}",
            response.status()
        )));
    }
    let json: serde_json::Value = response.json().await?;
    let upid = json
        .get("data")
        .and_then(|value| value.as_str())
        .filter(|upid| !upid.is_empty())
        .ok_or_else(|| {
            Error::ProxmoxApi("Import deletion response missing task UPID".to_string())
        })?;
    wait_for_task(session, node, upid, 120).await?;
    Ok(())
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
    // The request was rejected or the import task has stopped. Cleanup is
    // best effort and must never replace the original installation result.
    if source_unused {
        if let Err(error) =
            delete_import_image(session, &config.node, storage_name, image_filename).await
        {
            eprintln!(
                "Temporary import cleanup for VM {} failed: {error}",
                config.vm_id
            );
        }
    }
    result
}

/// Start a VM.
async fn start_vm(session: &ProxmoxSession, node: &str, vm_id: u32) -> Result<()> {
    let url = format!(
        "{}/api2/json/nodes/{}/qemu/{}/status/start",
        session.server_url.trim_end_matches('/'),
        node,
        vm_id
    );

    let client = create_client(60)?;

    let response = client
        .post(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .header("CSRFPreventionToken", &session.csrf_token)
        .send()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to start VM: {}", e)))?;

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(Error::ProxmoxApi(format!(
            "Failed to start VM ({}): {}",
            status, response_text
        )));
    }

    // Parse the response to get the task UPID
    let json: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse start VM response: {}", e)))?;

    // VM start returns a task UPID
    if let Some(upid) = json.get("data").and_then(|v| v.as_str()) {
        // Wait for the VM start task to complete
        wait_for_task(session, node, upid, 120).await?;
    }

    Ok(())
}

/// Wait for the Home Assistant webserver to be ready on port 80.
async fn wait_for_ha_webserver(ip: &str) -> bool {
    let base_url = format!("http://{}", ip);
    wait_for_ha_webserver_at_url(&base_url).await
}

/// Internal helper that accepts a full base URL (for testing).
async fn wait_for_ha_webserver_at_url(base_url: &str) -> bool {
    let client = match create_client(10) {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Try for up to 5 minutes (150 attempts * 2 seconds)
    for _ in 0..150 {
        match client.get(base_url).send().await {
            Ok(response) => {
                // Any response means the webserver is up
                if response.status().is_success() || response.status().as_u16() < 500 {
                    return true;
                }
            }
            Err(_) => {
                // Connection refused or other error, keep trying
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    false
}

/// Wait for Home Assistant to finish updating to the latest version.
async fn wait_for_ha_updated(ip: &str) -> bool {
    let base_url = format!("http://{}", ip);
    wait_for_ha_updated_at_url(&base_url).await
}

/// Internal helper that accepts a full base URL (for testing).
async fn wait_for_ha_updated_at_url(base_url: &str) -> bool {
    let url = format!("{}/manifest.json", base_url);
    let client = match create_client(10) {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Try for up to 1 hour (1800 attempts * 2 seconds)
    for _ in 0..1800 {
        match client.get(&url).send().await {
            Ok(response) => {
                // 200 OK means Home Assistant is fully ready
                if response.status().is_success() {
                    return true;
                }
            }
            Err(_) => {
                // Connection refused or other error, keep trying
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    false
}

/// Wait for the VM to get an IP address via QEMU guest agent.
async fn wait_for_vm_ip(session: &ProxmoxSession, node: &str, vm_id: u32) -> Option<String> {
    let url = format!(
        "{}/api2/json/nodes/{}/qemu/{}/agent/network-get-interfaces",
        session.server_url.trim_end_matches('/'),
        node,
        vm_id
    );

    let client = create_client(10).ok()?;

    // Try for up to 5 minutes (150 attempts * 2 seconds)
    for _ in 0..150 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let response = client
            .get(&url)
            .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
            .send()
            .await
            .ok()?;

        if response.status().is_success() {
            let json: serde_json::Value = response.json().await.ok()?;

            // Look for an IPv4 address on a non-loopback interface
            if let Some(interfaces) = json
                .get("data")
                .and_then(|d| d.get("result"))
                .and_then(|r| r.as_array())
            {
                for iface in interfaces {
                    let name = iface.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if name == "lo" {
                        continue;
                    }

                    if let Some(ip_addresses) = iface.get("ip-addresses").and_then(|a| a.as_array())
                    {
                        for addr in ip_addresses {
                            if addr.get("ip-address-type").and_then(|t| t.as_str()) == Some("ipv4")
                            {
                                if let Some(ip) = addr.get("ip-address").and_then(|i| i.as_str()) {
                                    if !ip.starts_with("127.") {
                                        return Some(ip.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Create a Home Assistant VM on Proxmox
async fn create_vm<B: ReleaseSource, P: ProgressCallback>(
    backend: &B,
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    progress_callback: &P,
) -> Result<ProxmoxVmResult> {
    validate_disk_size(config.disk_size_gb)?;

    // Step 1: Get HAOS release info
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    let release: HaosRelease = backend.get_latest_haos_release_for_board("ova").await?;
    let haos_version = &release.version;
    let image: &HaosImage = release
        .image_for("ova", ImageFormat::Qcow2)
        .ok_or_else(|| {
            Error::DownloadFailed(format!("No OVA image in HAOS release {}", haos_version))
        })?;

    // Catch anything that would fail later before spending time on the download
    pre_install_checks(session, config, image.size).await?;

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
        .download_image(image, &compressed_path, progress_callback)
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

    // Step 5: Create the VM with disk import and apply the selected size
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Verifying,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Creating virtual machine...".to_string(),
    });

    import_and_cleanup_image(session, config, &image_filename, &storage_name).await?;

    // Step 6: Start the VM if requested
    if config.auto_start {
        progress_callback.on_progress(FlashProgress {
            stage: FlashStage::Finalizing,
            progress: 0,
            bytes_processed: 0,
            total_bytes: 0,
            message: "Starting virtual machine...".to_string(),
        });

        start_vm(session, &config.node, config.vm_id).await?;
    }

    // Step 7: Wait for IP address
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Ready,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Waiting for network connection...".to_string(),
    });

    let ip_address = if config.auto_start {
        wait_for_vm_ip(session, &config.node, config.vm_id).await
    } else {
        None
    };

    // Step 8: Wait for Home Assistant webserver to be ready
    if let Some(ref ip) = ip_address {
        progress_callback.on_progress(FlashProgress {
            stage: FlashStage::Ready,
            progress: 50,
            bytes_processed: 0,
            total_bytes: 0,
            message: "Waiting for Home Assistant to start...".to_string(),
        });

        // Wait for webserver (don't fail if it times out)
        wait_for_ha_webserver(ip).await;

        // Step 9: Wait for Home Assistant to finish updating
        progress_callback.on_progress(FlashProgress {
            stage: FlashStage::Updating,
            progress: 0,
            bytes_processed: 0,
            total_bytes: 0,
            message: "Updating to the latest version...".to_string(),
        });

        // Wait for manifest.json (don't fail if it times out)
        wait_for_ha_updated(ip).await;
    }

    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Installation complete!".to_string(),
    });

    Ok(ProxmoxVmResult {
        vm_id: config.vm_id,
        node: config.node.clone(),
        ip_address,
    })
}

impl ProxmoxBackend for Backend {
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

    async fn get_next_vm_id(&self, session: &ProxmoxSession) -> Result<u32> {
        get_next_vm_id(session).await
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
    use serial_test::serial;

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

    // NOTE: HTTPS URL validation tests are not included here because the validation
    // is disabled in test builds (#[cfg(not(test))]) to allow mockito HTTP mocking.
    // The HTTPS requirement is enforced in production builds only.

    // create_client() tests
    #[test]
    fn test_create_client_valid_timeout() {
        let result = create_client(30);
        assert!(result.is_ok());
    }

    #[test]
    fn test_create_client_zero_timeout() {
        let result = create_client(0);
        assert!(result.is_ok());
    }

    #[test]
    fn test_create_client_large_timeout() {
        let result = create_client(1800);
        assert!(result.is_ok());
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

    #[test]
    fn test_proxmox_node_fields() {
        let node = ProxmoxNode {
            name: "pve".to_string(),
            status: "online".to_string(),
            cpu_usage: Some(0.5),
            memory_used: Some(4_000_000_000),
            memory_total: Some(8_000_000_000),
        };
        assert_eq!(node.name, "pve");
        assert_eq!(node.status, "online");
    }

    #[test]
    fn test_proxmox_storage_fields() {
        let storage = ProxmoxStorage {
            name: "local".to_string(),
            storage_type: "dir".to_string(),
            content: vec!["images".to_string()],
            available: 100_000_000_000,
            total: 500_000_000_000,
            active: true,
        };
        assert_eq!(storage.name, "local");
        assert!(storage.active);
    }

    fn storage(name: &str, active: bool, content: &[&str]) -> ProxmoxStorage {
        ProxmoxStorage {
            name: name.to_string(),
            storage_type: "dir".to_string(),
            content: content.iter().map(|c| c.to_string()).collect(),
            available: 100_000_000_000,
            total: 500_000_000_000,
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
        match check_disk_storage(&storage_list, "local-lvm", 32) {
            Err(Error::ProxmoxApi(msg)) => {
                assert!(msg.contains("Not enough free space"), "{}", msg);
                assert!(msg.contains("32 GB"), "{}", msg);
                assert!(msg.contains("20 GB free"), "{}", msg);
            }
            other => panic!("Expected not-enough-space error, got {:?}", other),
        }
    }

    #[test]
    fn test_check_disk_storage_rejects_missing_storage() {
        let storage_list = vec![storage("local-lvm", true, &["images"])];
        match check_disk_storage(&storage_list, "ceph-pool", 32) {
            Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("not found"), "{}", msg),
            other => panic!("Expected not-found error, got {:?}", other),
        }
    }

    #[test]
    fn test_check_disk_storage_rejects_inactive_storage() {
        let storage_list = vec![storage("local-lvm", false, &["images"])];
        match check_disk_storage(&storage_list, "local-lvm", 32) {
            Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("not active"), "{}", msg),
            other => panic!("Expected inactive error, got {:?}", other),
        }
    }

    #[test]
    fn test_check_disk_storage_rejects_storage_without_images() {
        // The import storage is a common wrong pick: it's active but can't hold VM disks.
        let storage_list = vec![storage("local", true, &["iso", "import"])];
        match check_disk_storage(&storage_list, "local", 32) {
            Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("Disk image"), "{}", msg),
            other => panic!("Expected missing-images error, got {:?}", other),
        }
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

        match select_import_storage(&storage_list, 0) {
            Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("import"), "{}", msg),
            other => panic!("Expected no-import-storage error, got {:?}", other),
        }
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
        match select_import_storage(&storage_list, 1_000_000_000) {
            Err(Error::ProxmoxApi(msg)) => {
                assert!(msg.contains("Not enough free space"), "{}", msg);
                assert!(msg.contains("small-import"), "{}", msg);
            }
            other => panic!("Expected not-enough-space error, got {:?}", other),
        }
    }

    #[test]
    fn test_ensure_privileges_lists_only_missing_privileges() {
        let granted: HashSet<String> = ["VM.Allocate", "VM.Audit"]
            .iter()
            .map(|p| p.to_string())
            .collect();

        assert!(ensure_privileges(&granted, "/vms/100", &["VM.Allocate"]).is_ok());

        match ensure_privileges(&granted, "/vms/100", &["VM.Allocate", "VM.Config.CPU"]) {
            Err(Error::ProxmoxApi(msg)) => {
                assert!(msg.contains("VM.Config.CPU"), "{}", msg);
                assert!(msg.contains("/vms/100"), "{}", msg);
                assert!(!msg.contains("VM.Allocate"), "{}", msg);
            }
            other => panic!("Expected missing-privilege error, got {:?}", other),
        }
    }

    fn node(name: &str, status: &str) -> ProxmoxNode {
        ProxmoxNode {
            name: name.to_string(),
            status: status.to_string(),
            cpu_usage: None,
            memory_used: None,
            memory_total: None,
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
        match check_node_online(&nodes, "pve2") {
            Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("offline"), "{}", msg),
            other => panic!("Expected offline error, got {:?}", other),
        }
    }

    #[test]
    fn test_check_node_online_rejects_missing_node() {
        let nodes = vec![node("pve", "online")];
        match check_node_online(&nodes, "pve3") {
            Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("not found"), "{}", msg),
            other => panic!("Expected not-found error, got {:?}", other),
        }
    }

    // =========================================================================
    // HTTP Mocking tests using mockito
    // =========================================================================

    mod http_mock_tests {
        use super::*;
        use mockito::{Matcher, Server};

        // Test progress callback for tests that need progress updates
        struct TestProgressCallback {
            updates: std::sync::Arc<std::sync::Mutex<Vec<FlashProgress>>>,
        }

        impl TestProgressCallback {
            fn new() -> Self {
                Self {
                    updates: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                }
            }

            #[allow(dead_code)]
            fn get_updates(&self) -> Vec<FlashProgress> {
                self.updates.lock().unwrap().clone()
            }
        }

        impl ProgressCallback for TestProgressCallback {
            fn on_progress(&self, progress: FlashProgress) {
                self.updates.lock().unwrap().push(progress);
            }
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_success() {
            let mut server = Server::new_async().await;

            // Mock authentication endpoint
            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "ticket": "PVE:root@pam:12345678::abcdef...",
                            "CSRFPreventionToken": "12345678:csrf-token-here",
                            "username": "root@pam"
                        }
                    }"#,
                )
                .create_async()
                .await;

            // Mock version endpoint
            let version_mock = server
                .mock("GET", "/api2/json/version")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "version": "8.4.1",
                            "release": "8.4",
                            "repoid": "abcd1234"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_ok());

            let session = result.unwrap();
            assert!(session.ticket.contains("PVE:root@pam"));
            assert!(session.csrf_token.contains("csrf-token"));
            assert_eq!(session.server_url, server.url());

            auth_mock.assert_async().await;
            version_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
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

            for (initial, code, second_status, second_data, error) in [
                (
                    partial.clone(),
                    None,
                    200,
                    complete.clone(),
                    Some("requires an authenticator"),
                ),
                (
                    partial.clone(),
                    Some("abc123"),
                    200,
                    complete.clone(),
                    Some("valid numeric"),
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
                    Some("did not offer TOTP"),
                ),
                (
                    serde_json::json!({"NeedTFA": 1, "ticket": unsupported}),
                    Some("123456"),
                    200,
                    complete.clone(),
                    Some("not supported"),
                ),
                (
                    serde_json::json!({"ticket": "PVE:!tfa!malformed:time::sig"}),
                    Some("123456"),
                    200,
                    complete.clone(),
                    Some("did not offer TOTP"),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    401,
                    serde_json::Value::Null,
                    Some("rejected"),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    503,
                    serde_json::Value::Null,
                    Some("HTTP 503"),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    200,
                    partial.clone(),
                    Some("incomplete"),
                ),
                (
                    partial.clone(),
                    Some("123456"),
                    200,
                    serde_json::json!({"ticket": challenge}),
                    Some("incomplete"),
                ),
                (
                    serde_json::json!({"NeedTFA": 1, "ticket": "PVE:root@pam:time::partial", "CSRFPreventionToken": "partial-csrf"}),
                    None,
                    200,
                    complete.clone(),
                    Some("did not offer TOTP"),
                ),
            ] {
                let mut server = Server::new_async().await;
                let first = server
                    .mock("POST", "/api2/json/access/ticket")
                    .match_body(mockito::Matcher::AllOf(vec![
                        mockito::Matcher::UrlEncoded("username".into(), "root@pam".into()),
                        mockito::Matcher::UrlEncoded("password".into(), "password".into()),
                        mockito::Matcher::UrlEncoded("new-format".into(), "1".into()),
                    ]))
                    .with_header("content-type", "application/json")
                    .with_body(serde_json::json!({"data": initial}).to_string())
                    .create_async()
                    .await;
                let sends_code = initial["ticket"] == challenge && code == Some("123456");
                let second = server
                    .mock("POST", "/api2/json/access/ticket")
                    .match_header("cookie", mockito::Matcher::Missing)
                    .match_body(mockito::Matcher::AllOf(vec![
                        mockito::Matcher::UrlEncoded("username".into(), "root@pam".into()),
                        mockito::Matcher::UrlEncoded("password".into(), "totp:123456".into()),
                        mockito::Matcher::UrlEncoded("tfa-challenge".into(), challenge.clone()),
                    ]))
                    .with_status(second_status)
                    .with_header("content-type", "application/json")
                    .with_body(serde_json::json!({"data": second_data}).to_string())
                    .expect(usize::from(sends_code))
                    .create_async()
                    .await;
                let version = server
                    .mock("GET", "/api2/json/version")
                    .match_header("cookie", "PVEAuthCookie=PVE:root@pam:12345678::complete")
                    .with_header("content-type", "application/json")
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
                    server_url: server.url(),
                    username: "root@pam".into(),
                    password: "password".into(),
                    totp: code.map(str::to_string),
                };
                let result = authenticate(&credentials).await;
                if let Some(expected) = error {
                    let err = result.unwrap_err();
                    assert!(matches!(err, Error::ProxmoxTwoFactor(_)), "{err}");
                    assert!(err.to_string().contains(expected), "{err}");
                    assert!(!err.to_string().contains("signature"));
                    assert!(!err.to_string().contains("123456"));
                } else {
                    let session = result.unwrap();
                    assert_eq!(session.ticket, complete["ticket"]);
                    assert_eq!(session.csrf_token, "final-csrf");
                }
                first.assert_async().await;
                second.assert_async().await;
                version.assert_async().await;
                partial_version.assert_async().await;
            }
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_wrong_credentials() {
            let mut server = Server::new_async().await;

            // Mock 401 response for wrong credentials
            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(401)
                .with_body("authentication failure")
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "wrong-password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Authentication failed"));
            } else {
                panic!("Expected ProxmoxApi error for 401");
            }

            auth_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_access_denied() {
            let mut server = Server::new_async().await;

            // Mock 403 response for insufficient permissions
            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(403)
                .with_body("access denied")
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "user@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Access denied"));
            } else {
                panic!("Expected ProxmoxApi error for 403");
            }

            auth_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_old_proxmox_version() {
            let mut server = Server::new_async().await;

            // Mock successful auth
            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "ticket": "PVE:root@pam:12345678::abcdef...",
                            "CSRFPreventionToken": "csrf-token",
                            "username": "root@pam"
                        }
                    }"#,
                )
                .create_async()
                .await;

            // Mock old version (below 8.4.1)
            let version_mock = server
                .mock("GET", "/api2/json/version")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "version": "7.4.0",
                            "release": "7.4"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("not supported"));
                assert!(msg.contains("8.4.1"));
            } else {
                panic!("Expected ProxmoxApi error for old version");
            }

            auth_mock.assert_async().await;
            version_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_nodes_success() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .match_header("Cookie", Matcher::Regex("PVEAuthCookie=.*".to_string()))
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": [
                            {
                                "node": "pve",
                                "status": "online",
                                "cpu": 0.15,
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

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_nodes(&session).await;
            assert!(result.is_ok());

            let nodes = result.unwrap();
            assert_eq!(nodes.len(), 2);
            assert_eq!(nodes[0].name, "pve");
            assert_eq!(nodes[0].status, "online");
            assert_eq!(nodes[1].name, "pve2");

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_nodes_auth_expired() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_status(401)
                .with_body("authentication required")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "expired-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_nodes(&session).await;
            assert!(matches!(result, Err(Error::ProxmoxSessionExpired)));

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_storage_and_vm_id_auth_expired() {
            let mut server = Server::new_async().await;
            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_status(401)
                .create_async()
                .await;
            let vm_id_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(401)
                .create_async()
                .await;
            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "expired-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            assert!(matches!(
                list_storage(&session, "pve").await,
                Err(Error::ProxmoxSessionExpired)
            ));
            assert!(matches!(
                get_next_vm_id(&session).await,
                Err(Error::ProxmoxSessionExpired)
            ));
            storage_mock.assert_async().await;
            vm_id_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_storage_success() {
            let mut server = Server::new_async().await;

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_status(200)
                .with_header("content-type", "application/json")
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

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_storage(&session, "pve").await;
            assert!(result.is_ok());

            let storage = result.unwrap();
            assert_eq!(storage.len(), 2);
            assert_eq!(storage[0].name, "local");
            assert_eq!(storage[0].storage_type, "dir");
            assert!(storage[0].content.contains(&"images".to_string()));
            assert_eq!(storage[1].name, "local-lvm");

            storage_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_storage_empty() {
            let mut server = Server::new_async().await;

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": []}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_storage(&session, "pve").await;
            assert!(result.is_ok());

            let storage = result.unwrap();
            assert!(storage.is_empty());

            storage_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_vm_id_free_uses_generic_message_without_reason() {
            let mut server = Server::new_async().await;

            let nextid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .match_query(Matcher::UrlEncoded("vmid".to_string(), "101".to_string()))
                .with_status(400)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": null}"#)
                .create_async()
                .await;

            match ensure_vm_id_free(&test_session(&server), 101).await {
                Err(Error::ProxmoxApi(msg)) => {
                    assert_eq!(msg, "VM ID 101 can't be used. Choose a different ID.");
                }
                other => panic!("Expected taken-ID error, got {:?}", other),
            }

            nextid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_vm_id_free_rejects_taken_id() {
            let mut server = Server::new_async().await;

            let nextid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .match_query(Matcher::UrlEncoded("vmid".to_string(), "101".to_string()))
                .with_status(400)
                .with_header("content-type", "application/json")
                .with_body(r#"{"errors": {"vmid": "VM 101 already exists"}, "data": null}"#)
                .create_async()
                .await;

            match ensure_vm_id_free(&test_session(&server), 101).await {
                Err(Error::ProxmoxApi(msg)) => {
                    assert!(msg.contains("101"), "{}", msg);
                    assert!(msg.contains("already exists"), "{}", msg);
                }
                other => panic!("Expected taken-ID error, got {:?}", other),
            }

            nextid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_vm_id_free_accepts_free_id() {
            let mut server = Server::new_async().await;

            let nextid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .match_query(Matcher::UrlEncoded("vmid".to_string(), "102".to_string()))
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": "102"}"#)
                .create_async()
                .await;

            let result = ensure_vm_id_free(&test_session(&server), 102).await;
            assert!(result.is_ok(), "unexpected error: {:?}", result.err());

            nextid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_vm_id_free_server_error() {
            let mut server = Server::new_async().await;

            let nextid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .match_query(Matcher::UrlEncoded("vmid".to_string(), "100".to_string()))
                .with_status(500)
                .with_body("Internal Server Error")
                .create_async()
                .await;

            match ensure_vm_id_free(&test_session(&server), 100).await {
                Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("500"), "{}", msg),
                other => panic!("Expected server error, got {:?}", other),
            }

            nextid_mock.assert_async().await;
        }

        fn test_session(server: &mockito::ServerGuard) -> ProxmoxSession {
            ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            }
        }

        fn vm_config(auto_start: bool) -> ProxmoxVmConfig {
            ProxmoxVmConfig {
                vm_id: 100,
                name: "homeassistant".to_string(),
                node: "pve".to_string(),
                storage: "local-lvm".to_string(),
                cpu_cores: 2,
                memory_mb: 4096,
                disk_size_gb: 32,
                auto_start,
            }
        }

        /// Mock `/access/permissions` for one path, in the shape Proxmox returns.
        async fn mock_privileges(
            server: &mut mockito::ServerGuard,
            path: &str,
            privileges: &[&str],
        ) -> mockito::Mock {
            let granted: serde_json::Map<String, serde_json::Value> = privileges
                .iter()
                .map(|privilege| (privilege.to_string(), serde_json::json!(1)))
                .collect();
            server
                .mock("GET", "/api2/json/access/permissions")
                .match_query(Matcher::UrlEncoded("path".to_string(), path.to_string()))
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(serde_json::json!({ "data": { path: granted } }).to_string())
                .create_async()
                .await
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_user_can_create_vm_allowed() {
            let mut server = Server::new_async().await;

            let mut vm_privileges = VM_CREATE_PRIVILEGES.to_vec();
            vm_privileges.push("VM.PowerMgmt");
            let vm_mock = mock_privileges(&mut server, "/vms/100", &vm_privileges).await;
            let bridge_mock =
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"]).await;

            let result = ensure_user_can_create_vm(&test_session(&server), &vm_config(true)).await;
            assert!(result.is_ok(), "unexpected error: {:?}", result.err());

            vm_mock.assert_async().await;
            bridge_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_user_can_create_vm_denied() {
            let mut server = Server::new_async().await;

            // A read-only user can log in fine but only has audit rights.
            let vm_mock = mock_privileges(&mut server, "/vms/100", &["VM.Audit"]).await;

            match ensure_user_can_create_vm(&test_session(&server), &vm_config(true)).await {
                Err(Error::ProxmoxApi(msg)) => {
                    assert!(msg.contains("VM.Allocate"), "{}", msg);
                    assert!(msg.contains("VM.PowerMgmt"), "{}", msg);
                    assert!(!msg.contains("VM.Audit"), "{}", msg);
                }
                other => panic!("Expected permission error, got {:?}", other),
            }

            vm_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_user_can_create_vm_needs_power_only_for_auto_start() {
            let mut server = Server::new_async().await;

            let vm_mock = mock_privileges(&mut server, "/vms/100", VM_CREATE_PRIVILEGES).await;
            let bridge_mock =
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &["SDN.Use"]).await;

            let result = ensure_user_can_create_vm(&test_session(&server), &vm_config(false)).await;
            assert!(result.is_ok(), "unexpected error: {:?}", result.err());

            vm_mock.assert_async().await;
            bridge_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_ensure_user_can_create_vm_needs_bridge_access() {
            let mut server = Server::new_async().await;

            let vm_mock = mock_privileges(&mut server, "/vms/100", VM_CREATE_PRIVILEGES).await;
            let bridge_mock =
                mock_privileges(&mut server, "/sdn/zones/localnetwork/vmbr0", &[]).await;

            match ensure_user_can_create_vm(&test_session(&server), &vm_config(false)).await {
                Err(Error::ProxmoxApi(msg)) => {
                    assert!(msg.contains("SDN.Use"), "{}", msg);
                    assert!(msg.contains("vmbr0"), "{}", msg);
                }
                other => panic!("Expected bridge permission error, got {:?}", other),
            }

            vm_mock.assert_async().await;
            bridge_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
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

            let result = uploadable_import_storages(&test_session(&server), &storage_list)
                .await
                .unwrap();
            let names: Vec<&str> = result.iter().map(|s| s.name.as_str()).collect();
            assert_eq!(names, vec!["local"]);

            denied_mock.assert_async().await;
            upload_only_mock.assert_async().await;
            allowed_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_uploadable_import_storages_reports_when_none_allowed() {
            let mut server = Server::new_async().await;

            let denied_mock =
                mock_privileges(&mut server, "/storage/local", &["Datastore.Audit"]).await;

            let storage_list = vec![storage("local", true, &["iso", "import"])];

            match uploadable_import_storages(&test_session(&server), &storage_list).await {
                Err(Error::ProxmoxApi(msg)) => {
                    assert!(msg.contains("Datastore.AllocateTemplate"), "{}", msg);
                    assert!(msg.contains("local"), "{}", msg);
                }
                other => panic!("Expected upload permission error, got {:?}", other),
            }

            denied_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_create_vm_digest_failure_after_healthy_preflight() {
            let mut server = Server::new_async().await;

            struct ImageSource {
                cache: tempfile::TempDir,
                url: String,
            }
            impl ReleaseSource for ImageSource {
                async fn check_connection(&self) -> Result<()> {
                    unreachable!("must not check connectivity during VM creation")
                }

                async fn get_device_manifest(&self) -> Result<crate::DeviceManifest> {
                    unreachable!()
                }
                async fn get_haos_release(&self, _: &str) -> Result<HaosRelease> {
                    unreachable!("must use OVA's board-specific release")
                }
                async fn get_latest_haos_release_for_board(
                    &self,
                    board: &str,
                ) -> Result<HaosRelease> {
                    assert_eq!(board, "ova");
                    Ok(HaosRelease {
                        version: "18.2".into(),
                        images: vec![HaosImage {
                            board: "ova".into(),
                            format: ImageFormat::Qcow2,
                            download_url: self.url.clone(),
                            size: 8,
                            digest: Some(format!("sha256:{}", "0".repeat(64))),
                        }],
                    })
                }
                async fn download_image<P: ProgressCallback>(
                    &self,
                    image: &HaosImage,
                    dest: &std::path::Path,
                    callback: &P,
                ) -> Result<()> {
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
                    panic!("unverified image reached extraction")
                }
                fn cache_dir(&self) -> Result<std::path::PathBuf> {
                    Ok(self.cache.path().to_path_buf())
                }
            }
            let backend = ImageSource {
                cache: tempfile::tempdir().unwrap(),
                url: format!("{}/image.xz", server.url()),
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
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": [{"node": "pve", "status": "online"}]}"#)
                .create_async()
                .await;

            let mut vm_privileges = VM_CREATE_PRIVILEGES.to_vec();
            vm_privileges.push("VM.PowerMgmt");
            let permission_mocks = vec![
                mock_privileges(&mut server, "/vms/100", &vm_privileges).await,
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
                .with_status(200)
                .with_header("content-type", "application/json")
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
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": "100"}"#)
                .create_async()
                .await;

            let config = ProxmoxVmConfig {
                vm_id: 100,
                name: "homeassistant".to_string(),
                node: "pve".to_string(),
                storage: "local-lvm".to_string(),
                cpu_cores: 2,
                memory_mb: 4096,
                disk_size_gb: 32,
                auto_start: true,
            };

            let result = create_vm(
                &backend,
                &test_session(&server),
                &config,
                &crate::NoOpProgress,
            )
            .await;
            assert!(
                matches!(result, Err(Error::ChecksumMismatch { .. })),
                "unexpected result: {result:?}"
            );
            assert_eq!(std::fs::read_dir(backend.cache.path()).unwrap().count(), 0);
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
        #[serial]
        async fn test_pre_install_checks_stop_at_offline_node() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_status(200)
                .with_header("content-type", "application/json")
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

            let config = ProxmoxVmConfig {
                vm_id: 100,
                name: "homeassistant".to_string(),
                node: "pve".to_string(),
                storage: "local-lvm".to_string(),
                cpu_cores: 2,
                memory_mb: 4096,
                disk_size_gb: 32,
                auto_start: true,
            };

            match pre_install_checks(&test_session(&server), &config, 400_000_000).await {
                Err(Error::ProxmoxApi(msg)) => assert!(msg.contains("offline"), "{}", msg),
                other => panic!("Expected offline node error, got {:?}", other),
            }

            nodes_mock.assert_async().await;
            permissions_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_next_vm_id_success() {
            let mut server = Server::new_async().await;

            let vmid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": "100"}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = get_next_vm_id(&session).await;
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), 100);

            vmid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_next_vm_id_as_number() {
            let mut server = Server::new_async().await;

            // Some Proxmox versions return the ID as a number
            let vmid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": 105}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = get_next_vm_id(&session).await;
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), 105);

            vmid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_next_vm_id_high_number() {
            let mut server = Server::new_async().await;

            let vmid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": "999"}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = get_next_vm_id(&session).await;
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), 999);

            vmid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_nodes_server_error() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_status(500)
                .with_body("Internal Server Error")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_nodes(&session).await;
            assert!(result.is_err());

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_missing_ticket_in_response() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "username": "root@pam"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("ticket"));
            } else {
                panic!("Expected ProxmoxApi error for missing ticket");
            }

            auth_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_missing_csrf_in_response() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "ticket": "PVE:root@pam:12345678::abcdef...",
                            "username": "root@pam"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("CSRFPreventionToken"));
            } else {
                panic!("Expected ProxmoxApi error for missing CSRF token");
            }

            auth_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_storage_node_not_found() {
            let mut server = Server::new_async().await;

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/nonexistent/storage")
                .with_status(404)
                .with_body("node not found")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_storage(&session, "nonexistent").await;
            assert!(result.is_err());

            storage_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_next_vm_id_invalid_format() {
            let mut server = Server::new_async().await;

            let vmid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": "not-a-number"}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = get_next_vm_id(&session).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Invalid VM ID"));
            } else {
                panic!("Expected ProxmoxApi error for invalid VM ID");
            }

            vmid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_nodes_permission_denied() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_status(403)
                .with_body("permission denied")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_nodes(&session).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Access denied") || msg.contains("permission"));
            } else {
                panic!("Expected ProxmoxApi error for 403");
            }

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_task_success() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "status": "stopped",
                            "exitstatus": "OK"
                        }
                    }"#,
                )
                .expect_at_least(1)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve",
                "UPID:pve:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;
            assert!(result.is_ok());

            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_task_failure() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "status": "stopped",
                            "exitstatus": "ERROR"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve",
                "UPID:pve:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Task failed"));
            } else {
                panic!("Expected ProxmoxApi error for failed task");
            }

            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_task_timeout() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "status": "running"
                        }
                    }"#,
                )
                .expect_at_least(1)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve",
                "UPID:pve:00000001:00000002:00000003:test:root@pam:",
                1, // 1 second timeout
            )
            .await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("timed out"));
            } else {
                panic!("Expected ProxmoxApi error for timeout");
            }

            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_task_http_error() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(500)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve",
                "UPID:pve:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;
            assert!(result.is_err());

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
        #[serial]
        async fn test_wait_for_task_polls_the_node_from_the_upid() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve2/tasks/UPID%3Apve2%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": {"status": "stopped", "exitstatus": "OK"}}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve1",
                "UPID:pve2:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;
            assert!(result.is_ok(), "{result:?}");

            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_task_error_includes_what_proxmox_said() {
            let mut server = Server::new_async().await;

            let _task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(400)
                .with_header("content-type", "application/json")
                .with_body(r#"{"errors":{"upid":"no such task"},"data":null}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve",
                "UPID:pve:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;

            match result {
                Err(Error::ProxmoxApi(msg)) => {
                    assert!(msg.contains("400"), "{msg}");
                    assert!(msg.contains("no such task"), "{msg}");
                }
                other => panic!("Expected ProxmoxApi error, got {other:?}"),
            }
        }

        #[tokio::test]
        #[serial]
        async fn test_create_vm_with_disk_success() {
            for disk_size_gb in [32, 64, 128, 256, 512] {
                check_create_vm_with_disk_size(disk_size_gb).await;
            }
        }

        async fn check_create_vm_with_disk_size(disk_size_gb: u32) {
            let mut server = Server::new_async().await;
            let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

            let vm_create_mock = server
                .mock("POST", "/api2/json/nodes/pve/qemu")
                .match_header("Cookie", Matcher::Regex("PVEAuthCookie=.*".to_string()))
                .match_header(
                    "CSRFPreventionToken",
                    Matcher::Regex("test-csrf".to_string()),
                )
                // The import source must use the selected storage, not a hardcoded "local".
                .match_body(Matcher::UrlEncoded(
                    "scsi0".to_string(),
                    "local-lvm:0,import-from=local-import:import/test-image.qcow2".to_string(),
                ))
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": "UPID:pve:00000001:00000002:00000003:qmcreate:root@pam:"
                    }"#,
                )
                .create_async()
                .await;

            // Mock task completion
            let create_requests = requests.clone();
            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Aqmcreate%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body_from_request(move |_| {
                    create_requests.lock().unwrap().push("import complete");
                    r#"{"data":{"status":"stopped","exitstatus":"OK"}}"#.into()
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
                .with_header("content-type", "application/json")
                .with_body_from_request(move |_| {
                    resize_requests.lock().unwrap().push("resize requested");
                    r#"{"data":"resize-task"}"#.into()
                })
                .create_async()
                .await;
            let resize_task_requests = requests.clone();
            let resize_task_mock = server
                .mock("GET", "/api2/json/nodes/pve/tasks/resize-task/status")
                .with_header("content-type", "application/json")
                .with_body_from_request(move |_| {
                    resize_task_requests.lock().unwrap().push("resize complete");
                    r#"{"data":{"status":"stopped","exitstatus":"OK"}}"#.into()
                })
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let config = ProxmoxVmConfig {
                vm_id: 100,
                name: "test-vm".to_string(),
                node: "pve".to_string(),
                storage: "local-lvm".to_string(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb,
                auto_start: false,
            };

            let result = create_vm_with_disk(
                &session,
                &config,
                "test-image.qcow2",
                "local-import",
                &mut false,
            )
            .await;
            assert!(result.is_ok());

            vm_create_mock.assert_async().await;
            task_mock.assert_async().await;
            resize_mock.assert_async().await;
            resize_task_mock.assert_async().await;
            assert_eq!(
                *requests.lock().unwrap(),
                ["import complete", "resize requested", "resize complete"]
            );
        }

        fn disk_test_config(disk_size_gb: u32) -> ProxmoxVmConfig {
            ProxmoxVmConfig {
                vm_id: 100,
                name: "test-vm".into(),
                node: "pve".into(),
                storage: "local-lvm".into(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb,
                auto_start: true,
            }
        }

        #[tokio::test]
        async fn test_disk_minimum_rejected_before_download_or_creation() {
            let session = ProxmoxSession {
                server_url: "http://127.0.0.1:1".into(),
                ticket: "test-ticket".into(),
                csrf_token: "test-csrf".into(),
            };
            for size in [0, 1, 31] {
                let config = disk_test_config(size);
                let error = create_vm(&Backend, &session, &config, &crate::NoOpProgress)
                    .await
                    .unwrap_err();
                assert!(error.to_string().contains("at least 32 GiB"));
                let mut source_unused = false;
                let error = create_vm_with_disk(
                    &session,
                    &config,
                    "haos.qcow2",
                    "local",
                    &mut source_unused,
                )
                .await
                .unwrap_err();
                assert!(error.to_string().contains("cannot shrink"));
                assert!(source_unused);
            }
        }

        #[tokio::test]
        async fn test_disk_resize_failures_propagate_from_creation() {
            for (status, body, task_status, expected_error) in [
                (500, "Insufficient storage", None, "Insufficient storage"),
                (403, "Permission denied", None, "Permission denied"),
                (200, "invalid json", None, "parse disk resize response"),
                (200, r#"{"data":null}"#, None, "missing task UPID"),
                (200, r#"{"data":""}"#, None, "missing task UPID"),
                (200, r#"{"data":12}"#, None, "missing task UPID"),
                (
                    200,
                    r#"{"data":"resize-task"}"#,
                    Some("shrinking disks is not supported"),
                    "shrinking disks is not supported",
                ),
            ] {
                let mut server = Server::new_async().await;
                let create_mock = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_header("content-type", "application/json")
                    .with_body(r#"{"data":"create-task"}"#)
                    .create_async()
                    .await;
                let create_task = server
                    .mock("GET", "/api2/json/nodes/pve/tasks/create-task/status")
                    .with_header("content-type", "application/json")
                    .with_body(r#"{"data":{"status":"stopped","exitstatus":"OK"}}"#)
                    .create_async()
                    .await;
                let resize_mock = server
                    .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                    .with_status(status)
                    .with_body(body)
                    .create_async()
                    .await;
                let resize_task = server
                    .mock("GET", "/api2/json/nodes/pve/tasks/resize-task/status")
                    .with_header("content-type", "application/json")
                    .with_body(
                        serde_json::json!({
                            "data": {"status": "stopped", "exitstatus": task_status}
                        })
                        .to_string(),
                    )
                    .expect(usize::from(task_status.is_some()))
                    .create_async()
                    .await;
                let session = ProxmoxSession {
                    server_url: server.url(),
                    ticket: "test-ticket".into(),
                    csrf_token: "test-csrf".into(),
                };
                let delete = server
                    .mock(
                        "DELETE",
                        "/api2/json/nodes/pve/storage/local/content/local%3Aimport%2Fhaos.qcow2",
                    )
                    .with_status(500)
                    .create_async()
                    .await;
                let error = import_and_cleanup_image(
                    &session,
                    &disk_test_config(32),
                    "haos.qcow2",
                    "local",
                )
                .await
                .unwrap_err();
                assert!(error.to_string().contains(expected_error), "{error}");
                assert!(error
                    .to_string()
                    .contains("VM 100 was created but its disk could not be resized"));
                assert_eq!(error.to_string().matches("Proxmox API error:").count(), 1);
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
                let create_mock = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_header("content-type", "application/json")
                    .with_body(body)
                    .create_async()
                    .await;
                let create_task = server
                    .mock("GET", "/api2/json/nodes/pve/tasks/create-task/status")
                    .with_header("content-type", "application/json")
                    .with_body(r#"{"data":{"status":"stopped","exitstatus":"import failed"}}"#)
                    .expect(usize::from(body.contains("create-task")))
                    .create_async()
                    .await;
                let resize_mock = server
                    .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                    .expect(0)
                    .create_async()
                    .await;
                let session = ProxmoxSession {
                    server_url: server.url(),
                    ticket: "test-ticket".into(),
                    csrf_token: "test-csrf".into(),
                };
                assert!(create_vm_with_disk(
                    &session,
                    &disk_test_config(64),
                    "haos.qcow2",
                    "local",
                    &mut false,
                )
                .await
                .is_err());
                create_mock.assert_async().await;
                create_task.assert_async().await;
                resize_mock.assert_async().await;
            }
        }

        #[tokio::test]
        #[serial]
        async fn test_create_vm_with_disk_error() {
            let mut server = Server::new_async().await;

            let vm_create_mock = server
                .mock("POST", "/api2/json/nodes/pve/qemu")
                .with_status(500)
                .with_body("Internal server error")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let config = ProxmoxVmConfig {
                vm_id: 100,
                name: "test-vm".to_string(),
                node: "pve".to_string(),
                storage: "local-lvm".to_string(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb: 32,
                auto_start: false,
            };

            let result =
                create_vm_with_disk(&session, &config, "test-image.qcow2", "local", &mut false)
                    .await;
            assert!(result.is_err());

            vm_create_mock.assert_async().await;
        }

        #[tokio::test]
        async fn delete_import_image_requires_a_task_upid() {
            for response in ["{}", r#"{"data":null}"#, r#"{"data":""}"#, r#"{"data":42}"#] {
                let mut server = Server::new_async().await;
                let delete = server
                    .mock("DELETE", "/api2/json/nodes/pve/storage/local-import/content/local-import%3Aimport%2Fhai-image-unique.qcow2")
                    .with_body(response)
                    .create_async()
                    .await;
                let task = server
                    .mock("GET", Matcher::Any)
                    .expect(0)
                    .create_async()
                    .await;
                let session = ProxmoxSession {
                    server_url: server.url(),
                    ticket: "test-ticket".into(),
                    csrf_token: "test-csrf".into(),
                };
                let error =
                    delete_import_image(&session, "pve", "local-import", "hai-image-unique.qcow2")
                        .await
                        .unwrap_err();
                assert!(error
                    .to_string()
                    .contains("Import deletion response missing task UPID"));
                delete.assert_async().await;
                task.assert_async().await;
            }
        }

        #[tokio::test]
        async fn import_cleanup_waits_for_completion_and_preserves_install_result() {
            use std::sync::{
                atomic::{AtomicBool, Ordering},
                Arc,
            };
            for cleanup_status in [200, 403, 500] {
                let mut server = Server::new_async().await;
                let completed = Arc::new(AtomicBool::new(false));
                let task_completed = completed.clone();
                let create = server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_body(r#"{"data":"import-task"}"#)
                    .create_async()
                    .await;
                let task = server
                    .mock("GET", "/api2/json/nodes/pve/tasks/import-task/status")
                    .with_chunked_body(move |writer| {
                        task_completed.store(true, Ordering::SeqCst);
                        writer.write_all(br#"{"data":{"status":"stopped","exitstatus":"OK"}}"#)
                    })
                    .create_async()
                    .await;
                let resize = server
                    .mock("PUT", "/api2/json/nodes/pve/qemu/100/resize")
                    .with_body(r#"{"data":"resize-task"}"#)
                    .create_async()
                    .await;
                let resize_task = server
                    .mock("GET", "/api2/json/nodes/pve/tasks/resize-task/status")
                    .with_body(r#"{"data":{"status":"stopped","exitstatus":"OK"}}"#)
                    .create_async()
                    .await;
                let delete = server.mock("DELETE", "/api2/json/nodes/pve/storage/local-import/content/local-import%3Aimport%2Fhai-image-unique.qcow2")
                    .match_header("cookie", "PVEAuthCookie=test-ticket")
                    .match_header("CSRFPreventionToken", "test-csrf")
                    .with_status(cleanup_status)
                    .with_chunked_body(move |writer| {
                        assert!(completed.load(Ordering::SeqCst), "deleted before import completion");
                        writer.write_all(br#"{"data":"delete-task"}"#)
                    }).create_async().await;
                let cleanup_task = server
                    .mock("GET", "/api2/json/nodes/pve/tasks/delete-task/status")
                    .with_body(r#"{"data":{"status":"stopped","exitstatus":"OK"}}"#)
                    .expect(if cleanup_status == 200 { 1 } else { 0 })
                    .create_async()
                    .await;
                let session = ProxmoxSession {
                    server_url: server.url(),
                    ticket: "test-ticket".into(),
                    csrf_token: "test-csrf".into(),
                };
                let config = ProxmoxVmConfig {
                    vm_id: 100,
                    name: "test-vm".into(),
                    node: "pve".into(),
                    storage: "local-lvm".into(),
                    cpu_cores: 2,
                    memory_mb: 2048,
                    disk_size_gb: 32,
                    auto_start: false,
                };
                import_and_cleanup_image(
                    &session,
                    &config,
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
            }
        }

        #[tokio::test]
        async fn failed_import_cleanup_requires_a_known_terminal_outcome() {
            for (create_status, response, task_status, task_body, deletes) in [
                (200, r#"{"data":null}"#, 200, "{}", 0),
                (200, r#"{"data":""}"#, 200, "{}", 0),
                (200, r#"{"data":"import-task"}"#, 503, "unavailable", 0),
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
                server
                    .mock("POST", "/api2/json/nodes/pve/qemu")
                    .with_status(create_status)
                    .with_body(response)
                    .create_async()
                    .await;
                server
                    .mock("GET", "/api2/json/nodes/pve/tasks/import-task/status")
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
                let session = ProxmoxSession {
                    server_url: server.url(),
                    ticket: "test-ticket".into(),
                    csrf_token: "test-csrf".into(),
                };
                let config = ProxmoxVmConfig {
                    vm_id: 100,
                    name: "test-vm".into(),
                    node: "pve".into(),
                    storage: "local-lvm".into(),
                    cpu_cores: 2,
                    memory_mb: 2048,
                    disk_size_gb: 32,
                    auto_start: false,
                };
                assert!(import_and_cleanup_image(
                    &session,
                    &config,
                    "hai-image-unique.qcow2",
                    "local-import"
                )
                .await
                .is_err());
                delete.assert_async().await;
            }
        }

        #[tokio::test]
        #[serial]
        async fn test_start_vm_success() {
            let mut server = Server::new_async().await;

            let start_mock = server
                .mock("POST", "/api2/json/nodes/pve/qemu/100/status/start")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": "UPID:pve:00000001:00000002:00000003:qmstart:root@pam:"
                    }"#,
                )
                .create_async()
                .await;

            // Mock task completion
            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Aqmstart%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "status": "stopped",
                            "exitstatus": "OK"
                        }
                    }"#,
                )
                .expect_at_least(1)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = start_vm(&session, "pve", 100).await;
            assert!(result.is_ok());

            start_mock.assert_async().await;
            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_start_vm_error() {
            let mut server = Server::new_async().await;

            let start_mock = server
                .mock("POST", "/api2/json/nodes/pve/qemu/100/status/start")
                .with_status(500)
                .with_body("Failed to start VM")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = start_vm(&session, "pve", 100).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Failed to start VM"));
            } else {
                panic!("Expected ProxmoxApi error");
            }

            start_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_vm_ip_success() {
            let mut server = Server::new_async().await;

            let ip_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/qemu/100/agent/network-get-interfaces",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "result": [
                                {
                                    "name": "lo",
                                    "ip-addresses": []
                                },
                                {
                                    "name": "eth0",
                                    "ip-addresses": [
                                        {
                                            "ip-address-type": "ipv4",
                                            "ip-address": "192.168.1.100"
                                        }
                                    ]
                                }
                            ]
                        }
                    }"#,
                )
                .expect_at_least(1)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_vm_ip(&session, "pve", 100).await;
            assert!(result.is_some());
            assert_eq!(result.unwrap(), "192.168.1.100");

            ip_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_vm_ip_skip_loopback() {
            let mut server = Server::new_async().await;

            let ip_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/qemu/100/agent/network-get-interfaces",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "result": [
                                {
                                    "name": "eth0",
                                    "ip-addresses": [
                                        {
                                            "ip-address-type": "ipv4",
                                            "ip-address": "127.0.0.1"
                                        },
                                        {
                                            "ip-address-type": "ipv4",
                                            "ip-address": "192.168.1.100"
                                        }
                                    ]
                                }
                            ]
                        }
                    }"#,
                )
                .expect_at_least(1)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_vm_ip(&session, "pve", 100).await;
            assert!(result.is_some());
            assert_eq!(result.unwrap(), "192.168.1.100");

            ip_mock.assert_async().await;
        }

        // NOTE: Skipping test_wait_for_vm_ip_no_ip because it takes 5+ minutes
        // wait_for_vm_ip retries 150 times with 2 second sleep = 300 seconds
        // The success paths are already tested above

        #[tokio::test]
        #[serial]
        async fn test_wait_for_ha_webserver_at_url_success() {
            let mut server = Server::new_async().await;

            let web_mock = server
                .mock("GET", "/")
                .with_status(200)
                .with_body("Home Assistant")
                .create_async()
                .await;

            let result = wait_for_ha_webserver_at_url(&server.url()).await;
            assert!(result);

            web_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_ha_webserver_at_url_404_is_success() {
            let mut server = Server::new_async().await;

            let web_mock = server
                .mock("GET", "/")
                .with_status(404)
                .with_body("Not Found")
                .create_async()
                .await;

            let result = wait_for_ha_webserver_at_url(&server.url()).await;
            assert!(result); // 404 is < 500, so it's considered "up"

            web_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_ha_updated_at_url_success() {
            let mut server = Server::new_async().await;

            let manifest_mock = server
                .mock("GET", "/manifest.json")
                .with_status(200)
                .with_body(r#"{"version": "2023.12.0"}"#)
                .create_async()
                .await;

            let result = wait_for_ha_updated_at_url(&server.url()).await;
            assert!(result);

            manifest_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_missing_data() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{}"#)
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("data"));
            } else {
                panic!("Expected ProxmoxApi error for missing data");
            }

            auth_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_invalid_json() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("not json")
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("parse"));
            } else {
                panic!("Expected ProxmoxApi error for invalid JSON");
            }

            auth_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_version_check_error() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "ticket": "PVE:root@pam:12345678::abcdef...",
                            "CSRFPreventionToken": "csrf-token",
                            "username": "root@pam"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let version_mock = server
                .mock("GET", "/api2/json/version")
                .with_status(500)
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            auth_mock.assert_async().await;
            version_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_version_missing_version_field() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "ticket": "PVE:root@pam:12345678::abcdef...",
                            "CSRFPreventionToken": "csrf-token",
                            "username": "root@pam"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let version_mock = server
                .mock("GET", "/api2/json/version")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "release": "8.4"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("version"));
            } else {
                panic!("Expected ProxmoxApi error for missing version");
            }

            auth_mock.assert_async().await;
            version_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_invalid_version_string() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "ticket": "PVE:root@pam:12345678::abcdef...",
                            "CSRFPreventionToken": "csrf-token",
                            "username": "root@pam"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let version_mock = server
                .mock("GET", "/api2/json/version")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "data": {
                            "version": "invalid",
                            "release": "8.4"
                        }
                    }"#,
                )
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("parse") && msg.contains("version"));
            } else {
                panic!("Expected ProxmoxApi error for invalid version");
            }

            auth_mock.assert_async().await;
            version_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_server_error() {
            let mut server = Server::new_async().await;

            let auth_mock = server
                .mock("POST", "/api2/json/access/ticket")
                .with_status(500)
                .with_body("Internal Server Error")
                .create_async()
                .await;

            let credentials = ProxmoxCredentials {
                server_url: server.url(),
                username: "root@pam".to_string(),
                password: "password".to_string(),
                totp: None,
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("error") && msg.contains("500"));
            } else {
                panic!("Expected ProxmoxApi error for server error");
            }

            auth_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_next_vm_id_unexpected_type() {
            let mut server = Server::new_async().await;

            let vmid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": {"invalid": "object"}}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = get_next_vm_id(&session).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Unexpected VM ID type"));
            } else {
                panic!("Expected ProxmoxApi error for unexpected type");
            }

            vmid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_next_vm_id_missing_data() {
            let mut server = Server::new_async().await;

            let vmid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = get_next_vm_id(&session).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("data"));
            } else {
                panic!("Expected ProxmoxApi error for missing data");
            }

            vmid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_get_next_vm_id_server_error() {
            let mut server = Server::new_async().await;

            let vmid_mock = server
                .mock("GET", "/api2/json/cluster/nextid")
                .with_status(500)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = get_next_vm_id(&session).await;
            assert!(result.is_err());

            vmid_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_storage_invalid_json() {
            let mut server = Server::new_async().await;

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("not json")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_storage(&session, "pve").await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("parse"));
            } else {
                panic!("Expected ProxmoxApi error for invalid JSON");
            }

            storage_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_storage_missing_data() {
            let mut server = Server::new_async().await;

            let storage_mock = server
                .mock("GET", "/api2/json/nodes/pve/storage")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_storage(&session, "pve").await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("data"));
            } else {
                panic!("Expected ProxmoxApi error for missing data");
            }

            storage_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_nodes_invalid_json() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("not json")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_nodes(&session).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("parse"));
            } else {
                panic!("Expected ProxmoxApi error for invalid JSON");
            }

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_nodes_missing_data() {
            let mut server = Server::new_async().await;

            let nodes_mock = server
                .mock("GET", "/api2/json/nodes")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = list_nodes(&session).await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Unexpected") || msg.contains("data"));
            } else {
                panic!("Expected ProxmoxApi error for missing data");
            }

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_task_missing_data() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve",
                "UPID:pve:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("Invalid task status"));
            } else {
                panic!("Expected ProxmoxApi error for missing data");
            }

            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_wait_for_task_invalid_json() {
            let mut server = Server::new_async().await;

            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Atest%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("not json")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let result = wait_for_task(
                &session,
                "pve",
                "UPID:pve:00000001:00000002:00000003:test:root@pam:",
                10,
            )
            .await;
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("parse"));
            } else {
                panic!("Expected ProxmoxApi error for invalid JSON");
            }

            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_upload_image_to_proxmox_success() {
            let mut server = Server::new_async().await;

            // Create a temp file to upload
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
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": "UPID:pve:00000001:00000002:00000003:imgup:root@pam:"}"#)
                .create_async()
                .await;

            // Mock the task status endpoint (task completes immediately)
            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Aimgup%3Aroot%40pam%3A/status",
                )
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": {"status": "stopped", "exitstatus": "OK"}}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let callback = TestProgressCallback::new();
            let result =
                upload_image_to_proxmox(&session, "pve", &temp_file, &callback, "local-import")
                    .await;

            assert!(result.is_ok(), "Upload should succeed: {:?}", result.err());
            let filename = result.unwrap();
            assert_eq!(filename, "test-image.qcow2");

            // Verify progress updates were sent
            let updates = callback.get_updates();
            assert!(updates.iter().any(|update| {
                update.bytes_processed == 18 && update.message.starts_with("Uploading ")
            }));
            assert_eq!(updates.last().unwrap().progress, 100);

            upload_mock.assert_async().await;
            task_mock.assert_async().await;
        }

        #[tokio::test]
        async fn test_upload_image_to_proxmox_backpressure_and_disconnect() {
            use tokio::io::AsyncReadExt;

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let session = ProxmoxSession {
                server_url: format!("http://{}", listener.local_addr().unwrap()),
                ticket: "test-ticket".into(),
                csrf_token: "test-csrf".into(),
            };
            let temp_dir = tempfile::tempdir().unwrap();
            let path = temp_dir.path().join("large.qcow2");
            let size = 128 * 1024 * 1024;
            std::fs::File::create(&path).unwrap().set_len(size).unwrap();
            let callback = TestProgressCallback::new();

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
                let updates = callback.get_updates();
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
            let updates = callback.get_updates();
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
            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".into(),
                csrf_token: "test-csrf".into(),
            };
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
            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".into(),
                csrf_token: "test-csrf".into(),
            };
            // Linux can open a directory as a file, but reading it fails.
            let temp_dir = tempfile::tempdir().unwrap();
            std::fs::write(temp_dir.path().join("image.qcow2"), b"image").unwrap();
            let path = temp_dir.path().to_path_buf();
            let callback = TestProgressCallback::new();
            let error = upload_image_to_proxmox(&session, "pve", &path, &callback, "local")
                .await
                .unwrap_err();
            let cause = std::io::Error::from_raw_os_error(libc::EISDIR).to_string();
            assert!(error.to_string().contains(&cause), "{error}");
            assert!(callback
                .get_updates()
                .iter()
                .all(|update| update.progress < 100));
        }

        #[tokio::test]
        #[serial]
        async fn test_upload_image_to_proxmox_http_error() {
            let mut server = Server::new_async().await;

            // Create a temp file to upload
            let temp_dir = tempfile::tempdir().unwrap();
            let temp_file = temp_dir.path().join("test-image.qcow2");
            std::fs::write(&temp_file, b"test image content").unwrap();

            // Mock the upload endpoint with a 500 error
            let upload_mock = server
                .mock("POST", "/api2/json/nodes/pve/storage/local/upload")
                .with_status(500)
                .with_body("Internal Server Error")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let callback = TestProgressCallback::new();
            let result =
                upload_image_to_proxmox(&session, "pve", &temp_file, &callback, "local").await;

            assert!(result.is_err());
            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("500"));
            } else {
                panic!("Expected ProxmoxApi error");
            }

            upload_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_upload_image_to_proxmox_invalid_response() {
            let mut server = Server::new_async().await;

            // Create a temp file to upload
            let temp_dir = tempfile::tempdir().unwrap();
            let temp_file = temp_dir.path().join("test-image.qcow2");
            std::fs::write(&temp_file, b"test image content").unwrap();

            // Mock the upload endpoint with invalid JSON
            let upload_mock = server
                .mock("POST", "/api2/json/nodes/pve/storage/local/upload")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body("not json")
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let callback = TestProgressCallback::new();
            let result =
                upload_image_to_proxmox(&session, "pve", &temp_file, &callback, "local").await;

            assert!(result.is_err());
            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("parse"));
            } else {
                panic!("Expected ProxmoxApi error");
            }

            upload_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_upload_image_to_proxmox_missing_upid() {
            let mut server = Server::new_async().await;

            // Create a temp file to upload
            let temp_dir = tempfile::tempdir().unwrap();
            let temp_file = temp_dir.path().join("test-image.qcow2");
            std::fs::write(&temp_file, b"test image content").unwrap();

            // Mock the upload endpoint without UPID in response
            let upload_mock = server
                .mock("POST", "/api2/json/nodes/pve/storage/local/upload")
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(r#"{"data": null}"#)
                .create_async()
                .await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let callback = TestProgressCallback::new();
            let result =
                upload_image_to_proxmox(&session, "pve", &temp_file, &callback, "local").await;

            assert!(result.is_err());
            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("UPID"));
            } else {
                panic!("Expected ProxmoxApi error");
            }

            upload_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_upload_image_to_proxmox_file_not_found() {
            let server = Server::new_async().await;

            let session = ProxmoxSession {
                server_url: server.url(),
                ticket: "test-ticket".to_string(),
                csrf_token: "test-csrf".to_string(),
            };

            let nonexistent_file = std::path::PathBuf::from("/nonexistent/path/to/image.qcow2");

            let callback = TestProgressCallback::new();
            let result =
                upload_image_to_proxmox(&session, "pve", &nonexistent_file, &callback, "local")
                    .await;

            assert!(result.is_err());
            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("open") || msg.contains("Failed"));
            } else {
                panic!("Expected ProxmoxApi error");
            }
        }
    }
}
