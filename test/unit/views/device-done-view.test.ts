import { expect, fixture, html } from "@open-wc/testing";
import type { InstallSuccess } from "../../../src/components/install-success.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import "../../../src/views/device-done-view.js";

describe("device-done-view", () => {
  beforeEach(() => wizardState.startFlow("sbc"));
  afterEach(() => wizardState.reset());

  async function render() {
    const view = await fixture(html`<device-done-view></device-done-view>`);
    const success =
      view.shadowRoot!.querySelector<InstallSuccess>("install-success")!;
    await success.updateComplete;
    const steps = [...success.shadowRoot!.querySelectorAll(".step-text")];
    return {
      success,
      steps: steps.map((step) => step.textContent!.replace(/\s+/g, " ").trim()),
      links: steps.flatMap((step) =>
        [...step.querySelectorAll("a")].map((link) => link.href)
      ),
    };
  }

  it("opens Home Assistant with one button where the device answered", async () => {
    wizardState.setSelections({
      ipAddress: "192.0.2.60",
      homeAssistantReady: true,
    });
    const { success, steps } = await render();

    expect(success.shadowRoot!.textContent).to.contain("You're all set!");
    expect(success.subtitle).to.equal("Home Assistant is ready on your device");
    expect(steps).to.be.empty;
    expect(
      success.shadowRoot!.querySelector<HTMLElement>(".next-steps")!.hidden
    ).to.be.true;
    const button = success.querySelector("wa-button")!;
    expect(button.getAttribute("variant")).to.equal("brand");
    expect(button.getAttribute("href")).to.equal("http://192.0.2.60");
    expect(button.textContent).to.equal(
      "Open Home Assistant Opens in your browser."
    );
    expect(success.companion).to.be.true;
  });

  it("says to wait when the wait was skipped before Home Assistant was ready", async () => {
    wizardState.setSelection("ipAddress", "192.0.2.60");
    const { success, steps, links } = await render();

    expect(success.subtitle).to.equal(
      "Your device is installing Home Assistant"
    );
    expect(steps[0]).to.contain("Allow about 20 minutes");
    expect(steps[1]).to.equal("Open Home Assistant in your browser");
    expect(links).to.deep.equal(["http://192.0.2.60/"]);
  });

  it("says how to find the device when the wait didn't find it", async () => {
    const { steps, links } = await render();

    expect(steps).to.have.length(3);
    expect(steps[1]).to.equal(
      "Open homeassistant.local in your browser. If it doesn't open, find the device's IP address in your router or on an attached display, then open http://<IP address>."
    );
    expect(links).to.deep.equal(["http://homeassistant.local/"]);
  });
});
