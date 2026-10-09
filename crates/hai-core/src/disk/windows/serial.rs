//! Serial from STORAGE_DEVICE_DESCRIPTOR, not the partition-table GUID.

use crate::error::{Error, Result};

pub(super) fn descriptor_serial(bytes: &[u8]) -> Result<Option<String>> {
    // STORAGE_DEVICE_DESCRIPTOR: Size at byte 4, SerialNumberOffset at 24,
    // followed by BusType, RawPropertiesLength and variable-length strings.
    let invalid = || Error::DeviceNotFound("Invalid storage serial descriptor".into());
    if bytes.len() < 36 {
        return Err(invalid());
    }
    let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if size < 36 || size > bytes.len() {
        return Err(invalid());
    }
    let offset = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
    if offset == 0 {
        return Ok(None);
    }
    if offset < 36 || offset >= size {
        return Err(invalid());
    }
    let serial = &bytes[offset..size];
    let end = serial
        .iter()
        .position(|&byte| byte == 0)
        .ok_or_else(invalid)?;
    let serial = std::str::from_utf8(&serial[..end]).map_err(|_| invalid())?;
    Ok(super::normalize_serial(Some(serial)))
}

#[cfg(target_os = "windows")]
pub(super) fn read_serial(device: &std::fs::File) -> Result<Option<String>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceProperty, IOCTL_STORAGE_QUERY_PROPERTY,
        STORAGE_PROPERTY_QUERY,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    let query = STORAGE_PROPERTY_QUERY {
        PropertyId: StorageDeviceProperty,
        QueryType: PropertyStandardQuery,
        AdditionalParameters: [0],
    };
    let query_descriptor = |buffer: &mut [u8]| -> Result<usize> {
        let mut returned = 0;
        // SAFETY: the owned handle and both buffers remain valid throughout
        // this synchronous query; the ioctl does not write to the disk.
        let ok = unsafe {
            DeviceIoControl(
                device.as_raw_handle(),
                IOCTL_STORAGE_QUERY_PROPERTY,
                (&query as *const STORAGE_PROPERTY_QUERY).cast(),
                std::mem::size_of_val(&query) as u32,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(super::device_io_error(std::io::Error::last_os_error()));
        }
        Ok(returned as usize)
    };
    let mut header = [0u8; 8];
    if query_descriptor(&mut header)? < header.len() {
        return Err(Error::DeviceNotFound("Cannot read the drive serial".into()));
    }
    let size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
    if !(36..=65536).contains(&size) {
        return Err(Error::DeviceNotFound(
            "Invalid storage descriptor size".into(),
        ));
    }
    let mut descriptor = vec![0; size];
    let returned = query_descriptor(&mut descriptor)?;
    descriptor.truncate(returned);
    descriptor_serial(&descriptor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(serial: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0; 36];
        bytes.extend_from_slice(serial);
        let size = bytes.len() as u32;
        bytes[4..8].copy_from_slice(&size.to_le_bytes());
        bytes[24..28].copy_from_slice(&36u32.to_le_bytes());
        bytes
    }

    #[test]
    fn parses_serial_and_missing_serial() {
        assert_eq!(
            descriptor_serial(&descriptor(b"  ABC123 \0"))
                .unwrap()
                .as_deref(),
            Some("ABC123")
        );
        assert_eq!(descriptor_serial(&descriptor(b" \0")).unwrap(), None);
        let mut bytes = descriptor(b"");
        bytes[24..28].fill(0);
        assert_eq!(descriptor_serial(&bytes).unwrap(), None);
    }

    #[test]
    fn rejects_truncated_and_invalid_descriptors() {
        assert!(descriptor_serial(&[0; 8]).is_err());
        assert!(descriptor_serial(&descriptor(b"unterminated")).is_err());
        let mut bytes = descriptor(b"serial\0");
        bytes[24..28].copy_from_slice(&4u32.to_le_bytes());
        assert!(descriptor_serial(&bytes).is_err());
        bytes[24..28].copy_from_slice(&999u32.to_le_bytes());
        assert!(descriptor_serial(&bytes).is_err());
        bytes[4..8].copy_from_slice(&999u32.to_le_bytes());
        assert!(descriptor_serial(&bytes).is_err());
    }
}
