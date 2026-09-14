import { aTimeout, expect, fixtureSync, html } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-progress-view.js";
import type { ProxmoxProgressView } from "../../../../src/views/proxmox/proxmox-progress-view.js";

/** The install pipeline's cancellation handle, which is private to the view */
function abortSignalOf(el: ProxmoxProgressView): AbortSignal | undefined {
  return (el as unknown as { _abortController?: AbortController })
    ._abortController?.signal;
}

/**
 * Mount the view synchronously, so assertions and listeners are in place
 * before the install pipeline's first `await` resolves.
 */
function mount(): ProxmoxProgressView {
  return fixtureSync<ProxmoxProgressView>(html`
    <proxmox-progress-view></proxmox-progress-view>
  `);
}

describe("proxmox-progress-view", () => {
  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://192.168.1.100:8006",
      ticket: "mock-ticket",
      csrf_token: "mock-csrf",
    });
  });

  afterEach(() => {
    wizardState.reset();
  });

  it("starts the install when connected", async () => {
    const el = mount();

    expect(abortSignalOf(el), "install did not start").to.exist;
    expect(abortSignalOf(el)!.aborted).to.be.false;
  });

  it("cancels the install pipeline when detached", async () => {
    const el = mount();
    const signal = abortSignalOf(el)!;

    el.remove();

    expect(signal.aborted).to.be.true;
  });

  it("does not touch the wizard or advance it after being detached", async () => {
    const el = mount();
    let completed = false;
    let errored = false;
    el.addEventListener("install-complete", () => {
      completed = true;
    });
    el.addEventListener("install-error", () => {
      errored = true;
    });

    el.remove();
    await aTimeout(50);

    expect(completed, "install-complete fired after detach").to.be.false;
    expect(errored, "install-error fired after detach").to.be.false;
    expect(wizardState.getState().selections.proxmoxVmResult).to.be.undefined;
  });

  it("reports an error without starting when there is no session", async () => {
    wizardState.startFlow("proxmox");

    const el = mount();
    await el.updateComplete;

    expect(abortSignalOf(el), "install should not have started").to.not.exist;
    expect(el.hasError).to.be.true;
    expect(el.shadowRoot!.textContent).to.contain("No Proxmox session");
  });
});
