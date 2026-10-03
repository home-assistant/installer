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
//! 8. Start VM and wait for IP via QEMU guest agent
//!
//! References:
//! - https://forum.proxmox.com/threads/api-equivalent-of-qm-importdisk.157457/
//! - https://forum.proxmox.com/threads/guide-install-home-assistant-os-in-a-vm.143251/

use crate::error::{Error, Result};
use crate::types::{
    FlashProgress, FlashStage, HaosImage, HaosRelease, ImageFormat, ProxmoxCredentials,
    ProxmoxNode, ProxmoxSession, ProxmoxStorage, ProxmoxVmConfig, ProxmoxVmResult,
};
use crate::ProgressCallback;
use std::collections::HashSet;

/// Minimum required Proxmox VE version for disk image import via API.
/// Version 8.4.1 added support for uploading qcow2/raw/img/vmdk files with content=import.
const MIN_PROXMOX_VERSION: (u32, u32, u32) = (8, 4, 1);

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

/// Authenticate with a Proxmox server and verify version requirements.
///
/// This function also verifies the Proxmox version is at least 8.4.1,
/// which is required for disk image import via the API.
pub async fn authenticate(credentials: &ProxmoxCredentials) -> Result<ProxmoxSession> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(ProxmoxSession {
                server_url: credentials.server_url.clone(),
                ticket: "mock-ticket".to_string(),
                csrf_token: "mock-csrf-token".to_string(),
            });
        }
    }

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
pub async fn list_nodes(session: &ProxmoxSession) -> Result<Vec<ProxmoxNode>> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(vec![
                ProxmoxNode {
                    name: "pve".to_string(),
                    status: "online".to_string(),
                    cpu_usage: Some(0.15),
                    memory_used: Some(4_000_000_000),
                    memory_total: Some(16_000_000_000),
                },
                ProxmoxNode {
                    name: "pve2".to_string(),
                    status: "online".to_string(),
                    cpu_usage: Some(0.25),
                    memory_used: Some(8_000_000_000),
                    memory_total: Some(32_000_000_000),
                },
            ]);
        }
    }

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
            return Err(Error::ProxmoxApi(
                "Authentication expired or invalid. Please reconnect to Proxmox.".to_string(),
            ));
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
pub async fn list_storage(session: &ProxmoxSession, node: &str) -> Result<Vec<ProxmoxStorage>> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            let _ = node;
            return Ok(vec![
                ProxmoxStorage {
                    name: "local".to_string(),
                    storage_type: "dir".to_string(),
                    content: vec![
                        "images".to_string(),
                        "rootdir".to_string(),
                        "import".to_string(),
                    ],
                    available: 100_000_000_000,
                    total: 500_000_000_000,
                    active: true,
                },
                ProxmoxStorage {
                    name: "local-lvm".to_string(),
                    storage_type: "lvmthin".to_string(),
                    content: vec!["images".to_string(), "rootdir".to_string()],
                    available: 200_000_000_000,
                    total: 1_000_000_000_000,
                    active: true,
                },
            ]);
        }
    }

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
pub async fn ensure_vm_id_free(session: &ProxmoxSession, vm_id: u32) -> Result<()> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(());
        }
    }

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
pub async fn get_next_vm_id(session: &ProxmoxSession) -> Result<u32> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            return Ok(100);
        }
    }

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

/// Wait for a Proxmox task to complete.
async fn wait_for_task(
    session: &ProxmoxSession,
    node: &str,
    upid: &str,
    timeout_secs: u64,
) -> Result<()> {
    let url = format!(
        "{}/api2/json/nodes/{}/tasks/{}/status",
        session.server_url.trim_end_matches('/'),
        node,
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

        if !response.status().is_success() {
            return Err(Error::ProxmoxApi(format!(
                "Failed to check task status: {}",
                response.status()
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
    use futures_util::stream;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use tokio::fs::File;
    use tokio::io::AsyncReadExt;

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
        message: format!("Reading {} for upload...", filename),
    });

    // Read the file into memory
    let mut file = File::open(local_path)
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to open image file: {}", e)))?;

    let file_size = file
        .metadata()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to get file metadata: {}", e)))?
        .len();

    let mut file_contents = Vec::with_capacity(file_size as usize);
    file.read_to_end(&mut file_contents)
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to read image file: {}", e)))?;

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

    // Create a chunked stream that reports upload progress
    let chunk_size = 256 * 1024; // 256KB chunks
    let bytes_sent = Arc::new(AtomicU64::new(0));

    // Convert file contents to owned chunks for streaming
    let chunks: Vec<Vec<u8>> = file_contents
        .chunks(chunk_size)
        .map(|c| c.to_vec())
        .collect();
    let total_chunks = chunks.len();

    // Track last progress update
    let last_progress_bytes = Arc::new(AtomicU64::new(0));
    let last_progress_bytes_clone = Arc::clone(&last_progress_bytes);

    let progress_stream = stream::iter(chunks.into_iter().enumerate().map(
        move |(chunk_idx, chunk)| {
            let chunk_len = chunk.len() as u64;
            let sent = bytes_sent.fetch_add(chunk_len, Ordering::SeqCst) + chunk_len;
            let last_update = last_progress_bytes_clone.load(Ordering::SeqCst);

            // Send progress update every PROGRESS_UPDATE_INTERVAL bytes or at the end
            if sent - last_update >= PROGRESS_UPDATE_INTERVAL || chunk_idx == total_chunks - 1 {
                last_progress_bytes_clone.store(sent, Ordering::SeqCst);
            }

            Ok::<_, std::io::Error>(chunk)
        },
    ));

    // Create the multipart part with streaming body
    let body = reqwest::Body::wrap_stream(progress_stream);
    let file_part = reqwest::multipart::Part::stream_with_length(body, file_size)
        .file_name(filename.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| Error::ProxmoxApi(format!("Failed to create file part: {}", e)))?;

    let form = reqwest::multipart::Form::new()
        .text("content", "import")
        .part("filename", file_part);

    let response = client
        .post(&url)
        .header("Cookie", format!("PVEAuthCookie={}", session.ticket))
        .header("CSRFPreventionToken", &session.csrf_token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| Error::ProxmoxApi(format!("Failed to upload image: {}", e)))?;

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
/// disk image during VM creation.
async fn create_vm_with_disk(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    image_filename: &str,
    storage_name: &str,
) -> Result<()> {
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
        return Err(Error::ProxmoxApi(format!(
            "Failed to create VM ({}): {}",
            status, response_text
        )));
    }

    // Parse the response to get the task UPID
    let json: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| Error::ProxmoxApi(format!("Failed to parse VM creation response: {}", e)))?;

    // VM creation returns a task UPID since it involves disk import
    if let Some(upid) = json.get("data").and_then(|v| v.as_str()) {
        // Wait for the VM creation task to complete
        wait_for_task(session, &config.node, upid, 600).await?;
    }

    Ok(())
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

/// Wait for the Home Assistant webserver to be ready on port 8123.
async fn wait_for_ha_webserver(ip: &str) -> bool {
    let base_url = format!("http://{}:8123", ip);
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
    let base_url = format!("http://{}:8123", ip);
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
pub async fn create_vm<P: ProgressCallback>(
    session: &ProxmoxSession,
    config: &ProxmoxVmConfig,
    progress_callback: &P,
) -> Result<ProxmoxVmResult> {
    #[cfg(feature = "mock")]
    {
        if crate::is_mock_enabled() {
            // Simulate VM creation progress
            let stages = [
                (10, "Downloading HAOS image..."),
                (30, "Uploading to Proxmox..."),
                (50, "Creating VM..."),
                (70, "Configuring VM..."),
                (90, "Starting VM..."),
                (100, "Complete"),
            ];

            for (progress, message) in stages {
                progress_callback.on_progress(FlashProgress {
                    stage: if progress < 100 {
                        FlashStage::Downloading
                    } else {
                        FlashStage::Complete
                    },
                    progress,
                    bytes_processed: 0,
                    total_bytes: 0,
                    message: message.to_string(),
                });
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }

            return Ok(ProxmoxVmResult {
                vm_id: config.vm_id,
                node: config.node.clone(),
                ip_address: Some("192.168.1.100".to_string()),
            });
        }
    }

    // Step 1: Get HAOS release info
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Downloading,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Fetching release info...".to_string(),
    });

    // Get the stable version info
    let stable_version = crate::download::get_stable_version().await?;

    // Get the OVA version for Proxmox (generic x86-64 virtualization)
    let haos_version = stable_version
        .hassos
        .get("ova")
        .ok_or_else(|| Error::ProxmoxApi("No HAOS version found for OVA".to_string()))?;

    // Look up the OVA image in the release to get its download URL.
    // Use the OVA's own version rather than "latest", which may differ.
    let release: HaosRelease = crate::download::get_haos_release(haos_version).await?;
    let image: &HaosImage =
        crate::download::find_image_for_board(&release, "ova", ImageFormat::Qcow2).ok_or_else(
            || Error::DownloadFailed(format!("No OVA image in HAOS release {}", haos_version)),
        )?;

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

    let cache_dir = crate::download::get_cache_dir()?;
    let compressed_filename = format!("haos_ova-{}.qcow2.xz", haos_version);
    let compressed_path = cache_dir.join(&compressed_filename);

    // Download the image
    crate::download::download_image(&image.download_url, &compressed_path, progress_callback)
        .await?;

    // Step 3: Extract the compressed image
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Extracting,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Extracting image...".to_string(),
    });

    let extracted_filename = format!("haos_ova-{}.qcow2", haos_version);
    let extracted_path = cache_dir.join(&extracted_filename);

    crate::download::extract_xz(&compressed_path, &extracted_path, progress_callback).await?;

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

    // Step 5: Create the VM with disk import
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Verifying,
        progress: 0,
        bytes_processed: 0,
        total_bytes: 0,
        message: "Creating virtual machine...".to_string(),
    });

    create_vm_with_disk(session, config, &image_filename, &storage_name).await?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn test_authenticate_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let credentials = ProxmoxCredentials {
            server_url: "https://proxmox.local:8006".to_string(),
            username: "root@pam".to_string(),
            password: "password".to_string(),
        };
        let session = authenticate(&credentials).await.unwrap();
        assert_eq!(session.ticket, "mock-ticket");
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_list_nodes_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let session = ProxmoxSession {
            server_url: "https://proxmox.local:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf".to_string(),
        };
        let nodes = list_nodes(&session).await.unwrap();
        assert!(!nodes.is_empty());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_list_storage_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let session = ProxmoxSession {
            server_url: "https://proxmox.local:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf".to_string(),
        };
        let storage = list_storage(&session, "pve").await.unwrap();
        assert!(!storage.is_empty());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_mock_storage_has_import_storage() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let session = ProxmoxSession {
            server_url: "https://proxmox.local:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf".to_string(),
        };
        // The mock fixture must expose an import-capable storage, otherwise the
        // whole Proxmox flow is unreachable without a live server.
        let storage_list = list_storage(&session, "pve").await.unwrap();
        assert_eq!(select_import_storage(&storage_list, 0).unwrap(), "local");
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_ensure_vm_id_free_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let session = ProxmoxSession {
            server_url: "https://proxmox.local:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf".to_string(),
        };
        assert!(ensure_vm_id_free(&session, 100).await.is_ok());
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

    #[tokio::test]
    #[serial]
    async fn test_get_next_vm_id_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let session = ProxmoxSession {
            server_url: "https://proxmox.local:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf".to_string(),
        };
        let vm_id = get_next_vm_id(&session).await.unwrap();
        assert_eq!(vm_id, 100);
        std::env::remove_var("HA_INSTALLER_MOCK");
    }

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

    #[tokio::test]
    #[serial]
    async fn test_create_vm_mock() {
        std::env::set_var("HA_INSTALLER_MOCK", "1");
        let session = ProxmoxSession {
            server_url: "https://proxmox.local:8006".to_string(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf".to_string(),
        };
        let config = ProxmoxVmConfig {
            vm_id: 100,
            name: "homeassistant".to_string(),
            node: "pve".to_string(),
            storage: "local-lvm".to_string(),
            cpu_cores: 2,
            memory_mb: 2048,
            disk_size_gb: 32,
            auto_start: true,
        };

        let result = create_vm(&session, &config, &crate::NoOpProgress).await;
        assert!(result.is_ok());
        let vm_result = result.unwrap();
        assert_eq!(vm_result.vm_id, 100);
        assert_eq!(vm_result.node, "pve");

        std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
        async fn test_authenticate_wrong_credentials() {
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            assert!(result.is_err());

            if let Err(Error::ProxmoxApi(msg)) = result {
                assert!(msg.contains("expired") || msg.contains("Authentication"));
            } else {
                panic!("Expected ProxmoxApi error for 401");
            }

            nodes_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_list_storage_success() {
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
        async fn test_pre_install_checks_pass_on_healthy_server() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = Server::new_async().await;

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

            let result = pre_install_checks(&test_session(&server), &config, 400_000_000).await;
            assert!(result.is_ok(), "unexpected error: {:?}", result.err());

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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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

        #[tokio::test]
        #[serial]
        async fn test_create_vm_with_disk_success() {
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = Server::new_async().await;

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
            let task_mock = server
                .mock(
                    "GET",
                    "/api2/json/nodes/pve/tasks/UPID%3Apve%3A00000001%3A00000002%3A00000003%3Aqmcreate%3Aroot%40pam%3A/status",
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
                create_vm_with_disk(&session, &config, "test-image.qcow2", "local-import").await;
            assert!(result.is_ok());

            vm_create_mock.assert_async().await;
            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_create_vm_with_disk_error() {
            std::env::remove_var("HA_INSTALLER_MOCK");
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

            let result = create_vm_with_disk(&session, &config, "test-image.qcow2", "local").await;
            assert!(result.is_err());

            vm_create_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_start_vm_success() {
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            };

            let result = authenticate(&credentials).await;
            assert!(result.is_err());

            auth_mock.assert_async().await;
            version_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_authenticate_version_missing_version_field() {
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
            let mut server = Server::new_async().await;

            // Create a temp file to upload
            let temp_dir = tempfile::tempdir().unwrap();
            let temp_file = temp_dir.path().join("test-image.qcow2");
            std::fs::write(&temp_file, b"test image content").unwrap();

            // Mocking a non-default storage proves the upload URL uses the supplied name.
            let upload_mock = server
                .mock("POST", "/api2/json/nodes/pve/storage/local-import/upload")
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
            assert!(!updates.is_empty());

            upload_mock.assert_async().await;
            task_mock.assert_async().await;
        }

        #[tokio::test]
        #[serial]
        async fn test_upload_image_to_proxmox_http_error() {
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
            std::env::remove_var("HA_INSTALLER_MOCK");
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
