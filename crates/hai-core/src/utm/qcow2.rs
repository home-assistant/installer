//! Growing the virtual size of a qcow2 image in place.
//!
//! UTM ignores `guest size` for a drive imported from a `source` file, and
//! its own `qemu-img` is an embedded framework we can't call. So the image
//! is grown before UTM imports it, while it is still our own temporary file.
//!
//! Only the header and the L1 table change. The extra L1 entries must fit in
//! the clusters the table already occupies, so no cluster is allocated and
//! the refcounts stay valid. HAOS images use 64 KiB clusters, where one L1
//! cluster covers 4 TiB.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::error::{Error, Result};

const MAGIC: &[u8; 4] = b"QFI\xfb";
const SIZE_OFFSET: u64 = 24;
const HEADER_V2_LENGTH: usize = 72;
const HEADER_V3_LENGTH: usize = 104;

/// The only incompatible feature we accept: the compression type, which only
/// affects how compressed clusters are read. Dirty, corrupt, external data
/// file and extended L2 images are refused.
const INCOMPATIBLE_COMPRESSION_TYPE: u64 = 1 << 3;

/// Grow the virtual size of the qcow2 image at `path` to `size_bytes`.
///
/// An image that is already at least that large is left alone: shrinking
/// would throw away data.
pub fn grow(path: &Path, size_bytes: u64) -> Result<()> {
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let header = Header::read(&mut file)?;

    if size_bytes <= header.size {
        return Ok(());
    }

    let l1_size = header.l1_entries_for(size_bytes)?;
    if l1_size > header.l1_capacity() {
        return Err(invalid_image(format!(
            "it can't be grown to {size_bytes} bytes without moving its L1 table"
        )));
    }

    // Unused bytes behind the L1 table are not guaranteed to be zero. They
    // become entries now, and a zero entry means "not allocated".
    let used_bytes = u64::from(header.l1_size) * 8;
    let new_bytes = (u64::from(l1_size) - u64::from(header.l1_size)) * 8;
    file.seek(SeekFrom::Start(header.l1_table_offset + used_bytes))?;
    file.write_all(&vec![0; new_bytes as usize])?;
    file.sync_data()?;

    // Size, crypt method and L1 size are adjacent, so one write switches
    // the image to its new size.
    let mut fields = [0u8; 16];
    fields[..8].copy_from_slice(&size_bytes.to_be_bytes());
    fields[12..].copy_from_slice(&l1_size.to_be_bytes());
    file.seek(SeekFrom::Start(SIZE_OFFSET))?;
    file.write_all(&fields)?;
    file.sync_data()?;

    Ok(())
}

/// The parts of a qcow2 header that decide how far the image can grow.
struct Header {
    cluster_bits: u32,
    size: u64,
    l1_size: u32,
    l1_table_offset: u64,
}

impl Header {
    fn read(file: &mut File) -> Result<Self> {
        let mut bytes = [0u8; HEADER_V3_LENGTH];
        read_header_bytes(file, &mut bytes[..HEADER_V2_LENGTH])?;

        if &bytes[0..4] != MAGIC {
            return Err(invalid_image("it isn't a qcow2 image".to_string()));
        }

        let version = be_u32(&bytes, 4);
        match version {
            2 => {}
            3 => {
                read_header_bytes(file, &mut bytes[HEADER_V2_LENGTH..])?;
                let incompatible = be_u64(&bytes, 72);
                if incompatible & !INCOMPATIBLE_COMPRESSION_TYPE != 0 {
                    return Err(invalid_image(format!(
                        "it uses unsupported qcow2 features ({incompatible:#x})"
                    )));
                }
            }
            _ => {
                return Err(invalid_image(format!(
                    "qcow2 version {version} isn't supported"
                )));
            }
        }

        // An encrypted or snapshotted image keeps state elsewhere that a
        // resize would have to touch as well. HAOS ships neither.
        if be_u32(&bytes, 32) != 0 {
            return Err(invalid_image("it is encrypted".to_string()));
        }
        if be_u32(&bytes, 60) != 0 {
            return Err(invalid_image("it contains snapshots".to_string()));
        }

        let cluster_bits = be_u32(&bytes, 20);
        if !(9..=21).contains(&cluster_bits) {
            return Err(invalid_image(format!(
                "its cluster size (2^{cluster_bits}) is invalid"
            )));
        }

        let header = Self {
            cluster_bits,
            size: be_u64(&bytes, SIZE_OFFSET as usize),
            l1_size: be_u32(&bytes, 36),
            l1_table_offset: be_u64(&bytes, 40),
        };
        if header.l1_table_offset == 0
            || !header.l1_table_offset.is_multiple_of(header.cluster_size())
        {
            return Err(invalid_image("its L1 table offset is invalid".to_string()));
        }
        if header.l1_size < header.l1_entries_for(header.size)? {
            return Err(invalid_image(
                "its L1 table is too small for its size".to_string(),
            ));
        }

        Ok(header)
    }

    fn cluster_size(&self) -> u64 {
        1 << self.cluster_bits
    }

    /// Number of L1 entries needed to address `size_bytes`. Each entry points
    /// to an L2 table of one cluster holding 8-byte entries.
    fn l1_entries_for(&self, size_bytes: u64) -> Result<u32> {
        let bytes_per_l1_entry = self.cluster_size() * (self.cluster_size() / 8);
        u32::try_from(size_bytes.div_ceil(bytes_per_l1_entry))
            .map_err(|_| invalid_image(format!("{size_bytes} bytes is too large")))
    }

    /// Number of L1 entries that fit in the clusters the table occupies.
    fn l1_capacity(&self) -> u32 {
        let entries_per_cluster = self.cluster_size() / 8;
        let clusters = u64::from(self.l1_size).div_ceil(entries_per_cluster).max(1);
        u32::try_from(clusters * entries_per_cluster).unwrap_or(u32::MAX)
    }
}

/// A file too short to hold a header is not a qcow2 image, not an I/O failure.
fn read_header_bytes(file: &mut File, bytes: &mut [u8]) -> Result<()> {
    file.read_exact(bytes).map_err(|error| match error.kind() {
        std::io::ErrorKind::UnexpectedEof => invalid_image("it isn't a qcow2 image".to_string()),
        _ => error.into(),
    })
}

fn invalid_image(reason: String) -> Error {
    Error::Utm(format!(
        "Could not set the disk size of the virtual machine image: {reason}"
    ))
}

fn be_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn be_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;
    const CLUSTER: u64 = 64 * 1024;

    /// The layout of a HAOS 18.3 image: version 3, 64 KiB clusters, 32 GiB,
    /// and a 64-entry L1 table at 192 KiB in a cluster of its own.
    fn haos_like_header() -> Vec<u8> {
        let mut header = vec![0u8; HEADER_V3_LENGTH];
        header[0..4].copy_from_slice(MAGIC);
        header[4..8].copy_from_slice(&3u32.to_be_bytes());
        header[20..24].copy_from_slice(&16u32.to_be_bytes());
        header[24..32].copy_from_slice(&(32 * GIB).to_be_bytes());
        header[36..40].copy_from_slice(&64u32.to_be_bytes());
        header[40..48].copy_from_slice(&(3 * CLUSTER).to_be_bytes());
        header[96..100].copy_from_slice(&4u32.to_be_bytes());
        header[100..104].copy_from_slice(&(HEADER_V3_LENGTH as u32).to_be_bytes());
        header
    }

    fn image_with(header: &[u8]) -> (tempfile::TempDir, std::path::PathBuf, Vec<u8>) {
        let mut image = vec![0u8; 4 * CLUSTER as usize];
        image[..header.len()].copy_from_slice(header);

        // Allocated L1 entries, then leftovers behind the table that must
        // not turn into L2 pointers.
        let l1 = 3 * CLUSTER as usize;
        for entry in 0..64 {
            image[l1 + entry * 8..l1 + entry * 8 + 8]
                .copy_from_slice(&(0x8000_0000_0000_0000u64 | (entry as u64 + 1)).to_be_bytes());
        }
        image[l1 + 64 * 8..l1 + 200 * 8].fill(0xaa);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("haos.qcow2");
        std::fs::write(&path, &image).unwrap();
        (dir, path, image)
    }

    fn read_header(path: &Path) -> Header {
        Header::read(&mut File::open(path).unwrap()).unwrap()
    }

    #[test]
    fn grows_the_size_and_l1_table_in_place() {
        let (_dir, path, before) = image_with(&haos_like_header());

        grow(&path, 512 * GIB).unwrap();

        let header = read_header(&path);
        assert_eq!(header.size, 512 * GIB);
        assert_eq!(header.l1_size, 1024);

        // Only the size, the L1 size and the new L1 entries changed.
        let after = std::fs::read(&path).unwrap();
        let l1_used_end = 3 * CLUSTER as usize + 64 * 8;
        let l1_new_end = 3 * CLUSTER as usize + 1024 * 8;
        assert_eq!(after.len(), before.len(), "no cluster was added");
        assert_eq!(after[..24], before[..24]);
        assert_eq!(after[40..l1_used_end], before[40..l1_used_end]);
        assert!(after[l1_used_end..l1_new_end].iter().all(|&byte| byte == 0));
        assert_eq!(after[l1_new_end..], before[l1_new_end..]);
    }

    #[test]
    fn never_shrinks() {
        let (_dir, path, before) = image_with(&haos_like_header());

        grow(&path, 32 * GIB).unwrap();
        grow(&path, 16 * GIB).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_size_needing_a_larger_l1_table_is_refused() {
        let (_dir, path, before) = image_with(&haos_like_header());

        let error = grow(&path, 8 * 1024 * GIB).unwrap_err();

        assert!(error.to_string().contains("L1 table"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn unsupported_images_are_refused_untouched() {
        type Corruption = fn(&mut Vec<u8>);
        let cases: [(&str, Corruption); 6] = [
            ("not qcow2", |header| header[0] = b'X'),
            ("version 4", |header| {
                header[4..8].copy_from_slice(&4u32.to_be_bytes())
            }),
            ("dirty", |header| header[79] = 1),
            ("encrypted", |header| {
                header[32..36].copy_from_slice(&1u32.to_be_bytes())
            }),
            ("snapshots", |header| {
                header[60..64].copy_from_slice(&1u32.to_be_bytes())
            }),
            ("L1 too small", |header| {
                header[36..40].copy_from_slice(&1u32.to_be_bytes())
            }),
        ];

        for (name, corrupt) in cases {
            let mut header = haos_like_header();
            corrupt(&mut header);
            let (_dir, path, before) = image_with(&header);

            assert!(grow(&path, 64 * GIB).is_err(), "{name}");
            assert_eq!(std::fs::read(&path).unwrap(), before, "{name}");
        }
    }

    #[test]
    fn a_truncated_file_is_not_a_qcow2_image() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("haos.qcow2");
        std::fs::write(&path, b"QFI\xfb").unwrap();

        let error = grow(&path, 64 * GIB).unwrap_err();

        assert!(error.to_string().contains("isn't a qcow2 image"), "{error}");
    }

    #[test]
    fn compression_type_is_accepted() {
        let mut header = haos_like_header();
        header[79] = INCOMPATIBLE_COMPRESSION_TYPE as u8;
        let (_dir, path, _) = image_with(&header);

        grow(&path, 64 * GIB).unwrap();

        assert_eq!(read_header(&path).size, 64 * GIB);
    }
}
