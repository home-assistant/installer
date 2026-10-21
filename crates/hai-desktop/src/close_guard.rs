//! Ask before closing the app while it's in the middle of an installation.
//!
//! Closing the window halfway through a flash leaves a half-written drive,
//! and halfway through a VM install leaves a broken VM. While a job runs, a
//! close request is held back and the frontend asks the user first. If they
//! still want out, the frontend calls [`quit_anyway`].

use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{Emitter, Runtime, Window, WindowEvent};

/// Sent to the frontend when a close request was held back.
const CLOSE_BLOCKED_EVENT: &str = "close-blocked";

static RUNNING_JOBS: JobCounter = JobCounter::new();

struct JobCounter(AtomicUsize);

impl JobCounter {
    const fn new() -> Self {
        Self(AtomicUsize::new(0))
    }

    fn start(&'static self) -> RunningJob {
        self.0.fetch_add(1, Ordering::AcqRel);
        RunningJob(self)
    }

    fn any(&self) -> bool {
        self.0.load(Ordering::Acquire) > 0
    }
}

/// Holds back closing the app until dropped.
pub(crate) struct RunningJob(&'static JobCounter);

impl Drop for RunningJob {
    fn drop(&mut self) {
        self.0 .0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Mark a job as running for as long as the returned guard lives.
pub(crate) fn running_job() -> RunningJob {
    RUNNING_JOBS.start()
}

/// Window event handler: hold back a close request while a job runs.
pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if !RUNNING_JOBS.any() {
        return;
    }

    api.prevent_close();
    ask_before_closing(window);
}

/// Bring the window forward and have the frontend ask whether to quit.
fn ask_before_closing<R: Runtime>(window: &Window<R>) {
    // Quit from the menu, the taskbar or the Dock also works on a minimized or
    // hidden window; bring it back, or the question goes unseen.
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();

    if window.emit(CLOSE_BLOCKED_EVENT, ()).is_err() {
        crate::diagnostics::warning("close_blocked_event_failed");
    }
}

/// Quit even though a job is still running. The user chose this.
#[tauri::command]
pub fn quit_anyway(app: tauri::AppHandle) {
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
        if !RUNNING_JOBS.any() {
            return NSApplicationTerminateReply::TerminateNow;
        }
        let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) else {
            // Nowhere to ask, so don't quit halfway through a job
            crate::diagnostics::warning("termination_blocked_without_window");
            return NSApplicationTerminateReply::TerminateCancel;
        };
        // Quit anyway exits by itself; a logout or shutdown has to be started again
        ask_before_closing(&window.as_ref().window());
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
        assert!(!COUNTER.any());

        let first = COUNTER.start();
        let second = COUNTER.start();
        assert!(COUNTER.any());

        drop(first);
        assert!(COUNTER.any());

        drop(second);
        assert!(!COUNTER.any());
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
            .find(|package| package.contains("\nname = \"tao\"\n"))
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
