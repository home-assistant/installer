//! `DeviceBackend` mock: a fixed list of fake block devices and a simulated
//! write.

use std::path::Path;

use crate::types::{BlockDevice, DeviceType, FlashStage};
use crate::{DeviceBackend, ProgressCallback, Result};

use super::{simulate, BackendMock};

fn mock_block_devices() -> Vec<BlockDevice> {
    vec![
        BlockDevice {
            id: "mock-sd-card-32gb".to_string(),
            name: "SD Card 32GB".to_string(),
            size: 32 * 1024 * 1024 * 1024, // 32 GB
            device_type: DeviceType::SdCard,
            removable: true,
            model: Some("SanDisk Ultra".to_string()),
            vendor: Some("SanDisk".to_string()),
        },
        BlockDevice {
            id: "mock-sd-card-64gb".to_string(),
            name: "SD Card 64GB".to_string(),
            size: 64 * 1024 * 1024 * 1024, // 64 GB
            device_type: DeviceType::SdCard,
            removable: true,
            model: Some("Samsung EVO Plus".to_string()),
            vendor: Some("Samsung".to_string()),
        },
        BlockDevice {
            id: "mock-usb-drive-128gb".to_string(),
            name: "USB Drive 128GB".to_string(),
            size: 128 * 1024 * 1024 * 1024, // 128 GB
            device_type: DeviceType::UsbDrive,
            removable: true,
            model: Some("USB Flash Drive".to_string()),
            vendor: Some("Kingston".to_string()),
        },
        BlockDevice {
            id: "mock-ssd-256gb".to_string(),
            name: "External SSD 256GB".to_string(),
            size: 256 * 1024 * 1024 * 1024, // 256 GB
            device_type: DeviceType::Ssd,
            removable: true,
            model: Some("Portable SSD T7".to_string()),
            vendor: Some("Samsung".to_string()),
        },
        BlockDevice {
            id: "mock-nvme-500gb".to_string(),
            name: "NVMe Drive 500GB".to_string(),
            size: 500 * 1024 * 1024 * 1024, // 500 GB
            device_type: DeviceType::Nvme,
            removable: false,
            model: Some("970 EVO Plus".to_string()),
            vendor: Some("Samsung".to_string()),
        },
    ]
}

impl DeviceBackend for BackendMock {
    async fn list_devices(&self) -> Result<Vec<BlockDevice>> {
        Ok(mock_block_devices())
    }

    async fn write_image<P: ProgressCallback>(
        &self,
        _image_path: &Path,
        _device_id: &str,
        _verify: bool,
        progress_callback: &P,
    ) -> Result<()> {
        simulate(
            progress_callback,
            FlashStage::Writing,
            "Writing to device (mock)...",
            250,
        )
        .await;
        Ok(())
    }
}
