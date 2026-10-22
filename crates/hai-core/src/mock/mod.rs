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

/// How long each simulated update shows: longer than the progress bar's CSS
/// transition, so the bar settles.
const STEP: Duration = Duration::from_millis(250);

/// Report a stage the way the native backend does: counted from 0 to `total`
/// bytes in 10% steps, or once at 0% when it has no bytes to count. A stop is
/// honored before every update.
pub(crate) async fn simulate<P: ProgressCallback>(
    cb: &P,
    stage: FlashStage,
    total: u64,
    message: &str,
) -> Result<()> {
    let steps = if total > 0 { 10 } else { 0 };
    for step in 0..=steps {
        if cb.is_cancelled() {
            return Err(crate::Error::Cancelled);
        }

        let bytes = total * step / 10;
        cb.on_progress(FlashProgress::new(stage.clone(), bytes, total, message));
        tokio::time::sleep(STEP).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{assert_progress_shape, ProxmoxSession, ProxmoxVmConfig};
    use crate::{DeviceBackend, ProxmoxBackend, ReleaseSource};

    /// Records every update, and stops once `stop_at` is reported.
    #[derive(Default)]
    struct Recorder {
        updates: std::sync::Mutex<Vec<FlashProgress>>,
        stop_at: Option<FlashStage>,
    }

    impl ProgressCallback for Recorder {
        fn on_progress(&self, progress: FlashProgress) {
            self.updates.lock().unwrap().push(progress);
        }

        fn is_cancelled(&self) -> bool {
            let updates = self.updates.lock().unwrap();
            updates
                .iter()
                .any(|u| Some(&u.stage) == self.stop_at.as_ref())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn flash_reports_progress_like_the_native_backend() {
        use FlashStage::*;

        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("haos.img.xz");
        let extracted = directory.path().join("haos.img");
        let image = &BackendMock.get_haos_release("latest").await.unwrap().images[0];
        for verify in [true, false] {
            let progress = Recorder::default();
            BackendMock
                .download_image(image, &archive, &progress)
                .await
                .unwrap();
            BackendMock
                .extract_xz(&archive, &extracted, &progress)
                .await
                .unwrap();
            let written = crate::disk::Image::new(&extracted);
            BackendMock
                .write_image(
                    &written,
                    "mock-sd-card-32gb",
                    &Default::default(),
                    verify,
                    &progress,
                )
                .await
                .unwrap();

            let mut stages = vec![
                Downloading,
                Extracting,
                Writing,
                Verifying,
                Finalizing,
                Complete,
            ];
            stages.retain(|stage| verify || *stage != Verifying);
            let updates = progress.updates.lock().unwrap();
            assert_progress_shape(&updates, &stages);
            // Like natively, the extraction counts the downloaded archive
            let extracting = updates.iter().find(|u| u.stage == Extracting).unwrap();
            assert_eq!(extracting.total_bytes, image.size);
        }
    }

    fn session() -> ProxmoxSession {
        ProxmoxSession {
            server_url: "https://pve.example:8006".into(),
            ticket: "mock-ticket".into(),
            csrf_token: "mock-csrf-token".into(),
            certificate_sha256: None,
        }
    }

    fn config() -> ProxmoxVmConfig {
        ProxmoxVmConfig {
            node: "pve".into(),
            storage: "local-lvm".into(),
            bridge: "vmbr0".into(),
            vlan_tag: None,
            vm_id: 100,
            name: "homeassistant".into(),
            cpu_cores: 2,
            memory_mb: 4096,
            disk_size_gb: 32,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn proxmox_install_reports_progress_like_the_native_backend() {
        use FlashStage::*;

        let progress = Recorder::default();
        ProxmoxBackend::create_vm(&BackendMock, &session(), &config(), &progress)
            .await
            .unwrap();
        assert_progress_shape(
            &progress.updates.lock().unwrap(),
            &[Downloading, Extracting, Uploading, CreatingVm, StartingVm],
        );
    }

    #[tokio::test(start_paused = true)]
    async fn proxmox_install_stops_until_the_vm_is_being_created() {
        for (stop_at, stopped) in [
            (FlashStage::Uploading, true),
            (FlashStage::CreatingVm, false),
        ] {
            let progress = Recorder {
                stop_at: Some(stop_at),
                ..Default::default()
            };
            let result =
                ProxmoxBackend::create_vm(&BackendMock, &session(), &config(), &progress).await;
            assert_eq!(matches!(result, Err(crate::Error::Cancelled)), stopped);
        }
    }
}
