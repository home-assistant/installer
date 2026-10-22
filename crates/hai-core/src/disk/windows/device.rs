//! Windows block device enumeration via PowerShell `Get-Disk`.

use super::super::*;
use crate::error::Error;
use serde::Deserialize;
use std::ffi::OsString;
use std::os::windows::{ffi::OsStringExt, process::CommandExt};
use std::path::PathBuf;
use std::process::Command;
use windows_sys::Win32::Foundation::MAX_PATH;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

#[derive(Debug, Deserialize)]
struct PowerShellDisk {
    #[serde(rename = "Number")]
    number: u32,
    #[serde(rename = "FriendlyName")]
    friendly_name: Option<String>,
    #[serde(rename = "Size")]
    size: Option<u64>,
    #[serde(rename = "MediaType")]
    media_type: Option<String>,
    #[serde(rename = "BusType")]
    bus_type: Option<String>,
    #[serde(rename = "IsSystem")]
    is_system: Option<bool>,
    #[serde(rename = "IsBoot")]
    is_boot: Option<bool>,
}

pub async fn list_devices() -> Result<Vec<BlockDevice>> {
    list_devices_sync()
}

/// Windows PowerShell in the system directory. By name alone, Windows looks
/// next to the installer first, in Downloads for example, and the installer
/// runs as administrator.
fn powershell() -> Result<PathBuf> {
    let mut buffer = [0u16; MAX_PATH as usize];
    // SAFETY: the pointer and length describe `buffer`
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), MAX_PATH) } as usize;
    // Zero is an error, and a larger length is the size the path would need
    if length == 0 || length > buffer.len() {
        return Err(Error::Io(std::io::Error::last_os_error()));
    }

    let system = PathBuf::from(OsString::from_wide(&buffer[..length]));
    Ok(system.join(r"WindowsPowerShell\v1.0\powershell.exe"))
}

pub(super) fn list_devices_sync() -> Result<Vec<BlockDevice>> {
    // Use PowerShell to get disk information in JSON format
    let script = r#"
        Get-Disk | Where-Object { $_.IsOffline -eq $false } | Select-Object Number, FriendlyName, Size, MediaType, BusType, IsSystem, IsBoot | ConvertTo-Json -Compress
    "#;

    let output = Command::new(powershell()?)
        .args(["-NoProfile", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(Error::Io)?;

    if !output.status.success() {
        return Err(Error::DeviceNotFound(format!(
            "PowerShell failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = stdout.trim();

    // Handle empty output
    if stdout.is_empty() {
        return Ok(Vec::new());
    }

    // PowerShell returns a single object (not array) if there's only one disk
    let disks: Vec<PowerShellDisk> = if stdout.starts_with('[') {
        serde_json::from_str(stdout)?
    } else {
        let single: PowerShellDisk = serde_json::from_str(stdout)?;
        vec![single]
    };

    let mut devices = Vec::new();

    for disk in disks {
        let size = disk.size.unwrap_or(0);

        // Internal drives are reported too; callers decide what to offer
        // based on the `removable` flag. Get-Disk has no removable bit, so
        // infer it from the bus, and never treat the running system's own
        // disk as removable even if it lives on USB.
        let on_removable_bus = matches!(
            disk.bus_type.as_deref(),
            Some("USB") | Some("SD") | Some("MMC")
        );
        let is_system = disk.is_system == Some(true) || disk.is_boot == Some(true);
        let removable = on_removable_bus && !is_system;

        // Determine device type based on bus type
        let device_type = determine_device_type(&disk);

        // Parse vendor and model from the friendly name
        let friendly_name = disk
            .friendly_name
            .clone()
            .unwrap_or_else(|| format!("Disk {}", disk.number));
        let (vendor, model) = parse_friendly_name(&friendly_name);

        let id = format!("\\\\.\\PhysicalDrive{}", disk.number);
        // Use the same descriptor as the opened-handle check. Get-Disk can
        // format its serial differently. No read/write access is requested.
        use std::os::windows::fs::OpenOptionsExt;
        let serial = std::fs::OpenOptions::new()
            .access_mode(0)
            .open(&id)
            .ok()
            .and_then(|device| {
                crate::disk::windows_serial::read_serial(&device)
                    .ok()
                    .flatten()
            });
        devices.push(BlockDevice {
            id,
            name: friendly_name,
            size,
            device_type,
            removable,
            model,
            vendor,
            serial,
        });
    }

    Ok(devices)
}

fn determine_device_type(disk: &PowerShellDisk) -> DeviceType {
    let bus = disk.bus_type.as_deref().unwrap_or("");
    let media = disk.media_type.as_deref().unwrap_or("");

    match bus {
        "USB" => DeviceType::UsbDrive,
        "SD" | "MMC" => DeviceType::SdCard,
        "NVMe" => DeviceType::Nvme,
        "SATA" | "ATA" => {
            if media == "SSD" {
                DeviceType::Ssd
            } else {
                DeviceType::Hdd
            }
        }
        _ => {
            if media == "SSD" {
                DeviceType::Ssd
            } else {
                DeviceType::Unknown
            }
        }
    }
}

/// Parse the FriendlyName from Windows to extract vendor and model.
/// Windows often combines vendor and model in the FriendlyName field.
pub(crate) fn parse_friendly_name(name: &str) -> (Option<String>, Option<String>) {
    // Common vendor prefixes found in Windows disk FriendlyNames
    let vendors = [
        "SanDisk",
        "Samsung",
        "Kingston",
        "Lexar",
        "PNY",
        "Transcend",
        "Sony",
        "Toshiba",
        "Western Digital",
        "WD",
        "Seagate",
        "Crucial",
        "Micron",
        "Generic",
        "USB",
    ];

    for vendor in vendors {
        if let Some(found) = find_vendor(name, vendor) {
            // Model is whatever comes after the vendor name
            let model = name[found.end..]
                .trim()
                .trim_start_matches(&[' ', '-', '_'][..])
                .to_string();

            return (
                Some(vendor.to_string()),
                if model.is_empty() { None } else { Some(model) },
            );
        }
    }

    // No known vendor found - use entire name as model
    (
        None,
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::{parse_friendly_name, powershell};

    #[test]
    fn powershell_comes_from_the_system_directory() {
        let path = powershell().unwrap();
        assert!(path.is_absolute());
        assert!(path.is_file(), "{}", path.display());

        let system = std::env::var("SystemRoot").unwrap();
        assert!(path
            .to_string_lossy()
            .to_lowercase()
            .starts_with(&system.to_lowercase()));
    }

    #[test]
    fn test_parse_friendly_name_with_vendor() {
        let (vendor, model) = parse_friendly_name("SanDisk Ultra USB");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, Some("Ultra USB".to_string()));
    }

    #[test]
    fn test_parse_friendly_name_vendor_only() {
        let (vendor, model) = parse_friendly_name("Kingston");
        assert_eq!(vendor, Some("Kingston".to_string()));
        assert_eq!(model, None);
    }

    #[test]
    fn test_parse_friendly_name_no_vendor() {
        let (vendor, model) = parse_friendly_name("Unknown Device");
        assert_eq!(vendor, None);
        assert_eq!(model, Some("Unknown Device".to_string()));
    }

    #[test]
    fn test_parse_friendly_name_empty() {
        let (vendor, model) = parse_friendly_name("");
        assert_eq!(vendor, None);
        assert_eq!(model, None);
    }

    #[test]
    fn test_parse_friendly_name_generic_usb() {
        let (vendor, model) = parse_friendly_name("Generic USB Flash Disk");
        assert_eq!(vendor, Some("Generic".to_string()));
        assert_eq!(model, Some("USB Flash Disk".to_string()));
    }

    #[test]
    fn test_parse_friendly_name_usb_prefix() {
        let (vendor, model) = parse_friendly_name("USB DISK");
        assert_eq!(vendor, Some("USB".to_string()));
        assert_eq!(model, Some("DISK".to_string()));
    }

    #[test]
    fn test_parse_friendly_name_western_digital() {
        let (vendor, model) = parse_friendly_name("Western Digital My Passport");
        assert_eq!(vendor, Some("Western Digital".to_string()));
        assert_eq!(model, Some("My Passport".to_string()));
    }

    #[test]
    fn test_parse_friendly_name_case_variations() {
        let (vendor, model) = parse_friendly_name("samsung evo");
        assert_eq!(vendor, Some("Samsung".to_string()));
        assert_eq!(model, Some("evo".to_string()));
    }

    #[test]
    fn test_parse_friendly_name_survives_text_that_grows_when_lowercased() {
        // "İ" is 2 bytes but lowercases to 3, which used to shift the slice
        // past the end of the original name and panic.
        let (vendor, model) = parse_friendly_name("İSanDisk Ultra");
        assert_eq!(vendor, Some("SanDisk".to_string()));
        assert_eq!(model, Some("Ultra".to_string()));
    }

    #[test]
    fn test_parse_friendly_name_ignores_the_kelvin_sign() {
        // The Kelvin sign lowercases to an ASCII "k", but it is not a "K".
        // Matching it used to cut the model to "on DataTraveler".
        let (vendor, model) = parse_friendly_name("\u{212A}ingston DataTraveler");
        assert_eq!(vendor, None);
        assert_eq!(model, Some("\u{212A}ingston DataTraveler".to_string()));
    }
}
