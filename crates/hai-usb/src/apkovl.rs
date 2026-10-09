//! Builds the Alpine "apkovl": a .tar.gz that Alpine's initramfs unpacks over `/` at boot.
//! Ours sets up autostart of `hai-live` on console 1.

use std::io::Write;

use flate2::{write::GzEncoder, Compression};
use tar::{EntryType, Header};

use crate::Result;

/// File name on the boot media. Alpine picks up any `*.apkovl.tar.gz` at the root.
pub const APKOVL_NAME: &str = "hai.apkovl.tar.gz";

const INITTAB: &str = include_str!("../overlay/inittab");

/// Returns the apkovl as gzipped tar bytes, with `hai_live` as `/usr/local/bin/hai-live`.
pub fn build(hai_live: &[u8]) -> Result<Vec<u8>> {
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));

    for dir in ["etc", "usr", "usr/local", "usr/local/bin"] {
        append(&mut tar, dir, EntryType::Directory, 0o755, b"")?;
    }
    // With an apkovl present, Alpine skips its default boot services unless this marker exists.
    append(
        &mut tar,
        "etc/.default_boot_services",
        EntryType::Regular,
        0o644,
        b"",
    )?;
    append(
        &mut tar,
        "etc/hostname",
        EntryType::Regular,
        0o644,
        b"hai-live\n",
    )?;
    append(
        &mut tar,
        "etc/inittab",
        EntryType::Regular,
        0o644,
        &unix_text(INITTAB),
    )?;
    append(
        &mut tar,
        "usr/local/bin/hai-live",
        EntryType::Regular,
        0o755,
        hai_live,
    )?;

    Ok(tar.into_inner()?.finish()?)
}

fn append<W: Write>(
    tar: &mut tar::Builder<W>,
    path: &str,
    kind: EntryType,
    mode: u32,
    data: &[u8],
) -> Result<()> {
    let mut header = Header::new_ustar();
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_size(data.len() as u64);
    tar.append_data(&mut header, path, data)?;
    Ok(())
}

/// Git on Windows may check text files out with CRLF, which breaks Linux config files.
fn unix_text(text: &str) -> Vec<u8> {
    text.replace("\r\n", "\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn entries(apkovl: &[u8]) -> Vec<(String, u32, Vec<u8>)> {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(apkovl));
        archive
            .entries()
            .unwrap()
            .map(|entry| {
                let mut entry = entry.unwrap();
                let path = entry.path().unwrap().to_string_lossy().into_owned();
                let mode = entry.header().mode().unwrap();
                let mut data = Vec::new();
                entry.read_to_end(&mut data).unwrap();
                (path, mode, data)
            })
            .collect()
    }

    #[test]
    fn contains_autostart_and_executable_hai_live() {
        let all = entries(&build(b"\x7fELF fake").unwrap());
        let find = |name: &str| all.iter().find(|(path, ..)| path == name).unwrap();

        let (_, mode, data) = find("usr/local/bin/hai-live");
        assert_eq!(*mode, 0o755);
        assert_eq!(data, b"\x7fELF fake");

        let (_, _, inittab) = find("etc/inittab");
        let inittab = String::from_utf8(inittab.clone()).unwrap();
        assert!(inittab.contains("tty1::respawn:/usr/local/bin/hai-live"));
        assert!(!inittab.contains('\r'));

        find("etc/.default_boot_services");
    }
}
