# Contributing to Home Assistant Installer

Thank you for your interest in contributing! This document provides guidelines
and instructions for contributing.

## Getting Started

### Prerequisites

- Rust (via rustup)
- Node.js 24+
- Platform-specific Tauri dependencies

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

### Running Tests

```bash
# Type-check source and tests
npm run typecheck

# All tests
npm test

# Unit tests only
npm run test:unit

# E2E tests
npm run test:e2e

# Rust tests
cargo test --workspace
```

### Windows Installer Identity

NSIS uses the product name and publisher for its installation identity. Keep
**Home Assistant Installer** and the identifier `io.home-assistant.installer`
stable; the publisher defaults from the identifier. Automatic migration from a
preview MSI to NSIS is not promised.

### Shared Wire Types

`src/api/types.ts` is generated from the Rust types in `hai-core`. After changing
an IPC request, response, or progress type, run `npm run generate:types` and commit
the output. Register new shared types in `types/bindings.rs`. The generator runs
only in tests and preserves serde names and nullable `Option` fields. JSON integer
fields remain TypeScript `number`, matching Tauri's existing wire representation
and precision limits. `ExpectedDevice` request fields also allow omission, as
accepted by serde; response fields with `None` are required nullable values.
CI checks the committed file without rewriting it. Handwritten command wrappers
remain in `src/api/commands.ts`; this does not generate command bindings.

## Development Guidelines

### Frontend Localization

Frontend-owned copy lives in `src/localization/en.json`, a flat keyed JSON
catalog with ICU MessageFormat placeholders and plurals. This is compatible
with Lokalise's JSON/ICU format; no translation service configuration is
required to develop locally. English is the only shipped language.

Use `localize` for text and attributes, and `localizeContent` for sentences
containing code-owned Lit placeholders (for example, a link or emphasized
drive name). Catalog values must never contain HTML. Keep whole sentences
together and use ICU plurals instead of assembling English suffixes. Keys
are type-checked; `npm run localization:check` checks every call's placeholder
names, catalog syntax, and unused entries in CI.

Choose semantic keys for a specific UI meaning, not merely identical English
wording, and named placeholders such as `version` or `drive`. Storage pools
and virtual disks have separate keys even when both say "Storage". Before the
first translation upload, review the initial extracted keys and positional
placeholders for concise, stable names and translator context; no keys have
been published to a translation service yet.

Startup reads the OS locale through Tauri's locale-only command permission before
loading component modules. Browser development uses `navigator.languages`.
Only English locales are currently supported: regional English tags retain
their `Intl` number formatting, while unsupported/invalid preferences fall
back to the next supported preference or `en`. Native lookup failures or a
one-second timeout also fall back, so locale detection cannot leave an empty
window. Locale selection happens once at startup, not during a running flow.
The OS plugin also injects static platform/version/architecture/family/type,
executable-extension and line-ending metadata into the first-party webview;
these fields are not gated by command permissions. Other OS commands,
including hostname, are not permitted by this capability.

Use `formatNumber` or ICU number placeholders for displayed numbers. Preserve
the existing unit basis and rounding: byte formatting uses decimal units
(1000 bytes is 1 KB) with its existing B/KB/MB/GB/TB labels. IDs, version strings,
URLs, filenames, IPC names, state keys, and device names are data, not messages.

Backend errors carry a fixed `code`. The frontend maps known codes to fixed
English messages in `src/utils/installer-error.ts`; moving that map into the
catalog is a follow-up. Never infer a code from English error text. Copy added by other branches must be extracted when
those changes are integrated.

### Code Style

- **Rust**: Follow `rustfmt` defaults, run `cargo fmt` before committing
- **TypeScript**: Follow ESLint config, run `npm run lint` before committing
- **Commits**: Use [Conventional Commits](https://www.conventionalcommits.org/)

### Commit Message Format

```
type(scope): description

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:

- `feat(proxmox): add node selection dropdown`
- `fix(flash): handle USB disconnect during write`
- `docs: update installation instructions`

### Branch Naming

- `feat/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation
- `refactor/description` - Code refactoring

### Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Ensure all tests pass
5. Submit a pull request

### Design Principles

When contributing UI changes, remember:

1. **Visual-first**: The UI should be understandable without reading text
2. **Use icons and images**: Every option should have a visual identity
3. **Follow HA branding**: Use Home Assistant colors and style
4. **Include Casita**: Use the mascot for personality in appropriate places

## Storage Capacity

Board entries in the bundled manifest define minimum and recommended nominal
drive capacities in decimal bytes. The initial policy is 16 GB minimum and
32 GB recommended: the [Home Assistant FAQ](https://www.home-assistant.io/faq/)
recommends 32 GB, while the
[ODROID guide](https://www.home-assistant.io/installation/odroid/) lists 16 GB
eMMC configurations.

Reported capacity may be up to 5% below the nominal capacity to account for
manufacturer-reserved space. For example, the 16 GB and 32 GB classes require
at least 15.2 GB and 30.4 GB reported capacity, respectively. Keep the frontend
classification and native minimum check consistent. This allowance never
applies to the separate exact-byte check that the extracted image fits the
drive. Display reported capacity using the shared decimal formatter; do not
substitute a nominal label or use display rounding to decide eligibility.

## Getting Help

- [Home Assistant Discord](https://discord.gg/home-assistant)
- [Community Forum](https://community.home-assistant.io/)

## License

By contributing, you agree that your contributions will be licensed under the
Apache 2.0 License.

## AI policy

This project follows the [Open Home Foundation AI Policy](AI_POLICY.md). In
short: AI tools are welcome as an aid, but you must fully understand and be
able to explain every change you submit. Contributions made by autonomous
agents are not accepted.
