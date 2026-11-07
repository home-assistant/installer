//! Ask before closing the app while it's in the middle of an installation.
//!
//! Closing the window halfway through a flash leaves a half-written drive,
//! and halfway through a VM install leaves a broken VM. While a job runs, a
//! close request is held back and the frontend asks the user first. If they
//! still want out, the frontend calls [`quit_anyway`].
//!
//! Installing an update of the installer, and restarting into it, hold back
//! new jobs instead: on Windows the installer exits halfway through it.
//! Installing it also holds back closing the app, without the choice to quit
//! anyway: on Linux the AppImage is rewritten in place, and quitting halfway
//! through leaves one that doesn't start.

use crate::command_error::CommandError;
use serde::Serialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{Emitter, Runtime, Window, WindowEvent};

/// Sent to the frontend when a close request was held back, with why.
const CLOSE_BLOCKED_EVENT: &str = "close-blocked";

static RUNNING_JOBS: JobCounter = JobCounter::new();

/// The counter's top bit, set while an update installs or the app restarts
/// into one.
const UPDATING: usize = 1 << (usize::BITS - 1);
/// The next bit, set while an update installs.
const INSTALLING: usize = 1 << (usize::BITS - 2);
const FLAGS: usize = UPDATING | INSTALLING;

/// Why closing the app is held back.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CloseBlocked {
    /// A job runs; the user may still quit
    Job,
    /// An update installs; quitting would break the app
    Update,
}

/// The running jobs, and whether an update holds them back, in one value, so
/// a job and an update can't both start.
pub(crate) struct JobCounter(AtomicUsize);

impl JobCounter {
    pub(crate) const fn new() -> Self {
        Self(AtomicUsize::new(0))
    }

    /// Mark a job as running for as long as the returned guard lives.
    /// Refused while an update holds jobs back.
    pub(crate) fn start(&'static self) -> Result<RunningJob, CommandError> {
        let previous = self.0.fetch_add(1, Ordering::AcqRel);
        if previous & UPDATING != 0 {
            self.0.fetch_sub(1, Ordering::AcqRel);
            return Err(CommandError::new(
                "installer_updating",
                "The installer is updating itself. Wait for it to restart, then try again.",
                true,
            ));
        }
        Ok(RunningJob(self))
    }

    /// Why closing the app is held back now, if it is.
    pub(crate) fn close_blocked(&self) -> Option<CloseBlocked> {
        let value = self.0.load(Ordering::Acquire);
        if value & INSTALLING != 0 {
            Some(CloseBlocked::Update)
        } else if value & !FLAGS > 0 {
            Some(CloseBlocked::Job)
        } else {
            None
        }
    }

    /// Hold back new jobs for as long as the returned guard lives. `None`
    /// while a job runs, or something else holds them back.
    pub(crate) fn hold_for_update(&'static self) -> Option<UpdateHold> {
        self.hold(UPDATING)
    }

    /// Hold back new jobs, and closing the app, for as long as the returned
    /// guard lives. `None` while a job runs, or something else holds them back.
    pub(crate) fn hold_for_install(&'static self) -> Option<UpdateHold> {
        self.hold(UPDATING | INSTALLING)
    }

    fn hold(&'static self, flags: usize) -> Option<UpdateHold> {
        self.0
            .compare_exchange(0, flags, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| UpdateHold(self))
    }
}

/// Holds back closing the app until dropped.
pub(crate) struct RunningJob(&'static JobCounter);

impl Drop for RunningJob {
    fn drop(&mut self) {
        self.0 .0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Holds back new jobs until dropped.
pub(crate) struct UpdateHold(&'static JobCounter);

impl Drop for UpdateHold {
    fn drop(&mut self) {
        self.0 .0.fetch_and(!FLAGS, Ordering::AcqRel);
    }
}

/// The app's jobs: flashes, VM installs and live USB sticks.
pub(crate) fn jobs() -> &'static JobCounter {
    &RUNNING_JOBS
}

/// Mark a job as running for as long as the returned guard lives. Refused
/// while an update holds jobs back.
pub(crate) fn running_job() -> Result<RunningJob, CommandError> {
    RUNNING_JOBS.start()
}

/// Window event handler: hold back a close request while a job runs or an
/// update installs.
pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let Some(blocked) = RUNNING_JOBS.close_blocked() else {
        return;
    };

    api.prevent_close();
    ask_before_closing(window, blocked);
}

/// Bring the window forward and have the frontend say why it stays open, and
/// for a job ask whether to quit anyway.
fn ask_before_closing<R: Runtime>(window: &Window<R>, blocked: CloseBlocked) {
    // Quit from the menu, the taskbar or the Dock also works on a minimized or
    // hidden window; bring it back, or the question goes unseen.
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();

    if window.emit(CLOSE_BLOCKED_EVENT, blocked).is_err() {
        crate::diagnostics::warning("close_blocked_event_failed");
    }
}

/// Quit even though a job is still running. The user chose this. Not while
/// an update installs, which the frontend never offers it for.
#[tauri::command]
pub fn quit_anyway(app: tauri::AppHandle) {
    if RUNNING_JOBS.close_blocked() == Some(CloseBlocked::Update) {
        crate::diagnostics::warning("quit_during_update_refused");
        return;
    }
    crate::diagnostics::warning("quit_during_job");
    // Ends the event loop without `terminate:`, so it isn't asked again
    app.exit(0);
}

#[cfg(target_os = "macos")]
pub(crate) use termination::guard_app_termination;

/// Quit from the menu or the Dock, logging out and shutting down send
/// `terminate:` to the app, which tao lets through without a close request or
/// any run event. `applicationShouldTerminate:` on tao's app delegate cancels it
/// while a job runs and asks the user, like a close request.
#[cfg(target_os = "macos")]
mod termination {
    use super::{ask_before_closing, RUNNING_JOBS};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use std::sync::OnceLock;
    use tauri::Manager;

    /// The class tao registers for its app delegate.
    const TAO_DELEGATE_CLASS: &std::ffi::CStr = c"TaoAppDelegateParent";

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    extern "C-unwind" fn should_terminate(
        _: &AnyObject,
        _: Sel,
        _: *mut AnyObject,
    ) -> NSApplicationTerminateReply {
        let Some(blocked) = RUNNING_JOBS.close_blocked() else {
            return NSApplicationTerminateReply::TerminateNow;
        };
        let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) else {
            // Nowhere to ask, so don't quit halfway through a job
            crate::diagnostics::warning("termination_blocked_without_window");
            return NSApplicationTerminateReply::TerminateCancel;
        };
        // Quit anyway exits by itself; a logout or shutdown has to be started again
        ask_before_closing(&window.as_ref().window(), blocked);
        NSApplicationTerminateReply::TerminateCancel
    }

    /// Add `applicationShouldTerminate:` to tao's app delegate.
    pub(crate) fn guard_app_termination(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());

        let Some(mtm) = MainThreadMarker::new() else {
            crate::diagnostics::warning("termination_guard_unavailable");
            return;
        };
        let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
            crate::diagnostics::warning("termination_guard_unavailable");
            return;
        };
        let class: &AnyClass = AsRef::<AnyObject>::as_ref(&*delegate).class();
        if class.name() != TAO_DELEGATE_CLASS {
            crate::diagnostics::warning("termination_guard_unavailable");
            return;
        }

        // SAFETY: the function matches the signature AppKit calls
        // `applicationShouldTerminate:` with, and `Q@:@` is its encoding.
        let added = unsafe {
            let imp: Imp =
                std::mem::transmute(should_terminate as extern "C-unwind" fn(_, _, _) -> _);
            ffi::class_addMethod(
                std::ptr::from_ref(class).cast_mut(),
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            // tao implements it itself now; it should go through the close check.
            crate::diagnostics::warning("termination_guard_unavailable");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_running_jobs_until_they_are_dropped() {
        static COUNTER: JobCounter = JobCounter::new();
        assert_eq!(COUNTER.close_blocked(), None);

        let first = COUNTER.start().unwrap();
        let second = COUNTER.start().unwrap();
        assert_eq!(COUNTER.close_blocked(), Some(CloseBlocked::Job));

        drop(first);
        assert_eq!(COUNTER.close_blocked(), Some(CloseBlocked::Job));

        drop(second);
        assert_eq!(COUNTER.close_blocked(), None);
    }

    #[test]
    fn an_update_and_a_job_hold_each_other_back() {
        static COUNTER: JobCounter = JobCounter::new();

        let job = COUNTER.start().unwrap();
        assert!(COUNTER.hold_for_update().is_none());
        drop(job);

        let hold = COUNTER.hold_for_update().unwrap();
        let refused = COUNTER.start().err().unwrap();
        assert_eq!(refused.code, "installer_updating");
        assert!(refused.retryable);
        assert!(COUNTER.hold_for_update().is_none());
        // Not a job, so closing the window isn't held back
        assert_eq!(COUNTER.close_blocked(), None);
        drop(hold);

        assert!(COUNTER.start().is_ok());
    }

    #[test]
    fn an_installing_update_holds_back_closing_too() {
        static COUNTER: JobCounter = JobCounter::new();

        let job = COUNTER.start().unwrap();
        assert!(COUNTER.hold_for_install().is_none());
        drop(job);

        let hold = COUNTER.hold_for_install().unwrap();
        assert_eq!(COUNTER.close_blocked(), Some(CloseBlocked::Update));
        assert_eq!(COUNTER.start().err().unwrap().code, "installer_updating");
        assert!(COUNTER.hold_for_update().is_none());
        drop(hold);

        assert_eq!(COUNTER.close_blocked(), None);
        assert!(COUNTER.start().is_ok());
    }

    #[test]
    fn tells_the_frontend_why_closing_waits() {
        assert_eq!(serde_json::json!(CloseBlocked::Job), "job");
        assert_eq!(serde_json::json!(CloseBlocked::Update), "update");
    }

    /// Quit from the menu or the Dock, logging out and shutting down only ask
    /// first while `guard_app_termination` can add its method to tao's app
    /// delegate. A test can't run tao's event loop, so check on each tao update
    /// that its delegate is still `TaoAppDelegateParent` and still lacks
    /// `applicationShouldTerminate:`, then bump the version here.
    #[test]
    fn termination_guard_was_checked_against_the_locked_tao() {
        let lock = include_str!("../../../Cargo.lock");
        let tao = lock
            .split("[[package]]")
            // `lines()`, not `\n`: a Windows checkout may have CRLF line endings
            .find(|package| package.lines().any(|line| line == "name = \"tao\""))
            .and_then(|package| {
                package
                    .lines()
                    .find_map(|line| line.strip_prefix("version = "))
            })
            .expect("tao is in Cargo.lock");
        assert_eq!(
            tao, "\"0.37.1\"",
            "check the termination guard against this tao"
        );
    }
}
