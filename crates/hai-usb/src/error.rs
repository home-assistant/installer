//! Error type for `hai-usb`.

/// Errors from preparing a live USB stick or ISO.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Download, checksum or cache folder error from `hai-core`.
    #[error(transparent)]
    Core(#[from] hai_core::Error),

    /// Local file error.
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// The HAOS release has no raw image for the generic x86-64 board.
    #[error("Home Assistant OS {0} has no generic x86-64 image")]
    MissingImage(String),

    /// The release metadata has no usable SHA-256 checksum.
    #[error("no SHA-256 checksum published for {0}")]
    MissingChecksum(String),

    /// The version string from the release metadata is not a plain version number.
    #[error("unexpected Home Assistant OS version: {0:?}")]
    InvalidVersion(String),

    /// Building the USB disk image failed.
    #[error("disk image: {0}")]
    DiskImage(String),

    /// Reading the Alpine ISO or writing our ISO failed.
    #[error("ISO: {0}")]
    Iso(String),

    /// The given `hai-live` file is not a Linux program.
    #[error("hai-live must be the Linux build (x86_64-unknown-linux-musl), not a Windows or macOS program")]
    NotLinuxBinary,

    /// The chosen drive is not removable, so it is never written.
    #[error("{0} is not a removable drive and will not be written")]
    NotRemovable(String),

    /// The drive at this id is no longer the one the user picked.
    #[error("the drive at {0} is no longer the one you picked; list drives and pick again")]
    DeviceChanged(String),
}

/// Result type for `hai-usb`.
pub type Result<T> = std::result::Result<T, Error>;
