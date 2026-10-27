//! Builds the Alpine "apkovl": a .tar.gz that Alpine's initramfs unpacks over `/` at boot.
//! Ours sets up autostart of `hai-live` on console 1 and tells it which language to start in.

use std::io::Write;

use flate2::{write::GzEncoder, Compression};
use tar::{EntryType, Header};

use crate::error::Result;

/// File name on the boot media. Alpine picks up any `*.apkovl.tar.gz` at the root.
pub const APKOVL_NAME: &str = "hai.apkovl.tar.gz";

const INITTAB: &str = include_str!("inittab");

/// Returns the apkovl as gzipped tar bytes, with `hai_live` as `/usr/local/bin/hai-live` and
/// `language` (a BCP 47 tag) as `/etc/hai-live/language`. Without that file `hai-live` starts in
/// English, so a tag that can't be one is left out.
pub fn build(hai_live: &[u8], language: &str) -> Result<Vec<u8>> {
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
    if is_plausible_language_tag(language) {
        append(&mut tar, "etc/hai-live", EntryType::Directory, 0o755, b"")?;
        append(
            &mut tar,
            "etc/hai-live/language",
            EntryType::Regular,
            0o644,
            format!("{language}\n").as_bytes(),
        )?;
    }

    Ok(tar.into_inner()?.finish()?)
}

/// Whether `tag` is shaped like a BCP 47 tag; `hai-live` decides which tags it knows.
fn is_plausible_language_tag(tag: &str) -> bool {
    (1..=35).contains(&tag.len())
        && !tag.starts_with('-')
        && !tag.ends_with('-')
        && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
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
        let all = entries(&build(b"\x7fELF fake", "en").unwrap());
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

    #[test]
    fn holds_the_language_hai_live_starts_in() {
        let all = entries(&build(b"\x7fELF fake", "de-AT").unwrap());
        let find = |name: &str| all.iter().find(|(path, ..)| path == name).unwrap();

        let (_, mode, _) = find("etc/hai-live");
        assert_eq!(*mode, 0o755);
        let (_, mode, data) = find("etc/hai-live/language");
        assert_eq!(*mode, 0o644);
        assert_eq!(data, b"de-AT\n");
    }

    #[test]
    fn leaves_out_a_language_that_cannot_be_a_tag() {
        for tag in [
            "",
            "-de",
            "de-",
            "de AT",
            "de\nAT",
            "../de",
            "de_AT",
            "dé",
            "a".repeat(36).as_str(),
        ] {
            let all = entries(&build(b"\x7fELF fake", tag).unwrap());
            assert!(
                all.iter()
                    .all(|(path, ..)| !path.starts_with("etc/hai-live")),
                "{tag:?}"
            );
        }
        let longest = "a".repeat(35);
        let all = entries(&build(b"\x7fELF fake", &longest).unwrap());
        assert!(all.iter().any(|(path, ..)| path == "etc/hai-live/language"));
    }
}
