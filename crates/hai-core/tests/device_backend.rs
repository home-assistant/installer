use std::path::Path;

use hai_core::{BlockDevice, DeviceBackend, ProgressCallback, Result};

struct BackendAuthorizingDuringWrite;

impl DeviceBackend for BackendAuthorizingDuringWrite {
    async fn list_devices(&self) -> Result<Vec<BlockDevice>> {
        panic!("preflight must not enumerate devices");
    }

    async fn write_image<P: ProgressCallback>(
        &self,
        _image_path: &Path,
        _device_id: &str,
        _verify: bool,
        _progress_callback: &P,
    ) -> Result<()> {
        panic!("preflight must not write an image");
    }
}

#[test]
fn existing_backend_implementation_defaults_to_no_preflight() {
    BackendAuthorizingDuringWrite
        .check_write_privileges()
        .unwrap();
}
