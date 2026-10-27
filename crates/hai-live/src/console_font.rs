//! The console font: Terminus, so the console can show every supported language.
//!
//! The kernel's built-in font has 256 glyphs in the old PC layout and lacks most accented
//! letters. hai-live loads Terminus `ter-v16n` or `ter-v32n` instead (512 glyphs, the kernel's
//! limit), with the half blocks of the logo patched in. Only the ioctls are Linux-only, so
//! parsing and patching are tested on any OS.

use std::fs;
use std::io;
use std::path::Path;

const TER_16: &[u8] = include_bytes!("../fonts/ter-v16n.psf");
const TER_32: &[u8] = include_bytes!("../fonts/ter-v32n.psf");
const VTCONSOLE: &str = "/sys/class/vtconsole";
const PSF1_MAGIC: [u8; 2] = [0x36, 0x04];
const PSF2_MAGIC: [u8; 4] = [0x72, 0xb5, 0x4a, 0x86];
/// `KD_FONT_OP_SET` takes every glyph padded to 32 rows.
const KERNEL_ROWS: usize = 32;

/// Loads the patched Terminus font on the console behind stdout.
///
/// Best effort, and only under the framebuffer console (fbcon): in VGA text mode a 512-glyph
/// font costs the bright colors. The size follows the font the kernel picked. Any error leaves
/// the console as it was. Call it before drawing: the console stores glyph numbers, so text
/// already on screen turns into other glyphs.
pub fn load() {
    if fbcon_bound(Path::new(VTCONSOLE)) {
        // Without it the built-in font still shows English
        let _ = load_patched();
    }
}

fn load_patched() -> io::Result<()> {
    let height = console::font_height()?;
    let mut font = patched(font_for(height)).ok_or(io::ErrorKind::InvalidData)?;
    let mut glyphs = kernel_glyphs(&font);
    console::set_font(&mut font, &mut glyphs)
}

/// Whether the patched font has a glyph for `c`; both sizes cover the same characters. Line
/// breaks have none: they are never drawn.
#[cfg(test)]
pub fn covers(c: char) -> bool {
    static FONT: std::sync::OnceLock<Option<Font>> = std::sync::OnceLock::new();
    FONT.get_or_init(|| patched(TER_16))
        .as_ref()
        .is_some_and(|font| {
            font.unicode
                .iter()
                .any(|pair| u32::from(pair.unicode) == u32::from(c))
        })
}

/// Whether the framebuffer console is bound, from `vtconsole` (normally `/sys/class/vtconsole`).
fn fbcon_bound(vtconsole: &Path) -> bool {
    let Ok(items) = fs::read_dir(vtconsole) else {
        return false;
    };
    items.flatten().any(|item| {
        let read = |file: &str| fs::read_to_string(item.path().join(file)).unwrap_or_default();
        item.file_name().to_string_lossy().starts_with("vtcon")
            && read("name").contains("frame buffer")
            && read("bind").trim() == "1"
    })
}

/// The font for a console whose current font is `height` pixels high. The kernel picks its
/// 16x32 font on large screens, and the text should stay that size.
fn font_for(height: u32) -> &'static [u8] {
    if height >= 24 {
        TER_32
    } else {
        TER_16
    }
}

/// A code point and the glyph that shows it, laid out like `struct unipair` in `linux/kd.h`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UniPair {
    unicode: u16,
    fontpos: u16,
}

#[derive(Debug)]
struct Font {
    width: usize,
    height: usize,
    count: usize,
    /// `count` bitmaps of `height` rows, each row padded to whole bytes, leftmost pixel in the
    /// top bit.
    glyphs: Vec<u8>,
    /// Which glyph shows which code point. The kernel only maps the Basic Multilingual Plane.
    unicode: Vec<UniPair>,
}

impl Font {
    fn row_bytes(&self) -> usize {
        self.width.div_ceil(8)
    }
}

/// Parses a PSF1 or PSF2 font with a Unicode table. `None` for anything else, and for fonts the
/// console can't take.
fn parse(data: &[u8]) -> Option<Font> {
    let (width, height, count, glyph_bytes, start, psf2) = if data.starts_with(&PSF1_MAGIC) {
        // Magic, mode, height. Always 8 wide; the mode says 256 or 512 glyphs and whether
        // there's a table.
        let (mode, height) = (*data.get(2)?, usize::from(*data.get(3)?));
        if mode & 0x06 == 0 {
            return None;
        }
        let count = if mode & 0x01 != 0 { 512 } else { 256 };
        (8, height, count, height, 4, false)
    } else if data.starts_with(&PSF2_MAGIC) {
        // Magic, version, header size, flags, glyph count, bytes per glyph, height, width
        let field = |i: usize| {
            let bytes = data.get(i * 4..i * 4 + 4)?.try_into().ok()?;
            usize::try_from(u32::from_le_bytes(bytes)).ok()
        };
        if field(3)? & 0x01 == 0 {
            return None;
        }
        (field(7)?, field(6)?, field(4)?, field(5)?, field(2)?, true)
    } else {
        return None;
    };
    // At most 512 glyphs of 64 pixels wide (vt.c), and the 32 rows they're padded to
    let fits = count <= 512 && (1..=64).contains(&width) && (1..=KERNEL_ROWS).contains(&height);
    if !fits || glyph_bytes != width.div_ceil(8) * height {
        return None;
    }
    let table_start = start.checked_add(count * glyph_bytes)?;
    let glyphs = data.get(start..table_start)?.to_vec();
    let table = &data[table_start..];

    // Per glyph its code points, then optional sequences (a base character with combining
    // marks), which the kernel can't use, then an end marker
    let code_points: Vec<Vec<u32>> = if psf2 {
        table
            .split(|&byte| byte == 0xff)
            .take(count)
            .map(|entry| {
                let single = entry.split(|&byte| byte == 0xfe).next().unwrap_or_default();
                let text = std::str::from_utf8(single).ok()?;
                Some(text.chars().map(u32::from).collect())
            })
            .collect::<Option<_>>()?
    } else {
        let entries: Vec<u16> = table
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect();
        entries
            .split(|&entry| entry == 0xffff)
            .take(count)
            .map(|entry| {
                let single = entry.split(|&e| e == 0xfffe).next().unwrap_or_default();
                single.iter().map(|&e| u32::from(e)).collect()
            })
            .collect()
    };
    let unicode = (0..)
        .zip(code_points)
        .flat_map(|(fontpos, points)| {
            points.into_iter().filter_map(move |c| {
                let unicode = u16::try_from(c).ok()?;
                Some(UniPair { unicode, fontpos })
            })
        })
        .collect();
    Some(Font {
        width,
        height,
        count,
        glyphs,
        unicode,
    })
}

fn patched(data: &[u8]) -> Option<Font> {
    let mut font = parse(data)?;
    patch(&mut font);
    Some(font)
}

/// Terminus has no ▀ or ▄, which the logo is drawn with. They take the places of ⌠ and ⌡,
/// which no supported language needs.
fn patch(font: &mut Font) {
    let size = font.row_bytes() * font.height;
    let half = font.row_bytes() * (font.height / 2);
    for (old, new, top) in [(0x2320, 0x2580, true), (0x2321, 0x2584, false)] {
        let Some(glyph) = font.unicode.iter().find(|pair| pair.unicode == old) else {
            continue;
        };
        let fontpos = glyph.fontpos;
        font.unicode.retain(|pair| pair.fontpos != fontpos);
        font.unicode.push(UniPair {
            unicode: new,
            fontpos,
        });
        let bitmap = &mut font.glyphs[usize::from(fontpos) * size..][..size];
        let (upper, lower) = bitmap.split_at_mut(half);
        upper.fill(if top { 0xff } else { 0 });
        lower.fill(if top { 0 } else { 0xff });
    }
}

/// The glyphs as `KD_FONT_OP_SET` takes them: each one padded to 32 rows.
fn kernel_glyphs(font: &Font) -> Vec<u8> {
    let row = font.row_bytes();
    let mut data = vec![0; font.count * KERNEL_ROWS * row];
    let slots = data.chunks_exact_mut(KERNEL_ROWS * row);
    for (slot, glyph) in slots.zip(font.glyphs.chunks_exact(font.height * row)) {
        slot[..glyph.len()].copy_from_slice(glyph);
    }
    data
}

/// The console behind stdout, through the ioctls `setfont` uses (`include/uapi/linux/kd.h`).
#[cfg(target_os = "linux")]
mod console {
    use super::{Font, UniPair};
    use std::io;
    use std::ptr;

    const KDFONTOP: u32 = 0x4B72;
    const KD_FONT_OP_SET: u32 = 0;
    const KD_FONT_OP_GET: u32 = 1;
    const PIO_UNIMAP: u32 = 0x4B67;
    const PIO_UNIMAPCLR: u32 = 0x4B68;

    #[repr(C)]
    struct ConsoleFontOp {
        op: u32,
        flags: u32,
        width: u32,
        height: u32,
        charcount: u32,
        data: *mut u8,
    }

    #[repr(C)]
    struct UnimapDesc {
        entry_ct: u16,
        entries: *mut UniPair,
    }

    /// Hash table hints, which only older kernels read; zero means no opinion.
    #[repr(C)]
    #[derive(Default)]
    struct UnimapInit {
        advised_hashsize: u16,
        advised_hashstep: u16,
        advised_hashlevel: u16,
    }

    /// Height of the console's current font.
    pub(super) fn font_height() -> io::Result<u32> {
        // Without a buffer the kernel only reports the size, if it's within the one given
        let mut op = ConsoleFontOp {
            op: KD_FONT_OP_GET,
            flags: 0,
            width: u32::MAX,
            height: u32::MAX,
            charcount: 0,
            data: ptr::null_mut(),
        };
        // SAFETY: `op` is a console_font_op without data, so the kernel only writes to `op`.
        check(unsafe { libc::ioctl(libc::STDOUT_FILENO, KDFONTOP as _, &mut op) })?;
        Ok(op.height)
    }

    /// Loads `font`, with `glyphs` laid out by `kernel_glyphs`, and then its Unicode map.
    pub(super) fn set_font(font: &mut Font, glyphs: &mut [u8]) -> io::Result<()> {
        let mut map = UnimapDesc {
            entry_ct: u16::try_from(font.unicode.len()).map_err(|_| io::ErrorKind::InvalidData)?,
            entries: font.unicode.as_mut_ptr(),
        };
        let mut op = ConsoleFontOp {
            op: KD_FONT_OP_SET,
            flags: 0,
            width: font.width as u32,
            height: font.height as u32,
            charcount: font.count as u32,
            data: glyphs.as_mut_ptr(),
        };
        // SAFETY: `glyphs` holds `charcount` glyphs of 32 rows, which is what the kernel reads.
        check(unsafe { libc::ioctl(libc::STDOUT_FILENO, KDFONTOP as _, &mut op) })?;
        // Once the font is in, these only fail when the kernel runs out of memory
        let mut hints = UnimapInit::default();
        // SAFETY: `hints` is a unimapinit, the argument older kernels read.
        check(unsafe { libc::ioctl(libc::STDOUT_FILENO, PIO_UNIMAPCLR as _, &mut hints) })?;
        // SAFETY: `entries` points to `entry_ct` pairs, which the kernel only reads.
        check(unsafe { libc::ioctl(libc::STDOUT_FILENO, PIO_UNIMAP as _, &mut map) })
    }

    fn check(result: libc::c_int) -> io::Result<()> {
        if result == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

/// hai-live only runs on Linux; elsewhere there is no console font to load.
#[cfg(not(target_os = "linux"))]
mod console {
    use super::Font;
    use std::io;

    pub(super) fn font_height() -> io::Result<u32> {
        Err(io::ErrorKind::Unsupported.into())
    }

    pub(super) fn set_font(_font: &mut Font, _glyphs: &mut [u8]) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Language;

    fn fontpos(font: &Font, unicode: u16) -> Option<u16> {
        let pair = font.unicode.iter().find(|pair| pair.unicode == unicode)?;
        Some(pair.fontpos)
    }

    fn glyph(font: &Font, unicode: u16) -> &[u8] {
        let size = font.row_bytes() * font.height;
        &font.glyphs[usize::from(fontpos(font, unicode).unwrap()) * size..][..size]
    }

    fn all(bytes: &[u8], value: u8) -> bool {
        bytes.iter().all(|&b| b == value)
    }

    #[test]
    fn parses_both_fonts() {
        // One of each format
        assert!(TER_16.starts_with(&PSF1_MAGIC) && TER_32.starts_with(&PSF2_MAGIC));
        for (data, width, height) in [(TER_16, 8, 16), (TER_32, 16, 32)] {
            let font = parse(data).unwrap();
            assert_eq!((font.count, font.width, font.height), (512, width, height));
            assert_eq!(font.glyphs.len(), 512 * font.row_bytes() * height);
            assert!(font.unicode.iter().all(|pair| pair.fontpos < 512));
            assert!(fontpos(&font, u16::from(b'A')).is_some());
        }
    }

    #[test]
    fn skips_sequences_and_rejects_other_files() {
        // PSF1, 256 glyphs of one row: glyph 0 is A, plus A with a ring as a sequence
        let mut psf1 = vec![0x36, 0x04, 0x02, 1];
        psf1.extend([0; 256]);
        let table: Vec<u16> = [&[0x41, 0xfffe, 0x41, 0x30a, 0xffff][..], &[0xffff; 255]].concat();
        psf1.extend(table.into_iter().flat_map(u16::to_le_bytes));
        let font = parse(&psf1).unwrap();
        assert_eq!((font.unicode.len(), fontpos(&font, 0x41)), (1, Some(0)));

        // PSF2, one glyph: Å, an emoji beyond the kernel's range, then Å as a sequence
        let mut psf2 = PSF2_MAGIC.to_vec();
        psf2.extend([0, 32, 1, 1, 1, 1, 8].map(u32::to_le_bytes).concat());
        psf2.push(0);
        psf2.extend(["Å😀".as_bytes(), &[0xfe], "A\u{30a}".as_bytes(), &[0xff]].concat());
        let font = parse(&psf2).unwrap();
        assert_eq!((font.unicode.len(), fontpos(&font, 0xc5)), (1, Some(0)));

        psf1[2] = 0x01; // no table
        assert!(parse(&psf1).is_none());
        assert!(parse(b"not a font").is_none());
        assert!(parse(&TER_32[..100]).is_none());
    }

    #[test]
    fn both_sizes_cover_the_same_characters() {
        let code_points = |data| {
            let font = patched(data).unwrap();
            let mut points: Vec<u16> = font.unicode.iter().map(|pair| pair.unicode).collect();
            points.sort_unstable();
            points
        };
        assert_eq!(code_points(TER_16), code_points(TER_32));
    }

    #[test]
    fn covers_the_patched_font() {
        assert!(covers('A') && covers('ß') && covers('▀') && covers('▄'));
        assert!(!covers('⌠') && !covers('⌡'));
        assert!(!covers('\n'));
    }

    /// What the screens draw themselves is checked in `ui`.
    #[test]
    fn covers_every_character_of_every_catalog() {
        for lang in Language::all() {
            for &(key, message) in lang.messages() {
                for c in message.chars() {
                    let code = u32::from(c);
                    assert!(
                        covers(c),
                        "{lang:?} {key}: the console font has no {c:?} (U+{code:04X})"
                    );
                }
            }
        }
    }

    #[test]
    fn half_blocks_replace_the_integral_halves() {
        for data in [TER_16, TER_32] {
            let (original, font) = (parse(data).unwrap(), patched(data).unwrap());
            let half = font.row_bytes() * font.height / 2;
            let (top, bottom) = (glyph(&font, 0x2580), glyph(&font, 0x2584));
            assert!(all(&top[..half], 0xff) && all(&top[half..], 0));
            assert!(all(&bottom[..half], 0) && all(&bottom[half..], 0xff));
            assert_eq!(fontpos(&font, 0x2580), fontpos(&original, 0x2320));
            assert_eq!(fontpos(&font, 0x2584), fontpos(&original, 0x2321));
            // Nothing else changes
            let size = font.row_bytes() * font.height;
            let glyphs = original.glyphs.chunks(size).zip(font.glyphs.chunks(size));
            assert_eq!(glyphs.filter(|(a, b)| a != b).count(), 2);
            assert_eq!(font.unicode.len(), original.unicode.len());
        }
    }

    #[test]
    fn pads_every_glyph_to_32_rows_for_the_kernel() {
        let font = patched(TER_16).unwrap();
        let data = kernel_glyphs(&font);
        assert_eq!(data.len(), 512 * 32);
        for (slot, glyph) in data.chunks(32).zip(font.glyphs.chunks(16)) {
            assert_eq!(&slot[..16], glyph);
            assert!(all(&slot[16..], 0));
        }
        // 32 rows of 2 bytes need no padding
        let font = patched(TER_32).unwrap();
        assert_eq!(kernel_glyphs(&font), font.glyphs);
    }

    fn add_vtcon(sys: &Path, name: &str, driver: &str, bind: &str) {
        let dir = sys.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("name"), format!("{driver}\n")).unwrap();
        fs::write(dir.join("bind"), format!("{bind}\n")).unwrap();
    }

    #[test]
    fn detects_the_framebuffer_console() {
        // UEFI: fbcon took over from the dummy console
        let dir = tempfile::tempdir().unwrap();
        add_vtcon(dir.path(), "vtcon0", "(S) dummy device", "0");
        add_vtcon(dir.path(), "vtcon1", "(M) frame buffer device", "1");
        assert!(fbcon_bound(dir.path()));

        // BIOS text mode, with fbcon loaded but not bound
        let dir = tempfile::tempdir().unwrap();
        add_vtcon(dir.path(), "vtcon0", "(S) VGA+", "1");
        assert!(!fbcon_bound(dir.path()));
        add_vtcon(dir.path(), "vtcon1", "(M) frame buffer device", "0");
        assert!(!fbcon_bound(dir.path()));

        assert!(!fbcon_bound(&dir.path().join("missing")));
    }

    #[test]
    fn follows_the_size_the_kernel_picked() {
        for (current, height) in [(8, 16), (16, 16), (24, 32), (32, 32)] {
            let font = patched(font_for(current)).unwrap();
            assert_eq!(font.height, height, "{current}");
        }
    }
}
