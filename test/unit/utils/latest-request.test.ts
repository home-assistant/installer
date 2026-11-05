import { expect, fixture, html as fixtureHtml } from "@open-wc/testing";
import { LitElement, type ReactiveControllerHost } from "lit";
import { wizardState } from "../../../src/state/wizard-state.js";
import { LatestRequest } from "../../../src/utils/latest-request.js";

/** A host that is in the page once its controller hears so. */
function connected(): LatestRequest {
  const host = {
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  const requests = new LatestRequest(host);
  requests.hostConnected();
  return requests;
}

class LatestRequestHost extends LitElement {
  readonly requests = new LatestRequest(this);
}
customElements.define("latest-request-host", LatestRequestHost);

describe("LatestRequest", () => {
  beforeEach(() => {
    wizardState.reset();
  });

  it("keeps a request current until a newer one starts", () => {
    const requests = connected();
    const first = requests.start();
    expect(first.latest).to.be.true;
    expect(first.current).to.be.true;

    const second = requests.start();

    expect(first.latest).to.be.false;
    expect(first.current).to.be.false;
    expect(second.latest).to.be.true;
    expect(second.current).to.be.true;
  });

  it("makes running requests stale when the host leaves the page", () => {
    const requests = connected();
    const request = requests.start();

    requests.hostDisconnected();
    expect(request.latest).to.be.false;
    expect(request.current).to.be.false;

    // Coming back starts over; what ran before stays stale
    requests.hostConnected();
    expect(request.current).to.be.false;
    expect(requests.start().current).to.be.true;
  });

  it("is never current for a request started out of the page", () => {
    const requests = connected();
    requests.hostDisconnected();

    const request = requests.start();

    expect(request.latest).to.be.true;
    expect(request.current).to.be.false;
  });

  it("is no longer current in another flow, but still the latest", () => {
    wizardState.startFlow("proxmox");
    const requests = connected();
    const request = requests.start();

    // What the view itself was busy with is still its to clear
    wizardState.startFlow("vm");
    expect(request.current).to.be.false;
    expect(request.latest).to.be.true;
  });

  it("counts the same flow started over as another flow", () => {
    wizardState.startFlow("proxmox");
    const requests = connected();
    const request = requests.start();

    wizardState.reset();
    wizardState.startFlow("proxmox");

    expect(request.current).to.be.false;
  });

  it("stays current across changes within the flow", () => {
    wizardState.startFlow("proxmox");
    const requests = connected();
    const request = requests.start();

    wizardState.setSelection("proxmoxNode", "pve");

    expect(request.current).to.be.true;
  });

  it("makes running requests stale on cancel", () => {
    const requests = connected();
    const request = requests.start();

    requests.cancel();

    expect(request.latest).to.be.false;
    expect(request.current).to.be.false;
    expect(requests.start().current).to.be.true;
  });

  it("follows the element it is a controller of", async () => {
    const el = await fixture<LatestRequestHost>(
      fixtureHtml`<latest-request-host></latest-request-host>`
    );
    const request = el.requests.start();
    expect(request.current).to.be.true;

    el.remove();

    expect(request.current).to.be.false;
  });
});
