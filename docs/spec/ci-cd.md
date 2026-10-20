# CI/CD (GitHub Actions)

## Principles

- **Immutable releases**: Once a version is released, it cannot be changed
- **Signed artifacts**: All release binaries are signed
- **Reproducible builds**: Same commit = same output
- **Multi-platform**: Build and test on macOS, Windows, Linux

---

## Workflow: CI (on every push/PR and version tag)

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
    tags: ["[0-9]+.[0-9]+.[0-9]+", "[0-9]+.[0-9]+.[0-9]+-*"]
  pull_request:
    branches: [main]

env:
  CARGO_TERM_COLOR: always

jobs:
  test-rust:
    name: Rust Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          components: llvm-tools-preview

      - name: Install cargo-llvm-cov
        uses: taiki-e/install-action@cargo-llvm-cov

      - name: Cache cargo
        uses: Swatinem/rust-cache@v2

      - name: Run tests with coverage
        run: cargo llvm-cov --workspace --lcov --output-path lcov.info

      - name: Upload Rust coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: lcov.info
          flags: rust
          token: ${{ secrets.CODECOV_TOKEN }}

  test-frontend:
    name: Frontend Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests with coverage
        run: npm run test:unit -- --coverage

      - name: Upload frontend coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: crates/hai-desktop/frontend/coverage/lcov.info
          flags: frontend
          token: ${{ secrets.CODECOV_TOKEN }}

  test-e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
      
      - name: Install Tauri dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
      
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
      
      - name: Run E2E tests
        run: npm run test:e2e
      
      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7

  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Lint frontend
        run: npm run lint

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt

      - name: Rust format check
        run: cargo fmt --all --check

      - name: Rust clippy
        run: cargo clippy --workspace --all-targets -- -D warnings
```

---

## Codecov Configuration

```yaml
# codecov.yml
coverage:
  precision: 2
  round: down
  status:
    project:
      default:
        target: auto
        threshold: 2%
    patch:
      default:
        target: 80%

flags:
  rust:
    paths:
      - crates/hai-core/src/
      - crates/hai-desktop/src/
    carryforward: true
  frontend:
    paths:
      - crates/hai-desktop/frontend/src/
    carryforward: true

comment:
  layout: "reach,diff,flags,files"
  behavior: default
  require_changes: true
```

---

## Releases (on version tag)

There is no separate release workflow. Pushing a version tag, like `1.0.0` or
`1.0.0-beta.1` (no `v` prefix), runs the whole CI workflow on the tagged
commit, and its `release` job drafts the GitHub release once every other job
has passed. A maintainer reviews the draft and publishes it.

On a tag, the CI workflow differs from a push to `main` in these ways:

- **Version check:** each build job first checks that the tag is exactly the
  version in the workspace `Cargo.toml`, and fails before anything is built or
  signed if it isn't.
- **No caches:** no job restores the npm, cargo or Playwright cache, so the
  installers and the tests that gate them never depend on what another run
  wrote. zizmor flags every cache in a workflow with a tag trigger and can't
  see the `if: github.ref_type != 'tag'` conditions, hence the
  `zizmor: ignore[cache-poisoning]` comments on those steps.
- **Signing:** the macOS build binds to the `release` environment and signs
  and notarizes the app and the DMG, the same as on every push to `main` (see
  [Required Secrets](#required-secrets)). Windows installers are not signed yet
  (#158). Linux packages are not signed; the provenance attestation covers
  them.
- **Release job:** downloads the installers the build jobs uploaded, creates
  a signed [SLSA build provenance](https://slsa.dev/provenance/) attestation
  for each installer with `actions/attest`, and creates the draft release
  with generated notes using `softprops/action-gh-release`. There is no `SHA256SUMS` file: GitHub records the
  SHA-256 of every release asset itself, and the attestations cover both
  integrity and origin.

A version with a suffix, such as `1.0.0-beta.1`, is marked as a prerelease.
Re-running a failed tag run is safe: the release job finds the existing draft
and replaces its assets. The job itself doesn't check whether the release is
already published; with immutable releases enabled, GitHub refuses uploads to a
published release, so the job fails instead of changing it.

A release contains the following. GitHub turns the spaces in the bundle names
into dots when they are uploaded.

| File | Platform |
|------|----------|
| `Home.Assistant.Installer_<version>_universal.dmg` | macOS, signed and notarized |
| `Home.Assistant.Installer_<version>_x64-setup.exe` | Windows (NSIS) |
| `Home.Assistant.Installer_<version>_amd64.deb` | Linux |
| `Home.Assistant.Installer-<version>-1.x86_64.rpm` | Linux |
| `Home.Assistant.Installer_<version>_amd64.AppImage` | Linux |

---

## Verifying Downloads

GitHub shows the SHA-256 of every asset on the release page. To compare a
download against it (on macOS, `shasum -a 256` instead of `sha256sum`):

```bash
gh release view 1.0.0 --repo home-assistant/installer --json assets \
  --jq '.assets[] | "\(.digest)  \(.name)"'
sha256sum Home.Assistant.Installer_1.0.0_universal.dmg
```

Check that an installer was built by this repository's workflow from a release
tag, with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify Home.Assistant.Installer_1.0.0_universal.dmg \
  --repo home-assistant/installer \
  --signer-workflow home-assistant/installer/.github/workflows/ci.yml \
  --source-ref refs/tags/1.0.0
```

The attestation is signed with a short-lived Sigstore certificate tied to the
workflow run that built the installer, and recorded in the public Sigstore
transparency log, so there are no signing keys to manage or rotate.

---

## Immutable Release Protections

1. **Tag protection** (a tag ruleset for `[0-9]*`): only maintainers may create
   version tags, and nobody may move or delete one.

2. **Branch protection on main**:
   - Require PR reviews
   - Require status checks (all tests must pass)
   - No force pushes

3. **Release process**:
   - Releases are created as drafts
   - Manual review before publishing
   - Immutable releases are enabled, so once a release is published, GitHub
     refuses any change to its assets or tag, including from the release job

4. **Checksums**: GitHub records the SHA-256 of every release asset and shows
   it on the release page and in the API.

5. **Provenance**: every installer has a signed build provenance attestation
   that ties it to the workflow, the commit and the tag it was built from.

---

## Required Secrets

The workflow uses no repository secrets.

Secrets of the protected `release` environment, which only `main` and version
tags (the tag pattern `[0-9]*.[0-9]*.[0-9]*`) may deploy to. The macOS build
job of the CI workflow binds to this environment on pushes to `main` and on
version tags, signs and notarizes the app and the DMG, and uploads the result.
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

1. Bump `version` in the `[workspace.package]` section of the root `Cargo.toml` and run `cargo check` to refresh `Cargo.lock`
2. Create PR with version bump
3. Merge to main after review
4. Create and push a tag on the merged commit, without a `v` prefix: `git tag 1.0.0 && git push origin 1.0.0`
5. CI tests, builds and signs everything, and drafts the release
6. Review the draft release: notes, assets, and that the macOS DMG opens without warnings
7. Publish the release (makes it immutable)

The root `Cargo.toml` is the only place the app version lives:

- The crates inherit it via `version.workspace = true`.
- `tauri.conf.json` has no `version`, so Tauri uses the `hai-desktop` crate version for the bundles and the runtime `PackageInfo`.
- Rust code reads it with `env!("CARGO_PKG_VERSION")` (e.g. the HTTP User-Agent).
- `package.json` is private and never published; its version stays at `0.0.0` and is not bumped.

---

## Distribution

| Platform | Distribution Method |
|----------|---------------------|
| macOS | Direct download (.dmg), Homebrew Cask |
| Windows | Direct download (.msi/.exe), Microsoft Store |
| Linux | Direct download (.AppImage), Flathub, possibly .deb/.rpm |

Build automation via GitHub Actions to produce all artifacts on release.
