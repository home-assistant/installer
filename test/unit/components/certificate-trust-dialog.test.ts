import { expect, fixture, html, oneEvent } from "@open-wc/testing";
import "../../../src/components/certificate-trust-dialog.js";
import type { CertificateTrustDialog } from "../../../src/components/certificate-trust-dialog.js";

/** A fingerprint shaped like the ones Proxmox reports. */
const FINGERPRINT =
  "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90";

/** A different fingerprint, for the "certificate changed" case. */
const OTHER_FINGERPRINT =
  "0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0";

/** The dialog as it appears on a first connection. */
function firstContact() {
  return fixture<CertificateTrustDialog>(html`
    <certificate-trust-dialog
      open
      server="192.168.1.100:8006"
      fingerprint=${FINGERPRINT}
    ></certificate-trust-dialog>
  `);
}

/** The dialog as it appears when the pinned certificate no longer matches. */
function certificateChanged() {
  return fixture<CertificateTrustDialog>(html`
    <certificate-trust-dialog
      open
      server="192.168.1.100:8006"
      fingerprint=${FINGERPRINT}
      previousFingerprint=${OTHER_FINGERPRINT}
    ></certificate-trust-dialog>
  `);
}

const cancelButton = (el: CertificateTrustDialog) =>
  el.shadowRoot!.querySelector<HTMLElement>("wa-button[appearance='outlined']")!;

const confirmButton = (el: CertificateTrustDialog) =>
  el.shadowRoot!.querySelector<HTMLElement>("wa-button[appearance='accent']")!;

const fingerprints = (el: CertificateTrustDialog) =>
  Array.from(el.shadowRoot!.querySelectorAll(".fingerprint")).map((node) =>
    node.textContent!.trim()
  );

describe("certificate-trust-dialog", () => {
  it("is hidden when open is false", async () => {
    const el = await fixture<CertificateTrustDialog>(html`
      <certificate-trust-dialog></certificate-trust-dialog>
    `);

    expect(el.hasAttribute("open")).to.be.false;
    expect(window.getComputedStyle(el).display).to.equal("none");
  });

  it("is visible when open is true", async () => {
    const el = await firstContact();

    expect(el.hasAttribute("open")).to.be.true;
    expect(window.getComputedStyle(el).display).to.not.equal("none");
  });

  describe("first connection", () => {
    it("asks whether the server is the right one", async () => {
      const el = await firstContact();

      const title = el.shadowRoot!.querySelector(".dialog-title");
      expect(title!.textContent).to.contain("Is this the right server?");
      // Not the alarming variant: nothing has changed, this is just first use.
      expect(title!.classList.contains("changed")).to.be.false;
    });

    it("shows the fingerprint the user has to compare", async () => {
      const el = await firstContact();

      expect(fingerprints(el)).to.deep.equal([FINGERPRINT]);
    });

    it("names the server the certificate came from", async () => {
      const el = await firstContact();

      const server = el.shadowRoot!.querySelector(".server");
      expect(server!.textContent).to.equal("192.168.1.100:8006");
    });

    it("says where the same fingerprint can be checked", async () => {
      const el = await firstContact();

      // Without this the user has nothing to compare against, which would make
      // the prompt a rubber stamp.
      const where = el.shadowRoot!.querySelector(".where-to-check")!;
      expect(where.textContent).to.contain("Certificates");
      expect(where.textContent).to.contain("pvenode cert info");
    });

    it("offers a plain confirm action", async () => {
      const el = await firstContact();

      expect(confirmButton(el).textContent!.trim()).to.equal(
        "Trust and connect"
      );
      expect(confirmButton(el).getAttribute("variant")).to.equal("brand");
    });

    it("does not show a previous fingerprint", async () => {
      const el = await firstContact();

      expect(el.shadowRoot!.querySelector(".fingerprint.previous")).to.not
        .exist;
      expect(el.shadowRoot!.querySelector(".warning")).to.not.exist;
    });
  });

  describe("certificate changed", () => {
    it("leads with the change rather than a routine prompt", async () => {
      const el = await certificateChanged();

      const title = el.shadowRoot!.querySelector(".dialog-title")!;
      expect(title.textContent).to.contain("Certificate has changed");
      expect(title.classList.contains("changed")).to.be.true;
    });

    it("warns that the connection may be intercepted", async () => {
      const el = await certificateChanged();

      const warning = el.shadowRoot!.querySelector(".warning")!;
      expect(warning.textContent).to.contain("intercepting");
      expect(warning.textContent).to.contain("do not continue");
    });

    it("shows the new and the previously trusted fingerprint", async () => {
      const el = await certificateChanged();

      // Both are needed for the user to tell a renewal from an attack.
      expect(fingerprints(el)).to.deep.equal([FINGERPRINT, OTHER_FINGERPRINT]);
      expect(
        el.shadowRoot!.querySelector(".fingerprint.previous")!.textContent!.trim()
      ).to.equal(OTHER_FINGERPRINT);
    });

    it("marks accepting the new certificate as destructive", async () => {
      const el = await certificateChanged();

      expect(confirmButton(el).getAttribute("variant")).to.equal("danger");
      expect(confirmButton(el).textContent!.trim()).to.equal(
        "Trust the new certificate"
      );
    });
  });

  describe("decisions", () => {
    it("dispatches dialog-confirm when the certificate is accepted", async () => {
      const el = await firstContact();

      setTimeout(() => confirmButton(el).click());
      expect(await oneEvent(el, "dialog-confirm")).to.exist;
    });

    it("dispatches dialog-cancel when cancelled", async () => {
      const el = await firstContact();

      setTimeout(() => cancelButton(el).click());
      expect(await oneEvent(el, "dialog-cancel")).to.exist;
    });

    it("closes on either decision", async () => {
      const accepted = await firstContact();
      confirmButton(accepted).click();
      await accepted.updateComplete;
      expect(accepted.open).to.be.false;

      const declined = await firstContact();
      cancelButton(declined).click();
      await declined.updateComplete;
      expect(declined.open).to.be.false;
    });

    it("treats dismissal (escape/backdrop/close) as declining", async () => {
      const el = await firstContact();
      const dialog = el.shadowRoot!.querySelector("wa-dialog")!;

      // Dismissing must never trust a certificate by accident.
      setTimeout(() =>
        dialog.dispatchEvent(
          new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
        )
      );
      expect(await oneEvent(el, "dialog-cancel")).to.exist;
      expect(el.open).to.be.false;
    });

    it("does not also fire dialog-cancel after accepting", async () => {
      const el = await firstContact();

      let cancelFired = false;
      el.addEventListener("dialog-cancel", () => (cancelFired = true));

      confirmButton(el).click();
      await el.updateComplete;

      // Accepting already closed the dialog, so the hide completion that
      // follows is not a dismissal -- otherwise the caller would see both a
      // trust and a decline for one decision.
      const dialog = el.shadowRoot!.querySelector("wa-dialog")!;
      dialog.dispatchEvent(
        new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
      );

      expect(cancelFired).to.be.false;
    });

    it("fires dialog-cancel exactly once when cancelled", async () => {
      const el = await firstContact();

      let cancelCount = 0;
      el.addEventListener("dialog-cancel", () => (cancelCount += 1));

      cancelButton(el).click();
      await el.updateComplete;

      const dialog = el.shadowRoot!.querySelector("wa-dialog")!;
      dialog.dispatchEvent(
        new CustomEvent("wa-after-hide", { bubbles: true, composed: true })
      );

      expect(cancelCount).to.equal(1);
    });
  });
});
