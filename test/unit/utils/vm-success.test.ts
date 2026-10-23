import { expect } from "@open-wc/testing";
import { html, render } from "lit";
import { vmSuccessSteps, vmTipPrefix } from "../../../src/utils/vm-success.js";
import { captureOpenedUrls, restoreTauriIpc, settle } from "../tauri-ipc.js";

/** Each step's text, whitespace collapsed, and the container it is in. */
function renderSteps(ipAddress: string | undefined) {
  const container = document.createElement("div");
  render(
    html`${vmSuccessSteps(ipAddress).map((step) => html`<p>${step}</p>`)}`,
    container
  );
  const steps = [...container.querySelectorAll("p")].map((p) =>
    p.textContent!.replace(/\s+/g, " ").trim()
  );
  return { container, steps };
}

describe("utils/vm-success", () => {
  afterEach(() => {
    restoreTauriIpc();
  });

  it("opens Home Assistant at the VM's address", async () => {
    const opened = captureOpenedUrls();
    const { container, steps } = renderSteps("192.0.2.50");
    expect(steps).to.deep.equal([
      "Wait a few minutes for Home Assistant to complete its initial setup",
      "Open 192.0.2.50 in your browser",
      "Create your user account and start automating!",
    ]);

    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).to.equal("http://192.0.2.50");
    link.click();
    await settle();
    expect(opened).to.deep.equal(["http://192.0.2.50"]);
  });

  it("opens Home Assistant at the name it announces without an address", () => {
    const { container, steps } = renderSteps(undefined);
    expect(steps[1]).to.equal("Open homeassistant.local in your browser");
    expect(container.querySelector("a")!.getAttribute("href")).to.equal(
      "http://homeassistant.local"
    );
  });

  it("starts a tip with a bold Tip:", () => {
    const container = document.createElement("div");
    render(vmTipPrefix(), container);
    expect(container.querySelector("strong")!.textContent).to.equal("Tip:");
  });
});
