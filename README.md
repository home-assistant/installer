# HAI - Home Assistant Installer

A cross-platform desktop application for installing Home Assistant OS on various hardware platforms.

## Features

- **Single Board Computers** - Flash SD cards for Raspberry Pi, ODROID, and more
- **Mini PCs** - Install on generic x86-64 or ARM64 devices
- **Home Assistant Hardware** - Flash or restore Yellow and Green devices
- **Proxmox VE** - Create Home Assistant VMs via API
- **UTM (macOS)** - Automated VM setup on Mac

## Installation

Download the latest release for your platform from the [Releases](https://github.com/home-assistant/installer/releases) page.

### Beta Platform Matrix

These are the proposed beta host requirements, not the architecture of the device
receiving Home Assistant OS. Minimum-version native acceptance testing is still
required before declaring the beta supported.

| Host | Architecture | Installer | Proposed minimum |
| ---- | ------------ | --------- | ---------------- |
| macOS | Apple Silicon and Intel, one universal binary | `.dmg` | macOS 14.5 |
| Windows | x64 | NSIS `.exe` | Windows 10 or 11 with current Evergreen WebView2 |
| Linux | x86_64 | `.deb`, `.rpm`, `.AppImage` | Ubuntu 22.04 / Debian 12 or newer, or a maintained Fedora release; see below |

Keep OS and web-view security updates installed. macOS 14.5 is a conservative beta
support-policy floor with [Safari 17.5-era WebKit](https://webkit.org/blog/15383/webkit-features-in-safari-17-5/),
not a proven technical minimum. Tauri's 10.13 default does not establish that the
modern Web Awesome UI works on those older systems.
Rust's Windows MSVC target [requires Windows 10 or newer](https://doc.rust-lang.org/rustc/platform-support/windows-msvc.html).
The Windows installer embeds the small WebView2 bootstrapper, which still needs
internet access to install the runtime. Downloading HAOS also requires internet.
Only NSIS is shipped; users of an earlier preview MSI should uninstall that preview
before installing the NSIS package. Automatic MSI-to-NSIS migration is not promised.

Linux builds use Ubuntu 22.04 to avoid requiring a newer glibc than 2.35. Native
packages also require GTK 3, WebKitGTK 4.1 with current distribution updates, and
`udisks2`; the latter is added to both package dependency lists. All Linux formats
need a desktop session with a polkit authentication agent. AppImage is the larger
portable alternative, but still needs the host's glibc and `udisks2` system
service. Its bundled WebKitGTK receives updates only when the AppImage is rebuilt,
not through the host's WebKitGTK package updates. Install host prerequisites with
your distribution's package manager and keep the installer updated. Flatpak is not
shipped: sandboxed access to raw disks and the host udisks2 service is not supported.

Linux ARM64, Windows ARM64, and 32-bit hosts are deferred for the beta. This does
not prevent an x64 host from flashing an ARM board. CI checks builds on the chosen
targets, including both macOS binary slices; it does not establish native launch,
macOS `authopen`/Automation consent, Windows elevation, Linux polkit, or real-disk
write/eject behavior on the minimum OS versions. Those checks remain release gates.

### Updating the installer

The installer does not check for updates or update itself. To update it, download and install a newer release for your platform from the Releases page linked above. This updates the installer application, not an existing Home Assistant installation.

## Privacy and Error Reporting

The installer does not automatically send error reports or diagnostic logs. For the first beta, feedback is voluntary through [GitHub issues](https://github.com/home-assistant/installer/issues). Review anything you share and remove credentials, hostnames, IP addresses, usernames, drive serials, and personal file paths; do not assume raw logs are redacted. The manual diagnostics workflow is tracked in [#152](https://github.com/home-assistant/installer/issues/152).

This does not make the installer offline: installation uses network requests for release metadata and images, the Proxmox server you configure, and Home Assistant readiness checks. Links you open also contact their destinations. These requests are separate from error reporting.

Opt-in reporting will be reconsidered after the first beta, as described in the [beta reporting decision](docs/spec/README.md#beta-error-reporting).

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (via rustup)
- [Node.js](https://nodejs.org/) 24+
- Platform-specific [Tauri dependencies](https://tauri.app/start/prerequisites/)

### Setup

```bash
# Clone the repository
git clone https://github.com/home-assistant/installer.git
cd installer

# Install dependencies
npm install

# Start development server
npm run tauri dev
```

### Commands

```bash
npm run tauri dev     # Start development server
npm run lint          # Run ESLint
npm run format        # Format code with Prettier
npm run test          # Run unit tests
npm run test:e2e      # Run E2E tests
```

### Mock Backend

For testing without real hardware, a network connection, or a Proxmox/UTM host, build the app with the mock backend. It is compiled in only with this feature flag, so release builds never contain it:

```bash
npm run tauri dev -- --features mock
```

## Tech Stack

- **Framework**: [Tauri 2.x](https://tauri.app/)
- **Backend**: Rust
- **Frontend**: [Lit](https://lit.dev/) + TypeScript
- **UI Components**: [Web Awesome](https://webawesome.com/)
- **Build**: [Vite](https://vite.dev/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

Apache 2.0 - See [LICENSE](LICENSE) for details.

---

Part of the [Open Home Foundation](https://www.openhomefoundation.org/)
