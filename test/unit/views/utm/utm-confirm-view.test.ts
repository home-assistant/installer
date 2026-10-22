import {
  expect,
  fixtureSync,
  html,
  oneEvent,
  waitUntil,
} from "@open-wc/testing";
import { MOCK_HAOS_RELEASE } from "../../../../src/api/mock-data.js";
import type { UtmVmConfig } from "../../../../src/api/types.js";
import {
  wizardState,
  type WizardSelections,
} from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-confirm-view.js";
import "../../../../src/views/utm/utm-progress-view.js";
import { mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

/** The text of the summary's values and details, whitespace collapsed. */
function summary(el: Element) {
  return [
    ...el.shadowRoot!.querySelectorAll(".summary-value, .summary-detail"),
  ].map((p) => p.textContent!.replace(/\s+/g, " ").trim());
}

describe("utm-confirm-view", () => {
  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  for (const [description, selections] of [
    ["nothing saved yet", {}],
    [
      "chosen settings",
      { vmName: "My Home", cpuCores: 6, memoryMb: 8192, diskSizeGb: 128 },
    ],
    // Where the confirm step and the install used to fall back differently
    ["values the configure step doesn't save", { vmName: "", cpuCores: 0 }],
  ] as [string, WizardSelections][]) {
    it(`shows the VM the install creates, with ${description}`, async () => {
      wizardState.startFlow("vm");
      for (const [key, value] of Object.entries(selections)) {
        wizardState.setSelection(key as keyof WizardSelections, value);
      }
      let created: UtmVmConfig | undefined;
      mockTauriIpc((cmd, args) => {
        switch (cmd) {
          case "get_utm_haos_release":
            return MOCK_HAOS_RELEASE;
          case "download_utm_image":
            return "/tmp/haos.qcow2";
          case "discard_utm_image":
            return undefined;
          case "create_utm_vm":
            created = (args as { config: UtmVmConfig }).config;
            // Nothing after creation matters here
            return Promise.reject("Stopped by the test");
        }
        throw new Error(`Unexpected IPC command: ${cmd}`);
      });

      const confirm = fixtureSync(html`<utm-confirm-view></utm-confirm-view>`);
      await waitUntil(() =>
        confirm.shadowRoot!.textContent!.includes(MOCK_HAOS_RELEASE.version)
      );
      const [name, resources, disk] = summary(confirm);
      confirm.remove();

      const install = fixtureSync(
        html`<utm-progress-view></utm-progress-view>`
      );
      await oneEvent(install, "install-error");

      expect(name).to.equal(created!.name);
      expect(resources).to.equal(
        `${created!.cpu_cores} CPU cores, ${created!.memory_mb / 1024} GB RAM`
      );
      expect(disk).to.equal(`${created!.disk_size_gb} GB`);
    });
  }
});
