//! Mock backend for the Home Assistant Installer — fake data and simulated
//! progress for development. Compiled only with the `mock` feature, so it never
//! ends up in a release build.
//!
//! Selected as `Backend` by hai-desktop (behind its `mock` feature) in place of
//! `crate::Backend`, so the app runs without real hardware, a network
//! connection, or a Proxmox/UTM host.
//!
//! Each backend trait is implemented in its own module:
//! [`release_source`], [`device`], [`proxmox`], [`utm`], [`host`].

use std::path::Path;
use std::time::Duration;

use crate::types::{FlashProgress, FlashStage};
use crate::{ProgressCallback, Result};

mod device;
mod host;
mod proxmox;
mod release_source;
mod utm;

/// Compile-time-selected mock backend.
#[derive(Debug, Clone, Copy, Default)]
pub struct BackendMock;

/// Write a small placeholder file so orchestration that inspects the output
/// (size checks, metadata) still works end-to-end in mock mode.
pub(crate) fn touch_placeholder(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, b"mock-image-data")?;
    Ok(())
}

/// Pretend size of every mock image, so byte counters look plausible.
const MOCK_IMAGE_BYTES: u64 = 100_000_000;

/// Drive a fake 0→100 progress sweep for a single stage in 5% steps.
///
/// Steps are coarse and `step_ms` apart so each update outlives the progress
/// bar's CSS transition; with finer, faster steps the bar never settles.
pub(crate) async fn simulate<P: ProgressCallback>(
    cb: &P,
    stage: FlashStage,
    message: &str,
    step_ms: u64,
) {
    for pct in (0..=100).step_by(5) {
        cb.on_progress(FlashProgress {
            stage: stage.clone(),
            progress: pct,
            bytes_processed: u64::from(pct) * (MOCK_IMAGE_BYTES / 100),
            total_bytes: MOCK_IMAGE_BYTES,
            message: message.to_string(),
        });
        tokio::time::sleep(Duration::from_millis(step_ms)).await;
    }
}

/// Mirror the real `extract_xz`: a few indeterminate updates (`total_bytes`
/// 0 while bytes grow), then a single final 100%.
pub(crate) async fn simulate_indeterminate<P: ProgressCallback>(
    cb: &P,
    stage: FlashStage,
    message: &str,
    step_ms: u64,
) {
    for step in 1..=8u64 {
        cb.on_progress(FlashProgress {
            stage: stage.clone(),
            progress: 0,
            bytes_processed: step * (MOCK_IMAGE_BYTES / 8),
            total_bytes: 0,
            message: message.to_string(),
        });
        tokio::time::sleep(Duration::from_millis(step_ms)).await;
    }
    cb.on_progress(FlashProgress {
        stage,
        progress: 100,
        bytes_processed: MOCK_IMAGE_BYTES,
        total_bytes: MOCK_IMAGE_BYTES,
        message: message.to_string(),
    });
}
