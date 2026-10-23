//! `HostBackend` mock: a generous fake host, a VM's Home Assistant that is
//! ready at once, and a device found on the network that installs it first.

use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::time::Duration;

use crate::types::{HaAnnouncement, HaSetupStatus, SystemInfo};
use crate::{HostBackend, Result};

use super::BackendMock;

/// Counts the lookups, so each finds a landing page the last one didn't
static LOOKUPS: AtomicUsize = AtomicUsize::new(0);

/// Where the device the lookups find answers. A VM's Home Assistant is
/// ready at once; the device's landing page downloads it first.
const DEVICE_ADDRESS: &str = "192.168.1.101";

/// How far the device's download got
static DOWNLOAD: AtomicU32 = AtomicU32::new(0);

impl HostBackend for BackendMock {
    fn system_info(&self) -> Result<SystemInfo> {
        Ok(SystemInfo {
            cpu_cores: 10,
            memory_mb: 32768,
        })
    }

    async fn check_ha_ready(&self, _ip: &str) -> bool {
        true
    }

    async fn check_ha_updated(&self, ip: &str) -> bool {
        ip != DEVICE_ADDRESS || DOWNLOAD.load(Ordering::Relaxed) > 100
    }

    async fn ha_setup_status(&self, ip: &str) -> Option<HaSetupStatus> {
        // A VM's Home Assistant is ready at once, so its landing page is gone
        if ip != DEVICE_ADDRESS {
            return None;
        }
        let progress = DOWNLOAD.fetch_add(20, Ordering::Relaxed).min(100);
        Some(HaSetupStatus {
            core_install_progress: Some(progress.into()),
            ..Default::default()
        })
    }

    /// A landing page that wasn't there at the last lookup, as a device that
    /// just started announces, after listening for a moment
    async fn find_home_assistants(&self) -> Result<Vec<HaAnnouncement>> {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let lookup = LOOKUPS.fetch_add(1, Ordering::Relaxed);
        // It has yet to download Home Assistant
        DOWNLOAD.store(0, Ordering::Relaxed);
        Ok(vec![HaAnnouncement {
            id: format!("mock-landing-page-{lookup}"),
            address: DEVICE_ADDRESS.into(),
            landing_page: true,
        }])
    }
}
