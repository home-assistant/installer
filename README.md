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
