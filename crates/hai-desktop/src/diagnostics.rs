//! Local diagnostics: fixed categories, and error text without what
//! identifies the user or their network. The tail goes into public issues.

use std::collections::VecDeque;
use std::net::Ipv6Addr;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Instant;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const TARGET: &str = "hai_diagnostics";
const TAIL_LINES: usize = 40;
static TAIL: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static START: OnceLock<Instant> = OnceLock::new();

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    log_builder().build()
}

fn log_builder() -> tauri_plugin_log::Builder {
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .filter(|metadata| metadata.target() == TARGET)
        .max_file_size(1_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
        .targets([tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("installer".into()),
            },
        )])
}

// Only callers with compile-time strings, deserialized enums or scrubbed
// error text can record data.
fn record(level: log::Level, message: String) {
    let elapsed = START.get_or_init(Instant::now).elapsed().as_millis();
    let line = format!("{elapsed}ms {message}");
    log::log!(target: TARGET, level, "{line}");
    if let Ok(mut tail) = TAIL.lock() {
        tail.push_back(line);
        while tail.len() > TAIL_LINES {
            tail.pop_front();
        }
    }
}

pub fn init() {
    record(log::Level::Info, "application started".into());
    std::panic::set_hook(Box::new(|_| {
        // Panic payloads (including assertion values) may contain credentials.
        record(log::Level::Error, "rust panic (payload omitted)".into());
        log::logger().flush();
    }));
}

pub fn warning(code: &'static str) {
    record(log::Level::Warn, format!("warning {code}"));
}

/// Record what failed, with its causes, as one scrubbed line. A poll can
/// fail the same way for minutes, so a line still in the tail isn't repeated.
pub fn error(error: &hai_core::Error) {
    let line = format!("rust error: {}", describe(error));
    let logged = TAIL.lock().is_ok_and(|tail| {
        tail.iter().any(|logged| {
            logged
                .split_once(' ')
                .is_some_and(|(_, logged)| logged == line)
        })
    });
    if !logged {
        record(log::Level::Error, line);
    }
}

/// Catalog parameters that hold names the user chose, like a Proxmox node's,
/// or a path through them, like `/storage/<storage>`.
const USER_NAMED: [&str; 8] = [
    "node", "storage", "storages", "bridge", "vnet", "volume", "name", "path",
];

fn describe(error: &hai_core::Error) -> String {
    use hai_core::Error::*;
    if let PermissionDenied(message)
    | ProxmoxTwoFactor(message)
    | ProxmoxActionRequired(message)
    | RateLimited(message)
    | ServiceUnavailable(message)
    | Utm(message)
    | UtmOperationUncertain(message)
    | UtmVmCreated(message) = error
    {
        let mut message = message.clone();
        for (name, value) in &mut message.params {
            if USER_NAMED.contains(name) {
                *value = "<name>".into();
            }
        }
        return scrub(&message.to_string());
    }
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        // Wrappers often repeat their cause's text already
        if !text.contains(&cause_text) {
            text = format!("{text}: {cause_text}");
        }
        source = cause.source();
    }
    scrub(&text)
}

/// Hosts of the services the installer uses; any other host is the user's.
const PUBLIC_HOSTS: [&str; 5] = [
    "github.com",
    "githubusercontent.com",
    "home-assistant.io",
    "alpinelinux.org",
    "sigstore.dev",
];
const MAX_ERROR_CHARS: usize = 300;

/// `text` on one line, without user names, credentials, private hosts,
/// addresses or volume IDs. Best effort, as people review an issue before
/// posting it.
fn scrub(text: &str) -> String {
    // Takes balanced parentheses, but not the one closing a URL in them, and
    // stops at a backslash, which may escape a quote in a credential's value
    static URL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*)://(?:[^\s/@<>"]*@)?(\[[^\]]*\]|[^\s/:?#()<>"'\\]+)(?::\d+)?((?:\([^\s?#()<>"\\]*\)|[^\s?#)<>"\\])*)(?:\([^\s()<>"\\]*\)|[^\s)<>"\\])*"#).unwrap()
    });
    static IPV6: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(^|[^\w:.])([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,8}(?:\.\d{1,3}){0,3})")
            .unwrap()
    });
    static RULES: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
        [
            // User folders, also other users' and drives mounted per user.
            // Names may have spaces, so a folder's name runs to the next separator.
            // It takes balanced parentheses, but not the one closing a path in them.
            (r#"(?i)([a-z]:[\\/]+users[\\/]+|/home/|/users/|/(?:run/)?media/)(?:\([^\\/:"()]*\)|[^\\/:")])+"#, "${1}<user>"),
            (r"(?i)\b(basic|bearer)\s+\S+", "${1} <redacted>"),
            (r#"(?i)\b([\w-]*(?:password|passwd|secret|token|ticket|csrf|cookie|authorization)[\w-]*)"?\s*[=:]\s*(?:"(?:[^"\\]|\\.)*"|\S+)"#, "${1}=<redacted>"),
            (r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "<id>"),
            (r"[\w.+-]+@[\w.-]+", "<user>"),
            (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "<ip>"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).unwrap(), replacement))
        .collect()
    });

    let line: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut line = URL
        .replace_all(&line, |caps: &Captures| {
            let host = caps[2].to_ascii_lowercase();
            let public = PUBLIC_HOSTS
                .iter()
                .any(|public| host == *public || host.ends_with(&format!(".{public}")));
            // The paths of the user's own server name its nodes and users
            if public {
                format!("{}://{}{}", &caps[1], &caps[2], &caps[3])
            } else {
                format!("{}://<host>", &caps[1])
            }
        })
        .into_owned();
    // Only what parses as an IPv6 address, not times or Rust paths. Before
    // IPv4, which would otherwise take the tail of `::ffff:192.0.2.1`.
    line = IPV6
        .replace_all(&line, |caps: &Captures| {
            let (address, colon) = match caps[2].strip_suffix(':') {
                Some(address) if address.parse::<Ipv6Addr>().is_ok() => (address, ":"),
                _ => (&caps[2], ""),
            };
            match address.parse::<Ipv6Addr>() {
                Ok(_) => format!("{}<ip>{colon}", &caps[1]),
                Err(_) => caps[0].to_owned(),
            }
        })
        .into_owned();
    for (rule, replacement) in RULES.iter() {
        line = rule.replace_all(&line, *replacement).into_owned();
    }
    // The root cause comes last, so a long line loses its middle
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX_ERROR_CHARS {
        return line;
    }
    let half = MAX_ERROR_CHARS / 2;
    let (head, tail) = (&chars[..half], &chars[chars.len() - half..]);
    format!("{}…{}", String::from_iter(head), String::from_iter(tail))
}

/// The setup status last recorded, as the install polls it every few seconds.
static LAST_SETUP_STATUS: Mutex<Option<String>> = Mutex::new(None);

/// Record what Supervisor reports while it installs Home Assistant, when that
/// changes. Only the fixed problem kinds and the progress in quarters reach
/// the log, never Supervisor's own text.
pub fn setup_status(status: &hai_core::HaSetupStatus) {
    let quarter = |progress: Option<f64>| {
        progress.map_or_else(
            || "none".to_owned(),
            |progress| format!("{}%", (progress / 25.0).floor() as u8 * 25),
        )
    };
    let line = format!(
        "supervisor self_update={} core_install={} problems={:?}",
        quarter(status.supervisor_update_progress),
        quarter(status.core_install_progress),
        status.problems
    );
    record_change(
        &LAST_SETUP_STATUS,
        if status.problems.is_empty() {
            log::Level::Info
        } else {
            log::Level::Warn
        },
        line,
    );
}

/// The lookup outcome last recorded, as the success step looks every few seconds.
static LAST_LOOKUP: Mutex<Option<String>> = Mutex::new(None);

/// Record how a lookup of Home Assistant on the network went, when that
/// changes. Only how many answered reaches the log, never who or where.
pub fn lookup<E: Categorized>(result: &Result<Vec<hai_core::HaAnnouncement>, E>) {
    match result {
        Ok(found) => record_change(
            &LAST_LOOKUP,
            log::Level::Info,
            format!(
                "home_assistant_lookup found={} landing_pages={}",
                found.len(),
                found.iter().filter(|found| found.landing_page).count()
            ),
        ),
        Err(error) => record_change(
            &LAST_LOOKUP,
            log::Level::Warn,
            format!("home_assistant_lookup failed {}", error.category()),
        ),
    }
}

/// Record `line`, unless it is the one `last` holds from the time before.
fn record_change(last: &Mutex<Option<String>>, level: log::Level, line: String) {
    if let Ok(mut last) = last.lock() {
        if last.as_ref() == Some(&line) {
            return;
        }
        *last = Some(line.clone());
    }
    record(level, line);
}

/// Preserve a useful failure category without persisting arbitrary error text.
pub fn error_category(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    for (needle, category) in [
        ("checksum", "checksum_mismatch"),
        ("verification failed", "verification_failed"),
        ("write-protected", "write_protected"),
        ("disconnected", "drive_disconnected"),
        ("permission", "permission_denied"),
        ("disk service unavailable", "disk_service_unavailable"),
        ("too large", "image_too_large"),
        ("larger than", "image_too_large"),
        ("timed out", "timeout"),
        ("timeout", "timeout"),
        ("network", "network_error"),
        ("download", "download_failed"),
        ("extract", "extraction_failed"),
        ("proxmox", "proxmox_error"),
        ("utm", "utm_error"),
        ("cancelled", "cancelled"),
    ] {
        if error.contains(needle) {
            return category;
        }
    }
    "operation_failed"
}

/// A failure's fixed category for the log, never its message.
pub trait Categorized {
    fn category(&self) -> &'static str;
}

impl Categorized for String {
    fn category(&self) -> &'static str {
        error_category(self)
    }
}

impl Categorized for crate::command_error::CommandError {
    // A fixed, credential-free code, finer than the public one where it helps
    fn category(&self) -> &'static str {
        self.diagnostic
    }
}

pub struct Operation {
    name: &'static str,
    stage: Mutex<(&'static str, Instant)>,
}

impl Operation {
    pub fn new(name: &'static str) -> Self {
        record(log::Level::Info, format!("rust {name} started"));
        Self {
            name,
            stage: Mutex::new(("preparing", Instant::now())),
        }
    }

    pub fn stage(&self, stage: &'static str) {
        if let Ok(mut current) = self.stage.lock() {
            if current.0 != stage {
                record(
                    log::Level::Info,
                    format!(
                        "rust {} {} finished duration_ms={}",
                        self.name,
                        current.0,
                        current.1.elapsed().as_millis()
                    ),
                );
                *current = (stage, Instant::now());
                record(
                    log::Level::Info,
                    format!("rust {} {stage} started", self.name),
                );
            }
        }
    }

    pub fn finish<T, E: Categorized>(&self, result: Result<T, E>) -> Result<T, E> {
        if let Ok(current) = self.stage.lock() {
            let outcome = result
                .as_ref()
                .err()
                .map(Categorized::category)
                .unwrap_or("success");
            record(
                if result.is_err() {
                    log::Level::Error
                } else {
                    log::Level::Info
                },
                format!(
                    "rust {} {} {outcome} duration_ms={}",
                    self.name,
                    current.0,
                    current.1.elapsed().as_millis()
                ),
            );
        }
        result
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Flow {
    Flash,
    Utm,
    Proxmox,
    Application,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Preparing,
    Connecting,
    Downloading,
    Extracting,
    Writing,
    Verifying,
    Finalizing,
    Uploading,
    Creating,
    CreatingVm,
    Starting,
    StartingVm,
    Waiting,
    Ready,
    Updating,
    Complete,
    Frontend,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Started,
    Finished,
    Failed,
}

/// Why a frontend step failed. The frontend sends a command's `CommandError`
/// code as is, so every code a command can return has a category here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    ChecksumMismatch,
    VerificationFailed,
    WriteProtected,
    DriveDisconnected,
    PermissionDenied,
    DiskServiceUnavailable,
    ImageTooLarge,
    Timeout,
    #[serde(alias = "network")]
    NetworkError,
    DownloadFailed,
    ExtractionFailed,
    ProxmoxError,
    #[serde(alias = "utm")]
    UtmError,
    Cancelled,
    OperationFailed,
    FrontendError,
    UnhandledRejection,
    Io,
    DeviceNotFound,
    DeviceBusy,
    ProxmoxApi,
    ProxmoxActionRequired,
    ProxmoxSessionExpired,
    ProxmoxCertificateChanged,
    ProxmoxTwoFactor,
    UtmOperationUncertain,
    UtmVmCreated,
    UnsupportedPlatform,
    Json,
    InvalidConfig,
    RateLimited,
    DriveTooSmall,
    TemporaryImageUnavailable,
    OperationInProgress,
    Internal,
    /// A problem Supervisor reported held up installing Home Assistant: the
    /// frontend's `home_assistant_` codes, one per `HaSetupProblem`.
    HomeAssistantNoInternet,
    HomeAssistantFreeSpace,
    HomeAssistantDockerRatelimit,
    HomeAssistantUpdateFailed,
    /// Any other value. A code without a category is still logged, as this;
    /// the value itself never reaches the log.
    #[serde(other)]
    Unrecognized,
}

#[tauri::command]
pub fn log_frontend_event(
    flow: Flow,
    stage: Stage,
    outcome: Outcome,
    error: Option<ErrorCategory>,
    elapsed_ms: u32,
) {
    record(
        if matches!(outcome, Outcome::Failed) {
            log::Level::Error
        } else {
            log::Level::Info
        },
        format!("frontend {flow:?} {stage:?} {outcome:?} error={error:?} duration_ms={elapsed_ms}"),
    );
}

#[derive(Serialize)]
pub struct Diagnostics {
    version: String,
    os: &'static str,
    os_version: String,
    architecture: &'static str,
    package_type: String,
    log_tail: String,
}

// OS discovery may run synchronous subprocesses; keep it off the UI thread.
#[tauri::command(async)]
pub fn get_diagnostics<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Diagnostics {
    Diagnostics {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        os_version: reportable_os_version(os_info::get().version().to_string()),
        architecture: std::env::consts::ARCH,
        package_type: tauri::utils::platform::bundle_type()
            .map(|kind| format!("{kind:?}"))
            .unwrap_or_else(|| "unbundled".into()),
        log_tail: TAIL
            .lock()
            .map(|tail| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_else(|_| "Log tail unavailable".into()),
    }
}

// Some distributions supply arbitrary release text; omit it from reports.
fn reportable_os_version(version: String) -> String {
    if (1..=64).contains(&version.len())
        && version
            .chars()
            .all(|c| c.is_ascii_digit() || ".-".contains(c))
    {
        version
    } else {
        "unknown".into()
    }
}

#[cfg(test)]
pub(crate) fn test_log_tail() -> Vec<String> {
    TAIL.lock().unwrap().iter().cloned().collect()
}

/// Start from an empty tail, with no setup status recorded yet.
#[cfg(test)]
pub(crate) fn clear_test_log_tail() {
    TAIL.lock().unwrap().clear();
    *LAST_SETUP_STATUS.lock().unwrap() = None;
}

#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|_| "Log directory unavailable")?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|_| "Could not open the logs folder".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_errors_enter_diagnostics_only_as_a_category() {
        for message in [
            "Proxmox API error: https://admin:password@private.example ticket=secret",
            "IO error: /home/private-user/private-file",
            "Network error: csrf_token=secret\nInjected log line",
            "password=arbitrary-secret",
        ] {
            let operation = Operation::new("privacy-test");
            let _ = operation.finish::<(), String>(Err(message.into()));
        }
        // Other tests log their own errors alongside
        let tail = test_log_tail()
            .into_iter()
            .filter(|line| line.contains("privacy-test"))
            .collect::<Vec<_>>()
            .join("\n");
        for secret in ["password", "private", "secret", "Injected", "csrf"] {
            assert!(!tail.contains(secret), "{tail}");
        }
        assert_eq!(
            error_category("Verification failed: secret"),
            "verification_failed"
        );
    }

    #[test]
    // A UTM command test clears the shared tail, which would drop this line
    #[serial_test::serial]
    fn busy_failures_log_their_reason_and_scrubbed_message() {
        let operation = Operation::new("busy-test");
        let error = crate::command_error::CommandError::from(hai_core::Error::DeviceBusy(
            hai_core::BusyReason::VolumeUnreadable,
            r"Cannot inspect volume \\?\Volume{2a9c1f0e-1d3b-4c5e-9f00-123456789abc}\: Access is denied".into(),
        ));
        let _ = operation.finish::<(), _>(Err(error));

        let tail = test_log_tail().join("\n");
        assert!(
            tail.contains("rust busy-test preparing device_busy_volume_unreadable"),
            "{tail}"
        );
        assert!(
            tail.contains(
                "rust error: Device is busy: Cannot inspect volume \\\\?\\Volume{<id>}\\"
            ),
            "{tail}"
        );
        assert!(!tail.contains("2a9c1f0e"), "{tail}");
    }

    #[test]
    fn scrubbed_error_text_keeps_what_failed_but_not_who_or_where() {
        for (text, scrubbed) in [
            (
                r"Not enough free space in C:\Users\Jane Doe\AppData\Local\io.home-assistant.installer",
                r"Not enough free space in C:\Users\<user>\AppData\Local\io.home-assistant.installer",
            ),
            (
                "Permission denied: /home/jane/.cache and /run/media/jane/STICK",
                "Permission denied: /home/<user>/.cache and /run/media/<user>/STICK",
            ),
            (
                "error sending request for url (https://github.com/home-assistant/operating-system/releases/download/16.3/haos.img.xz?token=x)",
                "error sending request for url (https://github.com/home-assistant/operating-system/releases/download/16.3/haos.img.xz)",
            ),
            (
                "POST https://admin:pw@pve.lan:8006/api2/json/nodes?x=1 failed",
                "POST https://<host> failed",
            ),
            (
                "ticket=PVE:root@pam:ABC CSRFPreventionToken: s3cret Authorization: Bearer abc",
                "ticket=<redacted> CSRFPreventionToken=<redacted> Authorization=<redacted> <redacted>",
            ),
            (
                "Authorization: Basic dXNlcjpwYXNz",
                "Authorization=<redacted> <redacted>",
            ),
            (
                "from 192.168.1.20 and fe80::1ff:fe23:4567:890a as root@pam",
                "from <ip> and <ip> as <user>",
            ),
            (
                "fd12:3456:: and ::dead:beef at 14:07:29 in std::io",
                "<ip> and <ip> at 14:07:29 in std::io",
            ),
            (
                "to 2001:db8:0:1:2:3:192.168.1.20 and ::ffff:192.168.1.20",
                "to <ip> and <ip>",
            ),
            (
                "GET https://admin:before(visible-secret)after@pve.lan/path",
                "GET https://<host>",
            ),
            (
                "(url https://github.com/a(1)?token=before(visible-secret)after)",
                "(url https://github.com/a(1))",
            ),
            (
                "(url https://pve.lan/a?token=before(visible-secret)after)",
                "(url https://<host>)",
            ),
            (
                "(url https://github.com/a'1?token=before'visible-fragment)",
                "(url https://github.com/a'1)",
            ),
            (
                "(url https://pve.lan/a?token=before'visible-fragment)",
                "(url https://<host>)",
            ),
            (
                r"at path C:\Users\Sean O'Brien\AppData",
                r"at path C:\Users\<user>\AppData",
            ),
            (
                r#"body {"password":"hunter2","ticket":"PVE:x"} password: "hunter 2""#,
                r#"body {"password=<redacted>,"ticket=<redacted>} password=<redacted>"#,
            ),
            (
                r#"{"password":"prefix\"visible-secret"}"#,
                r#"{"password=<redacted>}"#,
            ),
            (
                r#"{"password":"https://private.example/path\"visible-fragment"}"#,
                r#"{"password=<redacted>}"#,
            ),
            (
                r"(in C:\Users\Jane (Work) Doe\AppData and C:\Users\Jane (Work) Doe)",
                r"(in C:\Users\<user>\AppData and C:\Users\<user>)",
            ),
            ("first line\nInjected line", "first line Injected line"),
        ] {
            assert_eq!(scrub(text), scrubbed);
        }
        let long = scrub(&format!("{} (os error 10060)", "x".repeat(1000)));
        assert_eq!(long.chars().count(), MAX_ERROR_CHARS + 1);
        assert!(long.ends_with("(os error 10060)"), "{long}");
    }

    #[test]
    // Other tests clear the shared tail
    #[serial_test::serial]
    fn a_repeated_error_is_logged_once_while_in_the_tail() {
        let failure = || hai_core::Error::DownloadFailed("HTTP 503 while polling".into());
        error(&failure());
        error(&failure());
        let logged = test_log_tail()
            .iter()
            .filter(|line| line.ends_with(" rust error: Download failed: HTTP 503 while polling"))
            .count();
        assert_eq!(logged, 1);
    }

    #[test]
    fn errors_are_described_with_their_causes() {
        #[derive(Debug)]
        struct Cause;
        impl std::fmt::Display for Cause {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("dns error: No such host is known. (os error 11001)")
            }
        }
        impl std::error::Error for Cause {}

        #[derive(Debug)]
        struct Connect;
        impl std::fmt::Display for Connect {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("client error (Connect)")
            }
        }
        impl std::error::Error for Connect {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&Cause)
            }
        }

        // The io::Error repeats its wrapper's text, so it is left out
        assert_eq!(
            describe(&hai_core::Error::Io(std::io::Error::other(Connect))),
            "IO error: client error (Connect): dns error: No such host is known. (os error 11001)"
        );
    }

    #[test]
    fn catalog_messages_leave_out_the_names_the_user_chose() {
        let offline = hai_core::Error::ProxmoxActionRequired(hai_core::message!(
            "backend.proxmox.node_offline",
            node = "family-server",
        ));
        assert_eq!(
            describe(&offline),
            "Node \"<name>\" is offline. Choose an online node or start it in Proxmox."
        );
        let limited = hai_core::Error::RateLimited(hai_core::message!(
            "backend.download.github_rate_limited",
            minutes = 5,
        ));
        assert!(describe(&limited).contains("5 minutes"));
        let denied = hai_core::Error::ProxmoxActionRequired(hai_core::message!(
            "backend.proxmox.missing_privileges",
            privileges = "SDN.Use",
            path = "/sdn/zones/family-zone/private-bridge",
        ));
        assert_eq!(
            describe(&denied),
            "Your Proxmox user is missing SDN.Use on <name>."
        );
    }

    #[test]
    // Other tests clear the shared tail, or record setup statuses of their own
    #[serial_test::serial]
    fn setup_status_records_its_changes_as_fixed_categories() {
        use hai_core::{HaSetupProblem, HaSetupStatus};

        clear_test_log_tail();
        let status = |update, install, problems: &[HaSetupProblem]| HaSetupStatus {
            supervisor_update_progress: update,
            core_install_progress: install,
            problems: problems.to_vec(),
        };

        setup_status(&status(Some(10.0), None, &[HaSetupProblem::UpdateFailed]));
        // The same again, or a download step within its quarter, adds nothing
        setup_status(&status(Some(20.0), None, &[HaSetupProblem::UpdateFailed]));
        setup_status(&status(None, Some(30.0), &[]));
        setup_status(&status(None, Some(49.9), &[]));
        setup_status(&status(None, Some(100.0), &[]));

        let lines: Vec<_> = test_log_tail()
            .into_iter()
            .filter(|line| line.contains(" supervisor "))
            .map(|line| line.split_once(' ').unwrap().1.to_owned())
            .collect();
        assert_eq!(
            lines,
            [
                "supervisor self_update=0% core_install=none problems=[UpdateFailed]",
                "supervisor self_update=none core_install=25% problems=[]",
                "supervisor self_update=none core_install=100% problems=[]",
            ]
        );
    }

    #[test]
    // Other tests clear the shared tail
    #[serial_test::serial]
    fn lookup_records_its_changes_but_never_who_answered() {
        use hai_core::HaAnnouncement;

        clear_test_log_tail();
        let core = HaAnnouncement {
            id: "private-core-uuid".into(),
            address: "192.168.1.20:8123".into(),
            landing_page: false,
        };
        let landing_page = HaAnnouncement {
            id: "private-landing-page-uuid".into(),
            address: "192.168.1.50".into(),
            landing_page: true,
        };

        lookup::<String>(&Ok(vec![core.clone()]));
        // The same again adds nothing
        lookup::<String>(&Ok(vec![core.clone()]));
        lookup::<String>(&Ok(vec![core, landing_page]));
        lookup::<String>(&Err("Network error: 192.168.1.9 unreachable".into()));

        let tail = test_log_tail();
        let lines: Vec<_> = tail
            .iter()
            .filter(|line| line.contains(" home_assistant_lookup "))
            .map(|line| line.split_once(' ').unwrap().1)
            .collect();
        assert_eq!(
            lines,
            [
                "home_assistant_lookup found=1 landing_pages=0",
                "home_assistant_lookup found=2 landing_pages=1",
                "home_assistant_lookup failed network_error",
            ]
        );
    }

    #[test]
    fn every_setup_problem_has_a_failure_category() {
        use hai_core::HaSetupProblem::*;

        // The frontend ends a wait that a problem holds up with its code
        for problem in [NoInternet, FreeSpace, DockerRatelimit, UpdateFailed] {
            let code = format!(
                "home_assistant_{}",
                serde_json::to_value(problem).unwrap().as_str().unwrap()
            );
            let category = serde_json::from_value::<ErrorCategory>(code.clone().into()).unwrap();
            assert!(
                !matches!(category, ErrorCategory::Unrecognized),
                "{code} has no category"
            );
        }
    }

    #[test]
    fn frontend_ipc_rejects_free_form_fields() {
        assert!(serde_json::from_str::<Flow>("\"private.example\"").is_err());
        assert!(serde_json::from_str::<Stage>("\"password\"").is_err());
        let error = serde_json::from_str::<ErrorCategory>("\"ticket=secret\"").unwrap();
        assert_eq!(format!("{error:?}"), "Unrecognized");
    }

    #[test]
    fn every_command_error_code_has_a_category() {
        // The codes in command_error.rs and the ones commands.rs creates itself
        for code in [
            "network",
            "io",
            "device_not_found",
            "device_busy",
            "checksum_mismatch",
            "permission_denied",
            "disk_service_unavailable",
            "cancelled",
            "proxmox_api",
            "proxmox_action_required",
            "proxmox_session_expired",
            "proxmox_certificate_changed",
            "proxmox_two_factor",
            "utm",
            "utm_operation_uncertain",
            "utm_vm_created",
            "drive_disconnected",
            "write_protected",
            "unsupported_platform",
            "json",
            "invalid_config",
            "rate_limited",
            "download_failed",
            "extraction_failed",
            "verification_failed",
            "image_too_large",
            "drive_too_small",
            "temporary_image_unavailable",
            "operation_in_progress",
            "internal",
        ] {
            let category = serde_json::from_value::<ErrorCategory>(code.into()).unwrap();
            assert!(
                !matches!(category, ErrorCategory::Unrecognized),
                "{code} has no category"
            );
        }
    }

    #[test]
    fn frontend_command_records_allowed_events_and_bounds_tail() {
        // Isolate the process-global logger and tail from concurrent tests.
        if std::env::var_os("HAI_FRONTEND_LOG_TEST_CHILD").is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "diagnostics::tests::frontend_command_records_allowed_events_and_bounds_tail",
                    "--nocapture",
                ])
                .env("HAI_FRONTEND_LOG_TEST_CHILD", "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout)
                    .contains("FRONTEND_LOG_COMMAND_ASSERTIONS_PASSED"),
                "child did not complete the command assertions: {}",
                String::from_utf8_lossy(&output.stdout)
            );
            return;
        }

        struct Capture(Mutex<Vec<(log::Level, String)>>);
        impl log::Log for Capture {
            fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
                metadata.target() == TARGET
            }

            fn log(&self, record: &log::Record<'_>) {
                if self.enabled(record.metadata()) {
                    self.0
                        .lock()
                        .unwrap()
                        .push((record.level(), record.args().to_string()));
                }
            }

            fn flush(&self) {}
        }
        static LOG: Capture = Capture(Mutex::new(Vec::new()));
        log::set_logger(&LOG).unwrap();
        log::set_max_level(log::LevelFilter::Info);

        for elapsed_ms in 0..=TAIL_LINES as u32 {
            log_frontend_event(
                Flow::Flash,
                Stage::Writing,
                Outcome::Started,
                None,
                elapsed_ms,
            );
        }
        log_frontend_event(
            Flow::Flash,
            Stage::Writing,
            Outcome::Failed,
            Some(ErrorCategory::DriveDisconnected),
            99,
        );

        let records = LOG.0.lock().unwrap();
        assert_eq!(records.len(), TAIL_LINES + 2);
        for (elapsed_ms, (level, line)) in records[..=TAIL_LINES].iter().enumerate() {
            assert_eq!(*level, log::Level::Info);
            assert!(line.ends_with(&format!(
                "frontend Flash Writing Started error=None duration_ms={elapsed_ms}"
            )));
        }
        let (level, failure) = records.last().unwrap();
        assert_eq!(*level, log::Level::Error);
        assert!(failure.ends_with(
            "frontend Flash Writing Failed error=Some(DriveDisconnected) duration_ms=99"
        ));
        let tail = test_log_tail();
        assert_eq!(tail.len(), TAIL_LINES);
        assert_eq!(
            tail,
            records[2..]
                .iter()
                .map(|(_, line)| line.clone())
                .collect::<Vec<_>>()
        );
        println!("FRONTEND_LOG_COMMAND_ASSERTIONS_PASSED");
    }

    #[test]
    fn rapid_rotation_retains_one_file_and_only_allowlisted_log_targets() {
        let directory = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        let (_, _, logger) = log_builder()
            .max_file_size(128)
            .targets([tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Folder {
                    path: directory.path().to_path_buf(),
                    file_name: Some("installer".into()),
                },
            )])
            .split(app.handle())
            .unwrap();
        logger.log(
            &log::Record::builder()
                .target(TARGET)
                .level(log::Level::Info)
                .args(format_args!("rust initial marker"))
                .build(),
        );
        // KeepSome creates unpruned .bak files when timestamped archives collide.
        for _ in 0..100 {
            logger.log(
                &log::Record::builder()
                    .target(TARGET)
                    .level(log::Level::Info)
                    .args(format_args!("rust flash writing started"))
                    .build(),
            );
        }
        logger.log(
            &log::Record::builder()
                .target("webview")
                .level(log::Level::Error)
                .args(format_args!("password=secret-private-host"))
                .build(),
        );
        logger.flush();
        let files: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file_name(), "installer.log");
        let contents = std::fs::read_to_string(files[0].path()).unwrap();
        assert!(contents.len() <= 128);
        assert!(!contents.contains("secret"));
        assert!(!contents.contains("initial marker"));
        assert!(contents.contains("rust flash"));
    }

    #[test]
    fn panic_hook_omits_payload() {
        // Isolate the process-global panic hook from concurrently running tests.
        if std::env::var_os("HAI_PANIC_TEST_CHILD").is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "diagnostics::tests::panic_hook_omits_payload",
                    "--nocapture",
                ])
                .env("HAI_PANIC_TEST_CHILD", "1")
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(!String::from_utf8_lossy(&output.stdout).contains("panic-secret"));
            assert!(!String::from_utf8_lossy(&output.stderr).contains("panic-secret"));
            return;
        }
        init();
        assert!(std::panic::catch_unwind(|| panic!(
            "panic-secret ticket=password\nprivate-user@private-host"
        ))
        .is_err());
        let tail = test_log_tail().join("\n");
        assert!(tail.contains("rust panic (payload omitted)"));
        assert!(!tail.contains("panic-secret"));
    }

    #[test]
    // A UTM command test clears the shared tail, which would drop this line
    #[serial_test::serial]
    fn report_has_the_app_version_platform_and_log_tail() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = "2026.10.1".parse().unwrap();
        let app = tauri::test::mock_builder().build(context).unwrap();
        warning("report_test");

        let report = get_diagnostics(app.handle().clone());
        assert_eq!(report.version, "2026.10.1");
        assert_eq!(report.os, std::env::consts::OS);
        assert_eq!(report.architecture, std::env::consts::ARCH);
        assert!(
            report.os_version == "unknown"
                || report
                    .os_version
                    .chars()
                    .all(|c| c.is_ascii_digit() || ".-".contains(c)),
            "{}",
            report.os_version
        );
        assert!(
            report
                .log_tail
                .lines()
                .any(|line| line.ends_with("ms warning report_test")),
            "{}",
            report.log_tail
        );
    }

    #[test]
    // A UTM command test clears the shared tail, which would drop this line
    #[serial_test::serial]
    fn report_has_no_user_data() {
        let app = tauri::test::mock_app();
        let error = crate::command_error::CommandError::from(hai_core::Error::Io(
            std::io::Error::other("cannot open /home/private-user/haos.img"),
        ));
        let _ = Operation::new("report-privacy-test").finish::<(), _>(Err(error));

        let report = serde_json::to_value(get_diagnostics(app.handle().clone())).unwrap();
        let report = report.as_object().unwrap();
        let tail = report["log_tail"].as_str().unwrap();
        assert!(
            tail.contains("rust error: IO error: cannot open /home/<user>/haos.img"),
            "{tail}"
        );
        assert!(
            tail.contains("rust report-privacy-test preparing io duration_ms="),
            "{tail}"
        );
        // Users paste the report into public issues
        let mut fields: Vec<_> = report.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "architecture",
                "log_tail",
                "os",
                "os_version",
                "package_type",
                "version"
            ]
        );
        let home = app.path().home_dir().unwrap();
        for value in report.values() {
            let value = value.as_str().unwrap();
            assert!(!value.contains("private-user"), "{value}");
            // A root home dir (some containers) is part of every path
            assert!(
                home.parent().is_none() || !value.contains(&*home.to_string_lossy()),
                "{value}"
            );
        }
    }

    #[test]
    fn reportable_os_version_drops_release_text() {
        for version in ["10.0.26100", "26.5.0", "1".repeat(64).as_str()] {
            assert_eq!(reportable_os_version(version.into()), version);
        }
        for version in [
            "",
            "Rolling Release",
            "Rolling Release (20261001)",
            "24.04 LTS (Noble)",
            "1".repeat(65).as_str(),
        ] {
            assert_eq!(
                reportable_os_version(version.into()),
                "unknown",
                "{version}"
            );
        }
    }
}
