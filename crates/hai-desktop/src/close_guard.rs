//! Ask before closing the app while it's in the middle of an installation.
//!
//! Closing the window halfway through a flash leaves a half-written drive,
//! and halfway through a VM install leaves a broken VM. While a job runs, a
//! close request is held back and the frontend asks the user first. If they
//! still want out, the frontend calls [`quit_anyway`].

use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{Emitter, Window, WindowEvent};

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

    // Quit from the menu or the taskbar also works on a minimized or hidden
    // window; bring it back, or the question goes unseen.
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
    app.exit(0);
}

/// The default macOS menu, with a Quit item that goes through the close
/// check. The stock one terminates the app right away, so Cmd+Q would skip
/// the question.
#[cfg(target_os = "macos")]
pub(crate) fn menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        return Ok(menu);
    };

    // Look the stock item up rather than trusting its position; if it's not
    // there, leave the menu alone instead of removing the wrong item.
    let stock_quit = app_menu.items()?.into_iter().position(|item| {
        matches!(&item, MenuItemKind::Predefined(item)
            if item.text().is_ok_and(|text| text.starts_with("Quit")))
    });
    let Some(stock_quit) = stock_quit else {
        return Ok(menu);
    };

    app_menu.remove_at(stock_quit)?;
    app_menu.append(&MenuItem::with_id(
        app,
        QUIT_MENU_ID,
        format!("Quit {}", app.package_info().name),
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;

    Ok(menu)
}

#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "quit";

/// Menu event handler: Quit closes the window, which asks first if needed.
#[cfg(target_os = "macos")]
pub(crate) fn on_menu_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    use tauri::Manager;

    if event.id() != QUIT_MENU_ID {
        return;
    }
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.close();
        }
        None => app.exit(0),
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
}
