//! Settings Home Assistant OS imports on first boot
//!
//! On every boot, `haos-config` in Home Assistant OS copies the files in
//! `CONFIG/network/` of the boot partition to NetworkManager's connections,
//! then deletes `CONFIG`. A network added there is joined from the first
//! boot on, and its password doesn't stay on the boot partition.

use crate::disk::Image;
use crate::error::{Error, Result};
use crate::types::WifiConfig;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};

/// The images Wi-Fi can be added to all have a GPT with 512-byte sectors.
const SECTOR: u64 = 512;
const BOOT_PARTITION: &str = "hassos-boot";
/// Boot partitions are 16 to 64 MiB. This bounds what is read into memory.
const MAX_BOOT_PARTITION: u64 = 256 * 1024 * 1024;

/// Check `wifi` against what WPA2 Personal allows.
pub fn validate(wifi: &WifiConfig) -> Result<()> {
    if wifi.ssid.is_empty() || wifi.ssid.len() > 32 || wifi.ssid.chars().any(char::is_control) {
        return Err(Error::InvalidConfig(
            "The Wi-Fi name must be 1 to 32 bytes long, without control characters.".into(),
        ));
    }
    let password = wifi.password.as_bytes();
    let passphrase = (8..=63).contains(&password.len())
        && password.iter().all(|byte| (b' '..=b'~').contains(byte));
    let key = password.len() == 64 && password.iter().all(u8::is_ascii_hexdigit);
    if !passphrase && !key {
        return Err(Error::InvalidConfig(
            "The Wi-Fi password must be 8 to 63 characters long.".into(),
        ));
    }
    Ok(())
}

/// The Home Assistant OS image at `image`, with `wifi` added to its boot
/// partition. Only the copy in memory changes, never the file.
pub fn with_wifi(image: Image, wifi: &WifiConfig) -> Result<Image> {
    validate(wifi)?;
    let mut file = std::fs::File::open(image.path())?;
    let (offset, size) = boot_partition(&mut file)?;
    let mut partition = vec![0; size as usize];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut partition)?;
    add_network(&mut partition, keyfile(wifi).as_bytes())?;
    Ok(image.patched(offset, partition))
}

/// Offset and size of the boot partition, found by its GPT name.
fn boot_partition(image: &mut (impl Read + Seek)) -> Result<(u64, u64)> {
    let missing =
        || Error::InvalidConfig("The image has no Home Assistant OS boot partition.".into());
    let image_size = image.seek(SeekFrom::End(0))?;
    let mut header = [0; 92];
    image.seek(SeekFrom::Start(SECTOR))?;
    image.read_exact(&mut header).map_err(|_| missing())?;
    if &header[..8] != b"EFI PART" {
        return Err(missing());
    }
    let u32_at =
        |bytes: &[u8], at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let u64_at =
        |bytes: &[u8], at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    let entries = u64_at(&header, 72);
    let count = u32_at(&header, 80).min(128);
    let entry_size = u32_at(&header, 84) as usize;
    if !(128..=4096).contains(&entry_size) {
        return Err(missing());
    }

    let mut entry = vec![0; entry_size];
    image.seek(SeekFrom::Start(
        entries.checked_mul(SECTOR).ok_or_else(missing)?,
    ))?;
    for _ in 0..count {
        image.read_exact(&mut entry).map_err(|_| missing())?;
        let name: Vec<u16> = entry[56..128]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&unit| u16::from_le_bytes(unit))
            .take_while(|&unit| unit != 0)
            .collect();
        if String::from_utf16_lossy(&name) != BOOT_PARTITION {
            continue;
        }
        let (first, last) = (u64_at(&entry, 32), u64_at(&entry, 40));
        let offset = first.checked_mul(SECTOR).ok_or_else(missing)?;
        let size = last
            .checked_sub(first)
            .and_then(|sectors| (sectors + 1).checked_mul(SECTOR))
            .filter(|&size| size <= MAX_BOOT_PARTITION)
            .filter(|&size| {
                offset
                    .checked_add(size)
                    .is_some_and(|end| end <= image_size)
            })
            .ok_or_else(missing)?;
        return Ok((offset, size));
    }
    Err(missing())
}

/// Write `keyfile` to `CONFIG/network/` of the FAT file system in `partition`.
fn add_network(partition: &mut [u8], keyfile: &[u8]) -> std::io::Result<()> {
    let fs = fatfs::FileSystem::new(Cursor::new(partition), fatfs::FsOptions::new())?;
    {
        let network = fs.root_dir().create_dir("CONFIG")?.create_dir("network")?;
        let mut file = network.create_file("wifi.nmconnection")?;
        file.truncate()?;
        file.write_all(keyfile)?;
        file.flush()?;
    }
    fs.unmount()
}

/// A NetworkManager keyfile that joins `wifi` with DHCP and IPv6 autoconfiguration.
fn keyfile(wifi: &WifiConfig) -> String {
    // NetworkManager reads a list of byte values as the raw SSID, whatever
    // the characters in it. It ignores the user data, which marks the
    // profile as meant for the Supervisor to take over.
    let ssid: String = wifi.ssid.bytes().map(|byte| format!("{byte};")).collect();
    format!(
        "[connection]\nid={id}\ntype=wifi\n\n\
         [wifi]\nmode=infrastructure\nssid={ssid}\n\n\
         [wifi-security]\nkey-mgmt=wpa-psk\npsk={psk}\n\n\
         [ipv4]\nmethod=auto\n\n\
         [ipv6]\nmethod=auto\n\n\
         [user]\nio.home-assistant.import=supervisor\n",
        id = escape(&wifi.ssid),
        psk = escape(&wifi.password),
    )
}

/// Escape a key file value. `\s` keeps leading and trailing spaces, which
/// would be trimmed otherwise.
fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace(' ', "\\s")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wifi(ssid: &str, password: &str) -> WifiConfig {
        WifiConfig {
            ssid: ssid.into(),
            password: password.into(),
        }
    }

    #[test]
    fn accepts_wpa2_names_and_passwords() {
        for (ssid, password) in [
            ("Home", "12345678"),
            ("A", "x".repeat(63).as_str()),
            ("n".repeat(32).as_str(), " spaces at both ends "),
            ("Café 🏠", "~!@#$%^&*()_+-=[]{};':\",./<>?\\|`"),
            ("Hex", &"0123456789abcdefABCDEF".repeat(3)[..64]),
        ] {
            validate(&wifi(ssid, password)).unwrap_or_else(|e| panic!("{ssid:?}: {e}"));
        }
    }

    #[test]
    fn refuses_what_wpa2_does_not_allow() {
        for (ssid, password) in [
            ("", "12345678"),
            ("n".repeat(33).as_str(), "12345678"),
            // 31 characters, but 33 bytes
            (format!("{}é", "n".repeat(31)).as_str(), "12345678"),
            ("Line\nbreak", "12345678"),
            ("Home", "1234567"),
            ("Home", "x".repeat(64).as_str()),
            ("Home", "x".repeat(65).as_str()),
            ("Home", "pässwörd"),
            ("Home", "tab\tinside"),
        ] {
            assert!(
                matches!(
                    validate(&wifi(ssid, password)),
                    Err(Error::InvalidConfig(_))
                ),
                "{ssid:?} {password:?}"
            );
        }
    }

    #[test]
    fn keyfile_escapes_spaces_and_backslashes() {
        let keyfile = keyfile(&wifi(" My Wi-Fi", "a b\\c "));
        assert!(keyfile.contains("\nid=\\sMy\\sWi-Fi\n"), "{keyfile}");
        assert!(
            keyfile.contains("\nssid=32;77;121;32;87;105;45;70;105;\n"),
            "{keyfile}"
        );
        assert!(keyfile.contains("\npsk=a\\sb\\\\c\\s\n"), "{keyfile}");
        assert!(keyfile.contains("\nkey-mgmt=wpa-psk\n"));
        assert!(keyfile.ends_with("\n[user]\nio.home-assistant.import=supervisor\n"));
    }

    #[test]
    fn debug_output_hides_the_password() {
        let output = format!("{:?}", wifi("Home", "secret-password"));
        assert!(output.contains("Home"));
        assert!(!output.contains("secret-password"));
    }

    /// A raw image with a GPT whose second entry is `name`, holding
    /// `partition` at `offset_sectors`.
    fn gpt_image(name: &str, partition: &[u8], offset_sectors: u64) -> Vec<u8> {
        let mut image = vec![0; (offset_sectors * SECTOR) as usize + partition.len()];
        image[510..512].copy_from_slice(&[0x55, 0xaa]);
        image[512..520].copy_from_slice(b"EFI PART");
        image[512 + 72..512 + 80].copy_from_slice(&2u64.to_le_bytes());
        image[512 + 80..512 + 84].copy_from_slice(&4u32.to_le_bytes());
        image[512 + 84..512 + 88].copy_from_slice(&128u32.to_le_bytes());
        let entry = 1024 + 128;
        let last = offset_sectors + partition.len() as u64 / SECTOR - 1;
        image[entry + 32..entry + 40].copy_from_slice(&offset_sectors.to_le_bytes());
        image[entry + 40..entry + 48].copy_from_slice(&last.to_le_bytes());
        for (i, unit) in name.encode_utf16().enumerate() {
            image[entry + 56 + 2 * i..entry + 58 + 2 * i].copy_from_slice(&unit.to_le_bytes());
        }
        let start = (offset_sectors * SECTOR) as usize;
        image[start..].copy_from_slice(partition);
        image
    }

    fn fat_partition(size: u64) -> Vec<u8> {
        let mut partition = vec![0; size as usize];
        fatfs::format_volume(
            Cursor::new(&mut partition[..]),
            fatfs::FormatVolumeOptions::new().volume_label(*b"hassos-boot"),
        )
        .unwrap();
        partition
    }

    fn read_network(partition: &mut [u8]) -> String {
        let fs = fatfs::FileSystem::new(Cursor::new(partition), fatfs::FsOptions::new()).unwrap();
        let mut file = fs
            .root_dir()
            .open_file("CONFIG/network/wifi.nmconnection")
            .unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        contents
    }

    #[test]
    fn finds_the_boot_partition_by_name() {
        let image = gpt_image(BOOT_PARTITION, &[0; 4096], 64);
        assert_eq!(
            boot_partition(&mut Cursor::new(image)).unwrap(),
            (64 * SECTOR, 4096)
        );
    }

    #[test]
    fn refuses_images_without_a_boot_partition() {
        for image in [
            gpt_image("hassos-kernel0", &[0; 4096], 64),
            gpt_image("hassos-boot-ish", &[0; 4096], 64),
            // No GPT, as on boards with an MBR only
            vec![0; 64 * 1024],
            vec![0; 100],
        ] {
            assert!(matches!(
                boot_partition(&mut Cursor::new(image)),
                Err(Error::InvalidConfig(_))
            ));
        }
    }

    #[test]
    fn refuses_a_partition_past_the_end_of_the_image() {
        let mut image = gpt_image(BOOT_PARTITION, &[0; 4096], 64);
        image.truncate(image.len() - 512);
        assert!(matches!(
            boot_partition(&mut Cursor::new(image)),
            Err(Error::InvalidConfig(_))
        ));
    }

    #[test]
    fn adds_the_network_to_the_boot_partition_in_memory_only() {
        let partition = fat_partition(16 * 1024 * 1024);
        let original = gpt_image(BOOT_PARTITION, &partition, 2048);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), &original).unwrap();

        let image = with_wifi(Image::new(file.path()), &wifi("Home", "12345678")).unwrap();

        let mut written = Vec::new();
        image.open().unwrap().read_to_end(&mut written).unwrap();
        assert_eq!(written.len(), original.len());
        let boot = 2048 * SECTOR as usize;
        assert_eq!(written[..boot], original[..boot]);
        assert_eq!(
            read_network(&mut written[boot..]),
            keyfile(&wifi("Home", "12345678"))
        );
        assert_eq!(std::fs::read(file.path()).unwrap(), original);
    }

    #[test]
    fn replaces_a_network_already_on_the_partition() {
        let mut partition = fat_partition(16 * 1024 * 1024);
        add_network(&mut partition, &[b'x'; 5000]).unwrap();
        add_network(&mut partition, b"new").unwrap();
        assert_eq!(read_network(&mut partition), "new");
    }
}
