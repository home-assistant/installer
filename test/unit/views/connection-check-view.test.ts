import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../src/views/connection-check-view.js";
import type { ConnectionCheckView } from "../../../src/views/connection-check-view.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";

/** The error stays in the DOM, so a failure shows up as its text */
const alertText = (el: ConnectionCheckView) =>
  el.shadowRoot!.querySelector("[data-focus-alert]")!.textContent!.trim();

describe("connection-check-view", () => {
  afterEach(restoreTauriIpc);

  it("waits for the backend, displays its error and retries once", async () => {
    const first = deferred<void>();
    const retry = deferred<void>();
    let calls = 0;
    mockTauriIpc((command) => {
      expect(command).to.equal("check_connection");
      return ++calls === 1 ? first.promise : retry.promise;
    });
    const el = await fixture<ConnectionCheckView>(
      html`<connection-check-view></connection-check-view>`
    );
    let ready = 0;
    el.addEventListener("connection-ready", () => ready++);
    expect(el.shadowRoot!.textContent).to.contain("Checking connection");
    // The spinner that holds still with reduced motion
    expect(el.shadowRoot!.querySelector("loading-spinner")).to.exist;
    expect(ready).to.equal(0);
    // Shaped like the native CommandError, its text from the catalog
    first.reject(
      ipcError("network", "Cannot reach version.home-assistant.io.", true, {
        message_key: "backend.download.version_service_unreachable",
        message_params: {},
      })
    );
    await waitUntil(() => !!alertText(el));
    expect(el.shadowRoot!.textContent).to.contain(
      "Check your internet connection"
    );
    const button = el.shadowRoot!.querySelector(
      'wa-button[variant="brand"]'
    ) as HTMLElement;
    button.click();
    button.click();
    await settle();
    expect(calls).to.equal(2);
    expect(ready).to.equal(0);
    retry.resolve();
    await waitUntil(() => ready === 1);
  });

  it("keeps focus on Try again while it checks again, and announces the outcome", async () => {
    const retry = deferred<void>();
    let calls = 0;
    mockTauriIpc(() =>
      ++calls === 1
        ? Promise.reject(ipcError("network", "Offline", true))
        : retry.promise
    );
    const el = await fixture<ConnectionCheckView>(
      html`<connection-check-view></connection-check-view>`
    );
    await waitUntil(() => !!alertText(el));
    const status = el.shadowRoot!.querySelector('[role="status"]')!;
    const alert = el.shadowRoot!.querySelector("[data-focus-alert]")!;
    // The failure takes focus, so it is read out
    expect(el.shadowRoot!.activeElement).to.equal(alert);

    const button = el.shadowRoot!.querySelector(
      'wa-button[variant="brand"]'
    ) as HTMLElement & { loading: boolean };
    button.focus();
    button.click();
    await el.updateComplete;

    // Try again stays where it was, busy, so focus doesn't fall to the page
    expect(button.isConnected).to.be.true;
    expect(button.loading).to.be.true;
    expect(el.shadowRoot!.activeElement).to.equal(button);
    // The same regions report the new check, rather than new ones appearing
    expect(el.shadowRoot!.querySelector('[role="status"]')).to.equal(status);
    expect(status.textContent).to.contain("version service");
    expect(alertText(el)).to.equal("");

    retry.reject(ipcError("network", "Still offline", true));
    await waitUntil(() => !!alertText(el));
    expect(el.shadowRoot!.querySelector("[data-focus-alert]")).to.equal(alert);
    expect(status.textContent!.trim()).to.equal("");
  });

  it("offers installation help and a report once a check has failed", async () => {
    const retry = deferred<void>();
    let calls = 0;
    mockTauriIpc(() =>
      ++calls === 1
        ? Promise.reject(ipcError("network", "Offline", true))
        : retry.promise
    );
    const el = await fixture<ConnectionCheckView>(
      html`<connection-check-view></connection-check-view>`
    );
    const help = () => el.shadowRoot!.querySelector(".error-help");
    // Nothing has failed yet, so there is nothing to get help with
    expect(help()).to.equal(null);

    await waitUntil(() => !!alertText(el));
    expect(help()!.querySelector("a")!.getAttribute("href")).to.equal(
      "https://www.home-assistant.io/installation/"
    );
    expect(help()!.textContent).to.contain("Installation help");
    expect(help()!.querySelector("diagnostics-actions")).to.exist;
    // Outside the alert, so the focus reads out the failure alone
    expect(el.shadowRoot!.querySelector("[data-focus-alert] a")).to.equal(null);

    // The help stays while it checks again, as Try again does
    (
      el.shadowRoot!.querySelector('wa-button[variant="brand"]') as HTMLElement
    ).click();
    await el.updateComplete;
    expect(alertText(el)).to.equal("");
    expect(help()).to.exist;

    retry.resolve();
  });

  it("does not describe a service failure as offline", async () => {
    mockTauriIpc(() =>
      Promise.reject(
        ipcError("network", "unavailable", true, {
          message_key: "backend.download.version_service_unavailable",
          message_params: { status: 503 },
        })
      )
    );
    const el = await fixture<ConnectionCheckView>(
      html`<connection-check-view></connection-check-view>`
    );
    await waitUntil(() => !!alertText(el));
    expect(el.shadowRoot!.textContent).to.contain("HTTP 503");
    expect(el.shadowRoot!.textContent).not.to.contain("No internet connection");
    // The shared mascot serves its artwork from public/, unlike a bundled path
    expect(
      el.shadowRoot!.querySelector("casita-mascot")!.getAttribute("mood")
    ).to.equal("sad");
  });

  for (const action of ["back", "disconnect"]) {
    it(`ignores a late success after ${action}`, async () => {
      const pending = deferred<void>();
      mockTauriIpc(() => pending.promise);
      const el = await fixture<ConnectionCheckView>(
        html`<connection-check-view></connection-check-view>`
      );
      let ready = false;
      el.addEventListener("connection-ready", () => {
        ready = true;
      });
      if (action === "back") {
        (el.shadowRoot!.querySelector("wa-button") as HTMLElement).click();
      } else {
        el.remove();
      }
      pending.resolve();
      await settle();
      expect(ready).to.equal(false);
    });
  }

  it("sends ready and Back up through the page, as the other screens do", async () => {
    mockTauriIpc(() => Promise.resolve());
    const heard: string[] = [];
    const record = (event: Event) => heard.push(event.type);
    document.addEventListener("connection-ready", record);
    document.addEventListener("connection-back", record);
    try {
      const el = await fixture<ConnectionCheckView>(
        html`<connection-check-view></connection-check-view>`
      );
      await waitUntil(() => heard.length === 1);
      (el.shadowRoot!.querySelector("wa-button") as HTMLElement).click();
      expect(heard).to.deep.equal(["connection-ready", "connection-back"]);
    } finally {
      document.removeEventListener("connection-ready", record);
      document.removeEventListener("connection-back", record);
    }
  });

  it("checks again if a pending element is reconnected", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let calls = 0;
    mockTauriIpc(() => (++calls === 1 ? first.promise : second.promise));
    const el = await fixture<ConnectionCheckView>(
      html`<connection-check-view></connection-check-view>`
    );
    const parent = el.parentElement!;
    el.remove();
    parent.append(el);
    expect(calls).to.equal(2);
    let ready = 0;
    el.addEventListener("connection-ready", () => ready++);
    first.resolve();
    await settle();
    expect(ready).to.equal(0);
    second.resolve();
    await waitUntil(() => ready === 1);
  });
});
