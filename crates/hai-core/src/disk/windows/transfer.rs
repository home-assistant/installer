//! Keep the new partition table unpublished until the image body is complete.

use super::*;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::mpsc::Sender;

const METADATA_SIZE: usize = 1024 * 1024;

pub(super) trait DiskIo: Read + Write + Seek {
    fn sync_all(&mut self) -> std::io::Result<()>;
}

pub(super) fn validate_sizes(image_size: u64, disk_size: u64) -> Result<()> {
    if image_size > disk_size {
        return Err(Error::ImageTooLarge {
            written: 0,
            image_size,
        });
    }
    if image_size == 0 || disk_size < 2 * METADATA_SIZE as u64 {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid image or target disk size",
        )));
    }
    Ok(())
}

pub(super) fn with_volume_locks<D, V>(
    device: &mut D,
    volumes: Vec<V>,
    transfer: impl FnOnce(&mut D) -> Result<()>,
    refresh: impl FnOnce(&D) -> Result<()>,
) -> Result<()> {
    let result = transfer(device);
    drop(volumes);
    // Even a failed transfer can have erased the old layout. Refresh after
    // releasing its locks, but preserve the original failure if both fail.
    let refreshed = refresh(device);
    result.and(refreshed)
}

impl DiskIo for File {
    fn sync_all(&mut self) -> std::io::Result<()> {
        File::sync_all(self)
    }
}

pub(super) fn transfer(
    source: &mut File,
    device: &mut impl DiskIo,
    image_size: u64,
    disk_size: u64,
    verify: bool,
    progress: &Sender<FlashProgress>,
) -> Result<()> {
    validate_sizes(image_size, disk_size)?;
    let prefix_size = image_size.min(METADATA_SIZE as u64) as usize;
    let mut prefix = vec![0; prefix_size];
    source.read_exact(&mut prefix)?;

    // MSFT_Disk.Clear zeroes the first and last MiB. Do the same through our
    // retained handle: Clear-Disk's separate process cannot own our locks.
    let zeros = vec![0; METADATA_SIZE];
    device
        .seek(SeekFrom::Start(disk_size - METADATA_SIZE as u64))
        .map_err(device_io_error)?;
    device.write_all(&zeros).map_err(device_io_error)?;
    device.rewind().map_err(device_io_error)?;
    device.write_all(&zeros).map_err(device_io_error)?;
    device.sync_all().map_err(device_io_error)?;

    // Like Etcher's Windows writer, publish the first buffer last so new
    // partitions cannot mount during the body write. Old volumes stay locked.
    device
        .seek(SeekFrom::Start(prefix_size as u64))
        .map_err(device_io_error)?;
    let mut buffer = vec![0; WRITE_BUFFER_SIZE];
    let mut written = 0;
    let mut last_progress = 0;
    let body_size = image_size - prefix_size as u64;
    while written < body_size {
        let count = (body_size - written).min(buffer.len() as u64) as usize;
        source.read_exact(&mut buffer[..count])?;
        device
            .write_all(&buffer[..count])
            .map_err(device_io_error)?;
        written += count as u64;
        if written - last_progress >= PROGRESS_UPDATE_INTERVAL {
            last_progress = written;
            let _ = progress.send(FlashProgress::new(
                FlashStage::Writing,
                written,
                image_size,
                "Writing image to device...",
            ));
        }
    }
    device.sync_all().map_err(device_io_error)?;

    if verify {
        let _ = progress.send(FlashProgress::new(
            FlashStage::Verifying,
            0,
            image_size,
            "Verifying written data...",
        ));
        verify_body(source, device, prefix_size as u64, image_size, progress)
            .map_err(verification_error)?;
    }

    device.rewind().map_err(device_io_error)?;
    device.write_all(&prefix).map_err(device_io_error)?;
    device.sync_all().map_err(device_io_error)?;
    if verify {
        device
            .rewind()
            .map_err(device_io_error)
            .map_err(verification_error)?;
        let mut actual = vec![0; prefix_size];
        device
            .read_exact(&mut actual)
            .map_err(device_io_error)
            .map_err(verification_error)?;
        if actual != prefix {
            return Err(Error::VerificationFailed(
                "Data mismatch during verification".into(),
            ));
        }
    }
    let _ = progress.send(FlashProgress::new(
        if verify {
            FlashStage::Verifying
        } else {
            FlashStage::Writing
        },
        image_size,
        image_size,
        if verify {
            "Verification complete"
        } else {
            "Write complete"
        },
    ));
    Ok(())
}

fn verification_error(error: Error) -> Error {
    match error {
        Error::VerificationFailed(_) | Error::DriveDisconnected => error,
        other => Error::VerificationFailed(other.to_string()),
    }
}

fn verify_body(
    source: &mut File,
    device: &mut impl DiskIo,
    offset: u64,
    image_size: u64,
    progress: &Sender<FlashProgress>,
) -> Result<()> {
    source.seek(SeekFrom::Start(offset))?;
    device
        .seek(SeekFrom::Start(offset))
        .map_err(device_io_error)?;
    let mut expected = vec![0; WRITE_BUFFER_SIZE];
    let mut actual = vec![0; WRITE_BUFFER_SIZE];
    let mut verified = 0;
    let mut last_progress = 0;
    while verified < image_size - offset {
        let count = (image_size - offset - verified).min(expected.len() as u64) as usize;
        source.read_exact(&mut expected[..count])?;
        device
            .read_exact(&mut actual[..count])
            .map_err(device_io_error)?;
        if expected[..count] != actual[..count] {
            return Err(Error::VerificationFailed(
                "Data mismatch during verification".into(),
            ));
        }
        verified += count as u64;
        if verified - last_progress >= PROGRESS_UPDATE_INTERVAL {
            last_progress = verified;
            let _ = progress.send(FlashProgress::new(
                FlashStage::Verifying,
                verified,
                image_size,
                "Verifying written data...",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::{self, Cursor};

    #[test]
    fn retains_locks_through_transfer_and_refreshes_after_release_on_every_result() {
        struct Lock<'a>(&'a Cell<bool>);
        impl Drop for Lock<'_> {
            fn drop(&mut self) {
                self.0.set(false);
            }
        }
        for transfer_fails in [false, true] {
            for refresh_fails in [false, true] {
                let held = Cell::new(true);
                let refreshed = Cell::new(false);
                let result = with_volume_locks(
                    &mut (),
                    vec![Lock(&held)],
                    |_| {
                        assert!(held.get());
                        if transfer_fails {
                            Err(Error::WriteProtected)
                        } else {
                            Ok(())
                        }
                    },
                    |_| {
                        assert!(!held.get());
                        refreshed.set(true);
                        if refresh_fails {
                            Err(Error::DriveDisconnected)
                        } else {
                            Ok(())
                        }
                    },
                );
                assert!(refreshed.get());
                if transfer_fails {
                    assert!(matches!(result, Err(Error::WriteProtected)));
                } else if refresh_fails {
                    assert!(matches!(result, Err(Error::DriveDisconnected)));
                } else {
                    assert!(result.is_ok());
                }
            }
        }
    }

    struct Disk {
        bytes: Cursor<Vec<u8>>,
        events: Vec<(&'static str, u64)>,
        corrupt_read_at: Option<u64>,
        fail_write_at: Option<u64>,
        fail_sync: Option<usize>,
        syncs: usize,
    }

    impl Disk {
        fn new() -> Self {
            Self {
                bytes: Cursor::new(vec![0xaa; 4 * METADATA_SIZE]),
                events: Vec::new(),
                corrupt_read_at: None,
                fail_write_at: None,
                fail_sync: None,
                syncs: 0,
            }
        }
    }

    impl Read for Disk {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let offset = self.bytes.position();
            self.events.push(("read", offset));
            let count = self.bytes.read(buf)?;
            if self.corrupt_read_at == Some(offset) && count > 0 {
                buf[0] ^= 1;
            }
            Ok(count)
        }
    }

    impl Write for Disk {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let offset = self.bytes.position();
            if self.fail_write_at == Some(offset) {
                return Err(io::ErrorKind::ReadOnlyFilesystem.into());
            }
            self.events.push(("write", offset));
            self.bytes.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Seek for Disk {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.bytes.seek(pos)
        }
    }

    impl DiskIo for Disk {
        fn sync_all(&mut self) -> io::Result<()> {
            self.syncs += 1;
            self.events.push(("sync", self.bytes.position()));
            if self.fail_sync == Some(self.syncs) {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            Ok(())
        }
    }

    fn source(size: usize) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&vec![0x42; size]).unwrap();
        file.rewind().unwrap();
        file
    }

    #[test]
    fn publishes_prefix_after_body_flush_and_verification() {
        let mut image = source(2 * METADATA_SIZE + 512);
        let mut disk = Disk::new();
        let (tx, rx) = std::sync::mpsc::channel();
        transfer(
            image.as_file_mut(),
            &mut disk,
            (2 * METADATA_SIZE + 512) as u64,
            (4 * METADATA_SIZE) as u64,
            true,
            &tx,
        )
        .unwrap();
        assert_eq!(
            &disk.bytes.get_ref()[..2 * METADATA_SIZE + 512],
            vec![0x42; 2 * METADATA_SIZE + 512]
        );
        assert!(disk.bytes.get_ref()[3 * METADATA_SIZE..]
            .iter()
            .all(|&b| b == 0));
        assert_eq!(
            disk.events
                .iter()
                .map(|&(event, offset)| (event, offset))
                .collect::<Vec<_>>(),
            vec![
                ("write", (3 * METADATA_SIZE) as u64),
                ("write", 0),
                ("sync", METADATA_SIZE as u64),
                ("write", METADATA_SIZE as u64),
                ("sync", (2 * METADATA_SIZE + 512) as u64),
                ("read", METADATA_SIZE as u64),
                ("write", 0),
                ("sync", METADATA_SIZE as u64),
                ("read", 0),
            ]
        );
        let progress: Vec<_> = rx.try_iter().collect();
        assert_eq!(progress.last().unwrap().stage, FlashStage::Verifying);
    }

    #[test]
    fn body_failures_leave_prefix_unpublished() {
        for failure in 0..3 {
            let mut image = source(2 * METADATA_SIZE);
            let mut disk = Disk::new();
            match failure {
                0 => disk.fail_write_at = Some(METADATA_SIZE as u64),
                1 => disk.fail_sync = Some(2),
                _ => disk.corrupt_read_at = Some(METADATA_SIZE as u64),
            }
            let (tx, _) = std::sync::mpsc::channel();
            let error = transfer(
                image.as_file_mut(),
                &mut disk,
                (2 * METADATA_SIZE) as u64,
                (4 * METADATA_SIZE) as u64,
                true,
                &tx,
            )
            .unwrap_err();
            assert!(disk.bytes.get_ref()[..METADATA_SIZE]
                .iter()
                .all(|&b| b == 0));
            match failure {
                0 => assert!(matches!(error, Error::WriteProtected)),
                1 => assert!(matches!(error, Error::DriveDisconnected)),
                _ => assert!(matches!(error, Error::VerificationFailed(_))),
            }
        }
    }

    #[test]
    fn verifies_published_prefix_and_propagates_its_flush_failure() {
        for flush_failure in [false, true] {
            let mut image = source(2 * METADATA_SIZE);
            let mut disk = Disk::new();
            if flush_failure {
                disk.fail_sync = Some(3);
            } else {
                disk.corrupt_read_at = Some(0);
            }
            let (tx, _) = std::sync::mpsc::channel();
            let error = transfer(
                image.as_file_mut(),
                &mut disk,
                (2 * METADATA_SIZE) as u64,
                (4 * METADATA_SIZE) as u64,
                true,
                &tx,
            )
            .unwrap_err();
            if flush_failure {
                assert!(matches!(error, Error::DriveDisconnected));
            } else {
                assert!(matches!(error, Error::VerificationFailed(_)));
            }
        }
    }

    #[test]
    fn oversized_image_fails_before_touching_the_disk() {
        let mut image = source(512);
        let mut disk = Disk::new();
        let disk_size = disk.bytes.get_ref().len() as u64;
        let image_size = disk_size + 1;
        let (tx, _) = std::sync::mpsc::channel();
        let error = transfer(
            image.as_file_mut(),
            &mut disk,
            image_size,
            disk_size,
            true,
            &tx,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            Error::ImageTooLarge { written: 0, image_size: size } if size == image_size
        ));
        assert!(disk.events.is_empty());
        assert!(disk.bytes.get_ref().iter().all(|&byte| byte == 0xaa));
    }

    #[test]
    fn invalid_sizes_and_unreadable_prefix_fail_before_writes() {
        for (size, disk_size) in [
            (0, 4 * METADATA_SIZE),
            (5 * METADATA_SIZE, 4 * METADATA_SIZE),
            (512, 512),
            (2 * METADATA_SIZE, 4 * METADATA_SIZE),
        ] {
            let mut image = source(512);
            let mut disk = Disk::new();
            let (tx, _) = std::sync::mpsc::channel();
            assert!(transfer(
                image.as_file_mut(),
                &mut disk,
                size as u64,
                disk_size as u64,
                false,
                &tx
            )
            .is_err());
            assert!(disk.events.is_empty());
        }
    }

    #[test]
    fn writes_without_verification_and_handles_prefix_only_image() {
        for size in [512, 2 * METADATA_SIZE + 512] {
            let mut image = source(size);
            let mut disk = Disk::new();
            let (tx, _) = std::sync::mpsc::channel();
            transfer(
                image.as_file_mut(),
                &mut disk,
                size as u64,
                (4 * METADATA_SIZE) as u64,
                false,
                &tx,
            )
            .unwrap();
            assert_eq!(&disk.bytes.get_ref()[..size], vec![0x42; size]);
            assert!(!disk.events.iter().any(|&(event, _)| event == "read"));
        }
    }

    #[test]
    fn image_replaces_cleared_tail_at_and_near_disk_capacity() {
        for size in [4 * METADATA_SIZE - 512, 4 * METADATA_SIZE] {
            let mut image = source(size);
            let mut disk = Disk::new();
            let (tx, _) = std::sync::mpsc::channel();
            transfer(
                image.as_file_mut(),
                &mut disk,
                size as u64,
                (4 * METADATA_SIZE) as u64,
                true,
                &tx,
            )
            .unwrap();
            assert_eq!(&disk.bytes.get_ref()[..size], vec![0x42; size]);
            assert!(disk.bytes.get_ref()[size..].iter().all(|&byte| byte == 0));
        }
    }

    #[test]
    fn progress_does_not_count_the_unpublished_prefix() {
        let size = 12 * METADATA_SIZE;
        let mut image = source(size);
        let mut disk = Disk::new();
        let (tx, rx) = std::sync::mpsc::channel();
        transfer(
            image.as_file_mut(),
            &mut disk,
            size as u64,
            (14 * METADATA_SIZE) as u64,
            true,
            &tx,
        )
        .unwrap();
        let updates: Vec<_> = rx.try_iter().collect();
        let writing = updates
            .iter()
            .find(|update| update.stage == FlashStage::Writing)
            .unwrap();
        assert_eq!(writing.bytes_processed, (size - METADATA_SIZE) as u64);
        let verifying: Vec<_> = updates
            .iter()
            .filter(|update| update.stage == FlashStage::Verifying)
            .collect();
        assert_eq!(verifying[1].bytes_processed, (size - METADATA_SIZE) as u64);
        assert_eq!(verifying.last().unwrap().bytes_processed, size as u64);
        assert!(updates
            .iter()
            .all(|update| update.bytes_processed <= update.total_bytes));
    }
}
