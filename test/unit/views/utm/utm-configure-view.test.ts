import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/utm/utm-configure-view.js";
import type { UtmConfigureView } from "../../../../src/views/utm/utm-configure-view.js";

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
});
