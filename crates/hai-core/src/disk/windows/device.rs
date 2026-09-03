//! Windows block device enumeration via PowerShell `Get-Disk`.

use super::super::*;
use crate::error::Error;
use serde::Deserialize;
use std::process::Command;

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
    // Use PowerShell to get disk information in JSON format
    let script = r#"
        Get-Disk | Where-Object { $_.IsOffline -eq $false } | Select-Object Number, FriendlyName, Size, MediaType, BusType, IsSystem, IsBoot | ConvertTo-Json -Compress
    "#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
        .map_err(|e| Error::Io(e))?;

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
        // Skip system and boot drives
        if disk.is_system == Some(true) || disk.is_boot == Some(true) {
            continue;
        }

        // Skip very small drives (< 1GB)
        let size = disk.size.unwrap_or(0);
        if size < 1_000_000_000 {
            continue;
        }

        // Determine device type based on bus type
        let device_type = determine_device_type(&disk);

        // Parse vendor and model from the friendly name
        let friendly_name = disk
            .friendly_name
            .clone()
            .unwrap_or_else(|| format!("Disk {}", disk.number));
        let (vendor, model) = parse_friendly_name(&friendly_name);

        devices.push(BlockDevice {
            id: format!("\\\\.\\PhysicalDrive{}", disk.number),
            name: friendly_name,
            size,
            device_type,
            removable: matches!(
                disk.bus_type.as_deref(),
                Some("USB") | Some("SD") | Some("MMC")
            ),
            model,
            vendor,
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
        "NVMe" => DeviceType::NvMe,
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

    let name_lower = name.to_lowercase();

    for vendor in vendors {
        if name_lower.contains(&vendor.to_lowercase()) {
            // Find the vendor in the original string (preserving case)
            let vendor_start = name_lower.find(&vendor.to_lowercase()).unwrap();
            let vendor_end = vendor_start + vendor.len();

            // Model is whatever comes after the vendor name
            let model = name[vendor_end..]
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
    use super::parse_friendly_name;

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
        assert_eq!(model, Some("Flash Disk".to_string()));
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
}
