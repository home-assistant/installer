# Manual test plan — macOS flash path (authopen)

The privileged part of the macOS write path cannot be covered by automated
tests: it needs a real removable device, a real authorization dialog and a real
TCC decision. This checklist covers what the unit tests cannot.

Work through it on a Mac with a `tauri build` bundle — **not** `tauri dev`. The
elevation path depends on the Hardened Runtime, the entitlements and the
`Info.plist` usage string, and none of those apply to a `cargo run` binary.

## Building the bundle

The repository has no signing identity yet (that belongs to the CI work in
issues #1 and #2), so sign ad hoc for local testing:

```bash
npm install
APPLE_SIGNING_IDENTITY="-" npm run tauri build
```

Confirm the build actually picked up the new configuration before testing
anything else:

```bash
APP="target/release/bundle/macos/Home Assistant Installer.app"

# Hardened Runtime is on (look for the "runtime" flag)
codesign -d -vvv "$APP" 2>&1 | grep -i flags

# The entitlements were applied, and the App Sandbox is off
codesign -d --entitlements :- "$APP"

# The usage string reached the bundle
plutil -extract NSRemovableVolumesUsageDescription raw "$APP/Contents/Info.plist"
```

If any of those three is missing, stop: the rest of the plan will not be
testing what it claims to test.

## Preparation

- A USB stick or SD card you are willing to erase, **at least as large** as the
  image, plus a second one that is deliberately **smaller** than the image.
- Note the device id with `diskutil list` — the tests below refer to it as
  `diskN`.
- Note its block size, since that is what the new alignment code keys off:
  `diskutil info -plist diskN | plutil -extract DeviceBlockSize raw -`.
  Worth doing on both a 512-byte and a 4096-byte device if you have one of each.

---

## 1. Successful write and verify

1. Insert the larger device and let macOS mount it.
2. Flash an image with verification enabled.

Expected:

- [ ] **Exactly one** authentication dialog, at the start. This is the main
      thing this change is for — the old path could prompt a second time before
      verifying.
- [ ] The dialog names **Home Assistant Installer**, not `authopen`. If it says
      `authopen`, `-extauth` is not working and the external form is not being
      accepted.
- [ ] No further prompt when the progress bar moves from writing to verifying.
- [ ] Verification passes. (On the old code it could not: the verify read
      rounded the length up to a whole 64 MiB block and hashed the padding, so
      the digests only matched when the image happened to be an exact multiple.)
- [ ] The drive ejects at the end.
- [ ] Re-insert the drive and confirm the image actually boots, or at least that
      `diskutil list diskN` shows the image's partitions.

Worth repeating once with verification **off**, to confirm the write still
completes and ejects when the verify phase is skipped.

## 2. Image larger than the target device

The point of this case is the error message, which used to be a generic broken
pipe from `dd`.

Note that `flash_image` in `crates/hai-desktop/src/commands.rs` compares the
image size against the size the device reports and refuses early, so going
through the UI normally tests **that** check rather than the `ENOSPC` mapping.
To reach the new code path, either comment out that pre-check for the run, or
call `hai_core::disk_writer::write_image` directly from a scratch binary.

1. Select the deliberately-too-small device.
2. Start the flash.

Expected:

- [ ] The error says the **image is larger than the selected drive**, and
      reports how many of how many bytes fit.
- [ ] It is not "Write failed:", not a broken pipe, and not a bare I/O error.

## 3. Device pulled out mid-write

1. Start a flash onto the larger device.
2. Physically unplug it once the progress bar is moving.

Expected:

- [ ] The error is **Drive disconnected**, not a generic I/O failure.
- [ ] The application stays usable — no hang, no spinner that never resolves.
- [ ] Re-inserting the drive and flashing again works.

Worth also pulling the device during the **verify** phase, which is a separate
call site for the same mapping.

## 4. Cancelling the authentication dialog

1. Start a flash.
2. Press **Cancel** in the authentication dialog.

Expected:

- [ ] The message is a cancellation, not "Permission denied" and not an
      `authopen` failure. (`errAuthorizationCanceled` is −60006; the old code
      had −60005 and −60006 swapped, so a cancel reported as a denial.)
- [ ] Nothing was written: the device's existing content is intact.
- [ ] Retrying immediately afterwards prompts again and succeeds.

Also worth trying: enter a **wrong password** three times until the dialog gives
up. That is `errAuthorizationDenied` (−60005) and should read as
"Administrator access was denied", distinct from the cancel above.

## 5. First run from a clean TCC state

This is the case where elevating is *not* enough, and the one most likely to be
reported as "it asked for my password and then failed anyway".

```bash
tccutil reset SystemPolicyRemovableVolumes org.openhomefoundation.hai
```

Then, with the device inserted, flash it.

Expected:

- [ ] macOS asks for access to a removable volume, showing the text from
      `crates/hai-desktop/macos/Info.plist`. Read it as a user would and check
      it actually explains why.
- [ ] **Allow** → the flash proceeds normally, one admin prompt as in case 1.
- [ ] Reset again, and this time **Don't Allow** → the error points at
      *System Settings > Privacy & Security > Files and Folders > Removable
      Volumes*, and does **not** claim the password was wrong or that the
      device is busy.
- [ ] Granting access there and retrying succeeds without a rebuild.

Note that TCC keys off the signing identity, so an ad-hoc signed build is a
fresh subject every time it is rebuilt. Re-run the reset after any rebuild, and
expect to re-approve.

## 6. Device still mounted

1. Flash normally, but while the device is selected, open Disk Utility or a
   Finder window on the volume so something keeps a handle on it.

Expected:

- [ ] Either the unmount that runs before the write succeeds anyway (the usual
      case), or the error names the device and says it is still in use — it
      should not surface as a permission problem.

---

## What to record in the pull request

- macOS version and hardware (Apple silicon or Intel).
- The card reader or USB adapter used, and the device's block size.
- Whether the bundle was ad-hoc signed or signed with a real Developer ID, since
  TCC behaves differently between the two.
- Which of the cases above were actually exercised, and which were not.
