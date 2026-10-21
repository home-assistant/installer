//! Linux disk writing via udisks2 over D-Bus (polkit handles authorization).

use super::super::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::mpsc;
use zbus::fdo::{ManagedObjects, ObjectManagerProxy};
use zbus::proxy::CacheProperties;
use zbus::{Connection, OwnedFd, OwnedObjectPath, Variant};

pub async fn write_image<P: ProgressCallback>(
    image_path: &Path,
    device_id: &str,
    expected: &ExpectedDevice,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    check_identity(&super::device::list_devices().await?, device_id, expected)?;
    let connection = Connection::system()
        .await
        .map_err(|e| map_udisks_error(e, "connecting to the system bus"))?;
    let block_path = resolve_block_path(&connection, device_id).await?;

    super::device::ensure_safe_target(device_id)?;
    unmount_disk(&connection, &block_path).await?;

    let image_size = std::fs::metadata(image_path)?.len();

    super::device::ensure_safe_target(device_id)?;
    let device = open_device_rw(&connection, &block_path).await?;

    // Authorization may take a while. Check again before the first write.
    // rdev ties the fd to the enumerated node, but is not a hardware serial:
    // Linux can reuse device numbers after unplugging a drive.
    check_identity(&super::device::list_devices().await?, device_id, expected)?;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let opened = device.metadata()?;
    // Unplugged between the checks: report the disconnect, not a missing path
    let current = std::fs::metadata(device_id).map_err(device_io_error)?;
    if !opened.file_type().is_block_device() || opened.rdev() != current.rdev() {
        return Err(Error::DriveDisconnected);
    }

    // The device name can belong to another drive by the time the write is
    // done, so remember which drive this is while that is certain
    let flashed = match managed_objects(&connection).await {
        Ok(objects) => flashed_drive(&objects, &block_path),
        Err(_) => None,
    };

    // A stop during the polkit prompt must leave the drive untouched
    if progress_callback.is_cancelled() {
        return Err(Error::Cancelled);
    }

    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Writing,
        0,
        image_size,
        "Writing image to device...",
    ));

    // Send progress updates from the blocking task through a channel.
    let (progress_tx, progress_rx) = mpsc::channel::<FlashProgress>();

    let image = image_path.to_path_buf();
    let write_handle = tokio::task::spawn_blocking(move || {
        let mut device = device;
        write_to_device(&image, &mut device, image_size, &progress_tx)?;
        Ok(device)
    });
    let device = run_with_progress(write_handle, progress_rx, progress_callback).await?;

    if verify {
        stop_if_requested(progress_callback)?;
        progress_callback.on_progress(FlashProgress::new(
            FlashStage::Verifying,
            0,
            image_size,
            "Verifying written data...",
        ));

        let (progress_tx, progress_rx) = mpsc::channel::<FlashProgress>();
        let image = image_path.to_path_buf();
        let verify_handle = tokio::task::spawn_blocking(move || {
            verify_device(&image, device, image_size, &progress_tx)
        });
        run_with_progress(verify_handle, progress_rx, progress_callback).await?;
    } else {
        drop(device);
    }
    stop_if_requested(progress_callback)?;

    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Finalizing,
        0,
        0,
        "Syncing data...",
    ));

    // Best effort, like "Safely remove" in the file manager: the write and the
    // verify passed, so the drive is done. If this fails or is skipped, the
    // success screen tells the user to eject the drive themselves.
    if let Some(flashed) = flashed {
        let _ = eject_drive(&connection, &flashed).await;
    }

    progress_callback.on_progress(FlashProgress::new(
        FlashStage::Complete,
        image_size,
        image_size,
        "Complete",
    ));

    Ok(())
}

/// Read the written image back from the medium and compare it.
fn verify_device(
    image_path: &Path,
    mut device: File,
    total_size: u64,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    // Evict the pages we just wrote from the cache so the read-back
    // comes from the medium, not RAM
    drop_device_cache(&device);

    // Tag verify-phase failures as VerificationFailed so the caller can
    // label them "Verification failed" rather than "Write failed".
    let verified = (|| {
        device.seek(SeekFrom::Start(0)).map_err(device_io_error)?;
        verify_write(image_path, &mut device, total_size, progress_tx)
    })();

    verified.map_err(|e| match e {
        Error::VerificationFailed(_) | Error::DriveDisconnected | Error::Cancelled => e,
        other => Error::VerificationFailed(other.to_string()),
    })
}

fn write_to_device(
    image_path: &Path,
    dest: &mut File,
    total_size: u64,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    let mut source = File::open(image_path)?;

    let mut buffer = vec![0u8; WRITE_BUFFER_SIZE];
    let mut bytes_written: u64 = 0;
    let mut last_progress_bytes: u64 = 0;

    loop {
        let bytes_read = source.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        dest.write_all(&buffer[..bytes_read])
            .map_err(|error| device_write_error(error, bytes_written, total_size))?;

        bytes_written += bytes_read as u64;

        // Update progress periodically
        if bytes_written - last_progress_bytes >= PROGRESS_UPDATE_INTERVAL {
            last_progress_bytes = bytes_written;
            send_progress(
                progress_tx,
                FlashProgress::new(
                    FlashStage::Writing,
                    bytes_written,
                    total_size,
                    "Writing image to device...",
                ),
            )?;
        }
    }

    dest.sync_all()
        .map_err(|error| device_write_error(error, bytes_written, total_size))?;

    // Send final progress
    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Writing,
        bytes_written,
        total_size,
        "Write complete",
    ));

    Ok(())
}

fn verify_write(
    image_path: &Path,
    dest: &mut File,
    total_size: u64,
    progress_tx: &mpsc::Sender<FlashProgress>,
) -> Result<()> {
    let mut source = File::open(image_path)?;

    let mut source_buffer = vec![0u8; WRITE_BUFFER_SIZE];
    let mut dest_buffer = vec![0u8; WRITE_BUFFER_SIZE];
    let mut bytes_verified: u64 = 0;
    let mut last_progress_bytes: u64 = 0;

    loop {
        let source_read = source.read(&mut source_buffer)?;
        if source_read == 0 {
            break;
        }

        dest.read_exact(&mut dest_buffer[..source_read])
            .map_err(device_io_error)?;

        if source_buffer[..source_read] != dest_buffer[..source_read] {
            return Err(Error::VerificationFailed(
                "Data mismatch during verification".to_string(),
            ));
        }

        bytes_verified += source_read as u64;

        // Update progress periodically
        if bytes_verified - last_progress_bytes >= PROGRESS_UPDATE_INTERVAL {
            last_progress_bytes = bytes_verified;
            send_progress(
                progress_tx,
                FlashProgress::new(
                    FlashStage::Verifying,
                    bytes_verified,
                    total_size,
                    "Verifying written data...",
                ),
            )?;
        }
    }

    // Send final progress
    let _ = progress_tx.send(FlashProgress::new(
        FlashStage::Verifying,
        bytes_verified,
        total_size,
        "Verification complete",
    ));

    Ok(())
}

/// The drive a flash went to, as udisks knows it. Unlike the device name,
/// its `Id` is not handed to the next drive that gets plugged in.
#[derive(Debug, Clone, PartialEq)]
struct FlashedDrive {
    path: OwnedObjectPath,
    id: String,
    /// When the card went in, for a card reader. Its `Id` is the reader's,
    /// and stays the same when the card is swapped. `None` for a drive that
    /// is its own media, like a USB stick.
    media_detected: Option<u64>,
}

/// What to clean up after a flash, bound to the flashed drive.
#[derive(Debug, PartialEq)]
struct Cleanup {
    filesystems: Vec<OwnedObjectPath>,
    power_off: bool,
    eject: bool,
}

const BLOCK: &str = "org.freedesktop.UDisks2.Block";
const DRIVE: &str = "org.freedesktop.UDisks2.Drive";
const FILESYSTEM: &str = "org.freedesktop.UDisks2.Filesystem";

fn property<T: TryFrom<zbus::OwnedVariant>>(
    objects: &ManagedObjects,
    path: &OwnedObjectPath,
    interface: &str,
    name: &str,
) -> Option<T> {
    objects
        .get(path)?
        .iter()
        .find(|(candidate, _)| candidate.as_str() == interface)?
        .1
        .get(name)?
        .try_clone()
        .ok()?
        .try_into()
        .ok()
}

/// The drive behind `block_path`, or `None` when udisks can't name it for
/// sure (no drive, or no persistent `Id`). Then nothing gets cleaned up.
fn flashed_drive(objects: &ManagedObjects, block_path: &OwnedObjectPath) -> Option<FlashedDrive> {
    let path: OwnedObjectPath = property(objects, block_path, BLOCK, "Drive")?;
    let id: String = property(objects, &path, DRIVE, "Id")?;
    if path.as_str() == "/" || id.is_empty() {
        return None;
    }

    let media_detected = media_detected(objects, &path)?;
    Some(FlashedDrive {
        path,
        id,
        media_detected,
    })
}

/// When the current media went in, for a drive with removable media. The
/// outer `None` means udisks can't say, so the drive can't be told apart.
fn media_detected(objects: &ManagedObjects, drive: &OwnedObjectPath) -> Option<Option<u64>> {
    if !property::<bool>(objects, drive, DRIVE, "MediaRemovable")? {
        return Some(None);
    }

    // udisks only sets this when media arrives, so a write doesn't move it
    let detected: u64 = property(objects, drive, DRIVE, "TimeMediaDetected")?;
    (detected != 0).then_some(Some(detected))
}

/// The cleanup for `flashed`, if it is still plugged in as itself. Only its
/// own filesystems qualify, whatever device names they have by now.
fn cleanup_for(objects: &ManagedObjects, flashed: &FlashedDrive) -> Option<Cleanup> {
    let id: String = property(objects, &flashed.path, DRIVE, "Id")?;
    if id != flashed.id || media_detected(objects, &flashed.path)? != flashed.media_detected {
        return None;
    }

    let mut filesystems: Vec<OwnedObjectPath> = objects
        .iter()
        .filter(|(path, interfaces)| {
            interfaces.keys().any(|name| name.as_str() == FILESYSTEM)
                && property::<OwnedObjectPath>(objects, path, BLOCK, "Drive").as_ref()
                    == Some(&flashed.path)
        })
        .map(|(path, _)| path.clone())
        .collect();
    filesystems.sort_by(|a, b| a.as_str().cmp(b.as_str()));

    Some(Cleanup {
        filesystems,
        power_off: property(objects, &flashed.path, DRIVE, "CanPowerOff").unwrap_or(false)
            && !has_siblings(objects, &flashed.path),
        eject: property(objects, &flashed.path, DRIVE, "Ejectable").unwrap_or(false),
    })
}

/// Whether other drives share this one's hardware, like the other slots of a
/// multi-card reader. Powering it off would disconnect those too.
fn has_siblings(objects: &ManagedObjects, drive: &OwnedObjectPath) -> bool {
    let Some(sibling_id) = property::<String>(objects, drive, DRIVE, "SiblingId") else {
        return false;
    };
    if sibling_id.is_empty() {
        return false;
    }

    objects.keys().any(|path| {
        path != drive
            && property::<String>(objects, path, DRIVE, "SiblingId").as_ref() == Some(&sibling_id)
    })
}

/// Unmount what the desktop mounted from the fresh image, then power the
/// drive off, or eject its media when it can't be powered off. Skipped when
/// the flashed drive is gone, or another drive took its place.
async fn eject_drive(conn: &Connection, flashed: &FlashedDrive) -> Result<()> {
    let Some(cleanup) = cleanup_for(&managed_objects(conn).await?, flashed) else {
        return Ok(());
    };

    // Never raise a second password prompt for cleanup the user didn't ask for
    let options = || HashMap::from([("auth.no_user_interaction", Variant::from(true))]);
    let context = "cleaning up after the flash";

    // Desktops automount the new boot partition as soon as it appears. One
    // that stays mounted, refused or busy, ends the cleanup: powering off
    // under it would fail or lose data.
    for path in cleanup.filesystems {
        let filesystem = UDisks2FilesystemProxy::builder(conn)
            .path(path)
            .cache_properties(CacheProperties::No)
            .build()
            .await
            .map_err(|e| map_udisks_error(e, context))?;
        check_unmount_result(filesystem.unmount(options()).await, context)?;
    }

    let drive = UDisks2DriveProxy::builder(conn)
        .path(flashed.path.clone())
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|e| map_udisks_error(e, context))?;
    let result = if cleanup.power_off {
        drive.power_off(options()).await
    } else if cleanup.eject {
        drive.eject(options()).await
    } else {
        Ok(())
    };
    result.map_err(|e| map_udisks_error(e, context))
}

/// Unmount everything on the disk before writing.
async fn unmount_disk(conn: &Connection, block_path: &OwnedObjectPath) -> Result<()> {
    let objects = managed_objects(conn).await?;

    for path in unmount_targets(&objects, block_path)? {
        let context =
            format!("unmounting {path}; close applications using the drive and try again");
        let proxy = UDisks2FilesystemProxy::builder(conn)
            .path(path)
            .cache_properties(CacheProperties::No)
            .build()
            .await
            .map_err(|e| map_udisks_error(e, &context))?;
        check_unmount_result(proxy.unmount(HashMap::new()).await, &context)?;
    }

    Ok(())
}

/// Every udisks object with its interfaces and properties.
async fn managed_objects(conn: &Connection) -> Result<ManagedObjects> {
    let manager = ObjectManagerProxy::builder(conn)
        .destination("org.freedesktop.UDisks2")
        .path("/org/freedesktop/UDisks2")
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|e| map_udisks_error(e, "reading the disk inventory"))?;
    manager
        .get_managed_objects()
        .await
        .map_err(|e| map_udisks_error(e.into(), "reading the disk inventory"))
}

fn unmount_targets(
    objects: &ManagedObjects,
    block_path: &OwnedObjectPath,
) -> Result<Vec<OwnedObjectPath>> {
    let block = objects
        .get(block_path)
        .ok_or_else(|| Error::DeviceNotFound(block_path.to_string()))?;
    let mut targets = vec![block_path.clone()];
    if let Some(table) = block.get("org.freedesktop.UDisks2.PartitionTable") {
        let partitions = table
            .get("Partitions")
            .ok_or_else(|| Error::InvalidConfig("Missing disk partitions".into()))?;
        let partitions: Vec<OwnedObjectPath> =
            partitions
                .try_clone()
                .and_then(TryInto::try_into)
                .map_err(|e| Error::InvalidConfig(format!("Invalid disk partitions: {e}")))?;
        targets.extend(partitions);
    }
    let mut filesystems = Vec::new();
    for path in targets {
        let interfaces = objects
            .get(&path)
            .ok_or_else(|| Error::DeviceNotFound(path.to_string()))?;
        // Blank disks and non-filesystem partitions need no unmount call.
        if interfaces.contains_key("org.freedesktop.UDisks2.Filesystem") {
            filesystems.push(path);
        }
    }
    Ok(filesystems)
}

fn check_unmount_result(result: zbus::Result<()>, context: &str) -> Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(zbus::Error::MethodError(name, _, _))
            if name.as_str() == "org.freedesktop.UDisks2.Error.NotMounted" =>
        {
            Ok(())
        }
        Err(e) => Err(map_udisks_error(e, context)),
    }
}

async fn resolve_block_path(conn: &Connection, device_id: &str) -> Result<OwnedObjectPath> {
    let manager = UDisks2ManagerProxy::new(conn)
        .await
        .map_err(|e| map_udisks_error(e, "connecting to udisks2"))?;

    let mut devspec = HashMap::new();
    devspec.insert("path", Variant::from(device_id));

    let paths = manager
        .resolve_device(devspec, HashMap::new())
        .await
        .map_err(|e| map_udisks_error(e, "resolving the device"))?;

    paths
        .into_iter()
        .next()
        .ok_or_else(|| Error::DeviceNotFound(device_id.to_string()))
}

/// Open the device read-write via udisks2 (raises the polkit prompt).
async fn open_device_rw(conn: &Connection, path: &OwnedObjectPath) -> Result<File> {
    let block = UDisks2BlockProxy::builder(conn)
        .path(path.to_string())
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|e| map_udisks_error(e, "addressing the device"))?;

    // O_EXCL: to make sure we have exclusive access to the disk and error if not
    // O_SYNC: so each write reaches the card before returning to keep the
    // progress bar in sync
    let mut options = HashMap::new();
    options.insert("flags", Variant::from(libc::O_EXCL | libc::O_SYNC));
    let fd = block
        .open_device("rw", options)
        .await
        .map_err(|e| map_udisks_error(e, "opening the device"))?;
    Ok(File::from(std::os::fd::OwnedFd::from(fd)))
}

/// Best-effort: drop the kernel page cache for the whole device so a
/// subsequent read-back hits the physical medium instead of the copy we
/// just wrote. Failures are advisory and ignored.
fn drop_device_cache(device: &File) {
    use std::os::fd::AsRawFd;
    // SAFETY: `device` owns the fd and keeps it open for this call. A `len`
    // of 0 means "to end of file"; the return value is purely advisory.
    unsafe {
        libc::posix_fadvise(device.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED);
    }
}

fn map_udisks_error(err: zbus::Error, context: &str) -> Error {
    // Remedy only; the DiskServiceUnavailable variant supplies the
    // "Disk service unavailable:" prefix.
    const UNAVAILABLE: &str = "install and enable udisks2 to flash drives.";

    // The bus reports its own errors, like a missing service, as fdo errors
    if let zbus::Error::FDO(error) = &err {
        if matches!(
            **error,
            zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_)
        ) {
            return Error::DiskServiceUnavailable(UNAVAILABLE.to_string());
        }
    }
    if let zbus::Error::MethodError(name, message, _) = &err {
        let name = name.as_str();
        // udisks2 isn't installed / not activatable on the bus.
        if name.contains("ServiceUnknown") || name.contains("NameHasNoOwner") {
            return Error::DiskServiceUnavailable(UNAVAILABLE.to_string());
        }
        // User dismissed the polkit dialog.
        if name.contains("NotAuthorizedDismissed") {
            return Error::PermissionDenied("Authorization was canceled".to_string());
        }
        if name.contains("NotAuthorized") {
            return Error::PermissionDenied(
                message
                    .clone()
                    .unwrap_or_else(|| "Not authorized to access the device".to_string()),
            );
        }
        // udisks may use the dedicated DeviceBusy name, but often reports a
        // busy device as Error.Failed with "Device or resource busy" in the
        // message instead, so check both.
        if name.contains("DeviceBusy")
            || message
                .as_deref()
                .is_some_and(|m| m.contains("Device or resource busy"))
        {
            return Error::DeviceBusy(BusyReason::InUse, context.to_string());
        }
        // A locked card fails right at the open, as EROFS in the message.
        if message
            .as_deref()
            .is_some_and(|m| m.contains("Read-only file system"))
        {
            return Error::WriteProtected;
        }
        return Error::Io(std::io::Error::other(format!(
            "udisks2 error while {context}: {err}"
        )));
    }

    // Not a method error → couldn't reach the bus/service at all.
    Error::DiskServiceUnavailable(format!("{UNAVAILABLE} ({err})"))
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.Manager",
    default_service = "org.freedesktop.UDisks2",
    default_path = "/org/freedesktop/UDisks2/Manager"
)]
trait UDisks2Manager {
    /// Resolve a device spec like `{"path": "/dev/sdb"}` to block-object paths.
    fn resolve_device(
        &self,
        devspec: HashMap<&str, Variant<'_>>,
        options: HashMap<&str, Variant<'_>>,
    ) -> zbus::Result<Vec<OwnedObjectPath>>;
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.Block",
    default_service = "org.freedesktop.UDisks2"
)]
trait UDisks2Block {
    /// Open the whole device; `mode` is `"r"`, `"w"`, or `"rw"`.
    fn open_device(&self, mode: &str, options: HashMap<&str, Variant<'_>>)
        -> zbus::Result<OwnedFd>;
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.Drive",
    default_service = "org.freedesktop.UDisks2"
)]
trait UDisks2Drive {
    fn eject(&self, options: HashMap<&str, Variant<'_>>) -> zbus::Result<()>;
    fn power_off(&self, options: HashMap<&str, Variant<'_>>) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.freedesktop.UDisks2.Filesystem",
    default_service = "org.freedesktop.UDisks2"
)]
trait UDisks2Filesystem {
    fn unmount(&self, options: HashMap<&str, Variant<'_>>) -> zbus::Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zbus::message::Message;
    use zbus::names::OwnedErrorName;

    fn method_error(name: &str, message: Option<&str>) -> zbus::Error {
        let msg = Message::method_call("/", "Test").build(&()).unwrap();
        zbus::Error::MethodError(
            OwnedErrorName::try_from(name).unwrap(),
            message.map(String::from),
            msg,
        )
    }

    #[test]
    fn unmount_targets_include_only_filesystems_on_the_selected_disk() {
        let disk = OwnedObjectPath::try_from("/disk").unwrap();
        let part = OwnedObjectPath::try_from("/disk1").unwrap();
        let other = OwnedObjectPath::try_from("/other").unwrap();
        let filesystem =
            zbus::names::OwnedInterfaceName::try_from("org.freedesktop.UDisks2.Filesystem")
                .unwrap();
        let table =
            zbus::names::OwnedInterfaceName::try_from("org.freedesktop.UDisks2.PartitionTable")
                .unwrap();
        let mut objects = ManagedObjects::new();
        assert!(unmount_targets(&objects, &disk).is_err());
        objects.insert(disk.clone(), BTreeMap::new());
        assert!(unmount_targets(&objects, &disk).unwrap().is_empty());
        objects
            .get_mut(&disk)
            .unwrap()
            .insert(filesystem.clone(), HashMap::new());
        assert_eq!(
            unmount_targets(&objects, &disk).unwrap(),
            vec![disk.clone()]
        );
        objects.insert(
            other,
            BTreeMap::from([(filesystem.clone(), HashMap::new())]),
        );
        objects.get_mut(&disk).unwrap().insert(
            table.clone(),
            HashMap::from([(
                "Partitions".into(),
                zbus::OwnedVariant::try_from(Variant::from(vec![part.clone()])).unwrap(),
            )]),
        );
        assert!(unmount_targets(&objects, &disk).is_err());
        objects.insert(part.clone(), BTreeMap::new());
        assert_eq!(
            unmount_targets(&objects, &disk).unwrap(),
            vec![disk.clone()]
        );
        objects
            .get_mut(&part)
            .unwrap()
            .insert(filesystem, HashMap::new());
        assert_eq!(
            unmount_targets(&objects, &disk).unwrap(),
            vec![disk.clone(), part]
        );
        objects
            .get_mut(&disk)
            .unwrap()
            .get_mut(&table)
            .unwrap()
            .clear();
        assert!(unmount_targets(&objects, &disk).is_err());
    }

    type Properties<'a> = Vec<(&'a str, Variant<'a>)>;
    type Interfaces<'a> = Vec<(&'a str, Properties<'a>)>;

    /// A udisks inventory: object path, then interfaces with their properties.
    fn inventory(objects: Vec<(&str, Interfaces<'_>)>) -> ManagedObjects {
        objects
            .into_iter()
            .map(|(path, interfaces)| {
                let interfaces = interfaces
                    .into_iter()
                    .map(|(interface, properties)| {
                        let properties = properties
                            .into_iter()
                            .map(|(name, value)| {
                                (
                                    name.to_string(),
                                    zbus::OwnedVariant::try_from(value).unwrap(),
                                )
                            })
                            .collect();
                        (
                            zbus::names::OwnedInterfaceName::try_from(interface).unwrap(),
                            properties,
                        )
                    })
                    .collect();
                (OwnedObjectPath::try_from(path).unwrap(), interfaces)
            })
            .collect()
    }

    fn object(path: &str) -> zbus::ObjectPath<'_> {
        zbus::ObjectPath::try_from(path).unwrap()
    }

    fn path(path: &str) -> OwnedObjectPath {
        OwnedObjectPath::try_from(path).unwrap()
    }

    const SANDISK: &str = "/org/freedesktop/UDisks2/drives/SanDisk_1";
    const OTHER: &str = "/org/freedesktop/UDisks2/drives/Kingston_2";
    const SDB: &str = "/org/freedesktop/UDisks2/block_devices/sdb";
    const SDB1: &str = "/org/freedesktop/UDisks2/block_devices/sdb1";
    const SDC1: &str = "/org/freedesktop/UDisks2/block_devices/sdc1";

    fn flashed_sandisk() -> FlashedDrive {
        FlashedDrive {
            path: path(SANDISK),
            id: "SanDisk-Ultra-1".into(),
            media_detected: None,
        }
    }

    #[test]
    fn flashed_drive_needs_a_persistent_id() {
        let drive = |id: &'static str| {
            inventory(vec![
                (SDB, vec![(BLOCK, vec![("Drive", object(SANDISK).into())])]),
                (
                    SANDISK,
                    vec![(
                        DRIVE,
                        vec![("Id", id.into()), ("MediaRemovable", false.into())],
                    )],
                ),
            ])
        };
        assert_eq!(
            flashed_drive(&drive("SanDisk-Ultra-1"), &path(SDB)),
            Some(flashed_sandisk())
        );
        // udisks leaves Id blank when the drive has nothing persistent
        assert_eq!(flashed_drive(&drive(""), &path(SDB)), None);

        // A block without a drive, or with a drive udisks doesn't list
        let loose = inventory(vec![(
            SDB,
            vec![(BLOCK, vec![("Drive", object("/").into())])],
        )]);
        assert_eq!(flashed_drive(&loose, &path(SDB)), None);
        let missing = inventory(vec![(
            SDB,
            vec![(BLOCK, vec![("Drive", object(SANDISK).into())])],
        )]);
        assert_eq!(flashed_drive(&missing, &path(SDB)), None);
    }

    #[test]
    fn cleanup_touches_only_the_flashed_drive() {
        let objects = inventory(vec![
            (
                SANDISK,
                vec![(
                    DRIVE,
                    vec![
                        ("Id", "SanDisk-Ultra-1".into()),
                        ("MediaRemovable", false.into()),
                        ("CanPowerOff", true.into()),
                        ("Ejectable", true.into()),
                    ],
                )],
            ),
            (OTHER, vec![(DRIVE, vec![("Id", "Kingston-2".into())])]),
            // The whole disk has no filesystem, its partition does
            (SDB, vec![(BLOCK, vec![("Drive", object(SANDISK).into())])]),
            (
                SDB1,
                vec![
                    (BLOCK, vec![("Drive", object(SANDISK).into())]),
                    (FILESYSTEM, vec![]),
                ],
            ),
            // Mounted, but on another drive
            (
                SDC1,
                vec![
                    (BLOCK, vec![("Drive", object(OTHER).into())]),
                    (FILESYSTEM, vec![]),
                ],
            ),
        ]);

        assert_eq!(
            cleanup_for(&objects, &flashed_sandisk()),
            Some(Cleanup {
                filesystems: vec![path(SDB1)],
                power_off: true,
                eject: true,
            })
        );
    }

    #[test]
    fn multi_slot_reader_is_ejected_not_powered_off() {
        let slot = |id: &'static str, sibling: &'static str| {
            vec![(
                DRIVE,
                vec![
                    ("Id", id.into()),
                    ("MediaRemovable", false.into()),
                    ("SiblingId", sibling.into()),
                    ("CanPowerOff", true.into()),
                    ("Ejectable", true.into()),
                ],
            )]
        };
        let reader = "/sys/devices/pci0000:00/usb1/1-2";

        // Powering off would take the card in the other slot with it
        let shared = inventory(vec![
            (SANDISK, slot("SanDisk-Ultra-1", reader)),
            (OTHER, slot("Kingston-2", reader)),
        ]);
        let cleanup = cleanup_for(&shared, &flashed_sandisk()).unwrap();
        assert!(!cleanup.power_off);
        assert!(cleanup.eject);

        // Alone on its hardware, or without a SiblingId: power off as before
        for other_reader in ["/sys/devices/pci0000:00/usb1/1-3", ""] {
            let alone = inventory(vec![
                (SANDISK, slot("SanDisk-Ultra-1", "")),
                (OTHER, slot("Kingston-2", other_reader)),
            ]);
            assert!(cleanup_for(&alone, &flashed_sandisk()).unwrap().power_off);
        }
        let separate = inventory(vec![
            (SANDISK, slot("SanDisk-Ultra-1", reader)),
            (
                OTHER,
                slot("Kingston-2", "/sys/devices/pci0000:00/usb1/1-3"),
            ),
        ]);
        assert!(
            cleanup_for(&separate, &flashed_sandisk())
                .unwrap()
                .power_off
        );
    }

    #[test]
    fn card_reader_cleanup_needs_the_same_card() {
        // The reader keeps its Id when the card in it is swapped
        let reader = |detected: u64| {
            inventory(vec![
                (SDB, vec![(BLOCK, vec![("Drive", object(SANDISK).into())])]),
                (
                    SANDISK,
                    vec![(
                        DRIVE,
                        vec![
                            ("Id", "SanDisk-Ultra-1".into()),
                            ("MediaRemovable", true.into()),
                            ("TimeMediaDetected", detected.into()),
                            ("Ejectable", true.into()),
                        ],
                    )],
                ),
            ])
        };
        let flashed = flashed_drive(&reader(1_000), &path(SDB)).unwrap();
        assert_eq!(flashed.media_detected, Some(1_000));
        assert!(cleanup_for(&reader(1_000), &flashed).is_some());

        // Another card went in after the write
        assert_eq!(cleanup_for(&reader(2_000), &flashed), None);
        // No card now, or udisks can't say when it came
        assert_eq!(cleanup_for(&reader(0), &flashed), None);
        // Nothing to tell cards apart with to begin with
        assert_eq!(flashed_drive(&reader(0), &path(SDB)), None);
    }

    #[test]
    fn cleanup_is_skipped_once_the_drive_is_gone_or_replaced() {
        // Unplugged: udisks no longer lists the drive
        let removed = inventory(vec![(
            OTHER,
            vec![(DRIVE, vec![("Id", "Kingston-2".into())])],
        )]);
        assert_eq!(cleanup_for(&removed, &flashed_sandisk()), None);

        // Another drive took over sdb, and its partitions are mounted
        let replaced = inventory(vec![
            (OTHER, vec![(DRIVE, vec![("Id", "Kingston-2".into())])]),
            (SDB, vec![(BLOCK, vec![("Drive", object(OTHER).into())])]),
            (
                SDB1,
                vec![
                    (BLOCK, vec![("Drive", object(OTHER).into())]),
                    (FILESYSTEM, vec![]),
                ],
            ),
        ]);
        assert_eq!(cleanup_for(&replaced, &flashed_sandisk()), None);

        // Same object path, but a drive udisks identifies differently
        let lookalike = inventory(vec![(
            SANDISK,
            vec![(DRIVE, vec![("Id", "SanDisk-Ultra-9".into())])],
        )]);
        assert_eq!(cleanup_for(&lookalike, &flashed_sandisk()), None);
    }

    #[test]
    fn unmount_ignores_only_already_unmounted_filesystems() {
        assert!(check_unmount_result(Ok(()), "unmounting").is_ok());
        assert!(check_unmount_result(
            Err(method_error(
                "org.freedesktop.UDisks2.Error.NotMounted",
                None
            )),
            "unmounting"
        )
        .is_ok());
        for name in [
            "org.freedesktop.DBus.Error.UnknownInterface",
            "org.freedesktop.DBus.Error.UnknownMethod",
            "org.freedesktop.UDisks2.Error.DeviceBusy",
            "org.freedesktop.UDisks2.Error.Failed",
            "org.freedesktop.UDisks2.Error.NotAuthorized",
            "org.freedesktop.DBus.Error.UnknownObject",
            "org.freedesktop.DBus.Error.ServiceUnknown",
        ] {
            assert!(
                check_unmount_result(Err(method_error(name, None)), "unmounting").is_err(),
                "{name}"
            );
        }
        assert!(check_unmount_result(
            Err(zbus::Error::Failure("disconnected".into())),
            "unmounting"
        )
        .is_err());
    }

    #[test]
    fn busy_unmount_reports_which_volume_failed() {
        for (name, message) in [
            ("org.freedesktop.UDisks2.Error.DeviceBusy", None),
            (
                "org.freedesktop.UDisks2.Error.Failed",
                Some("Device or resource busy"),
            ),
        ] {
            let result =
                check_unmount_result(Err(method_error(name, message)), "unmounting /dev/sdb1");
            assert!(
                matches!(result, Err(Error::DeviceBusy(_, context)) if context.contains("/dev/sdb1"))
            );
        }
    }

    #[test]
    fn test_map_udisks_error_service_unknown() {
        for error in [
            zbus::fdo::Error::ServiceUnknown("udisks2".into()),
            zbus::fdo::Error::NameHasNoOwner("udisks2".into()),
        ] {
            let mapped =
                map_udisks_error(zbus::Error::FDO(Box::new(error)), "resolving the device");
            assert!(matches!(mapped, Error::DiskServiceUnavailable(_)));
        }
    }

    #[test]
    fn test_map_udisks_error_authorization_dismissed() {
        // Must match before the generic NotAuthorized branch, since the
        // name contains "NotAuthorized" as a prefix.
        let err = method_error(
            "org.freedesktop.UDisks2.Error.NotAuthorizedDismissed",
            Some("Not authorized to perform operation"),
        );
        let mapped = map_udisks_error(err, "opening the device");
        assert!(
            matches!(mapped, Error::PermissionDenied(msg) if msg == "Authorization was canceled")
        );
    }

    #[test]
    fn test_map_udisks_error_not_authorized_uses_message() {
        let err = method_error(
            "org.freedesktop.UDisks2.Error.NotAuthorizedCanObtain",
            Some("Not authorized to open the device"),
        );
        let mapped = map_udisks_error(err, "opening the device");
        assert!(
            matches!(mapped, Error::PermissionDenied(msg) if msg == "Not authorized to open the device")
        );
    }

    #[test]
    fn test_map_udisks_error_read_only_is_write_protected() {
        let err = method_error(
            "org.freedesktop.UDisks2.Error.Failed",
            Some("Error opening device /dev/sdb: Read-only file system"),
        );
        let mapped = map_udisks_error(err, "opening the device");
        assert!(matches!(mapped, Error::WriteProtected), "{mapped:?}");
    }

    #[test]
    fn test_map_udisks_error_busy_from_failed_message() {
        let err = method_error(
            "org.freedesktop.UDisks2.Error.Failed",
            Some("Error opening device /dev/sdb: Device or resource busy"),
        );
        let mapped = map_udisks_error(err, "opening the device");
        assert!(matches!(mapped, Error::DeviceBusy(..)));
    }

    #[test]
    fn test_map_udisks_error_bus_unreachable() {
        let err = zbus::Error::Failure("could not connect".to_string());
        let mapped = map_udisks_error(err, "connecting to the system bus");
        assert!(matches!(mapped, Error::DiskServiceUnavailable(_)));
    }

    #[test]
    fn test_write_to_device_copies_image() {
        let data: Vec<u8> = (0..123_456u32).map(|i| (i % 251) as u8).collect();
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), &data).unwrap();

        let mut dest = tempfile::tempfile().unwrap();
        let (tx, rx) = mpsc::channel();
        write_to_device(image.path(), &mut dest, data.len() as u64, &tx).unwrap();

        dest.seek(SeekFrom::Start(0)).unwrap();
        let mut written = Vec::new();
        dest.read_to_end(&mut written).unwrap();
        assert_eq!(written, data);

        let last = rx.try_iter().last().unwrap();
        assert_eq!(last.stage, FlashStage::Writing);
        assert_eq!(last.bytes_processed, data.len() as u64);
    }

    #[test]
    fn test_verify_write_detects_mismatch() {
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), b"expected data").unwrap();

        let mut dest = tempfile::tempfile().unwrap();
        dest.write_all(b"corrupted data").unwrap();
        dest.seek(SeekFrom::Start(0)).unwrap();

        let (tx, _rx) = mpsc::channel();
        let result = verify_write(image.path(), &mut dest, 13, &tx);
        assert!(matches!(result, Err(Error::VerificationFailed(_))));
    }

    #[test]
    fn test_write_and_verify_roundtrip() {
        let data: Vec<u8> = (0..65_536u32).map(|i| (i % 199) as u8).collect();
        let image = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(image.path(), &data).unwrap();

        let mut device = tempfile::tempfile().unwrap();
        let (tx, rx) = mpsc::channel();
        write_to_device(image.path(), &mut device, data.len() as u64, &tx).unwrap();
        verify_device(image.path(), device, data.len() as u64, &tx).unwrap();

        let stages: Vec<FlashStage> = rx.try_iter().map(|u| u.stage).collect();
        assert!(stages.contains(&FlashStage::Writing));
        assert!(stages.contains(&FlashStage::Verifying));
    }
}
