import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-configure-view.js";
import type { UtmConfigureView } from "../../../../src/views/utm/utm-configure-view.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

/** Mount the view and wait for the system-info lookup to settle */
async function mount(): Promise<UtmConfigureView> {
  const el = await fixture<UtmConfigureView>(html`
    <utm-configure-view></utm-configure-view>
  `);
  await waitUntil(
    () => wizardState.getState().selections.cpuCores !== undefined,
    "the view never saved its configuration"
  );
  await el.updateComplete;
  return el;
}

describe("utm-configure-view", () => {
  beforeEach(() => {
    wizardState.startFlow("vm");
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("saves the defaults on a first visit", async () => {
    await mount();

    const selections = wizardState.getState().selections;
    expect(selections.vmName).to.equal("Home Assistant");
    expect(selections.cpuCores).to.equal(4);
    expect(selections.memoryMb).to.equal(4096);
    expect(selections.diskSizeGb).to.equal(32);
  });

  it("keeps the existing selections when the step is revisited", async () => {
    // What the user picked before stepping back to an earlier step
    wizardState.setSelection("vmName", "My Home");
    wizardState.setSelection("cpuCores", 8);
    wizardState.setSelection("memoryMb", 16384);
    wizardState.setSelection("diskSizeGb", 128);

    const el = await mount();

    const selections = wizardState.getState().selections;
    expect(selections.vmName).to.equal("My Home");
    expect(selections.cpuCores).to.equal(8);
    expect(selections.memoryMb).to.equal(16384);
    expect(selections.diskSizeGb).to.equal(128);

    // And they are what the form shows, not just what is in the state
    const text = el.shadowRoot!.textContent!;
    expect(text).to.contain("8 cores");
    expect(text).to.contain("16 GB");
    expect(text).to.contain("128 GB");
  });

  it("restores the name into the input", async () => {
    wizardState.setSelection("vmName", "My Home");

    const el = await mount();

    const input = el.shadowRoot!.querySelector<HTMLInputElement>(".name-input");
    expect(input!.value).to.equal("My Home");
  });

  it("still caps a restored value the system cannot offer", async () => {
    // The mocked system reports 10 cores and 32 GB of memory
    wizardState.setSelection("cpuCores", 64);
    wizardState.setSelection("memoryMb", 65536);

    await mount();

    const selections = wizardState.getState().selections;
    expect(selections.cpuCores).to.equal(10);
    expect(selections.memoryMb).to.equal(24576);
  });

  it("does not save after being detached when the lookup fails", async () => {
    const systemInfo = deferred<never>();
    mockTauriIpc((cmd) => {
      if (cmd === "get_system_info") return systemInfo.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    const el = fixtureSync<UtmConfigureView>(html`
      <utm-configure-view></utm-configure-view>
    `);

    // Leave the step while the lookup is in flight, then let it fail
    el.remove();
    systemInfo.reject("system info unavailable");
    await settle();

    expect(wizardState.getState().selections.cpuCores).to.be.undefined;
  });

  it("keeps the defaults when the lookup fails while attached", async () => {
    mockTauriIpc((cmd) => {
      if (cmd === "get_system_info") throw "system info unavailable";
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    await mount();

    expect(wizardState.getState().selections.cpuCores).to.equal(4);
  });

  it("shows a restored core count above 8 once the system lookup allows it", async () => {
    wizardState.setSelection("cpuCores", 10);
    const systemInfo = deferred<{ cpu_cores: number; memory_mb: number }>();
    mockTauriIpc((cmd) => {
      if (cmd === "get_system_info") return systemInfo.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });

    // First render without system info, when the slider tops out at 8
    const el = await fixture<UtmConfigureView>(html`
      <utm-configure-view></utm-configure-view>
    `);
    systemInfo.resolve({ cpu_cores: 12, memory_mb: 32768 });
    // cpuCores is already set, so wait on the lookup itself instead
    await settle();
    await el.updateComplete;

    const slider = el.shadowRoot!.querySelector(
      'input[type="range"]'
    ) as HTMLInputElement;
    expect(wizardState.getState().selections.cpuCores).to.equal(10);
    expect(el.shadowRoot!.textContent).to.contain("10 cores");
    expect(slider.value).to.equal("10");
  });
});
