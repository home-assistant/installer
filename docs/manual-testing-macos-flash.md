# Manual test plan — macOS flash path (authopen)

The privileged part of the macOS write path needs a real removable device, a
real authorization dialog and a real TCC decision, so it is not covered by the
automated tests. `cargo test -p hai-core` on a Mac does cover the raw-device
rules (block alignment, end of media, cache flush) against a RAM disk.

Use a `tauri build` bundle, not `tauri dev`: TCC keys off the bundle and its
`Info.plist`, which a `cargo run` binary does not have.

## Building the bundle

There is no signing identity yet (issues #1 and #2), so sign ad hoc:

```bash
npm install
APPLE_SIGNING_IDENTITY="-" npm run tauri build
```

Confirm the usage string reached the bundle before testing anything else:

```bash
APP="target/release/bundle/macos/Home Assistant Installer.app"
plutil -extract NSRemovableVolumesUsageDescription raw "$APP/Contents/Info.plist"
```

## Preparation

- A USB stick or SD card you are willing to erase, at least as large as the
  image, plus a second one that is smaller than the image.
- Note the device id with `diskutil list`; the cases below call it `diskN`.
- Note its block size:
  `diskutil info -plist diskN | plutil -extract DeviceBlockSize raw -`.
  Worth covering both a 512-byte and a 4096-byte device if available.

---

## 1. Successful write and verify

1. Insert the larger device and let macOS mount it.
2. Flash an image with verification enabled.

Expected:

- [ ] Exactly one authentication dialog, at the start.
- [ ] The dialog names **Home Assistant Installer**, not `authopen`.
- [ ] No further prompt when the progress bar moves from writing to verifying.
- [ ] Verification passes.
- [ ] The drive ejects at the end.
- [ ] Re-insert the drive and confirm the image boots, or at least that
      `diskutil list diskN` shows the image's partitions.

Repeat once with verification off.

## 2. Image larger than the target device

`flash_image` in `crates/hai-desktop/src/commands.rs` refuses early when the
image is larger than the size the device reports, so the UI normally never
reaches the end-of-device detection in the write loop. To reach it, comment out
that pre-check for the run, or call `hai_core::disk_writer::write_image`
directly from a scratch binary.

1. Select the smaller device.
2. Start the flash.

Expected:

- [ ] The error says the image is larger than the selected drive and reports
      how many of how many bytes fit.
- [ ] It is not prefixed with "Write failed:" and is not a bare I/O error.

## 3. Device pulled out mid-write

1. Start a flash onto the larger device.
2. Physically unplug it once the progress bar is moving.

Expected:

- [ ] The error is **Drive disconnected**, not a generic I/O failure.
- [ ] The application stays usable: no hang, no spinner that never resolves.
- [ ] Re-inserting the drive and flashing again works.

Also pull the device during the verify phase, which is a separate call site for
the same mapping.

## 4. Cancelling the authentication dialog

1. Start a flash.
2. Press **Cancel** in the authentication dialog.

Expected:

- [ ] The message is a cancellation, not "Permission denied" and not an
      `authopen` failure.
- [ ] Nothing was written: the device's existing content is intact.
- [ ] Retrying immediately afterwards prompts again and succeeds.

Also enter a wrong password until the dialog gives up. That should read as
"Administrator access was denied", distinct from the cancel above.

## 5. First run from a clean TCC state

This is the case where elevating is not enough, and the one most likely to be
reported as "it asked for my password and then failed anyway".

```bash
tccutil reset SystemPolicyRemovableVolumes org.openhomefoundation.hai
```

Then, with the device inserted, flash it.

Expected:

- [ ] macOS asks for access to a removable volume, showing the text from
      `crates/hai-desktop/macos/Info.plist`. Read it as a user would and check
      it actually explains why.
- [ ] **Allow**: the flash proceeds normally, one admin prompt as in case 1.
- [ ] Reset again, and this time **Don't Allow**: the error points at
      *System Settings > Privacy & Security > Files and Folders > Removable
      Volumes*, and does not claim the password was wrong or that the device
      is busy.
- [ ] Granting access there and retrying succeeds without a rebuild.

TCC keys off the signing identity, so an ad-hoc signed build is a fresh subject
every time it is rebuilt. Re-run the reset after any rebuild, and expect to
re-approve.

## 6. Device still mounted

1. Flash normally, but while the device is selected, open Disk Utility or a
   Finder window on the volume so something keeps a handle on it.

Expected:

- [ ] Either the unmount that runs before the write succeeds anyway (the usual
      case), or the error names the device and says it is still in use. It
      should not surface as a permission problem.

---

## What to record in the pull request

- macOS version and hardware (Apple silicon or Intel).
- The card reader or USB adapter used, and the device's block size.
- Whether the bundle was ad-hoc signed or signed with a real Developer ID, since
  TCC behaves differently between the two.
- Which of the cases above were actually exercised, and which were not.
