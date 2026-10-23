import { expect } from "@open-wc/testing";
import { render } from "lit";
import "../../src/components/app-shell.js";
import {
  formatDiskSize,
  formatMemory,
  formatRam,
} from "../../src/utils/format.js";
import messages from "../../src/localization/en.json";
import {
  setLanguage,
  type MessageKey,
} from "../../src/localization/localize.js";
import { DEFAULT_UTM_VM_NAME } from "../../src/state/vm-defaults.js";
import { wizardState } from "../../src/state/wizard-state.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "./tauri-ipc.js";

interface RenderView extends HTMLElement {
  render(): unknown;
}

function view(tag: string, fields: Record<string, unknown> = {}): RenderView {
  return Object.assign(
    document.createElement(tag),
    fields
  ) as unknown as RenderView;
}

/** What a view's wizard state controller would have heard, had it shown */
function select(element: RenderView, selections: Record<string, unknown>) {
  (element as unknown as { _wizard: { state: unknown } })._wizard.state = {
    ...wizardState.getState(),
    selections,
  };
}

// Detached views exercise the real templates without starting install pipelines.
function output(element: RenderView): HTMLDivElement {
  const container = document.createElement("div");
  render(element.render(), container);
  return container;
}

describe("localized view contracts", () => {
  const original = { ...messages };
  const now = Date.now;

  afterEach(() => {
    restoreTauriIpc();
    Object.assign(messages, original);
    setLanguage("en");
    Date.now = now;
    wizardState.reset();
  });

  function replace(key: MessageKey, text: string) {
    messages[key] = text;
    setLanguage("en");
  }

  it("preserves the default unnamed-drive warning and installed UTM version", () => {
    const dialog = output(view("app-shell")).querySelector(
      "confirm-dialog"
    ) as RenderView;
    expect(
      output(dialog).querySelector(".dialog-message")?.textContent?.trim()
    ).to.equal(
      "All data on the selected drive will be permanently erased. This action cannot be undone."
    );
    const utm = output(
      view("utm-check-view", {
        _loading: false,
        _utmStatus: { installed: true, version: "4.7" },
      })
    );
    expect(utm.querySelector(".status-title")?.textContent?.trim()).to.equal(
      "UTM is installed (v4.7)"
    );
  });

  it("uses whole unnamed-device success sentences and preserves named-device text", () => {
    const element = view("success-view");
    const insertStep = () =>
      (
        output(element).querySelector("install-success") as unknown as {
          steps: unknown[];
        }
      ).steps[1];
    expect(insertStep()).to.equal(
      "Insert the written storage into your device."
    );
    replace(
      "views.sbc.success_view.step_insert_storage_generic",
      "Insert fixture."
    );
    expect(insertStep()).to.equal("Insert fixture.");
    select(element, { deviceName: "Raspberry Pi 5" });
    expect(insertStep()).to.equal(
      "Insert the written storage into Raspberry Pi 5."
    );
  });

  for (const tag of [
    "confirmation-view",
    "proxmox-confirm-view",
    "utm-confirm-view",
  ]) {
    it(`${tag} localizes version failure separately from loading and a known version`, async () => {
      const element = view(tag) as RenderView & {
        _haosVersion: { hostConnected(): void };
      };
      // The board release lookup needs a selected board to ask for.
      select(element, { deviceConfig: { board: "rpi5-64" } });
      expect(output(element).textContent).to.contain("Loading...");
      mockTauriIpc((command) => {
        expect(command).to.equal("get_haos_release");
        throw new Error("Release lookup fixture failure");
      });
      // What showing the view does, without rendering it
      const load = () => {
        element._haosVersion.hostConnected();
        return settle();
      };
      await load();
      expect(output(element).textContent).to.contain("Version Unknown");
      expect(output(element).textContent).not.to.contain("Loading...");
      replace("common.version_unknown", "Unavailable release fixture");
      expect(output(element).textContent).to.contain(
        "Unavailable release fixture"
      );
      mockTauriIpc(() => ({ version: "17.0" }));
      await load();
      expect(output(element).textContent).to.contain("Version 17.0");
      expect(output(element).textContent).not.to.contain(
        "Unavailable release fixture"
      );
    });
  }

  it("uses a whole catalog warning when the app has no drive name", () => {
    wizardState.reset();
    replace(
      "components.confirm_dialog.erase_warning_unknown",
      "Unknown-target warning fixture."
    );
    const dialog = output(view("app-shell")).querySelector(
      "confirm-dialog"
    ) as RenderView & { driveName: string };
    expect(dialog.driveName).to.equal("");
    expect(
      output(dialog).querySelector(".dialog-message")?.textContent?.trim()
    ).to.equal("Unknown-target warning fixture.");
  });

  it("install-progress gets its pending ETA from the catalog", () => {
    replace("components.install_progress.calculating", "Pending ETA fixture");
    const content = output(
      view("install-progress", {
        stage: "downloading",
        totalBytes: 1024,
        bytesProcessed: 0,
      })
    );
    expect(content.textContent).to.contain("Pending ETA fixture");
    expect(content.textContent).not.to.contain("Calculating...");
  });

  it("lets the installed-version catalog own spacing, wrapping, and order", () => {
    replace(
      "views.utm.utm_check_view.installed_with_version",
      "{version}: installed fixture"
    );
    replace("views.utm.utm_check_view.version", "[release {version}]");
    const element = view("utm-check-view", {
      _loading: false,
      _utmStatus: { installed: true, version: "4.7" },
    });
    const content = output(element);
    expect(
      content.querySelector(".status-title")?.textContent?.trim()
    ).to.equal("[release 4.7]: installed fixture");
    expect(content.querySelector(".version-info")?.textContent).to.equal(
      "[release 4.7]"
    );
    Object.assign(element, { _utmStatus: { installed: true, version: null } });
    expect(
      output(element).querySelector(".status-title")?.textContent?.trim()
    ).to.equal("UTM is installed");
  });

  it("keeps the VM name placeholder as data and separates disk from pool labels", () => {
    replace("views.welcome_view.home_assistant", "Brand translation fixture");
    replace(
      "views.proxmox.proxmox_configure_view.storage_pool",
      "Pool fixture"
    );
    replace("utils.summary_styles.disk_storage", "Disk fixture");
    const utm = output(view("utm-configure-view"));
    expect(
      utm.querySelector("wa-input[placeholder]")?.getAttribute("placeholder")
    ).to.equal(DEFAULT_UTM_VM_NAME);
    for (const tag of ["utm-confirm-view", "proxmox-confirm-view"]) {
      const content = output(view(tag));
      expect(content.textContent).to.contain("Disk fixture");
      expect(content.textContent).not.to.contain("Pool fixture");
    }
    const labels = Array.from(
      output(
        view("proxmox-configure-view", { _loading: false })
      ).querySelectorAll("[label]"),
      (field) => field.getAttribute("label")
    );
    expect(labels).to.include("Pool fixture");
    expect(labels).not.to.include("Disk fixture");
  });

  // One byte a second, so the bytes left are the seconds left
  function eta(seconds: number): string | null {
    Date.now = () => 10000;
    const element = view("install-progress", {
      stageStartTime: 9000,
      stageStartBytes: 0,
      bytesProcessed: 1,
      totalBytes: seconds + 1,
    }) as unknown as { _calculateEta(): string | null };
    return element._calculateEta();
  }

  for (const [seconds, phrase] of [
    [59, "Less than a minute remaining"],
    [60, "About 1 minute remaining"],
    [3540, "About 59 minutes remaining"],
    // Rounded up to whole minutes first, so never "60 minutes" or "1h 60m"
    [3599, "About 1h 0m remaining"],
    [3600, "About 1h 0m remaining"],
    [7199, "About 2h 0m remaining"],
  ] as const) {
    it(`install-progress preserves the ${seconds}-second ETA boundary`, () => {
      expect(eta(seconds)).to.equal(phrase);
    });
  }

  it("install-progress takes the ETA's duration units from the locale", () => {
    setLanguage("en-CA");
    expect(eta(5400)).to.equal("About 1h 30min remaining");
  });

  it("uses regional Intl grouping in VM formatters without changing size units", () => {
    setLanguage("en-IN");
    const drive = view("drive-card", { driveSize: 1.5 * 1000 ** 4 });
    expect(output(drive).querySelector(".size")?.textContent).to.equal(
      "1.5 TB"
    );
    const confirmation = view("confirmation-view") as unknown as {
      _formatSize(bytes: number): string;
    };
    expect(confirmation._formatSize(1.25 * 1000 ** 4)).to.equal("1.2 TB");
    expect(formatMemory(123456 * 1024)).to.equal("1,23,456 GB");
    expect(formatDiskSize(1.5 * 1024)).to.equal("1.5 TB");
    expect(formatDiskSize(1234 * 1024)).to.equal("1,234 TB");
    expect(formatDiskSize(1000)).to.equal("1,000 GB");
    expect(formatRam(123456 * 1024)).to.equal("1,23,456 GB RAM");
  });

  it("install-progress formats the actual rendered percentage", () => {
    setLanguage("en-IN");
    const element = view("install-progress", {
      stage: "downloading",
      totalBytes: 100,
      bytesProcessed: 12.5,
      progress: 12.5,
    });
    expect(
      output(element).querySelector(".percentage")?.textContent?.trim()
    ).to.equal("13%");
  });
});
