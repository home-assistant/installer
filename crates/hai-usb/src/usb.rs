//! Writes the stick image to a USB drive using hai-core's cross-platform disk writer.

use std::path::Path;

use hai_core::{Backend, BlockDevice, DeviceBackend, ExpectedDevice, ProgressCallback};

use crate::{Error, Result};

/// Removable drives only: the stick must never be written to a system or internal disk.
pub async fn list_usb_drives() -> Result<Vec<BlockDevice>> {
    let devices = Backend.list_devices().await?;
    Ok(devices.into_iter().filter(|d| d.removable).collect())
}

/// Writes `image` to the drive `device_id` with read-back verification.
///
/// `expected` is what the drive looked like when the user picked it; the write is refused
/// if the drive at `device_id` no longer matches, isn't removable, or is too small.
pub async fn write_to_usb<P: ProgressCallback>(
    image: &Path,
    device_id: &str,
    expected: &ExpectedDevice,
    progress: &P,
) -> Result<()> {
    Backend.check_write_privileges()?;
    let image_size = std::fs::metadata(image)?.len();
    let devices = Backend.list_devices().await?;
    find_target(&devices, device_id, expected, image_size)?;
    Backend
        .write_image(image, device_id, expected, true, progress)
        .await?;
    Ok(())
}

/// The safety gate before writing, kept separate so it can be tested without hardware.
fn find_target<'a>(
    devices: &'a [BlockDevice],
    device_id: &str,
    expected: &ExpectedDevice,
    image_size: u64,
) -> Result<&'a BlockDevice> {
    let device = devices
        .iter()
        .find(|d| d.id == device_id)
        .ok_or_else(|| hai_core::Error::DeviceNotFound(device_id.into()))?;
    if !device.removable {
        return Err(Error::NotRemovable(device_id.into()));
    }
    if !expected.matches(device) {
        return Err(Error::DeviceChanged(device_id.into()));
    }
    hai_core::disk::ensure_image_fits(image_size, device.size)?;
    Ok(device)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hai_core::DeviceType;

    fn drive(id: &str, size: u64, removable: bool) -> BlockDevice {
        BlockDevice {
            id: id.into(),
            name: id.into(),
            size,
            device_type: DeviceType::UsbDrive,
            removable,
            model: Some("Stick".into()),
            vendor: Some("Acme".into()),
            serial: Some("SN-1".into()),
        }
    }

    fn expected(device: &BlockDevice) -> ExpectedDevice {
        ExpectedDevice {
            size: Some(device.size),
            model: device.model.clone(),
            vendor: device.vendor.clone(),
            serial: device.serial.clone(),
        }
    }

    #[test]
    fn accepts_the_same_removable_drive_with_room() {
        let devices = [drive("usb", 2_000_000_000, true)];
        let found = find_target(&devices, "usb", &expected(&devices[0]), 1_000_000_000).unwrap();
        assert_eq!(found.id, "usb");
    }

    #[test]
    fn refuses_unsafe_targets() {
        let fixed = drive("ssd", 500_000_000_000, false);
        let stick = drive("usb", 2_000_000_000, true);
        let devices = [fixed.clone(), stick.clone()];

        let err = find_target(&devices, "ssd", &expected(&fixed), 1).unwrap_err();
        assert!(matches!(err, Error::NotRemovable(_)), "{err}");

        let mut swapped = expected(&stick);
        swapped.size = Some(4_000_000_000);
        let err = find_target(&devices, "usb", &swapped, 1).unwrap_err();
        assert!(matches!(err, Error::DeviceChanged(_)), "{err}");

        let mut same_model_other_stick = expected(&stick);
        same_model_other_stick.serial = Some("SN-2".into());
        let err = find_target(&devices, "usb", &same_model_other_stick, 1).unwrap_err();
        assert!(matches!(err, Error::DeviceChanged(_)), "{err}");

        let err = find_target(&devices, "usb", &expected(&stick), 3_000_000_000).unwrap_err();
        assert!(
            matches!(err, Error::Core(hai_core::Error::ImageTooLarge { .. })),
            "{err}"
        );

        let err = find_target(&devices, "gone", &expected(&stick), 1).unwrap_err();
        assert!(
            matches!(err, Error::Core(hai_core::Error::DeviceNotFound(_))),
            "{err}"
        );
    }
}
