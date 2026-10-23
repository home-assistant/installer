# CI/CD (GitHub Actions)

## Principles

- **Immutable releases**: Once a version is released, it cannot be changed
- **Signed artifacts**: Release binaries are signed where the platform has a
  signing scheme we've set up (macOS today; Windows is #158)
- **Reproducible builds**: Same commit = same output
- **Multi-platform**: Build and test on macOS, Windows, Linux

---

## Workflow: CI

Everything runs in one workflow,
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml); there is no
separate release workflow. It runs on every pull request, on every push to
`main`, daily on `main` for the audits alone, and by hand to make a release. The workflow file is the reference for
the jobs and their steps; in short:

- **Audit** jobs check `package-lock.json` (`npm audit`) and `Cargo.lock`
  (`cargo audit`) for known vulnerabilities. On a pull request, `cargo audit`
  only runs when the pull request changes `Cargo.lock`.
- **zizmor** lints the workflow itself.
- **Lint** jobs run ESLint, Prettier, the TypeScript type check, the
  localization catalog check, `cargo fmt`, `cargo shear` and Clippy (on all
  three platforms, since the disk code is split per OS).
- **Test** jobs run the frontend unit tests, the Playwright E2E tests in
  Chromium and WebKit (each split across three jobs), and the Rust tests on
  all three platforms. Frontend and Linux backend coverage go to Codecov.
- **Build** produces the installers for each platform and uploads each one as
  an unarchived workflow artifact. On pushes to `main` and in release runs,
  the macOS build is signed and notarized (see
  [Required Secrets](#required-secrets)).

A new push to a pull request cancels the run for the push before it. Only
runs on `main` save the cargo and apt caches; pull requests restore them but
don't write their own, so they don't push `main`'s caches out of the 10 GB
GitHub keeps per repository.

---

## Releases

A release is made by running the CI workflow on `main` from the Actions tab
(**Run workflow**) and choosing a channel: `alpha`, `beta` or `stable`. The
run tests and builds everything like a push to `main`, and its `release` job
creates the GitHub release as a draft once every other job has passed. Nothing
is published automatically, so each release can be finished by hand (its
image added, its notes edited) before it goes out:

- **Alpha:** a draft prerelease, which anyone with write access may publish.
- **Beta:** a draft prerelease, which an admin publishes.
- **Stable:** a draft, which an admin publishes.

### Versions

The run picks the version itself (`scripts/next-version.mjs`) from the
existing version tags:

- **Until the first stable release**, versions are prereleases of `0.0.0`:
  `0.0.0-alpha.1`, `0.0.0-alpha.2`, …, then `0.0.0-beta.1`, …
- **From the first stable release on**, versions are calendar versions,
  `YEAR.MONTH.PATCH` without zero padding: the first release in a month is
  `2026.11.0`, the next one in the same month `2026.11.1`, and the first one in
  the following month `2026.12.0`.
- **Alphas and betas after that** are prereleases of the next stable version:
  `2026.12.0-beta.1`, `2026.12.0-beta.2`, …

Prerelease numbers count up per channel. Once a version has a beta, the run
refuses to make an alpha of it, since that would sort before the beta. The
month is the month of the run, in UTC. Version tags have no `v` prefix.

The version only exists in the release run. The workspace `Cargo.toml` on
`main` stays at `0.0.0`, and each build job of a release run writes the
version there in its own checkout before building. Nothing is committed for a
release.

### A release run

A release run differs from a push to `main` in these ways:

- **Only from `main`, and only by the right people:** the `version` job fails
  if the run is on any other branch, or if a beta or stable run was started
  (or re-run) by anyone but an admin. Anyone with write access may release an
  alpha. The build and release jobs wait for the `version` job, so nothing is
  built if a check fails. Who may publish is limited separately, by the tag
  rulesets (see [Immutable Release Protections](#immutable-release-protections)).
- **No caches:** no job restores the npm, cargo, apt or Playwright cache, so
  the installers and the tests that gate them never depend on what another
  run wrote.
- **Version:** the `version` job picks the version once, and each build job
  writes it into `Cargo.toml` and checks that Cargo picked it up before it
  builds anything.
- **Release job:** downloads the installers the build jobs uploaded, creates a
  signed [SLSA build provenance](https://slsa.dev/provenance/) attestation for
  each installer with `actions/attest`, and creates the release with
  `gh release create`. There is no `SHA256SUMS` file: GitHub records the
  SHA-256 of every release asset itself, and the attestations cover both
  integrity and origin.

The release targets the commit the run built, and GitHub creates the tag on
that commit when the draft is published. Once it's out it is immutable, so
anything to add to a release goes into the draft first.

A draft has no tag until it's published. Until then, another
release run on the same channel picks the same version and replaces the draft
as a whole, notes and assets included, so re-running a failed release run is
safe. The release job refuses to touch a version that is already published or
tagged.

Alphas and betas are marked as prereleases.

### Release notes

Each release starts with a fixed note in the workflow (that the Windows installer
isn't signed yet), followed by GitHub's
[generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes):
the pull requests merged since the previous release, grouped by label as
configured in [`.github/release.yml`](../../.github/release.yml). They start
from:

- for an alpha or beta, the latest version tag, whatever its channel;
- for a stable release, the previous stable release, so its notes include
  everything its alphas and betas had. The first stable release lets GitHub
  pick.

Edit the notes in a draft before publishing if needed. The title and notes of
a published release can still be edited; its files and tag can't.

### Assets

A release contains the following. GitHub turns the spaces in the bundle names
into dots when they are uploaded.

| File | Platform |
|------|----------|
| `Home.Assistant.Installer_<version>_universal.dmg` | macOS, signed and notarized |
| `Home.Assistant.Installer_<version>_x64-setup.exe` | Windows (NSIS), not signed yet (#158) |
| `Home.Assistant.Installer_<version>_amd64.deb` | Linux |
| `Home.Assistant.Installer-<version>-1.x86_64.rpm` | Linux |
| `Home.Assistant.Installer_<version>_amd64.AppImage` | Linux |

Linux packages are not signed; the provenance attestation covers them.

---

## Verifying Downloads

GitHub shows the SHA-256 of every asset on the release page. To compare a
download against it (on macOS, `shasum -a 256` instead of `sha256sum`):

```bash
gh release view 2026.11.0 --repo home-assistant/installer --json assets \
  --jq '.assets[] | "\(.digest)  \(.name)"'
sha256sum Home.Assistant.Installer_2026.11.0_universal.dmg
```

Check that an installer was built by this repository's CI workflow on `main`,
with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify Home.Assistant.Installer_2026.11.0_universal.dmg \
  --repo home-assistant/installer \
  --signer-workflow home-assistant/installer/.github/workflows/ci.yml \
  --source-ref refs/heads/main
```

The output names the commit the installer was built from, which is the commit
the release's tag points to.

The attestation is signed with a short-lived Sigstore certificate tied to the
workflow run that built the installer, and recorded in the public Sigstore
transparency log, so there are no signing keys to manage or rotate.

---

## Immutable Release Protections

1. **Tag protection**: publishing a release creates its tag, so the tag
   rulesets decide who may publish which release:
   - "Version tags" covers every tag except alpha tags (`*-alpha.*`): only
     admins may create one, so only admins may publish a beta or stable
     release, and only admins may move or delete one.
   - "Alpha tags" covers `*-alpha.*`: anyone with write access may create
     one, so anyone with write access may publish an alpha, but nobody may
     move or delete one.

2. **Branch protection on main**:
   - Require PR reviews
   - Require status checks (all tests must pass)
   - No force pushes

3. **Release process**:
   - Releases are only made from `main`
   - Every release is created as a draft
   - Anyone with write access may start and publish an alpha
   - Betas and stable releases are started and published by admins
   - Immutable releases are enabled, so once a release is published, GitHub
     refuses any change to its assets or tag, including from the release job

4. **Checksums**: GitHub records the SHA-256 of every release asset and shows
   it on the release page and in the API.

5. **Provenance**: every installer has a signed build provenance attestation
   that ties it to the workflow run and the commit it was built from.

Anyone with write access can still run a changed copy of the workflow on
their own branch, so the checks inside the workflow only guard against
mistakes. What such a run can't do is enforced by GitHub instead: it gets no
Apple signing secrets (the `release` environment only allows `main`), it
can't publish a beta or stable release (the "Version tags" ruleset), and its
installers fail `gh attestation verify --source-ref refs/heads/main`.

Since anyone with write access may create alpha tags, they can also publish
an alpha release by hand, with any files attached. Its installers would have
no attestation from `main`, and nothing but an alpha can be released this
way.

---

## Required Secrets

The workflow uses no repository secrets.

Secrets of the protected `release` environment, which only `main` may deploy
to. The macOS build job binds to this environment on pushes to `main` and in
release runs, signs and notarizes the app and the DMG, and uploads the result.
Pull request builds don't reference the environment and stay unsigned.

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 export of the "Developer ID Application" certificate and its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password chosen when exporting the .p12 |
| `APPLE_SIGNING_IDENTITY` | Name of that certificate, e.g. `Developer ID Application: Open Home Foundation (TEAMID)`. Tauri refuses to sign if the imported certificate doesn't match it |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID (a UUID) |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_PRIVATE_KEY` | Contents of the `AuthKey_<key id>.p8` file |

The App Store Connect API key only needs the Developer role; it is used for
notarization alone. The job compiles with `tauri build --no-bundle` and only
then runs `tauri bundle` with the `APPLE_*` variables, so no npm or cargo build
script ever has the credentials in its environment. Tauri reads the variables
itself: it imports the certificate into a temporary keychain, signs the app
with the hardened runtime, notarizes and staples it, and signs the DMG. The
workflow then notarizes and staples the DMG too, since Gatekeeper assesses the
disk image when a download is opened, and verifies both with `codesign`,
`stapler` and `spctl`, the app from inside the mounted DMG, since Tauri
deletes its own copy after packing it.

---

## Release Process

1. Go to **Actions → CI → Run workflow**, keep the branch at `main`, choose the
   channel and run it
2. CI tests, builds and signs everything and creates the release as a draft;
   the run's summary names the version
3. Finish the draft: add the release image, review the notes and assets, and
   check that the macOS DMG opens without warnings
4. Publish it (creates the tag and makes the release immutable): anyone with
   write access for an alpha, an admin for a beta or stable release

The workspace `Cargo.toml` is the only place the app version lives, and a
release run is the only thing that sets it:

- The crates inherit it via `version.workspace = true`.
- `tauri.conf.json` has no `version`, so Tauri uses the `hai-desktop` crate
  version for the bundles and the runtime `PackageInfo`.
- Rust code reads it with `env!("CARGO_PKG_VERSION")` (e.g. the HTTP
  User-Agent).
- Builds from anything but a release run, including local builds, report
  `0.0.0`.
- `package.json` is private and never published; its version stays at `0.0.0`.

---

## Distribution

Installers are distributed as assets of the
[GitHub releases](https://github.com/home-assistant/installer/releases) only:
a DMG for macOS, an NSIS installer for Windows, and `.deb`, `.rpm` and
AppImage for Linux. There are no store or package repository listings.
