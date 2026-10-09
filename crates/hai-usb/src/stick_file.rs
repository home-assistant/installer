//! Files added to the root of the stick on top of the Alpine ISO contents.

use std::path::PathBuf;

/// Where a stick file's bytes come from.
#[derive(Debug, Clone)]
pub enum Source {
    /// Small generated content, held in memory.
    Bytes(Vec<u8>),
    /// A file on disk, streamed so large files (HAOS) never sit in memory.
    File(PathBuf),
}

/// A file placed at the root of the boot media.
#[derive(Debug, Clone)]
pub struct StickFile {
    /// File name at the root of the boot media.
    pub name: String,
    /// Content.
    pub source: Source,
}

impl StickFile {
    /// Size in bytes.
    pub fn size(&self) -> std::io::Result<u64> {
        match &self.source {
            Source::Bytes(bytes) => Ok(bytes.len() as u64),
            Source::File(path) => Ok(std::fs::metadata(path)?.len()),
        }
    }
}
