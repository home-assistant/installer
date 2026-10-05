//! Host system queries and Home Assistant reachability checks.
//!
//! Used by the VM flows to size a new VM and to poll a freshly started
//! Home Assistant instance.

use crate::error::{Error, Result};
use crate::types::SystemInfo;
use std::time::Duration;

/// Query the host for CPU core count and total memory.
pub fn system_info() -> Result<SystemInfo> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let cpu_cores = Command::new("sysctl")
            .args(["-n", "hw.ncpu"])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|s| s.trim().parse::<usize>().ok())
            .unwrap_or(4);

        let memory_bytes = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(8 * 1024 * 1024 * 1024);

        Ok(SystemInfo {
            cpu_cores,
            memory_mb: memory_bytes / (1024 * 1024),
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::UnsupportedPlatform(
            "Host system info is only implemented on macOS".to_string(),
        ))
    }
}

/// Whether the Home Assistant webserver is accepting connections on port 80.
pub async fn check_ha_ready(ip: &str) -> bool {
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    let addr = format!("{}:80", ip);
    matches!(
        timeout(Duration::from_secs(3), TcpStream::connect(&addr)).await,
        Ok(Ok(_))
    )
}

/// Whether Home Assistant has finished starting up (serves its manifest).
pub async fn check_ha_updated(ip: &str) -> bool {
    let url = format!("http://{}/manifest.json", ip);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}
