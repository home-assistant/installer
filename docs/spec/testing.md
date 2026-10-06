# Testing Strategy

## Overview

Testing is split into three layers: Rust unit tests, frontend component tests, and Playwright E2E tests. A mock mode enables testing flows without real hardware.

The workspace architecture allows testing hai-core independently from the Tauri integration, enabling better isolation and faster test cycles.

---

## 1. Rust Unit Tests

### hai-core Tests

Test core business logic independently of Tauri:

```rust
// crates/hai-core/src/download.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_parsing() {
        let json = r#"{"devices": [{"id": "rpi5", "name": "Raspberry Pi 5"}]}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.devices[0].id, "rpi5");
    }

    #[test]
    fn test_checksum_validation_success() {
        let data = b"test data";
        let hash = "sha256:...";
        assert!(validate_checksum(data, hash).is_ok());
    }

    #[test]
    fn test_checksum_validation_failure() {
        let data = b"test data";
        let wrong_hash = "sha256:wrong";
        assert!(validate_checksum(data, wrong_hash).is_err());
    }

    #[tokio::test]
    async fn test_manifest_cache_fallback() {
        // Test that cached manifest is used when fetch fails
    }
}
```

```rust
// crates/hai-core/src/devices.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_removable_devices() {
        let devices = vec![
            BlockDevice { device_type: DeviceType::SdCard, .. },
            BlockDevice { device_type: DeviceType::Internal, .. },
        ];
        let removable = filter_removable(&devices);
        assert_eq!(removable.len(), 1);
    }
}
```

### hai-desktop Tests

Test Tauri command wrappers and integration:

```rust
// crates/hai-desktop/src/commands.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_progress_adapter() {
        // Test TauriProgressAdapter converts correctly
    }
}
```

### Running Rust Tests

```bash
# Run all workspace tests
cargo test --workspace

# Run only hai-core tests
cargo test -p hai-core

# Run only hai-desktop tests
cargo test -p hai-desktop

# Run with verbose output
cargo test --workspace -- --nocapture
```

---

## 2. Frontend Component Tests (Web Test Runner)

Test Lit components in isolation.

```typescript
// test/unit/option-card.test.ts
import { fixture, html, expect } from '@open-wc/testing';
import '../../src/components/option-card.js';

describe('OptionCard', () => {
  it('renders title and description', async () => {
    const el = await fixture(html`
      <option-card 
        title="Raspberry Pi" 
        description="Flash an SD card">
      </option-card>
    `);
    
    expect(el.shadowRoot?.textContent).to.include('Raspberry Pi');
    expect(el.shadowRoot?.textContent).to.include('Flash an SD card');
  });

  it('dispatches select event on click', async () => {
    const el = await fixture(html`<option-card></option-card>`);
    
    let fired = false;
    el.addEventListener('select', () => fired = true);
    el.click();
    
    expect(fired).to.be.true;
  });

  it('applies selected state visually', async () => {
    const el = await fixture(html`<option-card selected></option-card>`);
    const card = el.shadowRoot?.querySelector('wa-card');
    
    expect(card?.hasAttribute('data-selected')).to.be.true;
  });
});
```

**Config:** `web-test-runner.config.js`
```javascript
export default {
  files: 'test/unit/**/*.test.ts',
  nodeResolve: true,
  plugins: [esbuildPlugin({ ts: true })],
};
```

**Run:** `npm run test:unit`

---

## 3. E2E Tests (Playwright)

Test complete user flows through the app.

### Welcome Screen Test

```typescript
// test/e2e/welcome.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Welcome Screen', () => {
  test('displays welcome message and proceeds on button click', async ({ page }) => {
    await page.goto('/');
    
    // Verify welcome screen content
    await expect(page.getByText('Welcome to your privacy-first')).toBeVisible();
    await expect(page.getByRole('button', { name: "Let's go" })).toBeVisible();
    await expect(page.locator('[alt="Open Home Foundation"]')).toBeVisible();
    
    // Click through
    await page.getByRole('button', { name: "Let's go" }).click();
    
    // Verify navigation to path selection
    await expect(page.getByText('What are you installing on?')).toBeVisible();
  });
});
```

### SBC Flow Test

```typescript
// test/e2e/sbc-flow.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Single Board Computer Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Enable mock mode
    await page.goto('/?mock=true');
    await page.getByRole('button', { name: "Let's go" }).click();
  });

  test('complete flow from path selection to confirmation', async ({ page }) => {
    // Select SBC path
    await page.getByRole('button', { name: /Raspberry Pi/i }).click();
    
    // Select specific device
    await page.getByRole('button', { name: 'Raspberry Pi 5' }).click();
    
    // Should show drive selection
    await expect(page.getByText('Select SD card')).toBeVisible();
    
    // Mock device should be available
    await page.getByText('Mock SD Card').click();
    await page.getByRole('button', { name: 'Next' }).click();
    
    // Should show confirmation
    await expect(page.getByText('Ready to install')).toBeVisible();
    await expect(page.getByText('Raspberry Pi 5')).toBeVisible();
    await expect(page.getByText('Mock SD Card')).toBeVisible();
  });

  test('back navigation works correctly', async ({ page }) => {
    await page.getByRole('button', { name: /Raspberry Pi/i }).click();
    await page.getByRole('button', { name: 'Raspberry Pi 5' }).click();
    
    // Go back
    await page.getByRole('button', { name: /back/i }).click();
    
    // Should be on device selection
    await expect(page.getByRole('button', { name: 'Raspberry Pi 5' })).toBeVisible();
  });
});
```

### Proxmox Flow Test

```typescript
// test/e2e/proxmox-flow.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Proxmox Flow', () => {
  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/?mock=true');
    await page.getByRole('button', { name: "Let's go" }).click();
    await page.getByRole('button', { name: /Proxmox/i }).click();
    
    // Fill invalid credentials
    await page.getByLabel('Server URL').fill('https://proxmox.local:8006');
    await page.getByLabel('Username').fill('root@pam');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Connect' }).click();
    
    // Should show error
    await expect(page.getByText(/authentication failed/i)).toBeVisible();
  });
});
```

### Toolbox Test

```typescript
// test/e2e/toolbox.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Toolbox Integration', () => {
  test('opens toolbox iframe and returns', async ({ page }) => {
    await page.goto('/');
    
    // Click toolbox button
    await page.getByRole('button', { name: /toolbox/i }).click();
    
    // Should show iframe with toolbox
    const iframe = page.frameLocator('iframe');
    await expect(iframe.locator('body')).toBeVisible();
    
    // Return to installer
    await page.getByRole('button', { name: /back to installer/i }).click();
    
    // Should be back on welcome
    await expect(page.getByText('Welcome to your privacy-first')).toBeVisible();
  });
});
```

### Playwright Config

```typescript
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
```

**Run:** `npm run test:e2e`

---

## 4. Mock Backend

Develop and test the desktop app without real hardware, a network connection, or a Proxmox/UTM host.

hai-core defines one trait per backend concern (`ReleaseSource`, `DeviceBackend`, `ProxmoxBackend`, `UtmBackend`, `HostBackend`) and two implementations:

- `hai_core::Backend` — the real implementation, delegating to the domain modules.
- `hai_core::BackendMock` — canned data and simulated progress, compiled only with the `mock` feature.

hai-desktop picks one at compile time in `crates/hai-desktop/src/backend.rs`; both are zero-sized unit structs, so the commands simply call `Backend.<method>()`. Release builds never contain mock code.

```bash
# Desktop app with the mock backend
npm run tauri dev -- --features mock

# Rust tests, including the ones that run the flows against the mock backend
cargo test --workspace --features hai-desktop/mock
```

Playwright E2E tests run in a plain browser without Tauri. There the frontend falls back to the fixtures in `src/api/mock-data.ts`; the Rust mock backend is not involved.

---

## Test Directory Structure

```
home-assistant-installer/
├── Cargo.toml                           # Workspace root
├── crates/
│   ├── hai-core/src/
│   │   ├── devices.rs                   # Contains inline unit tests
│   │   ├── download.rs                  # Contains inline unit tests
│   │   ├── flash.rs                     # Contains inline unit tests
│   │   ├── proxmox.rs                   # Contains inline unit tests
│   │   ├── utm.rs                       # Contains inline unit tests
│   │   └── mock/                        # BackendMock (feature "mock")
│   │
│   └── hai-desktop/
│       ├── src/
│       │   └── commands.rs              # Contains inline unit tests
│       └── frontend/
│           └── test/
│               └── unit/                # Frontend component tests
│                   ├── option-card.test.ts
│                   ├── device-card.test.ts
│                   └── ...
│
├── test/
│   └── e2e/
│       ├── navigation.spec.ts           # Basic navigation tests
│       ├── proxmox-flow.spec.ts         # Proxmox VE installation flow
│       └── utm-flow.spec.ts             # UTM VM creation flow (macOS)
├── playwright.config.ts
└── package.json
```

---

## npm Scripts

```json
{
  "scripts": {
    "test": "npm run test:unit && npm run test:rust",
    "test:rust": "cargo test --workspace",
    "test:unit": "cd crates/hai-desktop/frontend && web-test-runner",
    "test:e2e": "playwright test"
  }
}
```

### Running All Tests

```bash
# Run all tests (Rust + Frontend unit + E2E)
npm test && npm run test:e2e

# Run Rust workspace tests only
cargo test --workspace

# Run hai-core tests only (faster feedback during development)
cargo test -p hai-core

# Run frontend unit tests only
npm run test:unit

# Run E2E tests only
npm run test:e2e

# Run the desktop app with the mock backend
npm run tauri dev -- --features mock
```
