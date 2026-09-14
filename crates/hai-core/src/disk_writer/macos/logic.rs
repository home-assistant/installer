//! Platform-independent helpers for the macOS `authopen` write path.
//!
//! The privileged write path itself can only be exercised on a Mac with a real
//! drive attached, but most of what can go wrong in it is pure logic: rounding
//! buffers to the device block size, padding the last block, building the
//! argument vector for `authopen(1)` and turning an `errno` into a message a
//! user can act on. That logic lives here, outside the
//! `cfg(target_os = "macos")` implementation, so it is compiled and unit-tested
//! on every CI runner rather than only on macOS ones.

use crate::error::Error;

/// `O_RDWR` from the macOS `<sys/fcntl.h>`. `authopen -o` takes the numeric
/// `open(2)` flags, and we always want one descriptor usable for both the
/// write and the read-back verify.
pub const O_RDWR: i32 = 0x0002;

/// Block size assumed when `diskutil` does not report one.
///
/// 4096 rather than 512 because guessing too high is safe and guessing too low
/// is not: a length that is a multiple of 4096 is also a multiple of 512, so a
/// 4 KiB assumption works on a 512-byte device, while a 512-byte assumption
/// makes the final write fail with `EINVAL` on a 4 KiB device. The cost of
/// over-estimating is at most a few hundred extra zero bytes of padding.
pub const DEFAULT_BLOCK_SIZE: u64 = 4096;

/// Largest block size we are willing to believe from `diskutil`. Guards the
/// buffer-sizing arithmetic against a nonsense value.
pub const MAX_BLOCK_SIZE: u64 = 1024 * 1024;

// errno values as defined on macOS. They happen to match Linux, which is why
// the mapping below can be tested on a Linux runner, but the names here are
// the macOS ones because that is the only platform that produces them.
pub const EPERM: i32 = 1;
pub const EACCES: i32 = 13;
pub const EBUSY: i32 = 16;
pub const ENOSPC: i32 = 28;

/// Round `value` up to the next multiple of `block_size`.
pub fn align_up(value: u64, block_size: u64) -> u64 {
    if block_size == 0 {
        return value;
    }
    value.div_ceil(block_size) * block_size
}

/// Accept a block size reported by `diskutil`, or fall back to a sane default.
///
/// Writes to `/dev/rdiskN` are rejected unless both the length and the file
/// offset are multiples of the block size, so a bogus value here would turn
/// every write into `EINVAL`. Anything that is not a power of two in the
/// plausible range is treated as missing.
pub fn sanitize_block_size(reported: u64) -> u64 {
    if reported == 0 || reported > MAX_BLOCK_SIZE || !reported.is_power_of_two() {
        DEFAULT_BLOCK_SIZE
    } else {
        reported
    }
}

/// Size the streaming buffer so it is both close to `desired` and a whole
/// number of device blocks.
///
/// `dd` used to hide this: it padded short reads itself. Now that we write to
/// the descriptor directly, every buffer we hand to `write(2)` has to be block
/// aligned, so the buffer length has to be a multiple of the block size to
/// begin with.
pub fn aligned_buffer_size(desired: usize, block_size: u64) -> usize {
    let block_size = sanitize_block_size(block_size);
    let desired = desired.max(block_size as usize);
    let aligned = align_up(desired as u64, block_size);
    aligned as usize
}

/// Zero-fill `buffer[filled..]` up to the next block boundary and return the
/// number of bytes that should be written.
///
/// The image is almost never an exact multiple of the block size, so the final
/// chunk has to be rounded up and the tail zeroed. The padding is written to
/// the device but is deliberately *not* fed into the checksum: verification
/// compares the first `total_size` bytes only.
///
/// `buffer` is always a whole number of blocks (see [`aligned_buffer_size`]),
/// so the padded length never exceeds its length.
pub fn pad_final_block(buffer: &mut [u8], filled: usize, block_size: u64) -> usize {
    let padded = align_up(filled as u64, block_size) as usize;
    let padded = padded.min(buffer.len());
    buffer[filled..padded].fill(0);
    padded
}

/// Build the argument vector for `authopen`.
///
/// * `-stdoutpipe` makes `authopen` hand the open descriptor back over its
///   stdout socket as an `SCM_RIGHTS` control message instead of copying the
///   file's contents to stdout.
/// * `-extauth` makes it read an `AuthorizationExternalForm` from stdin and
///   reuse that authorization, so the system dialog is attributed to this
///   application rather than to `authopen` itself.
/// * `-o <flags>` are the numeric `open(2)` flags.
pub fn authopen_args(device_path: &str, open_flags: i32, use_extauth: bool) -> Vec<String> {
    let mut args = vec!["-stdoutpipe".to_string()];
    if use_extauth {
        args.push("-extauth".to_string());
    }
    args.push("-o".to_string());
    args.push(open_flags.to_string());
    args.push(device_path.to_string());
    args
}

/// Message shown when macOS refuses access to the device despite the user
/// having authenticated as an administrator.
///
/// `authopen` elevates, but it does not bypass TCC: access to removable media
/// is attributed to the responsible process, which is this application. So a
/// successful authorization followed by `EACCES`/`EPERM` means the removable
/// volumes privacy setting, not the admin password.
pub fn removable_volumes_message(device_id: &str) -> String {
    format!(
        "macOS blocked access to {device_id}. Administrator access was granted, so this is the \
         removable volumes privacy setting rather than the password: open System Settings > \
         Privacy & Security > Files and Folders, allow \"Home Assistant Installer\" access to \
         Removable Volumes, and try again."
    )
}

/// Message shown when the device could not be opened or written because
/// something else is holding it.
pub fn device_busy_message(device_id: &str) -> String {
    format!(
        "{device_id} is still in use. Its volumes are unmounted before writing starts, so \
         something remounted them or is holding the device open — Spotlight indexing, Time \
         Machine, Disk Utility or an open Finder window. Close those, unplug and reconnect the \
         drive, then try again."
    )
}

/// Map an I/O error from the privileged device descriptor onto an [`Error`].
///
/// `bytes_done` and `total_size` are only used to make the out-of-space message
/// concrete; they are ignored for every other errno.
pub fn map_device_io_error(
    err: std::io::Error,
    device_id: &str,
    bytes_done: u64,
    total_size: u64,
) -> Error {
    // Checked first so an unplugged drive keeps reporting as a disconnect
    // rather than as whichever errno the kernel happened to return.
    if super::is_drive_disconnected(&err) {
        return Error::DriveDisconnected;
    }

    match err.raw_os_error() {
        Some(ENOSPC) => Error::ImageTooLarge {
            written: bytes_done,
            image_size: total_size,
        },
        Some(EBUSY) => Error::DeviceBusy(device_busy_message(device_id)),
        Some(EACCES) | Some(EPERM) => Error::PermissionDenied(removable_volumes_message(device_id)),
        _ => Error::Io(err),
    }
}

/// Turn a failed `authopen` run into an [`Error`].
///
/// Called when the handshake produced no descriptor. `authopen` reports file
/// errors as `authopen: <path>: <strerror(errno)>`, which is the only detail
/// available about why the open failed, so the well-known `strerror` strings
/// are matched before falling back to the exit status.
pub fn classify_authopen_failure(exit_code: Option<i32>, stderr: &str, device_id: &str) -> Error {
    let haystack = stderr.to_ascii_lowercase();

    if haystack.contains("cancel") {
        return Error::Cancelled;
    }
    if haystack.contains("resource busy") || haystack.contains("device busy") {
        return Error::DeviceBusy(device_busy_message(device_id));
    }
    if haystack.contains("permission denied")
        || haystack.contains("operation not permitted")
        || haystack.contains("not authorized")
        || haystack.contains("denied")
    {
        return Error::PermissionDenied(removable_volumes_message(device_id));
    }
    if haystack.contains("no such file") || haystack.contains("device not configured") {
        return Error::DriveDisconnected;
    }

    let detail = stderr.trim();
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    };

    match exit_code {
        Some(code) => Error::PermissionDenied(format!(
            "authopen exited with status {code} without returning a descriptor for \
             {device_id}{detail}"
        )),
        None => Error::PermissionDenied(format!(
            "authopen was terminated by a signal without returning a descriptor for \
             {device_id}{detail}"
        )),
    }
}

/// Whether a failed `F_FULLFSYNC` can be ignored.
///
/// `/dev/rdiskN` is a character device that bypasses the buffer cache, so on
/// some devices there is simply nothing to flush and the kernel says so rather
/// than succeeding. Those answers mean "already durable", not "write lost".
pub fn full_sync_failure_is_benign(errno: i32) -> bool {
    // ENOTTY, EINVAL, ENOTSUP/EOPNOTSUPP as defined on macOS.
    matches!(errno, 25 | 22 | 45 | 102)
}

/// Read from `source` until `buffer` is full or the source is exhausted, and
/// return how many bytes were read.
///
/// Partial reads have to be stitched back together here rather than written
/// straight through: every write to the raw device must be a whole number of
/// blocks, so a short read in the middle of the image would otherwise produce
/// a misaligned write that the device rejects with `EINVAL`.
pub fn fill_buffer<R: std::io::Read>(source: &mut R, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match source.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    Ok(filled)
}

/// Map an `OSStatus` from Authorization Services onto an [`Error`].
///
/// Distinguishing "the user pressed Cancel" from "authorization failed" is the
/// whole reason this is a separate function: cancelling is a normal outcome and
/// should not be reported as a write failure.
pub fn map_authorization_status(code: i32, context: &str) -> Error {
    // From <Security/AuthorizationTags.h>.
    const ERR_AUTHORIZATION_DENIED: i32 = -60005;
    const ERR_AUTHORIZATION_CANCELED: i32 = -60006;
    const ERR_AUTHORIZATION_INTERACTION_NOT_ALLOWED: i32 = -60007;
    const ERR_AUTHORIZATION_EXTERNALIZE_NOT_ALLOWED: i32 = -60009;

    match code {
        ERR_AUTHORIZATION_CANCELED => Error::Cancelled,
        ERR_AUTHORIZATION_DENIED => {
            Error::PermissionDenied("Administrator access was denied".to_string())
        }
        ERR_AUTHORIZATION_INTERACTION_NOT_ALLOWED => Error::PermissionDenied(
            "macOS refused to show the administrator prompt. Run the application from the \
             desktop rather than over SSH or from a background service."
                .to_string(),
        ),
        ERR_AUTHORIZATION_EXTERNALIZE_NOT_ALLOWED => Error::PermissionDenied(
            "macOS refused to share this authorization with authopen (errAuthorization\
             ExternalizeNotAllowed)."
                .to_string(),
        ),
        other => Error::PermissionDenied(format!("{context} failed with status {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn align_up_rounds_to_the_next_block() {
        assert_eq!(align_up(0, 512), 0);
        assert_eq!(align_up(1, 512), 512);
        assert_eq!(align_up(512, 512), 512);
        assert_eq!(align_up(513, 512), 1024);
        assert_eq!(align_up(4095, 4096), 4096);
        assert_eq!(align_up(4096, 4096), 4096);
    }

    #[test]
    fn align_up_with_zero_block_size_is_the_identity() {
        // Cannot happen after sanitize_block_size, but the helper must not divide by zero.
        assert_eq!(align_up(1234, 0), 1234);
    }

    #[test]
    fn sanitize_block_size_accepts_real_device_block_sizes() {
        assert_eq!(sanitize_block_size(512), 512);
        assert_eq!(sanitize_block_size(4096), 4096);
        assert_eq!(sanitize_block_size(2048), 2048);
    }

    #[test]
    fn sanitize_block_size_rejects_implausible_values() {
        assert_eq!(sanitize_block_size(0), DEFAULT_BLOCK_SIZE);
        assert_eq!(sanitize_block_size(513), DEFAULT_BLOCK_SIZE); // not a power of two
        assert_eq!(sanitize_block_size(u64::MAX), DEFAULT_BLOCK_SIZE);
        assert_eq!(sanitize_block_size(MAX_BLOCK_SIZE * 2), DEFAULT_BLOCK_SIZE);
    }

    #[test]
    fn aligned_buffer_size_keeps_64_mib_when_it_already_divides() {
        let sixty_four_mib = 64 * 1024 * 1024;
        assert_eq!(aligned_buffer_size(sixty_four_mib, 512), sixty_four_mib);
        assert_eq!(aligned_buffer_size(sixty_four_mib, 4096), sixty_four_mib);
    }

    #[test]
    fn aligned_buffer_size_is_always_a_whole_number_of_blocks() {
        for block_size in [512u64, 1024, 2048, 4096, 8192] {
            for desired in [1usize, 1000, 100_000, 64 * 1024 * 1024 + 1] {
                let size = aligned_buffer_size(desired, block_size);
                assert_eq!(
                    size as u64 % block_size,
                    0,
                    "{size} is not a multiple of {block_size}"
                );
                assert!(size >= desired, "{size} shrank below {desired}");
            }
        }
    }

    #[test]
    fn aligned_buffer_size_is_never_smaller_than_one_block() {
        assert_eq!(aligned_buffer_size(0, 4096), 4096);
        assert_eq!(aligned_buffer_size(1, 4096), 4096);
    }

    #[test]
    fn pad_final_block_zero_fills_the_tail() {
        let mut buffer = vec![0xAAu8; 2048];
        let padded = pad_final_block(&mut buffer, 1000, 512);

        assert_eq!(padded, 1024);
        assert!(
            buffer[..1000].iter().all(|b| *b == 0xAA),
            "data was clobbered"
        );
        assert!(
            buffer[1000..1024].iter().all(|b| *b == 0),
            "tail not zeroed"
        );
        // Untouched beyond the padded length.
        assert!(buffer[1024..].iter().all(|b| *b == 0xAA));
    }

    #[test]
    fn pad_final_block_is_a_no_op_on_an_exact_multiple() {
        let mut buffer = vec![0xAAu8; 2048];
        let padded = pad_final_block(&mut buffer, 1024, 512);

        assert_eq!(padded, 1024);
        assert!(buffer.iter().all(|b| *b == 0xAA));
    }

    #[test]
    fn pad_final_block_handles_a_full_buffer() {
        let mut buffer = vec![0xAAu8; 4096];
        assert_eq!(pad_final_block(&mut buffer, 4096, 4096), 4096);
    }

    #[test]
    fn pad_final_block_never_runs_past_the_buffer() {
        // A buffer that is not a whole number of blocks cannot be produced by
        // aligned_buffer_size, but clamping keeps this memory-safe regardless.
        let mut buffer = vec![0u8; 600];
        assert_eq!(pad_final_block(&mut buffer, 600, 512), 600);
    }

    #[test]
    fn pad_final_block_of_an_empty_chunk_writes_nothing() {
        let mut buffer = vec![0xAAu8; 1024];
        assert_eq!(pad_final_block(&mut buffer, 0, 512), 0);
    }

    #[test]
    fn authopen_args_use_extauth_and_numeric_open_flags() {
        assert_eq!(
            authopen_args("/dev/rdisk4", O_RDWR, true),
            vec!["-stdoutpipe", "-extauth", "-o", "2", "/dev/rdisk4"]
        );
    }

    #[test]
    fn authopen_args_without_extauth_let_authopen_prompt() {
        assert_eq!(
            authopen_args("/dev/rdisk4", O_RDWR, false),
            vec!["-stdoutpipe", "-o", "2", "/dev/rdisk4"]
        );
    }

    #[test]
    fn authopen_args_always_end_with_the_device_path() {
        let args = authopen_args("/dev/rdisk11", O_RDWR, true);
        assert_eq!(args.last().unwrap(), "/dev/rdisk11");
    }

    #[test]
    fn o_rdwr_matches_the_macos_header_value() {
        // authopen takes the numeric flags, so a wrong constant silently opens
        // the device read-only and every write fails with EBADF.
        assert_eq!(O_RDWR, 2);
    }

    #[test]
    fn enospc_becomes_image_too_large() {
        let err = map_device_io_error(
            std::io::Error::from_raw_os_error(ENOSPC),
            "/dev/rdisk4",
            3_000_000_000,
            4_000_000_000,
        );

        match err {
            Error::ImageTooLarge {
                written,
                image_size,
            } => {
                assert_eq!(written, 3_000_000_000);
                assert_eq!(image_size, 4_000_000_000);
            }
            other => panic!("expected ImageTooLarge, got {other:?}"),
        }
        assert!(err_text(ENOSPC).contains("larger than the selected drive"));
    }

    fn err_text(errno: i32) -> String {
        map_device_io_error(
            std::io::Error::from_raw_os_error(errno),
            "/dev/rdisk4",
            0,
            1,
        )
        .to_string()
    }

    #[test]
    fn ebusy_becomes_device_busy_naming_the_device() {
        let err = map_device_io_error(
            std::io::Error::from_raw_os_error(EBUSY),
            "/dev/rdisk4",
            0,
            1,
        );

        match err {
            Error::DeviceBusy(msg) => {
                assert!(msg.contains("/dev/rdisk4"), "{msg}");
                assert!(msg.contains("unmounted"), "{msg}");
            }
            other => panic!("expected DeviceBusy, got {other:?}"),
        }
    }

    #[test]
    fn eacces_and_eperm_point_at_the_privacy_setting() {
        for errno in [EACCES, EPERM] {
            let err = map_device_io_error(
                std::io::Error::from_raw_os_error(errno),
                "/dev/rdisk4",
                0,
                1,
            );
            match err {
                Error::PermissionDenied(msg) => {
                    assert!(msg.contains("Removable Volumes"), "{errno}: {msg}");
                    assert!(msg.contains("Privacy & Security"), "{errno}: {msg}");
                }
                other => panic!("expected PermissionDenied for {errno}, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_disconnect_still_wins_over_the_errno_mapping() {
        // ENXIO would otherwise fall through to Error::Io.
        let err = map_device_io_error(std::io::Error::from_raw_os_error(6), "/dev/rdisk4", 0, 1);
        assert!(matches!(err, Error::DriveDisconnected));

        let err = map_device_io_error(
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"),
            "/dev/rdisk4",
            0,
            1,
        );
        assert!(matches!(err, Error::DriveDisconnected));
    }

    #[test]
    fn an_unrecognised_errno_is_passed_through_as_io() {
        let err = map_device_io_error(
            std::io::Error::from_raw_os_error(5), // EIO
            "/dev/rdisk4",
            0,
            1,
        );
        match err {
            Error::Io(inner) => assert_eq!(inner.raw_os_error(), Some(5)),
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn authopen_cancellation_is_not_a_failure() {
        let err = classify_authopen_failure(Some(1), "authopen: canceled", "/dev/rdisk4");
        assert!(matches!(err, Error::Cancelled), "{err:?}");
    }

    #[test]
    fn authopen_busy_is_reported_as_device_busy() {
        let err = classify_authopen_failure(
            Some(1),
            "authopen: /dev/rdisk4: Resource busy",
            "/dev/rdisk4",
        );
        assert!(matches!(err, Error::DeviceBusy(_)), "{err:?}");
    }

    #[test]
    fn authopen_permission_errors_point_at_the_privacy_setting() {
        for stderr in [
            "authopen: /dev/rdisk4: Permission denied",
            "authopen: /dev/rdisk4: Operation not permitted",
        ] {
            let err = classify_authopen_failure(Some(1), stderr, "/dev/rdisk4");
            match err {
                Error::PermissionDenied(msg) => {
                    assert!(msg.contains("Removable Volumes"), "{stderr}: {msg}")
                }
                other => panic!("expected PermissionDenied for {stderr}, got {other:?}"),
            }
        }
    }

    #[test]
    fn authopen_missing_device_reads_as_a_disconnect() {
        let err = classify_authopen_failure(
            Some(1),
            "authopen: /dev/rdisk4: No such file or directory",
            "/dev/rdisk4",
        );
        assert!(matches!(err, Error::DriveDisconnected), "{err:?}");
    }

    #[test]
    fn an_unexplained_authopen_exit_still_names_the_status_and_device() {
        let err = classify_authopen_failure(Some(3), "", "/dev/rdisk4");
        match err {
            Error::PermissionDenied(msg) => {
                assert!(msg.contains("status 3"), "{msg}");
                assert!(msg.contains("/dev/rdisk4"), "{msg}");
            }
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
    }

    #[test]
    fn an_authopen_killed_by_a_signal_is_reported_as_such() {
        let err = classify_authopen_failure(None, "", "/dev/rdisk4");
        match err {
            Error::PermissionDenied(msg) => assert!(msg.contains("signal"), "{msg}"),
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
    }

    #[test]
    fn unexpected_authopen_output_is_kept_in_the_message() {
        let err = classify_authopen_failure(Some(1), "something went sideways", "/dev/rdisk4");
        assert!(err.to_string().contains("something went sideways"), "{err}");
    }

    #[test]
    fn a_raw_device_with_nothing_to_flush_is_not_an_error() {
        for errno in [25, 22, 45, 102] {
            assert!(full_sync_failure_is_benign(errno), "{errno}");
        }
    }

    #[test]
    fn a_real_flush_failure_is_not_swallowed() {
        for errno in [EACCES, EBUSY, ENOSPC, 5 /* EIO */] {
            assert!(!full_sync_failure_is_benign(errno), "{errno}");
        }
    }

    /// A reader that hands back at most `chunk` bytes per call, the way a pipe
    /// or a slow file read behaves.
    struct Dribble<'a> {
        data: &'a [u8],
        chunk: usize,
    }

    impl std::io::Read for Dribble<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let take = self.data.len().min(out.len()).min(self.chunk);
            out[..take].copy_from_slice(&self.data[..take]);
            self.data = &self.data[take..];
            Ok(take)
        }
    }

    #[test]
    fn fill_buffer_stitches_short_reads_into_a_full_buffer() {
        let data: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
        let mut source = Dribble {
            data: &data,
            chunk: 7,
        };
        let mut buffer = vec![0u8; 4096];

        assert_eq!(fill_buffer(&mut source, &mut buffer).unwrap(), 4096);
        assert_eq!(buffer, data);
    }

    #[test]
    fn fill_buffer_stops_at_the_end_of_the_source() {
        let data = vec![1u8; 100];
        let mut source = Dribble {
            data: &data,
            chunk: 8,
        };
        let mut buffer = vec![0u8; 4096];

        assert_eq!(fill_buffer(&mut source, &mut buffer).unwrap(), 100);
        assert!(buffer[..100].iter().all(|b| *b == 1));
        assert!(buffer[100..].iter().all(|b| *b == 0));
    }

    #[test]
    fn fill_buffer_reports_nothing_at_eof() {
        let mut source = Dribble {
            data: &[],
            chunk: 8,
        };
        let mut buffer = vec![0u8; 512];
        assert_eq!(fill_buffer(&mut source, &mut buffer).unwrap(), 0);
    }

    #[test]
    fn fill_buffer_retries_after_an_interrupt() {
        struct InterruptOnce {
            interrupted: bool,
        }

        impl std::io::Read for InterruptOnce {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "signal",
                    ));
                }
                out[..4].fill(9);
                Ok(4)
            }
        }

        let mut source = InterruptOnce { interrupted: false };
        let mut buffer = vec![0u8; 4];
        assert_eq!(fill_buffer(&mut source, &mut buffer).unwrap(), 4);
        assert_eq!(buffer, vec![9u8; 4]);
    }

    #[test]
    fn fill_buffer_propagates_a_real_error() {
        struct Broken;

        impl std::io::Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from_raw_os_error(5))
            }
        }

        let mut buffer = vec![0u8; 16];
        let err = fill_buffer(&mut Broken, &mut buffer).unwrap_err();
        assert_eq!(err.raw_os_error(), Some(5));
    }

    #[test]
    fn the_default_block_size_is_safe_on_512_byte_devices() {
        // A multiple of the 4 KiB fallback is always a multiple of 512, which
        // is what makes over-estimating safe and under-estimating not.
        assert_eq!(DEFAULT_BLOCK_SIZE % 512, 0);
    }

    #[test]
    fn cancelling_the_dialog_maps_to_cancelled_not_permission_denied() {
        assert!(matches!(
            map_authorization_status(-60006, "Authorization"),
            Error::Cancelled
        ));
    }

    #[test]
    fn a_denied_authorization_is_permission_denied() {
        match map_authorization_status(-60005, "Authorization") {
            Error::PermissionDenied(msg) => assert!(msg.contains("denied"), "{msg}"),
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
    }

    #[test]
    fn a_headless_session_explains_why_no_prompt_appeared() {
        match map_authorization_status(-60007, "Authorization") {
            Error::PermissionDenied(msg) => assert!(msg.contains("SSH"), "{msg}"),
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_authorization_status_keeps_the_code_and_context() {
        match map_authorization_status(-60008, "Externalizing the authorization") {
            Error::PermissionDenied(msg) => {
                assert!(msg.contains("-60008"), "{msg}");
                assert!(msg.contains("Externalizing the authorization"), "{msg}");
            }
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
    }
}
