//! `HostBackend` mock: a generous fake host and an always-ready Home Assistant.

use crate::types::SystemInfo;
use crate::{HostBackend, Result};

use super::BackendMock;

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

    async fn check_ha_updated(&self, _ip: &str) -> bool {
        true
    }
}
