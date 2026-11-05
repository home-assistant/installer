import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import { wizardState } from "../../../../src/state/wizard-state.js";
import "../../../../src/views/proxmox/proxmox-configure-view.js";
import type { ProxmoxConfigureView } from "../../../../src/views/proxmox/proxmox-configure-view.js";
import { ipcError, mockTauriIpc, restoreTauriIpc } from "../../tauri-ipc.js";

const failed =
  "Proxmox could not complete the request. Check the server, account permissions, and connection.";
const expired =
  "Your Proxmox session expired. Reconnect to Proxmox to continue.";

const buttons = (el: ProxmoxConfigureView) =>
  [...el.shadowRoot!.querySelectorAll<HTMLElement>(".error > wa-button")].map(
    (button) => button.textContent!.trim()
  );
const focused = (el: ProxmoxConfigureView) => el.shadowRoot!.activeElement;

describe("proxmox-configure-view load error", () => {
  let nodes: () => unknown;

  beforeEach(() => {
    wizardState.startFlow("proxmox");
    wizardState.nextStep();
    wizardState.setSelection("proxmoxSession", {
      server_url: "https://pve.example:8006",
      ticket: "ticket",
      csrf_token: "csrf",
    });
    nodes = () => {
      throw ipcError("proxmox_api", "denied", true);
    };
    mockTauriIpc((cmd) => {
      switch (cmd) {
        case "proxmox_list_nodes":
          return nodes();
        case "proxmox_get_next_vm_id":
          return 100;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  async function mount() {
    const el = await fixture<ProxmoxConfigureView>(html`
      <proxmox-configure-view></proxmox-configure-view>
    `);
    await waitUntil(
      () => el.shadowRoot!.querySelector(".error-message")?.textContent!.trim(),
      "the lookup never failed"
    );
    return el;
  }

  // It had its own copy, with an inline style and the message in a card
  it("shows a failed lookup the way every step shows a load error", async () => {
    const el = await mount();
    const error = el.shadowRoot!.querySelector(".error")!;
    expect(!!error.querySelector(".error-icon")).to.be.true;
    const message = error.querySelector<HTMLElement>(
      ".error-message[data-focus-alert]"
    )!;
    expect(message.textContent!.trim()).to.equal(failed);
    // The shared sheet wraps a long message, as the inline style did
    expect(getComputedStyle(message).overflowWrap).to.equal("anywhere");
    expect(message.style.overflowWrap).to.equal("");
    expect(!!error.querySelector(".error-help")).to.be.true;
    expect(buttons(el)).to.deep.equal(["Try again"]);
    expect(!!el.shadowRoot!.querySelector(".config-card")).to.be.false;
  });

  it("offers Reconnect in place of Try again once the session expired", async () => {
    const el = await mount();
    nodes = () => {
      throw ipcError("proxmox_session_expired", "Session expired");
    };
    const retry =
      el.shadowRoot!.querySelector<HTMLElement>(".error > wa-button")!;
    retry.focus();
    retry.click();
    // The message took the focus from Try again, which made way for Reconnect
    await waitUntil(
      () => focused(el)?.textContent!.trim() === expired,
      "the expired session was never read out"
    );
    expect(focused(el)!.matches(".error-message[data-focus-alert]")).to.be.true;
    expect(buttons(el)).to.deep.equal(["Reconnect"]);

    el.shadowRoot!.querySelector<HTMLElement>(".error > wa-button")!.click();
    expect(wizardState.currentStep!.id).to.equal("connection");
  });
});
