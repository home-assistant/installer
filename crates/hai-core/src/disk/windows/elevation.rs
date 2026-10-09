//! Read the process token before downloading an image; never open a drive here.

use crate::{Error, Result};

#[cfg(target_os = "windows")]
pub(super) fn check_write_privileges() -> Result<()> {
    require_elevation(process_is_elevated())
}

#[cfg(target_os = "windows")]
fn process_is_elevated() -> std::io::Result<bool> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = std::ptr::null_mut();
    // SAFETY: the pseudo-process handle is valid and token is a writable output.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken succeeded and transferred ownership of this handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0;
    // SAFETY: the owned token stays open, and both output pointers refer to valid
    // writable storage of the sizes required for TokenElevation.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(elevation.TokenIsElevated != 0)
}

fn require_elevation(elevated: std::io::Result<bool>) -> Result<()> {
    match elevated {
        Ok(true) => Ok(()),
        Ok(false) => Err(Error::PermissionDenied(
            "Administrator access is required to write a drive. Close Home Assistant Installer, \
             then right-click it and choose \"Run as administrator\"."
                .to_string(),
        )),
        Err(err) => Err(Error::Io(std::io::Error::new(
            err.kind(),
            format!("Could not check Windows administrator access: {err}"),
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevated_process_can_continue() {
        require_elevation(Ok(true)).unwrap();
    }

    #[test]
    fn unelevated_process_gets_relaunch_guidance() {
        let Error::PermissionDenied(message) = require_elevation(Ok(false)).unwrap_err() else {
            panic!("expected a permission error");
        };
        assert!(message.contains("Close Home Assistant Installer"));
        assert!(message.contains("Run as administrator"));
    }

    #[test]
    fn token_query_failure_does_not_allow_flashing() {
        let err = require_elevation(Err(std::io::Error::from_raw_os_error(5))).unwrap_err();
        assert!(matches!(err, Error::Io(_)));
        assert!(err
            .to_string()
            .contains("Could not check Windows administrator access"));
    }
}
