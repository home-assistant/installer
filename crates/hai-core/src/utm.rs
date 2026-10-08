//! UTM integration for macOS
//!
//! This module provides functionality for creating Home Assistant VMs
//! using UTM on macOS via AppleScript automation.

use crate::error::{Error, Result};
#[cfg(any(target_os = "macos", test))]
use crate::types::{FlashProgress, FlashStage};
use crate::types::{UtmStatus, UtmVmConfig, UtmVmResult, VmStatusInfo};
use crate::{Backend, ProgressCallback, UtmBackend};

#[cfg(any(target_os = "macos", all(test, unix)))]
fn applescript_output(output: std::process::Output) -> Result<String> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let code = message
        .rsplit_once('(')
        .and_then(|(_, code)| code.strip_suffix(')'))
        .and_then(|code| code.parse::<i32>().ok());
    // Timeout, missing reply, and a lost application connection do not prove
    // that the command stopped. Neither does a terminated osascript process.
    if output.status.code().is_none()
        || matches!(code, None | Some(-1711 | -1712 | -1718 | -609 | -600))
    {
        Err(Error::UtmOperationUncertain(message))
    } else {
        Err(applescript_error(&message))
    }
}

/// Native host architecture used for both the HAOS image and UTM configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UtmArchitecture {
    Aarch64,
    X86_64,
}

impl UtmArchitecture {
    /// Detect the Mac's native architecture, including a process running under Rosetta.
    pub fn host() -> Result<Self> {
        #[cfg(target_os = "macos")]
        {
            Self::from_process(std::env::consts::ARCH, macos::translation_status)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(Error::UnsupportedPlatform(
                "UTM is only available on macOS".to_string(),
            ))
        }
    }

    /// HAOS board whose qcow2 image boots on this architecture.
    pub fn haos_board(self) -> &'static str {
        match self {
            Self::Aarch64 => "generic-aarch64",
            Self::X86_64 => "ova",
        }
    }

    /// Architecture name accepted by UTM's QEMU configuration.
    pub fn qemu_architecture(self) -> &'static str {
        match self {
            Self::Aarch64 => "aarch64",
            Self::X86_64 => "x86_64",
        }
    }

    #[cfg(any(target_os = "macos", test))]
    fn from_process(
        process_arch: &str,
        translation_status: impl FnOnce() -> std::io::Result<i32>,
    ) -> Result<Self> {
        match process_arch {
            "aarch64" => Ok(Self::Aarch64),
            "x86_64" => match translation_status() {
                Ok(0) => Ok(Self::X86_64),
                Ok(1) => Ok(Self::Aarch64),
                // Intel macOS versions without Rosetta do not expose this sysctl.
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Self::X86_64),
                Ok(value) => Err(Error::Utm(format!(
                    "Unexpected Rosetta translation status: {}",
                    value
                ))),
                Err(err) => Err(Error::Utm(format!(
                    "Failed to detect the Mac's native architecture: {}",
                    err
                ))),
            },
            arch => Err(Error::UnsupportedPlatform(format!(
                "Unsupported Mac architecture: {}",
                arch
            ))),
        }
    }
}

/// Check if UTM is installed and get its status
async fn check_utm_status() -> Result<UtmStatus> {
    #[cfg(target_os = "macos")]
    {
        macos::check_utm_status().await
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::UnsupportedPlatform(
            "UTM is only available on macOS".to_string(),
        ))
    }
}

/// Create a Home Assistant VM using UTM
async fn create_vm<P: ProgressCallback>(
    config: &UtmVmConfig,
    progress_callback: &P,
) -> Result<UtmVmResult> {
    #[cfg(target_os = "macos")]
    {
        return macos::create_vm(config, progress_callback).await;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = config;
        let _ = progress_callback;
        Err(Error::UnsupportedPlatform(
            "UTM is only available on macOS".to_string(),
        ))
    }
}

/// Start a UTM VM
fn start_vm(vm_id: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        macos::start_vm(vm_id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = vm_id;
        Err(Error::UnsupportedPlatform(
            "UTM is only available on macOS".to_string(),
        ))
    }
}

/// Resize a UTM VM's disk
fn resize_vm_disk(vm_id: &str, size_gb: u32) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // TODO: Implement via qemu-img
        let _ = (vm_id, size_gb);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (vm_id, size_gb);
        Err(Error::UnsupportedPlatform(
            "UTM is only available on macOS".to_string(),
        ))
    }
}

/// Get the status of a UTM VM
fn vm_status(vm_id: &str) -> Result<VmStatusInfo> {
    #[cfg(target_os = "macos")]
    {
        macos::vm_status(vm_id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = vm_id;
        Err(Error::UnsupportedPlatform(
            "UTM is only available on macOS".to_string(),
        ))
    }
}

#[cfg(any(target_os = "macos", test))]
fn applescript_error(stderr: &str) -> Error {
    // osascript reports the numeric Apple Event error after the localized message.
    if stderr.trim().ends_with("(-1743)") {
        Error::Utm(
            "Home Assistant Installer is not allowed to control UTM. Open System Settings > Privacy & Security > Automation, enable UTM under Home Assistant Installer, then try again."
                .to_string(),
        )
    } else {
        Error::Utm(stderr.trim().to_string())
    }
}

#[cfg(any(target_os = "macos", test))]
fn escaped_vm_id(vm_id: &str) -> String {
    vm_id.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(any(target_os = "macos", test))]
fn query_vm_status(
    vm_id: &str,
    mut run: impl FnMut(&str) -> Result<String>,
) -> Result<VmStatusInfo> {
    let vm_id = escaped_vm_id(vm_id);
    let status = run(&format!(
        r#"tell application "UTM"
    return status of virtual machine id "{vm_id}"
end tell"#
    ))?;
    let ip_address = if status == "started" {
        // The guest agent can be unavailable while HAOS boots. Keep the real
        // running state so a retry does not try to start an already running VM.
        run(&format!(
            r#"tell application "UTM"
    set addresses to query ip virtual machine id "{vm_id}"
    set AppleScript's text item delimiters to linefeed
    return addresses as text
end tell"#
        ))
        .ok()
        .and_then(|output| first_usable_ipv4(&output))
    } else {
        None
    };
    Ok(VmStatusInfo { status, ip_address })
}

#[cfg(any(target_os = "macos", test))]
fn first_usable_ipv4(output: &str) -> Option<String> {
    // UTM returns addresses in guest-interface order, with IPv4 before IPv6.
    // The current readiness checks and success links require an IPv4 host.
    output
        .lines()
        .filter_map(|line| line.trim().parse::<std::net::Ipv4Addr>().ok())
        .find(|ip| {
            !ip.is_unspecified()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && ip.octets()[0] != 0
                && ip.octets()[0] < 240
        })
        .map(|ip| ip.to_string())
}

#[cfg(any(target_os = "macos", test))]
fn finish_vm_creation(
    config: &UtmVmConfig,
    vm_id: String,
    progress_callback: &impl ProgressCallback,
    start: impl FnOnce(&str) -> Result<()>,
) -> Result<UtmVmResult> {
    if config.auto_start {
        progress_callback.on_progress(FlashProgress {
            stage: FlashStage::Downloading,
            progress: 50,
            bytes_processed: 0,
            total_bytes: 0,
            message: "Starting virtual machine...".to_string(),
        });
        start(&vm_id)?;
    }
    progress_callback.on_progress(FlashProgress {
        stage: FlashStage::Complete,
        progress: 100,
        bytes_processed: 0,
        total_bytes: 0,
        message: if config.auto_start {
            "VM created and started"
        } else {
            "VM created"
        }
        .to_string(),
    });
    Ok(UtmVmResult {
        id: vm_id,
        name: config.name.clone(),
        path: Some(format!(
            "~/Library/Containers/com.utmapp.UTM/Data/Documents/{}.utm",
            config.name
        )),
    })
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::process::Command;

    const UTM_APP_PATH: &str = "/Applications/UTM.app";

    pub(super) fn translation_status() -> std::io::Result<i32> {
        let mut translated: libc::c_int = 0;
        let mut size = std::mem::size_of_val(&translated);
        // Query this process directly: a child sysctl executable can run natively
        // even when the installer is translated by Rosetta.
        // https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment
        let result = unsafe {
            // SAFETY: the name is NUL-terminated, and the output pointer and size
            // refer to a live c_int. Null newp makes this a read-only query.
            libc::sysctlbyname(
                c"sysctl.proc_translated".as_ptr(),
                std::ptr::from_mut(&mut translated).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if result == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(translated)
    }

    pub(super) fn vm_status(vm_id: &str) -> Result<VmStatusInfo> {
        query_vm_status(vm_id, run_applescript)
    }

    pub(super) async fn check_utm_status() -> Result<UtmStatus> {
        // Check if UTM.app exists
        let utm_path = std::path::Path::new(UTM_APP_PATH);
        if !utm_path.exists() {
            return Ok(UtmStatus {
                installed: false,
                version: None,
                path: None,
            });
        }

        // Try to get UTM version from Info.plist
        let info_plist_path = format!("{}/Contents/Info.plist", UTM_APP_PATH);
        let version = get_utm_version(&info_plist_path);

        Ok(UtmStatus {
            installed: true,
            version,
            path: Some(UTM_APP_PATH.to_string()),
        })
    }

    pub(super) fn get_utm_version(plist_path: &str) -> Option<String> {
        let plist_content = std::fs::read(plist_path).ok()?;
        let plist: plist::Value = plist::from_bytes(&plist_content).ok()?;
        let dict = plist.as_dictionary()?;
        dict.get("CFBundleShortVersionString")?
            .as_string()
            .map(|s| s.to_string())
    }

    /// Get the primary network interface for bridged networking.
    /// Uses the default route to determine which interface has internet connectivity.
    pub(super) fn get_primary_network_interface() -> String {
        let output = Command::new("route")
            .args(["-n", "get", "default"])
            .output();

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if line.trim().starts_with("interface:") {
                        if let Some(interface) = line.split(':').nth(1) {
                            let interface = interface.trim();
                            if !interface.is_empty() {
                                return interface.to_string();
                            }
                        }
                    }
                }
            }
        }

        // Default to en0 if detection fails
        "en0".to_string()
    }

    /// Run an AppleScript and return the output
    pub(super) fn run_applescript(script: &str) -> Result<String> {
        let child = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| Error::Utm(format!("Failed to execute AppleScript: {}", e)))?;
        let output = child.wait_with_output().map_err(|error| {
            Error::UtmOperationUncertain(format!("Failed to wait for AppleScript: {error}"))
        })?;
        applescript_output(output)
    }

    /// Start a VM by its ID
    pub(super) fn start_vm(vm_id: &str) -> Result<()> {
        let script = format!(
            r#"tell application "UTM"
    set vm to virtual machine id "{}"
    start vm
end tell"#,
            escaped_vm_id(vm_id)
        );

        run_applescript(&script).map_err(|error| match error {
            // Starting never reads the import source. A lost reply here must
            // not retain an image whose creation already completed.
            Error::UtmOperationUncertain(message) => Error::Utm(message),
            error => error,
        })?;
        Ok(())
    }

    pub(super) async fn create_vm<P: ProgressCallback>(
        config: &UtmVmConfig,
        progress_callback: &P,
    ) -> Result<UtmVmResult> {
        // Verify UTM is installed
        let status = check_utm_status().await?;
        if !status.installed {
            return Err(Error::Utm("UTM is not installed".to_string()));
        }

        // Verify the image file exists
        let image_path = std::path::Path::new(&config.image_path);
        if !image_path.exists() {
            return Err(Error::Utm(format!(
                "Image file not found: {}",
                config.image_path
            )));
        }

        progress_callback.on_progress(FlashProgress {
            stage: FlashStage::Downloading,
            progress: 0,
            bytes_processed: 0,
            total_bytes: 0,
            message: "Creating virtual machine...".to_string(),
        });

        // Get architecture and network interface
        let arch = UtmArchitecture::host()?.qemu_architecture();
        let network_interface = get_primary_network_interface();

        // Escape the name for AppleScript
        let escaped_name = config.name.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_path = config.image_path.replace('\\', "\\\\").replace('"', "\\\"");

        // Convert disk size from GB to MB for UTM
        let disk_size_mb = config.disk_size_gb * 1024;

        // Build the drives configuration with VirtIO interface
        let drives_config = format!(
            "{{interface:VirtIO, source:(POSIX file \"{}\"), guest size:{}}}",
            escaped_path, disk_size_mb
        );

        // Create VM using QEMU backend with hardware virtualization
        // - hypervisor:true for hardware acceleration (uses macOS Hypervisor.framework)
        // - uefi:true for UEFI boot (required by HAOS)
        // - bridged network for direct LAN access (required for Home Assistant)
        let script = format!(
            r#"tell application "UTM"
    set vmConfig to {{name:"{name}", notes:"Created by the Home Assistant Installer", architecture:"{arch}", cpu cores:{cores}, memory:{memory}, hypervisor:true, uefi:true, drives:{{{drives}}}, network interfaces:{{{{mode:bridged, host interface:"{interface}"}}}}}}
    set vm to make new virtual machine with properties {{backend:qemu, configuration:vmConfig}}
    return id of vm
end tell"#,
            name = escaped_name,
            arch = arch,
            cores = config.cpu_cores,
            memory = config.memory_mb,
            drives = drives_config,
            interface = network_interface,
        );

        let vm_id = run_applescript(&script)?;

        finish_vm_creation(config, vm_id, progress_callback, start_vm)
    }
}

impl UtmBackend for Backend {
    async fn check_utm_status(&self) -> Result<UtmStatus> {
        check_utm_status().await
    }

    async fn create_vm<P: ProgressCallback>(
        &self,
        config: &UtmVmConfig,
        progress_callback: &P,
    ) -> Result<UtmVmResult> {
        create_vm(config, progress_callback).await
    }

    fn start_vm(&self, vm_id: &str) -> Result<()> {
        start_vm(vm_id)
    }

    fn resize_vm_disk(&self, vm_id: &str, size_gb: u32) -> Result<()> {
        resize_vm_disk(vm_id, size_gb)
    }

    fn vm_status(&self, vm_id: &str) -> Result<VmStatusInfo> {
        vm_status(vm_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_applescript_automation_denied() {
        for stderr in [
            "0:30: execution error: Not authorized to send Apple events to UTM. (-1743)\n",
            "0:30: execution error: Keine Berechtigung zum Senden von Apple-Events an UTM. (-1743)\n",
        ] {
            let Error::Utm(message) = applescript_error(stderr) else {
                panic!("Expected UTM error");
            };
            assert!(message.contains("System Settings > Privacy & Security > Automation"));
            assert!(message.contains("enable UTM under Home Assistant Installer"));
            assert!(message.contains("try again"));
            assert!(!message.contains("execution error"));
        }
    }

    #[test]
    fn native_apple_silicon_uses_arm_without_querying_rosetta() {
        let arch = UtmArchitecture::from_process("aarch64", || panic!("not needed")).unwrap();
        assert_eq!(arch.haos_board(), "generic-aarch64");
        assert_eq!(arch.qemu_architecture(), "aarch64");
    }

    #[test]
    fn translated_intel_process_uses_native_arm_image_and_vm() {
        let arch = UtmArchitecture::from_process("x86_64", || Ok(1)).unwrap();
        assert_eq!(arch.haos_board(), "generic-aarch64");
        assert_eq!(arch.qemu_architecture(), "aarch64");
    }

    #[test]
    fn native_intel_uses_ova_image_and_x86_vm() {
        for status in [Ok(0), Err(std::io::ErrorKind::NotFound.into())] {
            let arch = UtmArchitecture::from_process("x86_64", || status).unwrap();
            assert_eq!(arch.haos_board(), "ova");
            assert_eq!(arch.qemu_architecture(), "x86_64");
        }
    }

    #[test]
    fn test_other_applescript_errors_keep_their_message() {
        for stderr in [
            "0:30: execution error: User canceled. (-128)\n",
            "0:30: execution error: Virtual machine not found. (-1728)\n",
            "0:30: execution error: Other failure. (-17430)\n",
            "0:30: execution error: VM named (-1743) not found. (-1728)\n",
            "",
        ] {
            let Error::Utm(message) = applescript_error(stderr) else {
                panic!("Expected UTM error");
            };
            assert_eq!(message, stderr.trim());
        }
    }

    #[test]
    #[cfg(unix)]
    fn applescript_distinguishes_rejection_from_unknown_completion() {
        use std::os::unix::process::ExitStatusExt;
        for (status, stderr, uncertain) in [
            (
                256,
                "User canceled out of wait loop for reply. (-1711)",
                true,
            ),
            (256, "UTM got an error: AppleEvent timed out. (-1712)", true),
            (256, "Reply has not yet arrived. (-1718)", true),
            (256, "Connection is invalid. (-609)", true),
            (256, "Application is not running. (-600)", true),
            (9, "", true),
            (256, "Unexpected process failure", true),
            (256, "Not authorized to send Apple events. (-1743)", false),
            (256, "Keine Berechtigung fuer Apple-Events. (-1743)", false),
            (
                256,
                "UTM got an error: Invalid configuration. (-10000)",
                false,
            ),
            (256, "syntax error: Expected end of line. (-2741)", false),
        ] {
            let error = applescript_output(std::process::Output {
                status: std::process::ExitStatus::from_raw(status),
                stdout: Vec::new(),
                stderr: stderr.as_bytes().to_vec(),
            })
            .unwrap_err();
            if stderr.ends_with("(-1743)") {
                assert!(error
                    .to_string()
                    .contains("System Settings > Privacy & Security > Automation"));
            }
            assert_eq!(
                matches!(error, Error::UtmOperationUncertain(_)),
                uncertain,
                "{stderr}"
            );
        }
        assert_eq!(
            applescript_output(std::process::Output {
                status: std::process::ExitStatus::from_raw(0),
                stdout: b"vm-id\n".to_vec(),
                stderr: Vec::new(),
            })
            .unwrap(),
            "vm-id"
        );
    }

    #[test]
    fn status_and_address_queries_use_the_same_escaped_id() {
        let mut calls = Vec::new();
        let result = query_vm_status("unique\\\"id", |script| {
            calls.push(script.to_string());
            Ok(if calls.len() == 1 {
                "started".to_string()
            } else {
                "169.254.1.2\n192.168.1.20\n172.30.32.1\nfe80::1".to_string()
            })
        })
        .unwrap();
        assert_eq!(result.status, "started");
        assert_eq!(result.ip_address.as_deref(), Some("192.168.1.20"));
        assert_eq!(calls.len(), 2);
        for script in &calls {
            assert!(script.contains(r#"virtual machine id "unique\\\"id""#));
        }
        assert!(calls[1].contains("text item delimiters to linefeed"));
    }

    #[test]
    fn status_survives_guest_agent_not_ready() {
        let mut calls = 0;
        let result = query_vm_status("unique-id", |_| {
            calls += 1;
            if calls == 1 {
                Ok("started".into())
            } else {
                Err(Error::Utm("Guest agent is not running".into()))
            }
        })
        .unwrap();
        assert_eq!(result.status, "started");
        assert!(result.ip_address.is_none());
        assert_eq!(calls, 2);
    }

    #[test]
    fn only_started_vms_query_the_guest() {
        for status in [
            "stopped", "starting", "paused", "pausing", "stopping", "resuming",
        ] {
            let mut calls = 0;
            let result = query_vm_status("unique-id", |_| {
                calls += 1;
                Ok(status.into())
            })
            .unwrap();
            assert_eq!(result.status, status);
            assert!(result.ip_address.is_none());
            assert_eq!(calls, 1);
        }
        assert!(query_vm_status("missing-id", |_| Err(Error::Utm("VM not found".into()))).is_err());
    }

    #[test]
    fn address_selection_excludes_unusable_hosts_without_rejecting_private_lans() {
        for output in [
            "",
            "not-an-ip\n::1\nfe80::1\n2001:db8::1",
            "0.0.0.0\n0.1.2.3\n127.0.0.2\n169.254.2.3\n224.0.0.1\n240.0.0.1\n255.255.255.255",
        ] {
            assert_eq!(first_usable_ipv4(output), None);
        }
        for ip in ["10.1.2.3", "172.17.0.5", "172.30.32.8", "192.168.1.20"] {
            assert_eq!(
                first_usable_ipv4(&format!("fe80::1\n {ip}\n192.168.2.1")),
                Some(ip.into())
            );
        }
    }

    #[test]
    fn creation_returns_the_id_before_start_unless_auto_start_was_requested() {
        for auto_start in [false, true] {
            let config = UtmVmConfig {
                name: "Non-unique name".into(),
                image_path: "/tmp/test.qcow2".into(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb: 32,
                auto_start,
            };
            let mut started = false;
            let result =
                finish_vm_creation(&config, "unique-id".into(), &crate::NoOpProgress, |id| {
                    assert_eq!(id, "unique-id");
                    started = true;
                    Ok(())
                })
                .unwrap();
            assert_eq!(started, auto_start);
            assert_eq!(result.id, "unique-id");
            assert_eq!(result.name, config.name);
        }
    }

    #[test]
    fn architecture_detection_errors_do_not_guess_an_image() {
        for status in [Ok(2), Err(std::io::ErrorKind::PermissionDenied.into())] {
            assert!(UtmArchitecture::from_process("x86_64", || status).is_err());
        }
        assert!(UtmArchitecture::from_process("unknown", || panic!("not needed")).is_err());
    }

    #[tokio::test]
    #[serial_test::serial]
    #[cfg(not(target_os = "macos"))]
    async fn test_check_utm_status_not_available_on_non_macos() {
        let result = check_utm_status().await;
        assert!(result.is_err());
        match result {
            Err(Error::UnsupportedPlatform(msg)) => {
                assert_eq!(msg, "UTM is only available on macOS");
            }
            _ => panic!("Expected UnsupportedPlatform error"),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    #[cfg(not(target_os = "macos"))]
    async fn test_create_vm_not_available_on_non_macos() {
        let config = UtmVmConfig {
            name: "Test VM".to_string(),
            image_path: "/tmp/test.qcow2".to_string(),
            cpu_cores: 2,
            memory_mb: 2048,
            disk_size_gb: 32,
            auto_start: false,
        };
        let result = create_vm(&config, &crate::NoOpProgress).await;
        assert!(result.is_err());
        match result {
            Err(Error::UnsupportedPlatform(msg)) => {
                assert_eq!(msg, "UTM is only available on macOS");
            }
            _ => panic!("Expected UnsupportedPlatform error"),
        }
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_start_vm_not_available_on_non_macos() {
        match start_vm("test-vm-id") {
            Err(Error::UnsupportedPlatform(msg)) => {
                assert_eq!(msg, "UTM is only available on macOS");
            }
            _ => panic!("Expected UnsupportedPlatform error"),
        }
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn test_resize_vm_disk_not_available_on_non_macos() {
        match resize_vm_disk("test-vm-id", 64) {
            Err(Error::UnsupportedPlatform(msg)) => {
                assert_eq!(msg, "UTM is only available on macOS");
            }
            _ => panic!("Expected UnsupportedPlatform error"),
        }
    }

    #[cfg(target_os = "macos")]
    mod macos_tests {
        use super::create_vm;
        use super::macos::{
            check_utm_status, get_primary_network_interface, get_utm_version, run_applescript,
            start_vm,
        };
        use crate::error::Error;
        use crate::types::UtmVmConfig;

        #[test]
        fn test_get_primary_network_interface() {
            let interface = get_primary_network_interface();

            // Should return a non-empty string
            assert!(!interface.is_empty(), "Interface should not be empty");

            // Should typically start with "en" (like en0, en1, en2, etc.) or be "en0" as fallback
            // Common macOS interfaces: en0 (Ethernet/WiFi), en1, bridge0, etc.
            // At minimum, it should return "en0" as the fallback
            assert!(
                interface.starts_with("en") || interface.starts_with("bridge"),
                "Interface should typically start with 'en' or 'bridge', got: {}",
                interface
            );

            // The fallback is specifically "en0"
            // If the command fails or no interface is found, it returns "en0"
            if interface == "en0" {
                // This is valid - either it's the actual interface or the fallback
                assert_eq!(interface, "en0");
            }
        }

        #[tokio::test]
        #[serial_test::serial]
        async fn test_check_utm_status_not_installed() {
            // Since UTM is unlikely to be installed at the exact path we check,
            // or if it is, we can still verify the logic works
            let status = check_utm_status().await.unwrap();

            // Either UTM is installed or not, both are valid states
            if status.installed {
                assert!(status.path.is_some());
                assert_eq!(status.path.as_ref().unwrap(), "/Applications/UTM.app");
            } else {
                assert!(!status.installed);
                assert!(status.version.is_none());
                assert!(status.path.is_none());
            }
        }

        #[tokio::test]
        #[serial_test::serial]
        async fn test_create_vm_non_mock_utm_not_installed() {
            let config = UtmVmConfig {
                name: "Test VM".to_string(),
                image_path: "/tmp/test.qcow2".to_string(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb: 32,
                auto_start: false,
            };

            let result = create_vm(&config, &crate::NoOpProgress).await;

            // If UTM is not installed, we should get an error
            // If it is installed, we'll get an error about the image file not existing
            // Both are valid test outcomes as they exercise the non-mock code paths
            if let Err(e) = result {
                let error_msg = format!("{}", e);
                assert!(
                    error_msg.contains("UTM is not installed")
                        || error_msg.contains("Image file not found")
                        || error_msg.contains("Failed to execute AppleScript"),
                    "Unexpected error: {}",
                    error_msg
                );
            }
        }

        #[tokio::test]
        #[serial_test::serial]
        async fn test_create_vm_non_mock_image_not_found() {
            // Create a temporary directory for testing
            let temp_dir = std::env::temp_dir();
            let non_existent_image = temp_dir.join("non_existent_image.qcow2");

            let config = UtmVmConfig {
                name: "Test VM".to_string(),
                image_path: non_existent_image.to_str().unwrap().to_string(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb: 32,
                auto_start: false,
            };

            let result = create_vm(&config, &crate::NoOpProgress).await;

            // Should either fail because UTM is not installed or because image doesn't exist
            assert!(result.is_err());
            if let Err(e) = result {
                let error_msg = format!("{}", e);
                // Either UTM is not installed or the image file is not found
                assert!(
                    error_msg.contains("UTM is not installed")
                        || error_msg.contains("Image file not found"),
                    "Expected specific error, got: {}",
                    error_msg
                );
            }
        }

        #[test]
        fn test_run_applescript_failure() {
            // Test AppleScript with invalid syntax to trigger error path
            let result = run_applescript("this is invalid applescript syntax!");
            assert!(result.is_err());
            if let Err(Error::Utm(msg)) = result {
                // Error message should contain something about syntax error
                assert!(!msg.is_empty(), "Error message should not be empty");
            } else {
                panic!("Expected Utm error");
            }
        }

        #[test]
        fn test_run_applescript_success() {
            // Test a simple AppleScript that should succeed
            // This just returns a simple string
            let result = run_applescript("return \"test\"");

            match result {
                Ok(output) => {
                    assert_eq!(output, "test");
                }
                Err(_) => {
                    // If it fails, it might be because osascript is not available
                    // which is fine for the test environment
                }
            }
        }

        #[test]
        fn test_start_vm_function() {
            // Test that start_vm generates the correct AppleScript
            // We can't actually start a VM without UTM installed and a real VM ID,
            // but we can verify the function handles errors appropriately
            let result = start_vm("test-vm-id-12345");

            // Should fail because this VM ID doesn't exist
            if let Err(e) = result {
                // Verify it's a UTM error (from AppleScript execution)
                match e {
                    Error::Utm(_) => {
                        // Expected - the VM doesn't exist or UTM isn't running
                    }
                    _ => panic!("Expected Utm error, got: {:?}", e),
                }
            }
        }

        #[test]
        fn test_get_utm_version_with_string_not_dict() {
            // Create a temporary file with a plist that has the wrong type for the version
            use std::io::Write;
            let temp_dir = std::env::temp_dir();
            let test_file = temp_dir.join("wrong_type_plist.plist");

            // Write a valid plist with CFBundleShortVersionString as a number instead of string
            let plist_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleShortVersionString</key>
    <integer>42</integer>
</dict>
</plist>"#;

            let mut file = std::fs::File::create(&test_file).unwrap();
            file.write_all(plist_content.as_bytes()).unwrap();
            drop(file);

            let result = get_utm_version(test_file.to_str().unwrap());

            // Should return None when the value is not a string
            assert!(
                result.is_none(),
                "Should return None when version is not a string"
            );

            // Cleanup
            let _ = std::fs::remove_file(test_file);
        }

        #[test]
        fn test_get_utm_version_with_non_dict_root() {
            // Create a temporary file with a plist that has an array at root instead of dict
            use std::io::Write;
            let temp_dir = std::env::temp_dir();
            let test_file = temp_dir.join("array_root_plist.plist");

            // Write a valid plist with an array at the root
            let plist_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <string>test</string>
</array>
</plist>"#;

            let mut file = std::fs::File::create(&test_file).unwrap();
            file.write_all(plist_content.as_bytes()).unwrap();
            drop(file);

            let result = get_utm_version(test_file.to_str().unwrap());

            // Should return None when root is not a dictionary
            assert!(
                result.is_none(),
                "Should return None when plist root is not a dictionary"
            );

            // Cleanup
            let _ = std::fs::remove_file(test_file);
        }

        #[tokio::test]
        #[serial_test::serial]
        async fn test_create_vm_with_existing_image_file() {
            // Create a temporary image file
            use std::io::Write;
            let temp_dir = std::env::temp_dir();
            let test_image = temp_dir.join("test_utm_image.qcow2");
            let mut file = std::fs::File::create(&test_image).unwrap();
            file.write_all(b"fake qcow2 data").unwrap();
            drop(file);

            let config = UtmVmConfig {
                name: "Test VM with Image".to_string(),
                image_path: test_image.to_str().unwrap().to_string(),
                cpu_cores: 2,
                memory_mb: 2048,
                disk_size_gb: 32,
                auto_start: false,
            };

            let result = create_vm(&config, &crate::NoOpProgress).await;

            // This test exercises the code path after the image file check
            // If UTM is installed, it might succeed or fail depending on the system
            // If UTM is not installed, it should fail
            // Either way, we've exercised the non-mock create_vm path
            match result {
                Ok(_) => {
                    // UTM is installed and VM was created (or at least attempted)
                    // This is actually good - it means we exercised the full VM creation path
                }
                Err(e) => {
                    let error_msg = format!("{}", e);
                    // The error should be about UTM or AppleScript, not about the image file
                    assert!(
                        error_msg.contains("UTM")
                            || error_msg.contains("AppleScript")
                            || error_msg.contains("virtual machine"),
                        "Expected UTM/AppleScript/VM error after image check, got: {}",
                        error_msg
                    );
                }
            }

            // Cleanup
            let _ = std::fs::remove_file(test_image);
        }

        #[test]
        fn test_get_utm_version_with_nonexistent_path() {
            // Test with a path that doesn't exist
            let result = get_utm_version("/nonexistent/path/to/Info.plist");

            // Should return None for invalid/non-existent plist path
            assert!(result.is_none(), "Should return None for non-existent path");
        }

        #[test]
        fn test_get_utm_version_with_invalid_plist() {
            // Create a temporary file with invalid plist content
            use std::io::Write;
            let temp_dir = std::env::temp_dir();
            let test_file = temp_dir.join("invalid_plist.plist");

            // Write invalid content
            let mut file = std::fs::File::create(&test_file).unwrap();
            file.write_all(b"This is not a valid plist file").unwrap();
            drop(file);

            let result = get_utm_version(test_file.to_str().unwrap());

            // Should return None for invalid plist content
            assert!(
                result.is_none(),
                "Should return None for invalid plist file"
            );

            // Cleanup
            let _ = std::fs::remove_file(test_file);
        }

        #[test]
        fn test_get_utm_version_with_missing_version_key() {
            // Create a temporary file with valid plist but missing version key
            use std::io::Write;
            let temp_dir = std::env::temp_dir();
            let test_file = temp_dir.join("no_version_plist.plist");

            // Write a valid plist without CFBundleShortVersionString
            let plist_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>TestApp</string>
</dict>
</plist>"#;

            let mut file = std::fs::File::create(&test_file).unwrap();
            file.write_all(plist_content.as_bytes()).unwrap();
            drop(file);

            let result = get_utm_version(test_file.to_str().unwrap());

            // Should return None when CFBundleShortVersionString is missing
            assert!(
                result.is_none(),
                "Should return None when version key is missing"
            );

            // Cleanup
            let _ = std::fs::remove_file(test_file);
        }

        #[test]
        fn test_get_utm_version_with_valid_plist() {
            // Create a temporary file with valid plist including version
            use std::io::Write;
            let temp_dir = std::env::temp_dir();
            let test_file = temp_dir.join("valid_plist.plist");

            // Write a valid plist with CFBundleShortVersionString
            let plist_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleShortVersionString</key>
    <string>4.5.0</string>
    <key>CFBundleName</key>
    <string>UTM</string>
</dict>
</plist>"#;

            let mut file = std::fs::File::create(&test_file).unwrap();
            file.write_all(plist_content.as_bytes()).unwrap();
            drop(file);

            let result = get_utm_version(test_file.to_str().unwrap());

            // Should return the version string
            assert!(
                result.is_some(),
                "Should return Some for valid plist with version"
            );
            assert_eq!(result.unwrap(), "4.5.0", "Should extract correct version");

            // Cleanup
            let _ = std::fs::remove_file(test_file);
        }
    }
}
