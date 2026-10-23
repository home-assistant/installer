//! Restarting the app as administrator, which writing a USB stick needs on Windows.

use crate::command_error::CommandError;

/// Tells the restarted app to wait for this one to close first. Otherwise the
/// single-instance check would hand over to the old window and exit.
const WAIT_FOR_PID: &str = "--wait-for-pid";

/// Starts the app again as administrator. Windows shows its usual permission prompt.
#[cfg(windows)]
pub fn relaunch_as_admin() -> Result<(), CommandError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(Some(0)).collect()
    }
    let exe = wide(std::env::current_exe()?.as_os_str());
    let args = wide(OsStr::new(&format!(
        "{WAIT_FOR_PID} {}",
        std::process::id()
    )));
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
pub fn relaunch_as_admin() -> Result<(), CommandError> {
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
}
