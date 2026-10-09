//! `UtmBackend` mock: fake UTM status, a simulated VM creation, and fixed VM
//! list/status.

use std::time::Duration;

use crate::types::{FlashProgress, FlashStage, UtmStatus, UtmVmConfig, UtmVmResult, VmStatusInfo};
use crate::{ProgressCallback, Result, UtmBackend};

use super::BackendMock;

impl UtmBackend for BackendMock {
    async fn check_utm_status(&self) -> Result<UtmStatus> {
        Ok(UtmStatus {
            installed: true,
            version: Some("4.0.0".to_string()),
            path: Some("/Applications/UTM.app".to_string()),
        })
    }

    async fn create_vm<P: ProgressCallback>(
        &self,
        config: &UtmVmConfig,
        progress_callback: &P,
    ) -> Result<UtmVmResult> {
        for (progress, message) in [
            (10, "Downloading HAOS image..."),
            (30, "Extracting image..."),
            (50, "Creating UTM VM..."),
            (70, "Configuring VM settings..."),
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
        Ok(UtmVmResult {
            id: "mock-utm-vm-id".to_string(),
            name: config.name.clone(),
            path: Some(format!(
                "~/Library/Containers/com.utmapp.UTM/Data/Documents/{}.utm",
                config.name
            )),
        })
    }

    fn start_vm(&self, _vm_id: &str) -> Result<()> {
        Ok(())
    }

    fn resize_vm_disk(&self, _vm_id: &str, _size_gb: u32) -> Result<()> {
        Ok(())
    }

    fn vm_status(&self, _vm_id: &str) -> Result<VmStatusInfo> {
        Ok(VmStatusInfo {
            status: "started".to_string(),
            ip_address: Some("192.168.1.100".to_string()),
        })
    }
}
