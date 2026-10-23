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

/** The alert stays in the DOM, so a failure shows up as its text */
const alertText = (el: ConnectionCheckView) =>
  el.shadowRoot!.querySelector('[role="alert"]')!.textContent!.trim();

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
    const alert = el.shadowRoot!.querySelector('[role="alert"]')!;
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
    expect(el.shadowRoot!.querySelector('[role="alert"]')).to.equal(alert);
    expect(status.textContent!.trim()).to.equal("");
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
