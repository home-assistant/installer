//! Finds the bundled HAOS image on the boot media and checks it against its checksum file.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The HAOS image on the boot media and its expected SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledImage {
    /// Path to the `.img.xz` file.
    pub path: PathBuf,
    /// Lowercase hex SHA-256 from the `.sha256` file next to it.
    pub sha256: String,
}

impl BundledImage {
    /// File name, for the screen.
    pub fn name(&self) -> String {
        self.path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// Looks in every folder under `media` (normally `/media`) for `haos_*.img.xz` with a valid
/// `.sha256` file next to it. Returns the first one found.
pub fn find(media: &Path) -> Option<BundledImage> {
    let mut mounts: Vec<PathBuf> = std::fs::read_dir(media)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .collect();
    mounts.sort();
    for mount in mounts {
        let Ok(files) = std::fs::read_dir(&mount) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("haos_") && name.ends_with(".img.xz")) {
                continue;
            }
            let sums = std::fs::read_to_string(mount.join(format!("{name}.sha256")));
            if let Some(sha256) = sums.ok().and_then(|text| parse_sha256(&text, &name)) {
                return Some(BundledImage {
                    path: file.path(),
                    sha256,
                });
            }
        }
    }
    None
}

/// Reads a `sha256sum`-style line (`<hex>  <name>`) and returns the hex if it's for `name`.
fn parse_sha256(text: &str, name: &str) -> Option<String> {
    let (hex, file) = text.lines().next()?.split_once(char::is_whitespace)?;
    let file = file.trim_start().trim_start_matches('*');
    let valid = hex.len() == 64 && hex.bytes().all(|c| c.is_ascii_hexdigit());
    (valid && file == name).then(|| hex.to_ascii_lowercase())
}

/// Whether the file's SHA-256 matches. `progress(read, total)` is called as it goes.
pub fn verify(image: &BundledImage, progress: &mut dyn FnMut(u64, u64)) -> std::io::Result<bool> {
    let mut file = File::open(&image.path)?;
    let total = file.metadata()?.len();
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 4 * 1024 * 1024];
    let mut read_so_far = 0;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        read_so_far += read as u64;
        progress(read_so_far, total);
    }
    Ok(hex::encode(hasher.finalize()) == image.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "haos_generic-x86-64-18.3.img.xz";
    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[test]
    fn parses_sha256sum_lines() {
        let line = format!("{HELLO_SHA256}  {NAME}\n");
        assert_eq!(parse_sha256(&line, NAME).as_deref(), Some(HELLO_SHA256));
        assert_eq!(
            parse_sha256(&format!("{HELLO_SHA256} *{NAME}"), NAME).as_deref(),
            Some(HELLO_SHA256)
        );
        assert_eq!(parse_sha256(&line, "other.img.xz"), None);
        assert_eq!(parse_sha256(&format!("abc  {NAME}"), NAME), None);
    }

    #[test]
    fn finds_and_verifies_the_bundled_image() {
        let dir = tempfile::tempdir().unwrap();
        let stick = dir.path().join("sda1");
        std::fs::create_dir_all(&stick).unwrap();
        std::fs::create_dir_all(dir.path().join("cdrom")).unwrap();
        std::fs::write(stick.join(NAME), b"hello").unwrap();
        std::fs::write(
            stick.join(format!("{NAME}.sha256")),
            format!("{HELLO_SHA256}  {NAME}\n"),
        )
        .unwrap();

        let image = find(dir.path()).unwrap();
        assert_eq!(image.path, stick.join(NAME));
        assert!(verify(&image, &mut |_, _| {}).unwrap());

        std::fs::write(stick.join(NAME), b"hellO").unwrap();
        assert!(!verify(&image, &mut |_, _| {}).unwrap());
    }

    #[test]
    fn ignores_images_without_checksum_file() {
        let dir = tempfile::tempdir().unwrap();
        let stick = dir.path().join("sda1");
        std::fs::create_dir_all(&stick).unwrap();
        std::fs::write(stick.join(NAME), b"hello").unwrap();
        assert_eq!(find(dir.path()), None);
    }
}
