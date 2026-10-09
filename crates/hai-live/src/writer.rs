//! Erases old signatures and writes the decompressed HAOS image to the target disk.

use std::cell::Cell;
use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::rc::Rc;

/// Zeroed at both ends of the disk. Covers GPT headers, RAID and ZFS labels near the end.
const WIPE_BYTES: u64 = 4 * 1024 * 1024;
const BUFFER_BYTES: usize = 4 * 1024 * 1024;

/// Opens a whole disk for writing. On Linux this fails if the disk is mounted or in use.
pub fn open_disk(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_EXCL);
    }
    options.open(path)
}

/// Whether the opened `disk` is still the block device that `path` points to now.
#[cfg(unix)]
pub fn is_same_device(disk: &File, path: &Path) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    match (disk.metadata(), std::fs::metadata(path)) {
        (Ok(opened), Ok(current)) => {
            opened.file_type().is_block_device() && opened.rdev() == current.rdev()
        }
        _ => false,
    }
}

/// hai-live only runs on Linux; elsewhere nothing is ever confirmed.
#[cfg(not(unix))]
pub fn is_same_device(_disk: &File, _path: &Path) -> bool {
    false
}

/// Zeroes the start and end of `disk` (old partition tables and signatures can break HAOS's
/// first-boot resize), then writes the decompressed `image_xz` from the start.
///
/// `progress(compressed_read, compressed_total, written)` is called about every 64 MiB.
/// Returns the number of image bytes written.
pub fn write_image<D: Write + Seek>(
    image_xz: &Path,
    disk: &mut D,
    disk_size: u64,
    progress: &mut dyn FnMut(u64, u64, u64),
) -> io::Result<u64> {
    // Open the source first, so a vanished stick never leaves a wiped disk behind.
    let file = File::open(image_xz)?;
    let compressed_total = file.metadata()?.len();

    wipe_ends(disk, disk_size)?;
    disk.seek(SeekFrom::Start(0))?;

    let compressed_read = Rc::new(Cell::new(0));
    let mut input = BufReader::with_capacity(
        BUFFER_BYTES,
        CountingReader {
            inner: file,
            count: compressed_read.clone(),
        },
    );
    let mut output = ProgressWriter {
        inner: BufWriter::with_capacity(BUFFER_BYTES, &mut *disk),
        written: 0,
        next_report: 0,
        report: &mut |written| progress(compressed_read.get(), compressed_total, written),
    };
    lzma_rs::xz_decompress(&mut input, &mut output)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    let written = output.written;
    output.inner.flush()?;
    Ok(written)
}

fn wipe_ends<D: Write + Seek>(disk: &mut D, disk_size: u64) -> io::Result<()> {
    let wipe = WIPE_BYTES.min(disk_size);
    let zeros = vec![0u8; wipe as usize];
    disk.seek(SeekFrom::Start(0))?;
    disk.write_all(&zeros)?;
    disk.seek(SeekFrom::Start(disk_size - wipe))?;
    disk.write_all(&zeros)?;
    disk.flush()
}

struct CountingReader<R> {
    inner: R,
    count: Rc<Cell<u64>>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.count.set(self.count.get() + read as u64);
        Ok(read)
    }
}

struct ProgressWriter<'a, W> {
    inner: W,
    written: u64,
    next_report: u64,
    report: &'a mut dyn FnMut(u64),
}

impl<W: Write> Write for ProgressWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        if self.written >= self.next_report {
            (self.report)(self.written);
            self.next_report = self.written + 64 * 1024 * 1024;
        }
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_files_are_never_the_same_device() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(!is_same_device(file.as_file(), file.path()));
    }
    use std::io::Cursor;

    fn xz(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        lzma_rs::xz_compress(&mut &data[..], &mut out).unwrap();
        out
    }

    #[test]
    fn writes_image_at_start_and_wipes_the_end() {
        const MIB: usize = 1024 * 1024;
        let dir = tempfile::tempdir().unwrap();
        let image: Vec<u8> = (0..MIB).map(|i| (i % 251) as u8).collect();
        let image_xz = dir.path().join("haos.img.xz");
        std::fs::write(&image_xz, xz(&image)).unwrap();

        let disk_size = 16 * MIB;
        let mut disk = Cursor::new(vec![0xffu8; disk_size]);
        let mut reports = 0;
        let written = write_image(&image_xz, &mut disk, disk_size as u64, &mut |_, _, _| {
            reports += 1
        })
        .unwrap();
        let disk = disk.into_inner();

        assert_eq!(written, MIB as u64);
        assert!(reports > 0);
        assert_eq!(&disk[..MIB], &image[..]);
        // Rest of the start wipe stays zero, the middle is untouched, the end is zeroed.
        assert!(disk[MIB..4 * MIB].iter().all(|&b| b == 0));
        assert!(disk[4 * MIB..12 * MIB].iter().all(|&b| b == 0xff));
        assert!(disk[12 * MIB..].iter().all(|&b| b == 0));
    }

    #[test]
    fn rejects_files_that_are_not_xz() {
        let dir = tempfile::tempdir().unwrap();
        let image_xz = dir.path().join("bad.img.xz");
        let mut data = xz(&[7u8; 4096]);
        data[0] ^= 0xff;
        std::fs::write(&image_xz, data).unwrap();
        let mut disk = Cursor::new(vec![0u8; 8 * 1024 * 1024]);
        assert!(write_image(&image_xz, &mut disk, 8 * 1024 * 1024, &mut |_, _, _| {}).is_err());
    }

    #[test]
    fn missing_image_leaves_the_disk_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let disk_size = 16 * 1024 * 1024;
        let mut disk = Cursor::new(vec![0xffu8; disk_size]);
        let missing = dir.path().join("gone.img.xz");
        assert!(write_image(&missing, &mut disk, disk_size as u64, &mut |_, _, _| {}).is_err());
        assert!(disk.get_ref().iter().all(|&b| b == 0xff));
    }

    /// Decompression speed on real HAOS: set `HAOS_XZ` to the cached `.img.xz` and run
    /// `cargo test --release -p hai-live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn decompression_speed() {
        let path = std::env::var("HAOS_XZ").expect("set HAOS_XZ");
        let start = std::time::Instant::now();
        let mut input = BufReader::with_capacity(BUFFER_BYTES, File::open(path).unwrap());
        let mut sink = Counting(0);
        lzma_rs::xz_decompress(&mut input, &mut sink).unwrap();
        let secs = start.elapsed().as_secs_f64();
        println!(
            "decompressed {:.2} GB in {secs:.0} s ({:.0} MB/s)",
            sink.0 as f64 / 1e9,
            sink.0 as f64 / 1e6 / secs
        );
    }

    struct Counting(u64);
    impl Write for Counting {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0 += buf.len() as u64;
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
