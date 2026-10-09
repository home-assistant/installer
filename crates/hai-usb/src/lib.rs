//! Prepares a live USB stick or ISO that installs Home Assistant OS on a generic x86-64 PC.
//!
//! Runs on the user's PC. The desktop app (phase 2) calls this library; `main.rs` is a
//! small command line for testing.

mod apkovl;
mod disk_image;
mod downloads;
mod error;
mod iso;
mod stick;
mod stick_file;
mod usb;

pub use downloads::{cache_dir, fetch_alpine, fetch_haos, Download, ALPINE_VERSION, HAOS_BOARD};
pub use error::{Error, Result};
pub use stick::{prepare, write_image, write_iso, write_stick, Contents};
pub use usb::{list_usb_drives, write_to_usb};
