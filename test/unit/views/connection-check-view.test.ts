import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import "../../../src/views/connection-check-view.js";
import type { ConnectionCheckView } from "../../../src/views/connection-check-view.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../tauri-ipc.js";

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
    expect(ready).to.equal(0);
    first.reject(
      "Cannot reach version.home-assistant.io. Check your internet connection and try again."
    );
    await waitUntil(() => !!el.shadowRoot!.querySelector('[role="alert"]'));
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

  it("does not describe a service failure as offline", async () => {
    mockTauriIpc(() =>
      Promise.reject(
        "The Home Assistant version service is unavailable (HTTP 503). Try again later."
      )
    );
    const el = await fixture<ConnectionCheckView>(
      html`<connection-check-view></connection-check-view>`
    );
    await waitUntil(() => !!el.shadowRoot!.querySelector('[role="alert"]'));
    expect(el.shadowRoot!.textContent).to.contain("HTTP 503");
    expect(el.shadowRoot!.textContent).not.to.contain("No internet connection");
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
