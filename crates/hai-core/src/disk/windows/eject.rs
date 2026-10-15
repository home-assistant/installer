//! Eject a disk the way "Safely Remove Hardware" does.

use std::io;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::thread::sleep;
use std::time::Duration;

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_Parent, CM_Request_Device_EjectW, PNP_VetoTypeUnknown, SetupDiDestroyDeviceInfoList,
    SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW, SetupDiGetDeviceInterfaceDetailW,
    CR_SUCCESS, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, HDEVINFO, SP_DEVICE_INTERFACE_DATA,
    SP_DEVICE_INTERFACE_DETAIL_DATA_W, SP_DEVINFO_DATA,
};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, MAX_PATH};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Ioctl::{
    GUID_DEVINTERFACE_DISK, IOCTL_STORAGE_GET_DEVICE_NUMBER, STORAGE_DEVICE_NUMBER,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

/// Windows can veto an eject for a moment while it settles the new volumes.
const EJECT_ATTEMPTS: u32 = 3;
const EJECT_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Ask Windows to remove the drive behind `\\.\PhysicalDrive<disk_number>`.
pub(super) fn eject_disk(disk_number: u32) -> io::Result<()> {
    let disk = disk_device_instance(disk_number)?;

    // The disk's parent is the USB device or card reader it sits on, the one
    // "Safely Remove Hardware" lists. Ejecting that is what removes the drive.
    let mut parent = 0;
    // SAFETY: `parent` is a valid out pointer and `disk` a device instance.
    config_result(unsafe { CM_Get_Parent(&mut parent, disk, 0) })?;

    let mut last_veto = PNP_VetoTypeUnknown;
    for attempt in 1..=EJECT_ATTEMPTS {
        let mut veto = PNP_VetoTypeUnknown;
        // Passing a buffer for the veto name keeps Windows from showing its
        // own dialog when the eject is refused.
        let mut veto_name = [0u16; MAX_PATH as usize];
        // SAFETY: the out pointers are valid and `veto_name` holds MAX_PATH
        // characters, as passed.
        let result = unsafe {
            CM_Request_Device_EjectW(parent, &mut veto, veto_name.as_mut_ptr(), MAX_PATH, 0)
        };
        if result == CR_SUCCESS && veto == PNP_VetoTypeUnknown {
            return Ok(());
        }

        last_veto = veto;
        if attempt < EJECT_ATTEMPTS {
            sleep(EJECT_RETRY_DELAY);
        }
    }

    Err(io::Error::other(format!(
        "Windows refused to eject the drive (veto {last_veto})"
    )))
}

/// Find the device instance of the disk with this number.
fn disk_device_instance(disk_number: u32) -> io::Result<u32> {
    let devices = DeviceInfoList::disks()?;

    for index in 0.. {
        let mut interface: SP_DEVICE_INTERFACE_DATA = unsafe { zeroed() };
        interface.cbSize = size_of::<SP_DEVICE_INTERFACE_DATA>() as u32;
        // SAFETY: `devices` is a valid list and `interface` a sized struct.
        let found = unsafe {
            SetupDiEnumDeviceInterfaces(
                devices.0,
                null(),
                &GUID_DEVINTERFACE_DISK,
                index,
                &mut interface,
            )
        };
        if found == 0 {
            break;
        }

        let Ok((path, instance)) = interface_details(&devices, &interface) else {
            continue;
        };
        if device_number(&path) == Some(disk_number) {
            return Ok(instance);
        }
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("No disk device found for PhysicalDrive{disk_number}"),
    ))
}

/// The interface's device path, NUL-terminated, and its device instance.
fn interface_details(
    devices: &DeviceInfoList,
    interface: &SP_DEVICE_INTERFACE_DATA,
) -> io::Result<(Vec<u16>, u32)> {
    let mut required = 0;
    // SAFETY: asking for the required size only; no buffer is written.
    unsafe {
        SetupDiGetDeviceInterfaceDetailW(
            devices.0,
            interface,
            null_mut(),
            0,
            &mut required,
            null_mut(),
        )
    };
    if (required as usize) < size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() {
        return Err(io::Error::last_os_error());
    }

    // u64 storage keeps the detail struct suitably aligned
    let mut buffer = vec![0u64; (required as usize).div_ceil(size_of::<u64>())];
    let detail = buffer
        .as_mut_ptr()
        .cast::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>();
    let mut info: SP_DEVINFO_DATA = unsafe { zeroed() };
    info.cbSize = size_of::<SP_DEVINFO_DATA>() as u32;
    // SAFETY: `detail` points at `required` writable, aligned bytes; cbSize
    // is the fixed part's size, as the API expects.
    let filled = unsafe {
        (*detail).cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
        SetupDiGetDeviceInterfaceDetailW(
            devices.0,
            interface,
            detail,
            required,
            null_mut(),
            &mut info,
        )
    };
    if filled == 0 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: on success the API wrote a NUL-terminated path inside `buffer`.
    let path = unsafe {
        let start = std::ptr::addr_of!((*detail).DevicePath).cast::<u16>();
        let length = (0..).take_while(|&i| *start.add(i) != 0).count();
        std::slice::from_raw_parts(start, length + 1).to_vec()
    };
    Ok((path, info.DevInst))
}

/// The disk number behind a disk interface path, as in `PhysicalDrive<n>`.
fn device_number(path: &[u16]) -> Option<u32> {
    // SAFETY: `path` is NUL-terminated. No access rights are needed for this
    // query, so it works without locking anything.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut number: STORAGE_DEVICE_NUMBER = unsafe { zeroed() };
    let mut returned = 0;
    // SAFETY: `handle` is open and `number` is the output buffer it expects.
    let ok = unsafe {
        let ok = DeviceIoControl(
            handle,
            IOCTL_STORAGE_GET_DEVICE_NUMBER,
            null(),
            0,
            std::ptr::addr_of_mut!(number).cast(),
            size_of::<STORAGE_DEVICE_NUMBER>() as u32,
            &mut returned,
            null_mut(),
        );
        CloseHandle(handle);
        ok
    };

    (ok != 0).then_some(number.DeviceNumber)
}

fn config_result(result: u32) -> io::Result<()> {
    if result == CR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "Configuration Manager error {result}"
        )))
    }
}

/// The present disk interfaces, freed on drop.
struct DeviceInfoList(HDEVINFO);

impl DeviceInfoList {
    fn disks() -> io::Result<Self> {
        // SAFETY: a plain query for present disk interfaces.
        let list = unsafe {
            SetupDiGetClassDevsW(
                &GUID_DEVINTERFACE_DISK,
                null(),
                null_mut(),
                DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
            )
        };
        if list as isize == INVALID_HANDLE_VALUE as isize {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(list))
    }
}

impl Drop for DeviceInfoList {
    fn drop(&mut self) {
        // SAFETY: created by SetupDiGetClassDevsW and destroyed once.
        unsafe { SetupDiDestroyDeviceInfoList(self.0) };
    }
}
