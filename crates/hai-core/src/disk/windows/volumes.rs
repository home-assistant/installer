//! Hold every target volume's lock until the raw disk transaction finishes.

use super::super::*;
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_MORE_DATA, ERROR_NO_MORE_FILES, ERROR_SHARING_VIOLATION, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FindFirstVolumeW, FindNextVolumeW, FindVolumeClose, GetDriveTypeW, FILE_SHARE_READ,
    FILE_SHARE_WRITE, IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
};
use windows_sys::Win32::System::Ioctl::{
    DISK_EXTENT, FSCTL_DISMOUNT_VOLUME, FSCTL_LOCK_VOLUME, GET_LENGTH_INFORMATION,
    IOCTL_DISK_GET_LENGTH_INFO, IOCTL_DISK_UPDATE_PROPERTIES, VOLUME_DISK_EXTENTS,
};
use windows_sys::Win32::System::WindowsProgramming::{DRIVE_CDROM, DRIVE_RAMDISK, DRIVE_REMOTE};
use windows_sys::Win32::System::IO::DeviceIoControl;

struct VolumeSearch(HANDLE);

impl Drop for VolumeSearch {
    fn drop(&mut self) {
        // SAFETY: this is a live enumeration handle owned by this guard.
        unsafe { FindVolumeClose(self.0) };
    }
}

pub(super) fn lock_disk_volumes(disk_number: u32) -> Result<Vec<File>> {
    let mut name = [0u16; 1024];
    // SAFETY: name is writable for the provided number of UTF-16 characters.
    let handle = unsafe { FindFirstVolumeW(name.as_mut_ptr(), name.len() as u32) };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
            Ok(Vec::new())
        } else {
            Err(Error::Io(error))
        };
    }
    let search = VolumeSearch(handle);
    let mut volumes = Vec::new();
    loop {
        // Optical and remote volumes do not have disk extents. Unknown types
        // are still inspected, so an ownership-query failure cannot skip a disk.
        // SAFETY: successful enumeration returned a NUL-terminated name.
        let drive_type = unsafe { GetDriveTypeW(name.as_ptr()) };
        if !matches!(drive_type, DRIVE_REMOTE | DRIVE_CDROM | DRIVE_RAMDISK) {
            let length = name
                .iter()
                .position(|&c| c == 0)
                .ok_or_else(invalid_extents)?;
            if length == 0 || name[length - 1] != b'\\' as u16 {
                return Err(invalid_extents().into());
            }
            let path = OsString::from_wide(&name[..length - 1]);
            let query = OpenOptions::new()
                .access_mode(0)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(&path)
                .map_err(|error| query_error(&path, error))?;
            let disks = volume_disks(&query).map_err(|error| query_error(&path, error))?;
            if belongs_to_disk(&disks, disk_number)? {
                drop(query);
                let volume = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .open(&path)
                    .map_err(volume_error)?;
                // Check the actual handle we will lock, not just its path.
                if !belongs_to_disk(&volume_disks(&volume).map_err(volume_error)?, disk_number)? {
                    return Err(Error::DeviceBusy(
                        "Target volume changed during preparation".into(),
                    ));
                }
                volumes.push(volume);
            }
        }
        // SAFETY: search owns the handle and name is a writable UTF-16 buffer.
        if unsafe { FindNextVolumeW(search.0, name.as_mut_ptr(), name.len() as u32) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(Error::Io(error));
            }
            break;
        }
    }
    lock_and_dismount(volumes, control, || {
        std::thread::sleep(std::time::Duration::from_millis(100));
    })
}

fn query_error(path: &OsStr, error: impl std::fmt::Display) -> Error {
    Error::DeviceBusy(format!(
        "Cannot inspect volume {}: {error}",
        path.to_string_lossy()
    ))
}

fn belongs_to_disk(disks: &[u32], target: u32) -> Result<bool> {
    if disks.is_empty() {
        return Err(invalid_extents().into());
    }
    if !disks.contains(&target) {
        return Ok(false);
    }
    if disks.iter().any(|&disk| disk != target) {
        return Err(Error::DeviceBusy(
            "Target volume spans multiple disks".into(),
        ));
    }
    Ok(true)
}

fn lock_and_dismount<T>(
    volumes: Vec<T>,
    mut ioctl: impl FnMut(&T, u32) -> io::Result<()>,
    mut pause: impl FnMut(),
) -> Result<Vec<T>> {
    // Lock all volumes before dismounting any. Vec ownership closes every
    // handle on partial failure, which also releases acquired volume locks.
    for volume in &volumes {
        for attempt in 0..30 {
            match ioctl(volume, FSCTL_LOCK_VOLUME) {
                Err(error)
                    if attempt < 29
                        && matches!(error.raw_os_error(),
                            Some(code) if code == ERROR_ACCESS_DENIED as i32 || code == ERROR_SHARING_VIOLATION as i32
                        ) =>
                {
                    pause()
                }
                result => {
                    result.map_err(volume_error)?;
                    break;
                }
            }
        }
    }
    for volume in &volumes {
        ioctl(volume, FSCTL_DISMOUNT_VOLUME).map_err(volume_error)?;
    }
    Ok(volumes)
}

fn volume_error(error: io::Error) -> Error {
    if is_write_protected(&error) || is_drive_disconnected(&error) {
        device_io_error(error)
    } else {
        Error::DeviceBusy(format!(
            "Cannot lock or dismount the target volume: {error}"
        ))
    }
}

fn invalid_extents() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid disk volume information",
    )
}

fn volume_disks(volume: &File) -> io::Result<Vec<u32>> {
    read_volume_disks(|buffer, size, returned| {
        // SAFETY: the handle is live, the output buffer is aligned, initialized,
        // and at least size bytes long; this ioctl has no input buffer.
        let ok = unsafe {
            DeviceIoControl(
                volume.as_raw_handle(),
                IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
                std::ptr::null(),
                0,
                buffer.as_mut_ptr().cast(),
                size as u32,
                returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    })
}

fn read_volume_disks(
    mut query: impl FnMut(&mut [u64], usize, &mut u32) -> io::Result<()>,
) -> io::Result<Vec<u32>> {
    let header = offset_of!(VOLUME_DISK_EXTENTS, Extents);
    // u64 storage provides the native struct alignment. Bound driver-reported
    // counts before allocating, and validate the returned byte count.
    let mut count = 1;
    loop {
        let size = header + count * size_of::<DISK_EXTENT>();
        let mut buffer = vec![0u64; size.div_ceil(size_of::<u64>())];
        let mut returned = 0;
        let result = query(&mut buffer, size, &mut returned);
        let more_data = match result {
            Err(error) if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) => true,
            other => {
                other?;
                false
            }
        };
        if returned < size_of::<u32>() as u32 || returned as usize > size {
            return Err(invalid_extents());
        }
        // SAFETY: the buffer contains at least the initialized count field.
        let actual_count = unsafe { buffer.as_ptr().cast::<u32>().read() } as usize;
        if actual_count == 0 || actual_count > 1024 {
            return Err(invalid_extents());
        }
        if more_data {
            if actual_count <= count {
                return Err(invalid_extents());
            }
            count = actual_count;
            continue;
        }
        if header + actual_count * size_of::<DISK_EXTENT>() > returned as usize {
            return Err(invalid_extents());
        }
        // SAFETY: returned bytes cover all extents; offset and alignment match
        // the Windows API struct, and the slice does not outlive the buffer.
        let extents = unsafe {
            std::slice::from_raw_parts(
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(header)
                    .cast::<DISK_EXTENT>(),
                actual_count,
            )
        };
        return Ok(extents.iter().map(|extent| extent.DiskNumber).collect());
    }
}

pub(super) fn control(device: &File, code: u32) -> io::Result<()> {
    let mut returned = 0;
    // SAFETY: callers use only control codes without input/output buffers.
    let ok = unsafe {
        DeviceIoControl(
            device.as_raw_handle(),
            code,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn disk_length(device: &File) -> Result<u64> {
    let mut length = GET_LENGTH_INFORMATION::default();
    let mut returned = 0;
    // SAFETY: length is a writable native output struct and device stays live.
    let ok = unsafe {
        DeviceIoControl(
            device.as_raw_handle(),
            IOCTL_DISK_GET_LENGTH_INFO,
            std::ptr::null(),
            0,
            (&mut length as *mut GET_LENGTH_INFORMATION).cast(),
            size_of::<GET_LENGTH_INFORMATION>() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(device_io_error(io::Error::last_os_error()));
    }
    if returned as usize != size_of::<GET_LENGTH_INFORMATION>() || length.Length <= 0 {
        return Err(invalid_extents().into());
    }
    Ok(length.Length as u64)
}

pub(super) fn refresh_properties(device: &File) -> Result<()> {
    control(device, IOCTL_DISK_UPDATE_PROPERTIES).map_err(device_io_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct Volume(usize, Arc<Mutex<Vec<usize>>>);

    impl Drop for Volume {
        fn drop(&mut self) {
            self.1.lock().unwrap().push(self.0);
        }
    }

    #[test]
    fn locks_all_before_dismount_and_retains_handles_until_drop() {
        let dropped = Arc::new(Mutex::new(Vec::new()));
        let volumes = (0..2).map(|id| Volume(id, dropped.clone())).collect();
        let mut calls = Vec::new();
        let locked = lock_and_dismount(
            volumes,
            |volume, code| {
                calls.push((volume.0, code));
                Ok(())
            },
            || {},
        )
        .unwrap();
        assert_eq!(
            calls,
            vec![
                (0, FSCTL_LOCK_VOLUME),
                (1, FSCTL_LOCK_VOLUME),
                (0, FSCTL_DISMOUNT_VOLUME),
                (1, FSCTL_DISMOUNT_VOLUME)
            ]
        );
        assert!(dropped.lock().unwrap().is_empty());
        drop(locked);
        assert_eq!(*dropped.lock().unwrap(), vec![0, 1]);
    }

    #[test]
    fn closes_all_handles_on_partial_lock_or_dismount_failure() {
        for failed_code in [FSCTL_LOCK_VOLUME, FSCTL_DISMOUNT_VOLUME] {
            let dropped = Arc::new(Mutex::new(Vec::new()));
            let volumes = (0..2).map(|id| Volume(id, dropped.clone())).collect();
            let mut calls = Vec::new();
            let result = lock_and_dismount(
                volumes,
                |volume, code| {
                    calls.push((volume.0, code));
                    if volume.0 == 1 && code == failed_code {
                        Err(io::ErrorKind::PermissionDenied.into())
                    } else {
                        Ok(())
                    }
                },
                || {},
            );
            assert!(matches!(result, Err(Error::DeviceBusy(_))));
            assert_eq!(*dropped.lock().unwrap(), vec![0, 1]);
            if failed_code == FSCTL_LOCK_VOLUME {
                assert!(calls.iter().all(|&(_, code)| code == FSCTL_LOCK_VOLUME));
            }
        }
    }

    #[test]
    fn selects_only_target_and_rejects_unknown_or_spanning_ownership() {
        assert!(belongs_to_disk(&[12, 12], 12).unwrap());
        assert!(!belongs_to_disk(&[1, 2], 12).unwrap());
        assert!(belongs_to_disk(&[], 12).is_err());
        assert!(belongs_to_disk(&[12, 13], 12).is_err());
    }

    #[test]
    fn preserves_native_protection_and_disconnect_errors() {
        assert!(matches!(
            volume_error(io::Error::from_raw_os_error(19)),
            Error::WriteProtected
        ));
        assert!(matches!(
            volume_error(io::Error::from_raw_os_error(1167)),
            Error::DriveDisconnected
        ));
    }

    #[test]
    fn unknown_volume_errors_do_not_blame_the_target() {
        for code in [19, 21, 1167] {
            let error =
                read_volume_disks(|_, _, _| Err(io::Error::from_raw_os_error(code))).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(code));
            let native_message = error.to_string();
            let error = query_error(OsStr::new("unknown volume"), error);
            assert!(matches!(error, Error::DeviceBusy(message)
                if message.contains("unknown volume") && message.ends_with(&native_message)));
        }
    }

    #[test]
    fn rejects_invalid_or_unbounded_extent_results() {
        for (count, returned, more) in [
            (0, 32, false),
            (1025, 32, true),
            (2, 32, false),
            (1, 33, false),
            (1, 0, false),
            (1, 32, true),
        ] {
            let error = read_volume_disks(|buffer, _, bytes_returned| {
                buffer[0] = count;
                *bytes_returned = returned;
                if more {
                    Err(io::Error::from_raw_os_error(ERROR_MORE_DATA as i32))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn retries_only_transient_lock_errors_with_a_bound() {
        let mut calls = 0;
        let mut pauses = 0;
        let locked = lock_and_dismount(
            vec![()],
            |_, code| {
                calls += 1;
                if code == FSCTL_LOCK_VOLUME && calls == 1 {
                    Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32))
                } else {
                    Ok(())
                }
            },
            || pauses += 1,
        )
        .unwrap();
        assert_eq!(locked.len(), 1);
        assert_eq!((calls, pauses), (3, 1));

        let mut calls = 0;
        let mut pauses = 0;
        let result = lock_and_dismount(
            vec![()],
            |_, code| {
                assert_eq!(code, FSCTL_LOCK_VOLUME);
                calls += 1;
                Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32))
            },
            || pauses += 1,
        );
        assert!(matches!(result, Err(Error::DeviceBusy(_))));
        assert_eq!((calls, pauses), (30, 29));

        let result = lock_and_dismount(
            vec![()],
            |_, _| Err(io::Error::from_raw_os_error(19)),
            || panic!("write protection must not be retried"),
        );
        assert!(matches!(result, Err(Error::WriteProtected)));
    }
}
