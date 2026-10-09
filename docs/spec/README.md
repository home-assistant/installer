# HAI - Home Assistant Installer Specification

## Overview

HAI (Home Assistant Installer) is a cross-platform desktop application that simplifies installing Home Assistant OS across multiple platforms. The app guides users through an intent-based flow, automatically handling image downloads, device preparation, and VM provisioning where supported.

- **Full name**: Home Assistant Installer
- **Short name**: HAI (also means "Hi!" in Dutch)
- **Binary name**: `hai`

## Architecture

HAI is structured as a Cargo workspace with shared core logic:

| Crate | Description |
|-------|-------------|
| **hai-core** | Shared Rust library with all business logic (device enumeration, downloads, flashing, Proxmox/UTM integration) |
| **hai-desktop** | Tauri desktop app with web frontend (Lit + Web Awesome) - thin wrappers around hai-core |

This architecture enables future additions like a TUI installer for live USB environments while sharing all core logic.

## Documentation Structure

| Document | Description |
|----------|-------------|
| [architecture.md](./architecture.md) | Tech stack, project structure, Tauri setup |
| [ui-design.md](./ui-design.md) | Visual-first philosophy, mockups, assets, branding |
| [user-flows.md](./user-flows.md) | All installation flows (SBC, mini PC, Proxmox, UTM) |
| [backend.md](./backend.md) | Rust commands, platform-specific code, manifest handling |
| [testing.md](./testing.md) | Test strategy, Playwright, mock mode |
| [ci-cd.md](./ci-cd.md) | GitHub Actions, releases, signing, cosign |
| [contributing.md](./contributing.md) | Issue templates, renovate, AI instructions |

## Quick Links

- [Contributing Guide](./contributing.md#contributing-guide)

## Target Platforms

The installer itself runs on:
- macOS (Apple Silicon and Intel)
- Windows
- Linux

## Installation Paths Supported

### Fully Automated
- Single Board Computers (Pi 3/4/5, ODROID, etc.) - Flash SD card
- Mini PC / NUC (Generic x86-64 or ARM64) - Flash connected SSD/NVMe
- Home Assistant Hardware (Yellow, Green) - Flash or restore
- Proxmox VE - API-driven VM creation
- macOS VM - Automated UTM setup

### Documentation Links Only
- Windows VMs (Hyper-V)
- Linux VMs (KVM, VirtualBox)
- Containers (Docker, Portainer)
- NAS devices (Unraid, Synology)

## Beta Error Reporting

For the first beta, do not add automatic diagnostic transmission or a reporting SDK. Use voluntary issue reports, with the manual diagnostics workflow tracked separately in [#152](https://github.com/home-assistant/installer/issues/152). That workflow is still pending; this decision does not implement logging, redaction, or a report-sharing UI.

After the first beta, review whether those reports leave actionable gaps in hardware and OS coverage before deciding on opt-in reporting in [#153](https://github.com/home-assistant/installer/issues/153). The post-beta evaluation and provider choice are still open. Before adding reporting:

- Get OHF agreement on a destination: hosted or self-hosted Sentry, or an OHF endpoint.
- Choose explicit consent per report or for recurring reporting, show exactly what would be sent, and allow consent to be withdrawn.
- Define and test scrubbing of credentials, tickets, hostnames, IPs, usernames, drive serials, and personal file paths.
- Document the destination, collected fields, retention, and withdrawal behavior in the app and README before any diagnostic transmission is enabled.
