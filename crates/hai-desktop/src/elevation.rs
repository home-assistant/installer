//! Restarting the app as administrator, which writing a drive needs on Windows.

use crate::command_error::CommandError;

/// Tells the restarted app to wait for this one to close first. Otherwise the
/// single-instance check would hand over to the old window and exit.
const WAIT_FOR_PID: &str = "--wait-for-pid";

/// Tells the restarted app where to open the flow, as the frontend encoded it.
const RESUME: &str = "--resume";

/// Longest resume state passed on, well under Windows' command line limit.
const MAX_RESUME_LEN: usize = 8192;

/// What the restarted app hands its frontend, once.
#[derive(Default)]
pub struct ResumeState(std::sync::Mutex<Option<String>>);

impl ResumeState {
    /// The resume state this process was started with, if any.
    pub fn from_args(args: impl Iterator<Item = String>) -> Self {
        Self(std::sync::Mutex::new(resume_arg(args)))
    }

    fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Where a restart as administrator asked this app to open the flow. The
/// frontend checks it; a second call gets nothing.
#[tauri::command]
pub fn take_resume_state(state: tauri::State<'_, ResumeState>) -> Option<String> {
    state.take()
}

/// Only base64url text goes on the command line, so it needs no quoting.
fn valid_resume(resume: &str) -> bool {
    !resume.is_empty()
        && resume.len() <= MAX_RESUME_LEN
        && resume
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn resume_arg(args: impl Iterator<Item = String>) -> Option<String> {
    args.skip_while(|arg| arg != RESUME)
        .nth(1)
        .filter(|resume| valid_resume(resume))
}

/// The arguments for the restarted app. A resume state that isn't valid is
/// left out, so the app starts on the welcome screen.
#[cfg(any(windows, test))]
fn relaunch_args(pid: u32, resume: Option<&str>) -> String {
    match resume.filter(|resume| valid_resume(resume)) {
        Some(resume) => format!("{WAIT_FOR_PID} {pid} {RESUME} {resume}"),
        None => format!("{WAIT_FOR_PID} {pid}"),
    }
}

/// Starts the app again as administrator. Windows shows its usual permission prompt.
#[cfg(windows)]
pub fn relaunch_as_admin(resume: Option<&str>) -> Result<(), CommandError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(Some(0)).collect()
    }
    let exe = wide(std::env::current_exe()?.as_os_str());
    let args = wide(OsStr::new(&relaunch_args(std::process::id(), resume)));
    let verb = wide(OsStr::new("runas"));
    // SAFETY: every pointer is a NUL-terminated UTF-16 string that outlives the call.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            exe.as_ptr(),
            args.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Above 32 means it started; declining the prompt returns an error code.
    if result as isize > 32 {
        Ok(())
    } else {
        Err(CommandError::new(
            "relaunch_cancelled",
            "The installer wasn't restarted as administrator.",
            true,
        ))
    }
}

/// Only Windows needs this; macOS and Linux ask for a password when writing.
#[cfg(not(windows))]
pub fn relaunch_as_admin(_resume: Option<&str>) -> Result<(), CommandError> {
    Err(CommandError::new(
        "unsupported_platform",
        "Restarting as administrator is only needed on Windows.",
        false,
    ))
}

/// When started by [`relaunch_as_admin`], waits up to 5 seconds for the old window to close.
pub fn wait_for_previous_instance() {
    if let Some(pid) = previous_pid(std::env::args()) {
        wait_for_exit(pid);
    }
}

fn previous_pid(args: impl Iterator<Item = String>) -> Option<u32> {
    args.skip_while(|arg| arg != WAIT_FOR_PID)
        .nth(1)
        .and_then(|pid| pid.parse().ok())
}

#[cfg(windows)]
fn wait_for_exit(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    // SAFETY: the handle is checked before use and closed exactly once.
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            return;
        }
        WaitForSingleObject(process, 5_000);
        CloseHandle(process);
    }
}

#[cfg(not(windows))]
fn wait_for_exit(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_previous_pid_only_after_the_flag() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(
            previous_pid(args(&["hai", WAIT_FOR_PID, "1234"]).into_iter()),
            Some(1234)
        );
        assert_eq!(previous_pid(args(&["hai"]).into_iter()), None);
        assert_eq!(
            previous_pid(args(&["hai", WAIT_FOR_PID, "x"]).into_iter()),
            None
        );
        assert_eq!(previous_pid(args(&["hai", "1234"]).into_iter()), None);
    }

    #[test]
    fn passes_a_valid_resume_state_after_the_pid() {
        assert_eq!(
            relaunch_args(42, Some("eyJ2IjoxfQ")),
            "--wait-for-pid 42 --resume eyJ2IjoxfQ"
        );
        assert_eq!(relaunch_args(42, None), "--wait-for-pid 42");
    }

    #[test]
    fn leaves_out_a_resume_state_that_would_need_quoting() {
        let too_long = "a".repeat(MAX_RESUME_LEN + 1);
        for resume in ["", "a b", "a\"b", "a=b", "a/b", "é", too_long.as_str()] {
            assert_eq!(relaunch_args(42, Some(resume)), "--wait-for-pid 42");
        }
    }

    #[test]
    fn reads_the_resume_state_only_after_its_flag() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        let state = ResumeState::from_args(
            args(&["hai", WAIT_FOR_PID, "1", RESUME, "eyJ2IjoxfQ"]).into_iter(),
        );
        assert_eq!(state.take().as_deref(), Some("eyJ2IjoxfQ"));
        // Handed out once
        assert_eq!(state.take(), None);

        for list in [
            &["hai"][..],
            &["hai", RESUME],
            &["hai", "eyJ2IjoxfQ"],
            &["hai", RESUME, "not base64!"],
        ] {
            assert_eq!(ResumeState::from_args(args(list).into_iter()).take(), None);
        }
    }
}
