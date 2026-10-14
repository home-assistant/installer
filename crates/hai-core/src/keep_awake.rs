//! Keep the computer from going to sleep while a long job runs.
//!
//! A laptop that sleeps halfway through a write leaves a half-written drive,
//! and one that sleeps during a VM upload leaves a broken install. While a
//! [`KeepAwake`] is alive, the system doesn't go to sleep on its own. The
//! display may still turn off, and the user can still put the computer to
//! sleep on purpose.
//!
//! - macOS: a `PreventUserIdleSystemSleep` power assertion, like `caffeinate -i`.
//! - Windows: a `PowerRequestSystemRequired` power request. Unlike
//!   `SetThreadExecutionState`, it isn't tied to a thread, so it survives an
//!   async task moving between threads.
//! - Linux: a logind `sleep` and `idle` inhibitor lock, held by its file
//!   descriptor.

use crate::error::{Error, Result};

/// Keeps the system awake until dropped.
pub struct KeepAwake {
    _inner: platform::Inner,
}

impl KeepAwake {
    /// Ask the system to stay awake. `reason` is shown to the user by tools
    /// that list what keeps the computer awake.
    pub async fn acquire(reason: &str) -> Result<Self> {
        Ok(Self {
            _inner: platform::Inner::acquire(reason).await?,
        })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    use super::{Error, Result};

    const ASSERTION_LEVEL_ON: u32 = 255;
    const IO_RETURN_SUCCESS: i32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    pub(super) struct Inner {
        assertion_id: u32,
    }

    impl Inner {
        pub(super) async fn acquire(reason: &str) -> Result<Self> {
            let assertion_type = CFString::from_static_string("PreventUserIdleSystemSleep");
            let name = CFString::new(reason);
            let mut assertion_id = 0;

            // SAFETY: both strings are valid CFStrings for the duration of the
            // call, and `assertion_id` is a valid out pointer.
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    assertion_type.as_concrete_TypeRef(),
                    ASSERTION_LEVEL_ON,
                    name.as_concrete_TypeRef(),
                    &mut assertion_id,
                )
            };
            if result != IO_RETURN_SUCCESS {
                return Err(Error::UnsupportedPlatform(format!(
                    "Could not create a power assertion ({result:#x})"
                )));
            }

            Ok(Self { assertion_id })
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            // SAFETY: the assertion was created by us and is released once.
            unsafe {
                IOPMAssertionRelease(self.assertion_id);
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };

    use super::{Error, Result};

    /// `POWER_REQUEST_CONTEXT_VERSION`, which lives behind another
    /// `windows-sys` feature.
    const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;

    pub(super) struct Inner {
        // Stored as an integer: a raw `HANDLE` isn't `Send`, and the guard
        // lives across `.await` points in async commands.
        request: isize,
    }

    impl Inner {
        pub(super) async fn acquire(reason: &str) -> Result<Self> {
            let mut reason: Vec<u16> = reason.encode_utf16().chain(Some(0)).collect();
            let context = REASON_CONTEXT {
                Version: POWER_REQUEST_CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: reason.as_mut_ptr(),
                },
            };

            // SAFETY: `context` and the reason string it points to are valid
            // for the duration of the call.
            let request = unsafe { PowerCreateRequest(&context) };
            if request == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error().into());
            }

            // SAFETY: `request` is the valid handle created above.
            if unsafe { PowerSetRequest(request, PowerRequestSystemRequired) } == 0 {
                let error = std::io::Error::last_os_error();
                unsafe { CloseHandle(request) };
                return Err(Error::Io(error));
            }

            Ok(Self {
                request: request as isize,
            })
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            let request = self.request as HANDLE;
            // SAFETY: the request was created and set by us, and is cleared
            // and closed once.
            unsafe {
                PowerClearRequest(request, PowerRequestSystemRequired);
                CloseHandle(request);
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use zbus::zvariant::OwnedFd;
    use zbus::Connection;

    use super::{Error, Result};

    #[zbus::proxy(
        interface = "org.freedesktop.login1.Manager",
        default_service = "org.freedesktop.login1",
        default_path = "/org/freedesktop/login1"
    )]
    trait LoginManager {
        fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> zbus::Result<OwnedFd>;
    }

    pub(super) struct Inner {
        // logind holds the lock until this file descriptor is closed.
        _lock: OwnedFd,
    }

    impl Inner {
        pub(super) async fn acquire(reason: &str) -> Result<Self> {
            let lock = async {
                let connection = Connection::system().await?;
                LoginManagerProxy::new(&connection)
                    .await?
                    .inhibit("sleep:idle", "Home Assistant Installer", reason, "block")
                    .await
            }
            .await
            .map_err(|error| {
                Error::UnsupportedPlatform(format!(
                    "Could not take a logind inhibitor lock: {error}"
                ))
            })?;

            Ok(Self { _lock: lock })
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::{Error, Result};

    pub(super) struct Inner;

    impl Inner {
        pub(super) async fn acquire(_reason: &str) -> Result<Self> {
            Err(Error::UnsupportedPlatform(
                "Keeping the system awake isn't supported here".to_string(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send<T: Send>() {}

    #[test]
    fn the_guard_can_be_held_across_await_points() {
        // Async Tauri commands must be `Send`, and they hold the guard while
        // they await the job.
        assert_send::<KeepAwake>();
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[tokio::test]
    async fn acquiring_and_releasing_works() {
        let guard = KeepAwake::acquire("Testing the Home Assistant Installer")
            .await
            .unwrap();
        drop(guard);
    }
}
