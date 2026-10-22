//! Keep the computer from going to sleep while a long job runs.
//!
//! A laptop that sleeps halfway through a write leaves a half-written drive,
//! and one that sleeps during a VM upload leaves a broken install. While a
//! [`KeepAwake`] is alive, the system doesn't go to sleep on its own (with
//! one Windows exception, below). The display may still turn off, and the
//! user can still put the computer to sleep on purpose.
//!
//! - macOS: a `PreventUserIdleSystemSleep` power assertion, like `caffeinate -i`.
//! - Windows: a `PowerRequestSystemRequired` power request. Unlike
//!   `SetThreadExecutionState`, it isn't tied to a thread, so it survives an
//!   async task moving between threads. On a Modern Standby laptop running
//!   on battery, Windows lets the request lapse five minutes after the sleep
//!   timeout, so there it buys time, not a guarantee.
//! - Linux: the desktop's `Inhibit` portal, asking it not to suspend on its
//!   own. Without a portal, a logind `idle` inhibitor lock. Neither blocks a
//!   suspend the user asks for, unlike a logind `sleep` lock.

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
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    use futures_util::StreamExt;
    use zbus::{Connection, OwnedFd, OwnedObjectPath, OwnedVariant, Variant};

    use super::{Error, Result};

    /// The portal's "suspend the session" flag.
    const INHIBIT_SUSPEND: u32 = 4;

    /// How long the desktop gets to inhibit suspend before we fall back.
    const PORTAL_TIMEOUT: Duration = Duration::from_secs(5);

    #[zbus::proxy(
        interface = "org.freedesktop.portal.Inhibit",
        default_service = "org.freedesktop.portal.Desktop",
        default_path = "/org/freedesktop/portal/desktop"
    )]
    trait Portal {
        fn inhibit(
            &self,
            window: &str,
            flags: u32,
            options: HashMap<&str, Variant<'_>>,
        ) -> zbus::Result<OwnedObjectPath>;
    }

    #[zbus::proxy(
        interface = "org.freedesktop.portal.Request",
        default_service = "org.freedesktop.portal.Desktop"
    )]
    trait Request {
        #[zbus(signal)]
        fn response(
            &self,
            response: u32,
            results: HashMap<String, OwnedVariant>,
        ) -> zbus::Result<()>;
    }

    #[zbus::proxy(
        interface = "org.freedesktop.login1.Manager",
        default_service = "org.freedesktop.login1",
        default_path = "/org/freedesktop/login1"
    )]
    trait LoginManager {
        fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> zbus::Result<OwnedFd>;
    }

    pub(super) struct Inner {
        _lock: Lock,
    }

    // Never read: holding a lock is all these are for
    #[allow(dead_code)]
    enum Lock {
        // The portal drops the inhibition when this connection closes.
        Portal(Connection),
        // logind holds the lock until this file descriptor is closed.
        Logind(OwnedFd),
    }

    impl Inner {
        pub(super) async fn acquire(reason: &str) -> Result<Self> {
            // The portal may never answer: it silently drops a request the
            // user's permissions don't allow, and one that can't start holds
            // the call until D-Bus gives up, two minutes later on Ubuntu.
            if let Ok(Ok(connection)) =
                tokio::time::timeout(PORTAL_TIMEOUT, inhibit_with_portal(reason)).await
            {
                return Ok(Self {
                    _lock: Lock::Portal(connection),
                });
            }

            inhibit_with_logind(reason)
                .await
                .map(|lock| Self {
                    _lock: Lock::Logind(lock),
                })
                .map_err(|error| {
                    Error::UnsupportedPlatform(format!(
                        "Could not ask the system to stay awake: {error}"
                    ))
                })
        }
    }

    async fn inhibit_with_portal(reason: &str) -> zbus::Result<Connection> {
        // A connection of our own, so dropping it ends exactly this inhibition
        let connection = Connection::session().await?;

        // `Inhibit` returns before the desktop has acted on it; the outcome
        // comes later as a `Response` on the request object. That object's
        // path is known up front, so subscribe before asking to not miss it.
        static NEXT_TOKEN: AtomicU32 = AtomicU32::new(0);
        let token = format!(
            "hai_keep_awake_{}",
            NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
        );
        let sender = connection
            .unique_name()
            .ok_or_else(|| zbus::Error::Failure("Not connected to the session bus".into()))?
            .trim_start_matches(':')
            .replace('.', "_");
        let request_path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
        let mut responses = RequestProxy::builder(&connection)
            .path(request_path.as_str())
            .build()
            .await?
            .receive_response()
            .await?;

        let options = HashMap::from([
            ("handle_token", Variant::from(token.as_str())),
            ("reason", Variant::from(reason)),
        ]);
        let handle = PortalProxy::new(&connection)
            .await?
            .inhibit("", INHIBIT_SUSPEND, options)
            .await?;
        if handle.as_str() != request_path {
            return Err(zbus::Error::Failure(
                "The portal answered on an unexpected request".into(),
            ));
        }

        let response = responses
            .next()
            .await
            .ok_or_else(|| zbus::Error::Failure("The portal went away".into()))?;
        match response.args()?.response {
            0 => Ok(connection),
            code => Err(zbus::Error::Failure(format!(
                "The portal refused to inhibit suspend ({code})"
            ))),
        }
    }

    async fn inhibit_with_logind(reason: &str) -> zbus::Result<OwnedFd> {
        let connection = Connection::system().await?;
        // Only `idle`: a `sleep` lock in block mode would also refuse a
        // suspend the user asks for.
        LoginManagerProxy::new(&connection)
            .await?
            .inhibit("idle", "Home Assistant Installer", reason, "block")
            .await
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
