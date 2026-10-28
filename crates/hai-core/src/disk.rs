//! Block device enumeration and raw disk writing.
//!
//! This module provides platform-specific implementations for listing
//! block devices (SD cards, USB drives, etc.) and writing raw disk
//! images to them.

use crate::error::{BusyReason, Error, Result};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use crate::types::DeviceType;
use crate::types::{BlockDevice, ExpectedDevice, FlashProgress, FlashStage};
use crate::{Backend, DeviceBackend, ProgressCallback};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(target_os = "linux")]
#[path = "disk/linux/mod.rs"]
mod imp;
#[cfg(target_os = "macos")]
#[path = "disk/macos/mod.rs"]
mod imp;
#[cfg(target_os = "windows")]
#[path = "disk/windows/mod.rs"]
mod imp;

#[cfg(any(target_os = "windows", test))]
#[path = "disk/windows/elevation.rs"]
mod windows_elevation;

// Pure logic behind the macOS write path, compiled under `test` on every
// platform so the Linux-only backend test job covers it without shipping it
// in non-macOS builds.
#[cfg(any(target_os = "macos", test))]
#[path = "disk/macos/logic.rs"]
mod macos_logic;

#[cfg(any(target_os = "macos", test))]
#[path = "disk/macos/safety.rs"]
mod macos_safety;

#[cfg(any(target_os = "windows", test))]
#[path = "disk/windows/transfer.rs"]
mod windows_transfer;

#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "disk/macos/device.rs"]
mod macos_device_tests;

#[cfg(any(target_os = "windows", test))]
#[path = "disk/windows/serial.rs"]
mod windows_serial;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("hai-core supports only Linux, macOS and Windows");

/// Buffer size for disk writes (4 MB for SD cards)
#[allow(dead_code)]
const WRITE_BUFFER_SIZE: usize = 4 * 1024 * 1024;

/// Buffer size for fast drives like NVMe/SSDs (64 MB)
#[allow(dead_code)]
const FAST_DRIVE_BUFFER_SIZE: usize = 64 * 1024 * 1024;

/// How often to send progress updates (every N bytes)
#[allow(dead_code)]
const PROGRESS_UPDATE_INTERVAL: u64 = 10 * 1024 * 1024; // 10 MB

/// What a writer copies to the drive: an image file, with one range of it
/// replaced from memory, so settings added to it never reach the local disk.
#[derive(Clone)]
pub struct Image {
    path: PathBuf,
    patch: Option<Arc<Patch>>,
}

struct Patch {
    offset: u64,
    bytes: Vec<u8>,
}

impl std::fmt::Debug for Image {
    // Never the patch bytes: they can hold a password
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Image")
            .field("path", &self.path)
            .field(
                "patch",
                &self
                    .patch
                    .as_ref()
                    .map(|patch| (patch.offset, patch.bytes.len())),
            )
            .finish()
    }
}

impl Image {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            patch: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read `bytes` in place of the file's bytes at `offset`. The range must
    /// lie within the file.
    pub fn patched(self, offset: u64, bytes: Vec<u8>) -> Self {
        Self {
            patch: Some(Arc::new(Patch { offset, bytes })),
            ..self
        }
    }

    pub fn size(&self) -> std::io::Result<u64> {
        Ok(std::fs::metadata(&self.path)?.len())
    }

    pub fn open(&self) -> std::io::Result<ImageReader> {
        Ok(ImageReader {
            file: std::fs::File::open(&self.path)?,
            patch: self.patch.clone(),
        })
    }
}

/// Reads an [`Image`], its patch included.
pub struct ImageReader {
    file: std::fs::File,
    patch: Option<Arc<Patch>>,
}

impl Read for ImageReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let Some(patch) = &self.patch else {
            return self.file.read(buf);
        };
        let position = self.file.stream_position()?;
        let end = patch.offset + patch.bytes.len() as u64;
        if position < patch.offset {
            // Stop where the patch starts
            let len = (patch.offset - position).min(buf.len() as u64) as usize;
            return self.file.read(&mut buf[..len]);
        }
        if position >= end {
            return self.file.read(buf);
        }
        let start = (position - patch.offset) as usize;
        let len = buf.len().min(patch.bytes.len() - start);
        buf[..len].copy_from_slice(&patch.bytes[start..start + len]);
        self.file.seek(SeekFrom::Current(len as i64))?;
        Ok(len)
    }
}

impl Seek for ImageReader {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(position)
    }
}

pub(super) fn normalize_serial(serial: Option<&str>) -> Option<String> {
    serial
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn check_identity(devices: &[BlockDevice], id: &str, expected: &ExpectedDevice) -> Result<()> {
    let Some(device) = devices
        .iter()
        .find(|device| device.id == id && expected.matches(device))
    else {
        return Err(Error::DeviceNotFound(
            "The selected drive changed or was disconnected. Select it again.".into(),
        ));
    };

    // The app only offers removable drives. Refuse anything else here too, so
    // a new caller or a regression in the app can never reach an internal disk.
    if !device.removable {
        return Err(Error::InvalidConfig(format!(
            "{id} is not a removable drive and cannot be overwritten"
        )));
    }
    Ok(())
}

/// The sector size every image is laid out for. The partition tables in the
/// images count in 512-byte sectors, so on a drive with larger sectors the
/// firmware looks for them in the wrong place.
const SUPPORTED_SECTOR_SIZE: u64 = 512;

/// Refuse a drive whose logical sectors aren't 512 bytes, before anything on
/// it is touched.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", test))]
fn ensure_supported_sector_size(sector_size: u64) -> Result<()> {
    if sector_size == SUPPORTED_SECTOR_SIZE {
        Ok(())
    } else {
        Err(Error::UnsupportedSectorSize(sector_size))
    }
}

/// Whether a media type/model string refers to an SD card. Matches "SD" as
/// its own word (plus SDHC/SDXC/microSD variants) so names like "Samsung
/// Portable SSD" don't count.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn mentions_sd_card(s: &str) -> bool {
    let s = s.to_lowercase();
    s.split(|c: char| !c.is_ascii_alphanumeric()).any(|token| {
        matches!(
            token,
            "sd" | "sdhc" | "sdxc" | "microsd" | "microsdhc" | "microsdxc"
        )
    })
}

/// Find an ASCII vendor name in a drive name, ignoring ASCII case, and return
/// its byte range in `name`.
///
/// Searching a lowercased copy instead hands back offsets into a string that
/// can differ in length from the original ("İ" grows when lowercased), and
/// slicing the original with those panics. An ASCII match can only land on
/// ASCII bytes, so the range is always on char boundaries of `name`.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn find_vendor(name: &str, vendor: &str) -> Option<std::ops::Range<usize>> {
    if vendor.is_empty() {
        return None;
    }

    name.as_bytes()
        .windows(vendor.len())
        .position(|window| window.eq_ignore_ascii_case(vendor.as_bytes()))
        .map(|start| start..start + vendor.len())
}

/// Raw OS error codes that mean the drive went away. The numbers differ per
/// OS: on Windows 6 is `ERROR_INVALID_HANDLE` and 19 `ERROR_WRITE_PROTECT`.
#[cfg(unix)]
const DISCONNECTED_OS_ERRORS: &[i32] = &[
    6,  // ENXIO: device not configured
    19, // ENODEV: no such device
];
#[cfg(windows)]
const DISCONNECTED_OS_ERRORS: &[i32] = &[
    21,   // ERROR_NOT_READY
    433,  // ERROR_NO_SUCH_DEVICE
    1167, // ERROR_DEVICE_NOT_CONNECTED
];

/// Check if an I/O error indicates the drive was disconnected
fn is_drive_disconnected(io_err: &std::io::Error) -> bool {
    matches!(
        io_err.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof
    ) || io_err
        .raw_os_error()
        .is_some_and(|code| DISCONNECTED_OS_ERRORS.contains(&code))
}

/// Check if an I/O error means the drive is write-protected, like an SD card
/// with its lock switch on.
fn is_write_protected(io_err: &std::io::Error) -> bool {
    // std gives EROFS and ERROR_WRITE_PROTECT this kind
    io_err.kind() == std::io::ErrorKind::ReadOnlyFilesystem
}

/// Map an I/O error from reading or writing the device onto an [`Error`]:
/// a disconnect and write protection get their own errors, so the user is
/// told what to do about them.
fn device_io_error(io_err: std::io::Error) -> Error {
    if is_drive_disconnected(&io_err) {
        Error::DriveDisconnected
    } else if is_write_protected(&io_err) {
        Error::WriteProtected
    } else if io_err.kind() == std::io::ErrorKind::PermissionDenied {
        // Something on this computer, like security software, refused access
        Error::Io(io_err)
    } else {
        Error::DriveIo(io_err)
    }
}

/// Check known capacity before any destructive disk operation.
pub fn ensure_image_fits(image_size: u64, drive_size: u64) -> Result<()> {
    if image_size > drive_size {
        return Err(Error::ImageTooLarge {
            written: 0,
            image_size,
            drive_size: Some(drive_size),
        });
    }
    Ok(())
}

// Also compiled in tests, which cover the Windows transfer on every platform
#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn device_write_error(error: std::io::Error, written: u64, image_size: u64) -> Error {
    if error.kind() == std::io::ErrorKind::StorageFull {
        Error::ImageTooLarge {
            written,
            image_size,
            drive_size: None,
        }
    } else {
        device_io_error(error)
    }
}

/// Send progress from a blocking disk worker. `run_with_progress` drops the
/// receiver when the user cancels, so a failed send means: stop here.
fn send_progress(
    progress: &std::sync::mpsc::Sender<FlashProgress>,
    update: FlashProgress,
) -> Result<()> {
    progress.send(update).map_err(|_| Error::Cancelled)
}

/// Drive a blocking task while forwarding its progress updates to the
/// callback, then drain updates buffered after the task finished (e.g. the
/// final "Write complete" / "Verification complete") so they aren't lost.
///
/// On cancel the receiver is dropped and the task stops at its next
/// `send_progress`. It is still awaited: the flash only ends once nothing
/// touches the drive anymore.
async fn run_with_progress<T, P: ProgressCallback>(
    handle: tokio::task::JoinHandle<Result<T>>,
    progress_rx: std::sync::mpsc::Receiver<FlashProgress>,
    progress_callback: &P,
) -> Result<T> {
    loop {
        if progress_callback.is_cancelled() {
            drop(progress_rx);
            return handle
                .await
                .map_err(|e| Error::Io(std::io::Error::other(e)))?;
        }

        match progress_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(update) => progress_callback.on_progress(update),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if handle.is_finished() {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    while let Ok(update) = progress_rx.try_recv() {
        progress_callback.on_progress(update);
    }

    handle
        .await
        .map_err(|e| Error::Io(std::io::Error::other(e)))?
}

/// Check for a stop before starting the next step. This asks the stop itself:
/// `run_with_progress` only looks every 100 ms, so a worker's progress update
/// can still get through right after one.
fn stop_if_requested<P: ProgressCallback>(progress_callback: &P) -> Result<()> {
    if progress_callback.is_cancelled() {
        return Err(Error::Cancelled);
    }
    Ok(())
}

/// List all block devices on the system
async fn list_devices() -> Result<Vec<BlockDevice>> {
    imp::list_devices().await
}

/// Write an image to a block device with progress updates
async fn write_image<P: ProgressCallback>(
    image: &Image,
    device_id: &str,
    expected: &ExpectedDevice,
    verify: bool,
    progress_callback: &P,
) -> Result<()> {
    image.size()?;

    imp::write_image(image, device_id, expected, verify, progress_callback).await
}

impl DeviceBackend for Backend {
    fn check_write_privileges(&self) -> Result<()> {
        #[cfg(target_os = "windows")]
        return windows_elevation::check_write_privileges();

        #[cfg(not(target_os = "windows"))]
        Ok(())
    }

    async fn list_devices(&self) -> Result<Vec<BlockDevice>> {
        list_devices().await
    }

    async fn write_image<P: ProgressCallback>(
        &self,
        image: &Image,
        device_id: &str,
        expected: &ExpectedDevice,
        verify: bool,
        progress_callback: &P,
    ) -> Result<()> {
        write_image(image, device_id, expected, verify, progress_callback).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usb_stick(removable: bool) -> BlockDevice {
        BlockDevice {
            id: "/dev/sdb".into(),
            name: "SanDisk Ultra".into(),
            size: 32_000_000_000,
            device_type: crate::types::DeviceType::UsbDrive,
            removable,
            model: Some("Ultra".into()),
            vendor: Some("SanDisk".into()),
            serial: None,
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
    fn identity_check_accepts_the_selected_removable_drive() {
        let stick = usb_stick(true);
        assert!(
            check_identity(std::slice::from_ref(&stick), "/dev/sdb", &expected(&stick)).is_ok()
        );
    }

    #[test]
    fn identity_check_refuses_a_drive_that_is_not_removable() {
        let disk = usb_stick(false);
        let error =
            check_identity(std::slice::from_ref(&disk), "/dev/sdb", &expected(&disk)).unwrap_err();
        assert!(matches!(error, Error::InvalidConfig(_)), "{error:?}");
    }

    #[test]
    fn identity_check_refuses_a_different_or_missing_drive() {
        let stick = usb_stick(true);
        let mut other = stick.clone();
        other.size += 1;
        for devices in [vec![other], vec![]] {
            let error = check_identity(&devices, "/dev/sdb", &expected(&stick)).unwrap_err();
            assert!(matches!(error, Error::DeviceNotFound(_)), "{error:?}");
        }
    }

    #[test]
    fn only_512_byte_sectors_are_supported() {
        assert!(ensure_supported_sector_size(512).is_ok());
        for size in [0, 4096, 1024, 2048] {
            assert!(matches!(
                ensure_supported_sector_size(size),
                Err(Error::UnsupportedSectorSize(reported)) if reported == size
            ));
        }
    }

    struct CancelledProgress;

    impl ProgressCallback for CancelledProgress {
        fn on_progress(&self, _progress: FlashProgress) {}

        fn is_cancelled(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn cancel_stops_the_worker_and_waits_for_it() {
        let (progress_tx, progress_rx) = std::sync::mpsc::channel();
        let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            // Keeps "writing" until a progress update has nowhere to go
            let result: Result<()> = loop {
                let update = FlashProgress::new(FlashStage::Writing, 0, 0, "Writing");
                if let Err(error) = send_progress(&progress_tx, update) {
                    break Err(error);
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            };
            stopped_tx.send(()).unwrap();
            result
        });

        let error = run_with_progress(worker, progress_rx, &CancelledProgress)
            .await
            .unwrap_err();

        assert!(matches!(error, Error::Cancelled), "{error:?}");
        // The worker was done before the flash reported back
        stopped_rx.try_recv().unwrap();
    }

    #[derive(Default)]
    struct Stoppable(std::sync::atomic::AtomicBool);

    impl ProgressCallback for Stoppable {
        fn on_progress(&self, _progress: FlashProgress) {}

        fn is_cancelled(&self) -> bool {
            self.0.load(std::sync::atomic::Ordering::Acquire)
        }
    }

    #[tokio::test]
    async fn a_stop_after_the_last_update_still_stops_the_next_step() {
        let (progress_tx, progress_rx) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let update = FlashProgress::new(FlashStage::Writing, 1, 1, "Write complete");
            send_progress(&progress_tx, update)?;
            Ok("device")
        });
        let progress = Stoppable::default();

        // The worker hands back what the next step needs
        let device = run_with_progress(worker, progress_rx, &progress)
            .await
            .unwrap();
        assert_eq!(device, "device");

        // Its update got through, so only the stop itself can tell
        progress.0.store(true, std::sync::atomic::Ordering::Release);
        let error = stop_if_requested(&progress).unwrap_err();
        assert!(matches!(error, Error::Cancelled), "{error:?}");
    }

    #[test]
    fn capacity_check_rejects_only_oversized_images() {
        ensure_image_fits(1024, 1024).unwrap();
        ensure_image_fits(512, 1024).unwrap();
        assert!(matches!(
            ensure_image_fits(2048, 1024),
            Err(Error::ImageTooLarge {
                written: 0,
                image_size: 2048,
                drive_size: Some(1024)
            })
        ));
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn test_mentions_sd_card_whole_word_variants() {
        for s in [
            "SD",
            "sd card",
            "SD Card Reader",
            "SDXC",
            "SDHC Card",
            "microSD",
            "microSDHC",
            "SanDisk Extreme microSDXC",
            "Generic-SD/MMC",
            "APPLE SD Card Reader Media",
        ] {
            assert!(mentions_sd_card(s), "{s:?} should be an SD card");
        }
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn test_mentions_sd_card_rejects_substrings() {
        for s in [
            "",
            "SSD",
            "Samsung Portable SSD T7",
            "USB Drive",
            "sdb",
            "sda1",
        ] {
            assert!(!mentions_sd_card(s), "{s:?} should not be an SD card");
        }
    }

    #[test]
    fn test_find_vendor_ignores_ascii_case() {
        assert_eq!(find_vendor("Ultra SANDISK", "SanDisk"), Some(6..13));
        assert_eq!(find_vendor("samsung evo", "Samsung"), Some(0..7));
        assert_eq!(find_vendor("Unknown Device", "SanDisk"), None);
        assert_eq!(find_vendor("SanDisk", ""), None);
    }

    #[test]
    fn test_find_vendor_returns_ranges_into_the_original_name() {
        // Lowercasing changes the byte length of these names, so offsets
        // taken from a lowercased copy would point at the wrong bytes.
        let name = "İSanDisk Ultra";
        let found = find_vendor(name, "SanDisk").unwrap();
        assert_eq!(&name[found], "SanDisk");

        assert_eq!(
            find_vendor("\u{212A}ingston DataTraveler", "Kingston"),
            None
        );
    }

    #[test]
    fn device_io_errors_are_classified() {
        use std::io::{Error as IoError, ErrorKind};

        let kind = IoError::from;
        let os = IoError::from_raw_os_error;
        let mut cases = vec![
            (kind(ErrorKind::NotFound), "disconnected"),
            (kind(ErrorKind::BrokenPipe), "disconnected"),
            (kind(ErrorKind::UnexpectedEof), "disconnected"),
            (kind(ErrorKind::ReadOnlyFilesystem), "write-protected"),
            (kind(ErrorKind::StorageFull), "full"),
            (kind(ErrorKind::PermissionDenied), "io"),
            (IoError::other("unknown"), "drive"),
        ];
        #[cfg(unix)]
        cases.extend([
            (os(6), "disconnected"),     // ENXIO
            (os(19), "disconnected"),    // ENODEV
            (os(30), "write-protected"), // EROFS
            (os(28), "full"),            // ENOSPC
            (os(5), "drive"),            // EIO
            (os(1), "io"),               // EPERM
        ]);
        // The Unix numbers mean something else on Windows: 6 is
        // ERROR_INVALID_HANDLE and 19 ERROR_WRITE_PROTECT, a locked SD card.
        #[cfg(windows)]
        cases.extend([
            (os(21), "disconnected"),   // ERROR_NOT_READY
            (os(433), "disconnected"),  // ERROR_NO_SUCH_DEVICE
            (os(1167), "disconnected"), // ERROR_DEVICE_NOT_CONNECTED
            (os(1), "drive"),           // ERROR_INVALID_FUNCTION
            (os(6), "drive"),
            (os(19), "write-protected"),
            (os(39), "full"),    // ERROR_HANDLE_DISK_FULL
            (os(112), "full"),   // ERROR_DISK_FULL
            (os(23), "drive"),   // ERROR_CRC
            (os(31), "drive"),   // ERROR_GEN_FAILURE
            (os(121), "drive"),  // ERROR_SEM_TIMEOUT
            (os(1117), "drive"), // ERROR_IO_DEVICE
        ]);

        for (error, expected) in cases {
            let case = format!("{error:?}");
            let classified = match device_write_error(error, 10, 20) {
                Error::DriveDisconnected => "disconnected",
                Error::WriteProtected => "write-protected",
                Error::ImageTooLarge {
                    written: 10,
                    image_size: 20,
                    drive_size: None,
                } => "full",
                Error::DriveIo(_) => "drive",
                Error::Io(_) => "io",
                other => panic!("{case}: {other:?}"),
            };
            assert_eq!(classified, expected, "{case}");
        }
    }

    #[tokio::test]
    async fn test_list_devices_succeeds() {
        // Smoke test: the real platform enumeration runs and succeeds.
        assert!(list_devices().await.is_ok());
    }

    #[tokio::test]
    async fn test_write_image_nonexistent_image() {
        // The image metadata check runs before any platform code, so a
        // missing image surfaces as Io and the device id is never touched.
        let result = write_image(
            &Image::new("/nonexistent/image/file.img"),
            "unused-device-id",
            &ExpectedDevice::default(),
            false,
            &crate::NoOpProgress,
        )
        .await;
        assert!(matches!(result.unwrap_err(), Error::Io(_)));
    }
}
