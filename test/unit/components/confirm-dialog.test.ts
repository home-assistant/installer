import { expect, fixture, html, oneEvent } from "@open-wc/testing";
import "../../../src/components/confirm-dialog.js";
import type { ConfirmDialog } from "../../../src/components/confirm-dialog.js";

describe("confirm-dialog", () => {
  it("is hidden when open is false", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog></confirm-dialog>
    `);

    expect(el.hasAttribute("open")).to.be.false;
    expect(window.getComputedStyle(el).display).to.equal("none");
  });

  it("is visible when open is true", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    expect(el.hasAttribute("open")).to.be.true;
    expect(window.getComputedStyle(el).display).to.not.equal("none");
  });

  it("renders dialog with title", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const title = el.shadowRoot!.querySelector(".dialog-title");
    expect(title).to.exist;
    expect(title!.textContent).to.contain("Erase drive and install?");
  });

  it("renders dialog with warning icon", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const icon = el.shadowRoot!.querySelector(".warning-icon");
    expect(icon).to.exist;
  });

  it("renders dialog with drive name in message", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open driveName="My USB Drive"></confirm-dialog>
    `);

    const driveName = el.shadowRoot!.querySelector(".drive-name");
    expect(driveName).to.exist;
    expect(driveName!.textContent).to.equal("My USB Drive");
  });

  it("renders cancel button", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const cancelButton = el.shadowRoot!.querySelector(
      "wa-button[appearance='outlined']"
    );
    expect(cancelButton).to.exist;
    expect(cancelButton!.textContent!.trim()).to.equal("Cancel");
  });

  it("renders confirm button", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const confirmButton = el.shadowRoot!.querySelector(
      "wa-button[variant='danger']"
    );
    expect(confirmButton).to.exist;
    expect(confirmButton!.textContent!.trim()).to.equal("Erase and install");
  });

  it("dispatches dialog-cancel event when cancel button is clicked", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const cancelButton = el.shadowRoot!.querySelector(
      "wa-button[appearance='outlined']"
    ) as HTMLButtonElement;

    setTimeout(() => cancelButton.click());
    const event = await oneEvent(el, "dialog-cancel");
    expect(event).to.exist;
  });

  it("dispatches dialog-confirm event when confirm button is clicked", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const confirmButton = el.shadowRoot!.querySelector(
      "wa-button[variant='danger']"
    ) as HTMLButtonElement;

    setTimeout(() => confirmButton.click());
    const event = await oneEvent(el, "dialog-confirm");
    expect(event).to.exist;
  });

  it("closes dialog when cancel button is clicked", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const cancelButton = el.shadowRoot!.querySelector(
      "wa-button[appearance='outlined']"
    ) as HTMLButtonElement;

    expect(el.open).to.be.true;
    cancelButton.click();
    await el.updateComplete;
    expect(el.open).to.be.false;
  });

  it("closes dialog when confirm button is clicked", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const confirmButton = el.shadowRoot!.querySelector(
      "wa-button[variant='danger']"
    ) as HTMLButtonElement;

    expect(el.open).to.be.true;
    confirmButton.click();
    await el.updateComplete;
    expect(el.open).to.be.false;
  });

  it("dispatches dialog-cancel when dismissed (escape/backdrop/close)", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const dialog = el.shadowRoot!.querySelector("wa-dialog")!;

    setTimeout(() =>
      dialog.dispatchEvent(
        new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
      )
    );
    const event = await oneEvent(el, "dialog-cancel");
    expect(event).to.exist;
    expect(el.open).to.be.false;
  });

  it("does not also fire dialog-cancel when confirmed", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    let cancelFired = false;
    el.addEventListener("dialog-cancel", () => (cancelFired = true));

    const confirmButton = el.shadowRoot!.querySelector(
      "wa-button[variant='danger']"
    ) as HTMLElement;
    confirmButton.click();
    await el.updateComplete;

    // Confirm already closed the dialog, so no hide completion is a dismissal,
    // however many arrive. Real Escape/backdrop dismissal is covered in E2E.
    const dialog = el.shadowRoot!.querySelector("wa-dialog")!;
    const afterHide = () =>
      dialog.dispatchEvent(
        new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
      );
    afterHide();
    afterHide();

    expect(cancelFired).to.be.false;
    expect(el.open).to.be.false;
  });

  it("fires dialog-cancel exactly once when cancelled", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    let cancelCount = 0;
    el.addEventListener("dialog-cancel", () => (cancelCount += 1));

    const cancelButton = el.shadowRoot!.querySelector(
      "wa-button[appearance='outlined']"
    ) as HTMLElement;
    cancelButton.click();
    await el.updateComplete;

    // Cancel and dismissal share an event, so the hide completion that follows
    // the button must not report a second one.
    const dialog = el.shadowRoot!.querySelector("wa-dialog")!;
    const afterHide = () =>
      dialog.dispatchEvent(
        new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
      );
    afterHide();
    afterHide();

    expect(cancelCount).to.equal(1);
  });

  it("stays silent when a consumer closes it programmatically", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    let cancelFired = false;
    el.addEventListener("dialog-cancel", () => (cancelFired = true));

    // Closing through the public `open` property is not a user dismissal,
    // so it must not report one even though it still completes a hide.
    el.open = false;
    await el.updateComplete;
    el.shadowRoot!.querySelector("wa-dialog")!.dispatchEvent(
      new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
    );

    expect(cancelFired).to.be.false;
  });

  it("has correct dialog structure", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    expect(el.shadowRoot!.querySelector("wa-dialog")).to.exist;
    expect(el.shadowRoot!.querySelector(".dialog-title")).to.exist;
    expect(el.shadowRoot!.querySelector(".dialog-message")).to.exist;
    expect(
      el.shadowRoot!.querySelectorAll("wa-button[slot='footer']").length
    ).to.equal(2);
  });

  it("stores driveName property", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog driveName="Test Drive"></confirm-dialog>
    `);

    expect(el.driveName).to.equal("Test Drive");
  });

  it("stores open property", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    expect(el.open).to.be.true;
  });

  it("can toggle open state", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog></confirm-dialog>
    `);

    expect(el.open).to.be.false;
    expect(el.hasAttribute("open")).to.be.false;

    el.open = true;
    await el.updateComplete;

    expect(el.open).to.be.true;
    expect(el.hasAttribute("open")).to.be.true;
  });

  it("event bubbles and is composed", async () => {
    const el = await fixture<ConfirmDialog>(html`
      <confirm-dialog open></confirm-dialog>
    `);

    const confirmButton = el.shadowRoot!.querySelector(
      "wa-button[variant='danger']"
    ) as HTMLButtonElement;

    setTimeout(() => confirmButton.click());
    const event = await oneEvent(el, "dialog-confirm");
    expect(event.bubbles).to.be.true;
    expect(event.composed).to.be.true;
  });

  describe("password note", () => {
    const originalPlatform = navigator.platform;

    const setPlatform = (value: string) => {
      Object.defineProperty(window.navigator, "platform", {
        value,
        configurable: true,
      });
    };

    afterEach(() => setPlatform(originalPlatform));

    const cases: Array<{ label: string; platform: string; shown: boolean }> = [
      { label: "macOS", platform: "MacIntel", shown: true },
      { label: "Linux", platform: "Linux x86_64", shown: true },
      // Windows has no in-flow prompt: the app must already run elevated.
      { label: "Windows", platform: "Win32", shown: false },
    ];

    for (const { label, platform, shown } of cases) {
      it(`${shown ? "shows" : "hides"} the note on ${label}`, async () => {
        setPlatform(platform);
        const el = await fixture<ConfirmDialog>(html`
          <confirm-dialog open></confirm-dialog>
        `);

        const note = el.shadowRoot!.querySelector(".password-note");
        if (shown) {
          expect(note).to.exist;
          expect(note!.textContent).to.contain("prompted for your password");
        } else {
          expect(note).to.not.exist;
        }
      });
    }
  });
});
