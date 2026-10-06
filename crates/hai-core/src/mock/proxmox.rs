//! `ProxmoxBackend` mock: fake authentication, nodes, storage, and a simulated
//! VM creation.

use std::time::Duration;

use crate::types::{
    FlashProgress, FlashStage, ProxmoxCredentials, ProxmoxNode, ProxmoxSession, ProxmoxStorage,
    ProxmoxVmConfig, ProxmoxVmResult,
};
use crate::{ProgressCallback, ProxmoxBackend, Result};

use super::BackendMock;

impl ProxmoxBackend for BackendMock {
    async fn authenticate(&self, credentials: &ProxmoxCredentials) -> Result<ProxmoxSession> {
        Ok(ProxmoxSession {
            server_url: credentials.server_url.clone(),
            ticket: "mock-ticket".to_string(),
            csrf_token: "mock-csrf-token".to_string(),
        })
    }

    async fn list_nodes(&self, _session: &ProxmoxSession) -> Result<Vec<ProxmoxNode>> {
        Ok(vec![
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
        ])
    }

    async fn list_storage(
        &self,
        _session: &ProxmoxSession,
        _node: &str,
    ) -> Result<Vec<ProxmoxStorage>> {
        Ok(vec![
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
        ])
    }

    async fn get_next_vm_id(&self, _session: &ProxmoxSession) -> Result<u32> {
        Ok(100)
    }

    async fn create_vm<P: ProgressCallback>(
        &self,
        _session: &ProxmoxSession,
        config: &ProxmoxVmConfig,
        progress_callback: &P,
    ) -> Result<ProxmoxVmResult> {
        for (progress, message) in [
            (10, "Downloading HAOS image..."),
            (30, "Uploading to Proxmox..."),
            (50, "Creating VM..."),
            (70, "Configuring VM..."),
            (90, "Starting VM..."),
            (100, "Complete"),
        ] {
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
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Ok(ProxmoxVmResult {
            vm_id: config.vm_id,
            node: config.node.clone(),
            ip_address: Some("192.168.1.100".to_string()),
        })
    }
}
