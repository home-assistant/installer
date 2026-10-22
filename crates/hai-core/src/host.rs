//! Host system queries and Home Assistant reachability checks.
//!
//! Used by the VM flows to size a new VM and to poll a freshly started
//! Home Assistant instance.

use crate::error::Result;
use crate::types::SystemInfo;
use crate::{Backend, HostBackend};
use std::net::Ipv4Addr;
use std::sync::LazyLock;
use std::time::Duration;

/// Whether a VM's guest reported `ip` for a network the host can reach.
///
/// Home Assistant OS also gives its own Docker networks an address: the
/// Supervisor's `hassio` bridge (172.30.32.0/23) and `docker0`
/// (172.30.232.0/23). Only the VM itself can reach them, and the guest lists
/// them while its LAN interface is still waiting for a DHCP lease.
pub(crate) fn is_reachable_vm_address(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let haos_internal = a == 172 && b == 30 && matches!(c, 32 | 33 | 232 | 233);
    !haos_internal
        && !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_multicast()
        && !ip.is_broadcast()
        && a != 0
        && a < 240
}

/// Query the host for CPU core count and total memory.
fn system_info() -> Result<SystemInfo> {
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
        Err(crate::error::Error::UnsupportedPlatform(
            "Host system info is only implemented on macOS".to_string(),
        ))
    }
}

/// Whether the Home Assistant webserver at `ip` answers HTTP on port 80.
async fn check_ha_ready(ip: &str) -> bool {
    // Any non-5xx reply means the webserver is up, even if `/` itself is not served.
    get_status(ip, "/")
        .await
        .is_some_and(|status| !status.is_server_error())
}

/// Whether Home Assistant at `ip` has finished starting up (serves its manifest).
async fn check_ha_updated(ip: &str) -> bool {
    get_status(ip, "/manifest.json")
        .await
        .is_some_and(|status| status.is_success())
}

/// Shared by every check: the frontend polls these every 2 seconds, for up to
/// an hour, and a client per check would redo its setup and drop its
/// connections each time.
static HA_CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        // The VM is on the local network, out of reach for a corporate proxy.
        // The proxy's own 407 would pass as ready, its 502 would never pass.
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()
});

async fn get_status(ip: &str, path: &str) -> Option<reqwest::StatusCode> {
    // Never probe an empty host: in `http:///manifest.json` the path would be read as the host.
    if ip.trim().is_empty() {
        return None;
    }
    let client = HA_CLIENT.as_ref()?;
    let response = client.get(format!("http://{ip}{path}")).send().await.ok()?;
    Some(response.status())
}

impl HostBackend for Backend {
    fn system_info(&self) -> Result<SystemInfo> {
        system_info()
    }

    async fn check_ha_ready(&self, ip: &str) -> bool {
        check_ha_ready(ip).await
    }

    async fn check_ha_updated(&self, ip: &str) -> bool {
        check_ha_updated(ip).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    #[test]
    fn test_haos_docker_networks_are_not_reachable_vm_addresses() {
        for ip in [
            "172.30.32.1",
            "172.30.33.254",
            "172.30.232.1",
            "172.30.233.254",
        ] {
            assert!(!is_reachable_vm_address(ip.parse().unwrap()), "{ip}");
        }
        // The neighbouring /23s are ordinary private networks
        for ip in [
            "172.30.31.254",
            "172.30.34.1",
            "172.30.231.254",
            "172.30.234.1",
        ] {
            assert!(is_reachable_vm_address(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn test_check_ha_ready_success() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("GET", "/")
            .with_status(200)
            .create_async()
            .await;

        assert!(check_ha_ready(&server.host_with_port()).await);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_check_ha_ready_404_is_ready() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("GET", "/")
            .with_status(404)
            .create_async()
            .await;

        assert!(check_ha_ready(&server.host_with_port()).await);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_check_ha_ready_5xx_is_not_ready() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("GET", "/")
            .with_status(502)
            .create_async()
            .await;

        assert!(!check_ha_ready(&server.host_with_port()).await);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_check_ha_updated_success() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("GET", "/manifest.json")
            .with_status(200)
            .with_body(r#"{"version": "2023.12.0"}"#)
            .create_async()
            .await;

        assert!(check_ha_updated(&server.host_with_port()).await);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_check_ha_updated_404_is_not_updated() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("GET", "/manifest.json")
            .with_status(404)
            .create_async()
            .await;

        assert!(!check_ha_updated(&server.host_with_port()).await);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_get_status_never_probes_an_empty_host() {
        let mut server = Server::new_async().await;
        let mock = server.mock("GET", "/").expect(0).create_async().await;

        // Without a host, this path would be taken for the server's address
        let path = format!("/{}", server.host_with_port());
        assert_eq!(get_status("", &path).await, None);
        mock.assert_async().await;
    }

    /// Run by `test_probes_ignore_proxy_environment` in a child process, so the
    /// proxy variables it sets never leak into tests running in parallel.
    #[tokio::test]
    #[ignore = "run in its own process by test_probes_ignore_proxy_environment"]
    async fn probes_with_dead_proxy_in_environment() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("GET", "/manifest.json")
            .with_status(200)
            .create_async()
            .await;

        assert!(check_ha_updated(&server.host_with_port()).await);
        mock.assert_async().await;
    }

    #[test]
    fn test_probes_ignore_proxy_environment() {
        // Nothing listens on the discard port, so any request sent through it fails
        let dead_proxy = "http://127.0.0.1:9";
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "host::tests::probes_with_dead_proxy_in_environment",
                "--ignored",
                "--quiet",
            ])
            .env("HTTP_PROXY", dead_proxy)
            .env("http_proxy", dead_proxy)
            .env("ALL_PROXY", dead_proxy)
            .env("all_proxy", dead_proxy)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .status()
            .unwrap();

        assert!(status.success());
    }
}
