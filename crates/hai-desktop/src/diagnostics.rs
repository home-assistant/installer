//! Local diagnostics deliberately exclude free-form errors, paths and network data.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

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

// Only callers with compile-time strings or deserialized enums can record data.
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
    UnsupportedSectorSize,
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
    // The live USB stick and ISO, and restarting as administrator for them
    HaiLiveMissing,
    HaiLiveInvalid,
    ReleaseUnavailable,
    ImageBuildFailed,
    FileExists,
    InvalidFileName,
    FileNameNotPortable,
    FolderNotFound,
    FolderInCache,
    FolderNameTaken,
    RelaunchCancelled,
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
    fn raw_error_details_never_enter_diagnostics() {
        for message in [
            "Proxmox API error: https://admin:password@private.example ticket=secret",
            "IO error: /home/private-user/private-file",
            "Network error: csrf_token=secret\nInjected log line",
            "password=arbitrary-secret",
        ] {
            let operation = Operation::new("privacy-test");
            let _ = operation.finish::<(), String>(Err(message.into()));
        }
        let tail = test_log_tail().join("\n");
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
    fn busy_failures_log_their_reason_without_the_message() {
        let operation = Operation::new("busy-test");
        let error = crate::command_error::CommandError::from(hai_core::Error::DeviceBusy(
            hai_core::BusyReason::VolumeUnreadable,
            "Cannot inspect volume private-volume".into(),
        ));
        let _ = operation.finish::<(), _>(Err(error));

        let tail = test_log_tail().join("\n");
        assert!(
            tail.contains("rust busy-test preparing device_busy_volume_unreadable"),
            "{tail}"
        );
        assert!(!tail.contains("private-volume"), "{tail}");
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
        let tail = tail.join("\n");
        for private in ["private", "192.168"] {
            assert!(!tail.contains(private), "{tail}");
        }
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
            "unsupported_sector_size",
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
            "hai_live_missing",
            "hai_live_invalid",
            "release_unavailable",
            "image_build_failed",
            "file_exists",
            "invalid_file_name",
            "file_name_not_portable",
            "folder_not_found",
            "folder_in_cache",
            "folder_name_taken",
            "relaunch_cancelled",
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
        let _ = Operation::new("report-privacy-test")
            .finish::<(), String>(Err("IO error: /home/private-user/private-file".into()));

        let report = serde_json::to_value(get_diagnostics(app.handle().clone())).unwrap();
        let report = report.as_object().unwrap();
        let tail = report["log_tail"].as_str().unwrap();
        assert!(
            tail.contains("rust report-privacy-test preparing operation_failed duration_ms="),
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
            assert!(!value.contains("private"), "{value}");
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
