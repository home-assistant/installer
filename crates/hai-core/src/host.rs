//! Host system queries and Home Assistant reachability checks.
//!
//! Used by the VM flows to size a new VM, and by every flow to poll a freshly
//! started Home Assistant instance, and Supervisor's progress installing it.

use crate::error::Result;
use crate::types::{HaAnnouncement, HaSetupProblem, HaSetupStatus, SystemInfo};
use crate::{Backend, HostBackend};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::net::Ipv4Addr;
use std::sync::LazyLock;
use std::time::Duration;

/// Whether a VM's guest reported `ip` for a network the host can reach, or a
/// device announced it for one.
///
/// Home Assistant OS also gives its own Docker networks an address: the
/// Supervisor's `hassio` bridge (172.30.32.0/23) and `docker0`
/// (172.30.232.0/23). Only the VM itself can reach them, and the guest lists
/// them while its LAN interface is still waiting for a DHCP lease. Older
/// landing pages announce them too.
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
    Some(get(ip, path).await?.status())
}

async fn get(ip: &str, path: &str) -> Option<reqwest::Response> {
    // Never probe an empty host: in `http:///manifest.json` the path would be read as the host.
    if ip.trim().is_empty() {
        return None;
    }
    let client = HA_CLIENT.as_ref()?;
    client.get(format!("http://{ip}{path}")).send().await.ok()
}

/// The Supervisor job that downloads and installs Home Assistant Core.
const CORE_INSTALL_JOB: &str = "home_assistant_core_install";

/// The Supervisor job that updates Supervisor itself, which on a first boot
/// usually runs before Core installs.
const SUPERVISOR_UPDATE_JOB: &str = "supervisor_update";

/// The `data` of a successful Supervisor API reply.
#[derive(Deserialize)]
struct SupervisorReply<T> {
    data: T,
}

#[derive(Deserialize)]
struct JobsInfo {
    jobs: Vec<Job>,
}

#[derive(Deserialize)]
struct Job {
    /// Supervisor names a scheduled job only once it starts.
    name: Option<String>,
    progress: f64,
    #[serde(default)]
    child_jobs: Vec<Job>,
}

/// The progress (0-100) of the job called `name`, anywhere in the tree.
fn job_progress(jobs: &[Job], name: &str) -> Option<f64> {
    jobs.iter().find_map(|job| {
        if job.name.as_deref() == Some(name) {
            Some(job.progress.clamp(0.0, 100.0))
        } else {
            job_progress(&job.child_jobs, name)
        }
    })
}

#[derive(Deserialize)]
struct NetworkInfo {
    host_internet: Option<bool>,
    supervisor_internet: Option<bool>,
}

#[derive(Deserialize)]
struct ResolutionInfo {
    issues: Vec<Issue>,
}

#[derive(Deserialize)]
struct Issue {
    #[serde(rename = "type")]
    kind: IssueType,
    #[serde(default)]
    context: IssueContext,
}

/// Where Supervisor found an issue: only Supervisor's and Core's are told
/// apart, the rest is left behind here and never reaches diagnostics.
#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
enum IssueContext {
    Supervisor,
    Core,
    #[default]
    #[serde(other)]
    Other,
}

/// The Supervisor issues that hold up installing Core.
///
/// Others are left out on purpose. Supervisor checks DNS servers only once
/// the system has internet, and names each one that fails, while the rest
/// resolve. It raises a failed time sync right before it sets the clock
/// itself. And Core's fatal error comes from starting Core, which on a first
/// boot is the landing page itself, so no landing page passes it on.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum IssueType {
    FreeSpace,
    DockerRatelimit,
    UpdateFailed,
    #[serde(other)]
    Other,
}

impl Issue {
    fn problem(self) -> Option<HaSetupProblem> {
        Some(match self.kind {
            IssueType::FreeSpace => HaSetupProblem::FreeSpace,
            IssueType::DockerRatelimit => HaSetupProblem::DockerRatelimit,
            // Core installs once Supervisor is up to date. A plugin's update
            // fails without holding it up.
            IssueType::UpdateFailed
                if matches!(self.context, IssueContext::Supervisor | IssueContext::Core) =>
            {
                HaSetupProblem::UpdateFailed
            }
            IssueType::UpdateFailed | IssueType::Other => return None,
        })
    }
}

/// A Supervisor API reply, as the landing page passes it on.
async fn supervisor_data<T: DeserializeOwned>(ip: &str, path: &str) -> Option<T> {
    let response = get(ip, &format!("/supervisor-api{path}")).await?;
    if !response.status().is_success() {
        return None;
    }
    Some(response.json::<SupervisorReply<T>>().await.ok()?.data)
}

/// What Supervisor reports while it installs Core, through the paths of the
/// Supervisor API that the landing page passes on without authentication.
/// They are gone once Core runs, so `None` is expected then. It is also
/// `None` when only some of them answer.
async fn ha_setup_status(ip: &str) -> Option<HaSetupStatus> {
    let (jobs, network, resolution) = tokio::join!(
        supervisor_data::<JobsInfo>(ip, "/jobs/info"),
        supervisor_data::<NetworkInfo>(ip, "/network/info"),
        supervisor_data::<ResolutionInfo>(ip, "/resolution/info"),
    );
    // A part that doesn't answer would read as no download or no problem,
    // and clear what an earlier answer showed: only a full answer is news
    let (Some(jobs), Some(network), Some(resolution)) = (jobs, network, resolution) else {
        return None;
    };

    let core_install_progress = job_progress(&jobs.jobs, CORE_INSTALL_JOB);
    let supervisor_update_progress = job_progress(&jobs.jobs, SUPERVISOR_UPDATE_JOB);
    // Unknown connectivity is not a problem: Supervisor checks it after starting
    let offline =
        network.host_internet == Some(false) || network.supervisor_internet == Some(false);
    let mut problems: Vec<_> = offline
        .then_some(HaSetupProblem::NoInternet)
        .into_iter()
        .chain(resolution.issues.into_iter().filter_map(Issue::problem))
        .collect();
    problems.sort();
    problems.dedup();

    Some(HaSetupStatus {
        core_install_progress,
        supervisor_update_progress,
        problems,
    })
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

    async fn ha_setup_status(&self, ip: &str) -> Option<HaSetupStatus> {
        ha_setup_status(ip).await
    }

    async fn find_home_assistants(&self) -> Result<Vec<HaAnnouncement>> {
        crate::discovery::find_home_assistants().await
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
    async fn test_check_ha_ready_and_updated() {
        // "/" is the ready check, "/manifest.json" the updated one
        for (path, status, expected) in [
            ("/", 200, true),
            ("/", 404, true),
            ("/", 502, false),
            ("/manifest.json", 200, true),
            ("/manifest.json", 404, false),
        ] {
            let mut server = Server::new_async().await;
            let mock = server
                .mock("GET", path)
                .with_status(status)
                .create_async()
                .await;

            let host = server.host_with_port();
            let answer = match path {
                "/" => check_ha_ready(&host).await,
                _ => check_ha_updated(&host).await,
            };
            assert_eq!(answer, expected, "{path} {status}");
            mock.assert_async().await;
        }
    }

    /// Answer a landing page path with a Supervisor reply holding `data`.
    async fn supervisor_reply(
        server: &mut mockito::ServerGuard,
        path: &str,
        data: &str,
    ) -> mockito::Mock {
        server
            .mock("GET", format!("/supervisor-api{path}").as_str())
            .with_header("content-type", "application/json")
            .with_body(format!(r#"{{"result":"ok","data":{data}}}"#))
            .create_async()
            .await
    }

    const ONLINE: &str =
        r#"{"interfaces":[],"docker":{},"host_internet":true,"supervisor_internet":true}"#;

    #[tokio::test]
    async fn test_ha_setup_status_reports_the_core_download() {
        let mut server = Server::new_async().await;
        supervisor_reply(
            &mut server,
            "/jobs/info",
            // A scheduled job has no name until it starts, and the download
            // itself is a child of the install
            r#"{"ignore_conditions":[],"jobs":[
                {"name":null,"progress":0,"done":false,"child_jobs":[]},
                {"name":"supervisor_update","progress":80,"done":false,"child_jobs":[]},
                {"name":"home_assistant_core_install","progress":42.5,"done":false,
                 "stage":null,"errors":[],"child_jobs":[
                    {"name":"docker_interface_install","progress":42.5,"done":false,"child_jobs":[]}]}]}"#,
        )
        .await;
        supervisor_reply(&mut server, "/network/info", ONLINE).await;
        supervisor_reply(
            &mut server,
            "/resolution/info",
            r#"{"unsupported":[],"unhealthy":[],"suggestions":[],"issues":[],"checks":[]}"#,
        )
        .await;

        assert_eq!(
            ha_setup_status(&server.host_with_port()).await,
            Some(HaSetupStatus {
                core_install_progress: Some(42.5),
                supervisor_update_progress: Some(80.0),
                problems: vec![],
            })
        );
    }

    #[tokio::test]
    async fn test_ha_setup_status_reports_problems_most_fundamental_first() {
        let mut server = Server::new_async().await;
        supervisor_reply(
            &mut server,
            "/jobs/info",
            r#"{"ignore_conditions":[],"jobs":[]}"#,
        )
        .await;
        supervisor_reply(
            &mut server,
            "/network/info",
            r#"{"host_internet":true,"supervisor_internet":false}"#,
        )
        .await;
        // Issues that cannot hold up the install are left out
        supervisor_reply(
            &mut server,
            "/resolution/info",
            r#"{"issues":[
                {"type":"update_failed","context":"supervisor","reference":null,"uuid":"a"},
                {"type":"multiple_data_disks","context":"system","reference":"sda","uuid":"b"},
                {"type":"free_space","context":"system","reference":null,"uuid":"c"},
                {"type":"update_failed","context":"core","reference":null,"uuid":"d"}]}"#,
        )
        .await;

        assert_eq!(
            ha_setup_status(&server.host_with_port()).await,
            Some(HaSetupStatus {
                core_install_progress: None,
                supervisor_update_progress: None,
                problems: vec![
                    HaSetupProblem::NoInternet,
                    HaSetupProblem::FreeSpace,
                    HaSetupProblem::UpdateFailed,
                ],
            })
        );
    }

    #[tokio::test]
    async fn test_ha_setup_status_takes_unknown_connectivity_for_no_problem() {
        let mut server = Server::new_async().await;
        supervisor_reply(
            &mut server,
            "/jobs/info",
            r#"{"ignore_conditions":[],"jobs":[]}"#,
        )
        .await;
        // Supervisor checks connectivity after starting; until then it is unknown
        supervisor_reply(
            &mut server,
            "/network/info",
            r#"{"host_internet":null,"supervisor_internet":null}"#,
        )
        .await;
        supervisor_reply(&mut server, "/resolution/info", r#"{"issues":[]}"#).await;

        assert_eq!(
            ha_setup_status(&server.host_with_port()).await,
            Some(HaSetupStatus::default())
        );
    }

    #[tokio::test]
    async fn test_ha_setup_status_leaves_out_failures_core_does_not_wait_for() {
        let problems = |issues: String| async move {
            let mut server = Server::new_async().await;
            supervisor_reply(&mut server, "/jobs/info", r#"{"jobs":[]}"#).await;
            supervisor_reply(&mut server, "/network/info", ONLINE).await;
            supervisor_reply(
                &mut server,
                "/resolution/info",
                &format!(r#"{{"issues":{issues}}}"#),
            )
            .await;
            ha_setup_status(&server.host_with_port())
                .await
                .unwrap()
                .problems
        };

        // A plugin's update, a DNS server among others that resolve, a time
        // sync Supervisor fixes itself, and a fatal error the landing page
        // can't be up to pass on: none of them keep Core from installing
        assert_eq!(
            problems(
                r#"[
                {"type":"update_failed","context":"plugin","reference":"audio","uuid":"a"},
                {"type":"dns_server_failed","context":"dns_server","reference":"dns://192.0.2.1","uuid":"b"},
                {"type":"ntp_sync_failed","context":"system","reference":null,"uuid":"c"},
                {"type":"fatal_error","context":"store","reference":"https://github.com/hassio-addons/repository","uuid":"d"},
                {"type":"fatal_error","context":"core","reference":null,"uuid":"e"}]"#
                    .into()
            )
            .await,
            []
        );
        for context in ["supervisor", "core"] {
            assert_eq!(
                problems(format!(
                    r#"[{{"type":"update_failed","context":"{context}","reference":null,"uuid":"f"}}]"#
                ))
                .await,
                [HaSetupProblem::UpdateFailed],
                "{context}"
            );
        }
    }

    #[tokio::test]
    async fn test_ha_setup_status_is_none_for_a_partial_answer() {
        let mut server = Server::new_async().await;
        supervisor_reply(&mut server, "/network/info", ONLINE).await;
        server
            .mock("GET", "/supervisor-api/jobs/info")
            .with_status(502)
            .create_async()
            .await;
        server
            .mock("GET", "/supervisor-api/resolution/info")
            .with_status(400)
            .with_body(r#"{"result":"error","message":"Supervisor is starting"}"#)
            .create_async()
            .await;

        // Without the issues, an earlier problem must not read as solved
        assert_eq!(ha_setup_status(&server.host_with_port()).await, None);
    }

    #[tokio::test]
    async fn test_ha_setup_status_is_none_without_a_landing_page() {
        // Once Core runs, the landing page and its Supervisor paths are gone
        let server = Server::new_async().await;
        assert_eq!(ha_setup_status(&server.host_with_port()).await, None);
        assert_eq!(ha_setup_status("").await, None);
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
