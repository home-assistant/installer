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
    // The code is already a fixed, credential-free category
    fn category(&self) -> &'static str {
        self.code
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
    NetworkError,
    DownloadFailed,
    ExtractionFailed,
    ProxmoxError,
    UtmError,
    Cancelled,
    OperationFailed,
    FrontendError,
    UnhandledRejection,
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
pub fn get_diagnostics(app: tauri::AppHandle) -> Diagnostics {
    let version = os_info::get().version().to_string();
    Diagnostics {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        // Some distributions supply arbitrary release text; omit it from reports.
        os_version: if version.len() <= 64
            && version
                .chars()
                .all(|c| c.is_ascii_digit() || ".-".contains(c))
        {
            version
        } else {
            "unknown".into()
        },
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

#[cfg(test)]
pub(crate) fn test_log_tail() -> Vec<String> {
    TAIL.lock().unwrap().iter().cloned().collect()
}

#[cfg(all(test, feature = "mock"))]
pub(crate) fn clear_test_log_tail() {
    TAIL.lock().unwrap().clear();
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
    fn frontend_ipc_rejects_free_form_fields() {
        assert!(serde_json::from_str::<Flow>("\"private.example\"").is_err());
        assert!(serde_json::from_str::<Stage>("\"password\"").is_err());
        assert!(serde_json::from_str::<ErrorCategory>("\"ticket=secret\"").is_err());
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
}
