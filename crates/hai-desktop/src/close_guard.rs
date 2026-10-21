//! Ask before closing the app while it's in the middle of an installation.
//!
//! Closing the window halfway through a flash leaves a half-written drive,
//! and halfway through a VM install leaves a broken VM. While a job runs, a
//! close request is held back and the frontend asks the user first. If they
//! still want out, the frontend calls [`quit_anyway`], otherwise
//! [`keep_running`].

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
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || termination::answer(&handle, true));
    }
    #[cfg(not(target_os = "macos"))]
    app.exit(0);
}

/// Keep running after all. The user chose this.
#[tauri::command]
pub fn keep_running(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || termination::answer(&handle, false));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
pub(crate) use termination::guard_app_termination;

/// What to do with a `terminate:` request.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum TerminateDecision {
    /// No job runs, so let it through.
    Now,
    /// Hold it back and ask the user.
    Ask,
    /// Already asking; the answer covers this request too.
    AlreadyAsking,
}

/// What the user's answer to the quit question does.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum AnswerAction {
    /// Reply to the held-back `terminate:`, letting it through or cancelling it.
    Reply { terminate: bool },
    /// Nothing was held back (a window close asked), so exit by ourselves.
    Exit,
    /// Nothing was held back and the user keeps the app running.
    Stay,
}

/// A `terminate:` held back until the user answered.
#[cfg(any(target_os = "macos", test))]
struct PendingTermination(std::sync::atomic::AtomicBool);

#[cfg(any(target_os = "macos", test))]
impl PendingTermination {
    const fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    fn request(&self, job_running: bool) -> TerminateDecision {
        if !job_running {
            return TerminateDecision::Now;
        }
        if self.0.swap(true, Ordering::AcqRel) {
            return TerminateDecision::AlreadyAsking;
        }
        TerminateDecision::Ask
    }

    /// The question couldn't be asked; drop the request.
    fn abandon(&self) {
        self.0.store(false, Ordering::Release);
    }

    /// Settle the user's answer, taking the request waiting for it.
    fn answer(&self, quit: bool) -> AnswerAction {
        if self.0.swap(false, Ordering::AcqRel) {
            AnswerAction::Reply { terminate: quit }
        } else if quit {
            AnswerAction::Exit
        } else {
            AnswerAction::Stay
        }
    }
}

/// Quit from the menu or the Dock, logging out and shutting down send
/// `terminate:` to the app, which tao lets through without a close request or
/// any run event. `applicationShouldTerminate:` on tao's app delegate holds it
/// back while a job runs, until the user answered.
#[cfg(target_os = "macos")]
mod termination {
    use super::{
        ask_before_closing, AnswerAction, PendingTermination, TerminateDecision, RUNNING_JOBS,
    };
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use std::sync::OnceLock;
    use tauri::Manager;

    /// The class tao registers for its app delegate.
    const TAO_DELEGATE_CLASS: &std::ffi::CStr = c"TaoAppDelegateParent";

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// A `terminate:` is waiting for the user's answer.
    static PENDING: PendingTermination = PendingTermination::new();

    /// Act on the user's answer to the quit question. Runs on the main thread.
    pub(super) fn answer(app: &tauri::AppHandle, quit: bool) {
        match PENDING.answer(quit) {
            // Let a held-back quit, logout or shutdown carry on, or cancel it
            AnswerAction::Reply { terminate } => match MainThreadMarker::new() {
                Some(mtm) => NSApplication::sharedApplication(mtm)
                    .replyToApplicationShouldTerminate(terminate),
                None if terminate => app.exit(0),
                None => {}
            },
            // Ends the event loop without `terminate:`, so it isn't asked again
            AnswerAction::Exit => app.exit(0),
            AnswerAction::Stay => {}
        }
    }

    extern "C-unwind" fn should_terminate(
        _: &AnyObject,
        _: Sel,
        _: *mut AnyObject,
    ) -> NSApplicationTerminateReply {
        match PENDING.request(RUNNING_JOBS.any()) {
            TerminateDecision::Now => return NSApplicationTerminateReply::TerminateNow,
            TerminateDecision::AlreadyAsking => return NSApplicationTerminateReply::TerminateLater,
            TerminateDecision::Ask => {}
        }
        let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) else {
            // Nowhere to ask, so don't quit halfway through a job
            PENDING.abandon();
            crate::diagnostics::warning("termination_blocked_without_window");
            return NSApplicationTerminateReply::TerminateCancel;
        };
        ask_before_closing(&window.as_ref().window());
        NSApplicationTerminateReply::TerminateLater
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

    #[test]
    fn lets_termination_through_while_idle() {
        let pending = PendingTermination::new();
        assert_eq!(pending.request(false), TerminateDecision::Now);
        assert_eq!(pending.request(false), TerminateDecision::Now);
    }

    #[test]
    fn asks_once_for_repeated_termination_during_a_job() {
        let pending = PendingTermination::new();
        assert_eq!(pending.request(true), TerminateDecision::Ask);
        assert_eq!(pending.request(true), TerminateDecision::AlreadyAsking);
        assert_eq!(pending.request(true), TerminateDecision::AlreadyAsking);
    }

    #[test]
    fn quit_anyway_lets_the_held_back_termination_through() {
        let pending = PendingTermination::new();
        assert_eq!(pending.request(true), TerminateDecision::Ask);
        assert_eq!(
            pending.answer(true),
            AnswerAction::Reply { terminate: true }
        );
    }

    #[test]
    fn keep_running_cancels_the_held_back_termination_and_asks_next_time() {
        let pending = PendingTermination::new();
        assert_eq!(pending.request(true), TerminateDecision::Ask);
        assert_eq!(
            pending.answer(false),
            AnswerAction::Reply { terminate: false }
        );

        // The next termination asks again
        assert_eq!(pending.request(true), TerminateDecision::Ask);
    }

    #[test]
    fn answers_without_a_held_back_termination_exit_or_stay() {
        // A window close asked, so quitting anyway has to exit by itself
        let pending = PendingTermination::new();
        assert_eq!(pending.answer(true), AnswerAction::Exit);
        assert_eq!(pending.answer(false), AnswerAction::Stay);
    }

    #[test]
    fn an_answer_settles_the_held_back_termination_once() {
        let pending = PendingTermination::new();
        assert_eq!(pending.request(true), TerminateDecision::Ask);
        assert_eq!(
            pending.answer(false),
            AnswerAction::Reply { terminate: false }
        );
        // A second answer has nothing left to reply to
        assert_eq!(pending.answer(true), AnswerAction::Exit);
    }

    #[test]
    fn asks_again_after_the_question_could_not_be_shown() {
        let pending = PendingTermination::new();
        assert_eq!(pending.request(true), TerminateDecision::Ask);
        pending.abandon();

        assert_eq!(pending.answer(true), AnswerAction::Exit);
        assert_eq!(pending.request(true), TerminateDecision::Ask);
    }
}
