//! Eject a disk the way "Safely Remove Hardware" does.

use std::io;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::thread::sleep;
use std::time::Duration;

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_DevNode_Registry_PropertyW, CM_Get_Device_IDW, CM_Get_Parent, CM_Locate_DevNodeW,
    CM_Request_Device_EjectW, PNP_VetoTypeUnknown, SetupDiDestroyDeviceInfoList,
    SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW, SetupDiGetDeviceInterfaceDetailW,
    CM_DEVCAP_REMOVABLE, CM_DRP_CAPABILITIES, CM_LOCATE_DEVNODE_NORMAL, CR_SUCCESS,
    DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, HDEVINFO, MAX_DEVICE_ID_LEN, SP_DEVICE_INTERFACE_DATA,
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

/// The disk a flash went to, by its PnP device instance ID. Unlike the disk
/// number, Windows doesn't hand that ID to the next drive that shows up.
pub(super) struct FlashedDisk {
    /// NUL-terminated, as the Configuration Manager takes it.
    instance_id: Vec<u16>,
}

/// Remember which disk `\\.\PhysicalDrive<disk_number>` is. Call this while
/// the drive's identity is verified, before the disk number can move on.
pub(super) fn flashed_disk(disk_number: u32) -> io::Result<FlashedDisk> {
    let disk = disk_device_instance(disk_number)?;

    let mut instance_id = vec![0u16; MAX_DEVICE_ID_LEN as usize + 1];
    // SAFETY: the buffer holds MAX_DEVICE_ID_LEN characters plus the NUL
    // that stays in place, as the length passed says.
    config_result(unsafe {
        CM_Get_Device_IDW(disk, instance_id.as_mut_ptr(), MAX_DEVICE_ID_LEN, 0)
    })?;
    let length = instance_id.iter().position(|&c| c == 0).unwrap_or(0);
    instance_id.truncate(length + 1);
    Ok(FlashedDisk { instance_id })
}

/// Ask Windows to remove the flashed disk, the way "Safely Remove Hardware"
/// does. Skipped when the disk is gone, or nothing on its way up the device
/// tree says it can be removed.
pub(super) fn eject_disk(flashed: &FlashedDisk) -> io::Result<()> {
    let mut disk = 0;
    // SAFETY: `disk` is a valid out pointer and the ID is NUL-terminated.
    // NORMAL only finds devices that are present right now.
    let located = unsafe {
        CM_Locate_DevNodeW(
            &mut disk,
            flashed.instance_id.as_ptr(),
            CM_LOCATE_DEVNODE_NORMAL,
        )
    };
    if located != CR_SUCCESS {
        return Ok(());
    }

    let Some(target) = removal_target(disk, parent_of, is_removable) else {
        return Ok(());
    };

    let mut last_veto = PNP_VetoTypeUnknown;
    for attempt in 1..=EJECT_ATTEMPTS {
        let mut veto = PNP_VetoTypeUnknown;
        // Passing a buffer for the veto name keeps Windows from showing its
        // own dialog when the eject is refused.
        let mut veto_name = [0u16; MAX_PATH as usize];
        // SAFETY: the out pointers are valid and `veto_name` holds MAX_PATH
        // characters, as passed.
        let result = unsafe {
            CM_Request_Device_EjectW(target, &mut veto, veto_name.as_mut_ptr(), MAX_PATH, 0)
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

/// The node to eject: the disk itself when it says it can be removed, else
/// the device it sits on. For an SD card in a built-in reader that's the
/// card, for a USB stick or card reader the USB device. Never anything
/// higher up: hubs and controllers carry other devices too.
///
/// `None` when neither is removable, or one can't tell: then the drive is
/// better left alone.
fn removal_target<Node: Copy>(
    disk: Node,
    parent_of: impl FnOnce(Node) -> Option<Node>,
    is_removable: impl Fn(Node) -> Option<bool>,
) -> Option<Node> {
    if is_removable(disk)? {
        return Some(disk);
    }

    let parent = parent_of(disk)?;
    is_removable(parent)?.then_some(parent)
}

fn parent_of(node: u32) -> Option<u32> {
    let mut parent = 0;
    // SAFETY: `parent` is a valid out pointer and `node` a device instance.
    (unsafe { CM_Get_Parent(&mut parent, node, 0) } == CR_SUCCESS).then_some(parent)
}

fn is_removable(node: u32) -> Option<bool> {
    let mut capabilities = 0u32;
    let mut length = size_of::<u32>() as u32;
    // SAFETY: the buffer is one u32, as `length` says; no type is needed.
    let result = unsafe {
        CM_Get_DevNode_Registry_PropertyW(
            node,
            CM_DRP_CAPABILITIES,
            null_mut(),
            std::ptr::addr_of_mut!(capabilities).cast(),
            &mut length,
            0,
        )
    };
    (result == CR_SUCCESS).then_some(capabilities & CM_DEVCAP_REMOVABLE != 0)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A node in a test device tree: its name, its parent, and whether it's
    /// removable (`None` when Windows couldn't read that).
    type Node = (&'static str, Option<&'static str>, Option<bool>);

    /// What `removal_target` picks in `tree`, starting at "disk".
    fn target(tree: &[Node]) -> Option<&'static str> {
        let find = |name| tree.iter().find(|node| node.0 == name);
        removal_target("disk", |name| find(name)?.1, |name| find(name)?.2)
    }

    #[test]
    fn usb_stick_ejects_the_usb_device() {
        let tree = [
            ("disk", Some("usb"), Some(false)),
            ("usb", Some("hub"), Some(true)),
            ("hub", Some("root"), Some(false)),
            ("root", None, Some(false)),
        ];
        assert_eq!(target(&tree), Some("usb"));
    }

    #[test]
    fn external_hub_stays_put() {
        // The hub can be removed too, but other devices hang off it
        let tree = [
            ("disk", Some("usb"), Some(false)),
            ("usb", Some("hub"), Some(true)),
            ("hub", Some("root"), Some(true)),
            ("root", None, Some(false)),
        ];
        assert_eq!(target(&tree), Some("usb"));
    }

    #[test]
    fn built_in_sd_reader_ejects_only_the_card() {
        let tree = [
            ("disk", Some("sd-host"), Some(true)),
            ("sd-host", Some("pci"), Some(false)),
            ("pci", None, Some(false)),
        ];
        assert_eq!(target(&tree), Some("disk"));
    }

    #[test]
    fn nothing_removable_or_unclear_is_left_alone() {
        let fixed = [
            ("disk", Some("controller"), Some(false)),
            ("controller", None, Some(false)),
        ];
        assert_eq!(target(&fixed), None);

        // A capability Windows couldn't read is no reason to guess upwards
        let unreadable = [("disk", Some("usb"), None), ("usb", None, Some(true))];
        assert_eq!(target(&unreadable), None);
    }

    #[test]
    fn hub_above_a_fixed_reader_stays_put() {
        // A reader built into the laptop sits on an internal hub, which says
        // it can be removed: ejecting that takes other devices with it
        let tree = [
            ("disk", Some("reader"), Some(false)),
            ("reader", Some("hub"), Some(false)),
            ("hub", Some("root"), Some(true)),
            ("root", None, Some(false)),
        ];
        assert_eq!(target(&tree), None);
    }
}
