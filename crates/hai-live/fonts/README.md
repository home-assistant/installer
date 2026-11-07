# Console fonts

hai-live loads one of these on the live USB stick's console at start, so the console can show every supported language (see `src/console_font.rs`).

| File | Font | Format |
|---|---|---|
| `ter-v16n.psf` | Terminus 8x16, normal | PSF1, 512 glyphs, Unicode table |
| `ter-v32n.psf` | Terminus 16x32, normal | PSF2, 512 glyphs, Unicode table |
| `OFL.txt` | the licence | |

The fonts are [Terminus Font](https://terminus-font.sourceforge.net/) 4.49.1, the `ter-v` set that combines all of its code pages, built from the upstream release `terminus-font-4.49.1.tar.gz` (SHA-256 `d961c1b781627bf417f9b340693d64fc219e0113ad3a3af1a3424c7aa373ef79`). They are unmodified, only decompressed: the build installs them gzipped and hai-live has no gzip decoder. `OFL.txt` is the tarball's `OFL.TXT`, with Unix line endings.

## Patch at load time

Terminus has no ▀ (U+2580) or ▄ (U+2584), which the logo is drawn with. When hai-live loads a font, it redraws the glyphs of ⌠ (U+2320) and ⌡ (U+2321) in memory as the top and bottom half block, and maps U+2580 and U+2584 to them instead. No supported language needs ⌠ or ⌡. The files here stay as they are.

## Licence

Copyright (C) 2020 Dimitar Toshkov Zhekov, with Reserved Font Name "Terminus Font". Licensed under the SIL Open Font License, Version 1.1, in `OFL.txt`.

The fonts are compiled into hai-live, so `OFL.txt` goes wherever hai-live goes: the desktop app bundles it next to hai-live as `terminus-font-OFL.txt` (`crates/hai-desktop/tauri.live-usb.conf.json`), and every stick, ISO and disk image has it at the root of the boot media under the same name (`crates/hai-core/src/live_usb.rs`).

The patched font is a Modified Version under the licence. It has no name of its own and is never called Terminus Font.
