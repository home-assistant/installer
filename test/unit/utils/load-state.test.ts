import { expect, fixtureSync, html } from "@open-wc/testing";
import type { LitElement } from "lit";
import {
  loadStateStyles,
  renderLoadError,
  renderLoading,
  renderRetryButton,
  renderStatusRow,
  statusRowStyles,
} from "../../../src/utils/load-state.js";
import type { InstallerError } from "../../../src/utils/installer-error.js";
import "../../../src/views/ha-hardware/device-selection-view.js";
import "../../../src/views/minipc/architecture-selection-view.js";
import "../../../src/views/proxmox/proxmox-configure-view.js";
import "../../../src/views/proxmox/proxmox-connect-view.js";
import "../../../src/views/sbc/device-selection-view.js";
import "../../../src/views/sbc/drive-selection-view.js";
import "../../../src/views/utm/utm-check-view.js";

const STEPS = [
  "ha-hardware-device-selection-view",
  "minipc-architecture-selection-view",
  "device-selection-view",
  "drive-selection-view",
  "proxmox-configure-view",
];

const STATUS_STEPS = ["utm-check-view", "proxmox-connect-view"];

/** The CSS a step adds to the given shared sheet */
function ownStyles(tag: string, shared: unknown) {
  return (customElements.get(tag) as typeof LitElement).elementStyles
    .filter((style) => style !== shared)
    .map((style) => ("cssText" in style ? style.cssText : ""))
    .join("\n");
}

const failure = (retryable: boolean): InstallerError => ({
  code: "network",
  message: "Could not connect.",
  retryable,
  details: {},
});

const noop = () => undefined;

describe("load state", () => {
  it("says what it waits for next to a spinner screen readers skip", () => {
    const el = fixtureSync(
      html`<div>${renderLoading("Loading devices")}</div>`
    );
    const spinner = el.querySelector(".loading loading-spinner")!;
    expect(spinner.getAttribute("aria-hidden")).to.equal("true");
    expect(el.querySelector(".loading span")!.textContent).to.equal(
      "Loading devices"
    );
  });

  it("says why a load failed and offers Try again", () => {
    const el = fixtureSync(
      html`<div>${renderLoadError(failure(true), false, noop)}</div>`
    );
    expect(
      el.querySelector(".error-message[data-focus-alert]")!.textContent!.trim()
    ).to.equal("Could not connect.");
    expect(
      el.querySelector(".error-icon")!.getAttribute("aria-hidden")
    ).to.equal("true");
    const retry = el.querySelector(".error wa-button")!;
    expect(retry.textContent!.trim()).to.equal("Try again");
    expect(retry.hasAttribute("loading")).to.be.false;
  });

  it("keeps Try again, busy, and empties the message while it retries", () => {
    const el = fixtureSync(
      html`<div>${renderLoadError(failure(true), true, noop)}</div>`
    );
    expect(
      el.querySelector(".error-message[data-focus-alert]")!.textContent!.trim()
    ).to.equal("");
    expect(el.querySelector(".error wa-button")!.hasAttribute("loading")).to.be
      .true;
  });

  it("offers Try again only for an error that may pass", () => {
    const el = fixtureSync(
      html`<div>${renderLoadError(failure(false), false, noop)}</div>`
    );
    expect(el.querySelector("wa-button")).to.be.null;
  });

  it("offers what fixes the error in place of Try again", () => {
    let actions = 0;
    const el = fixtureSync(
      html`<div>
        ${renderLoadError(failure(true), false, noop, {
          action: { label: "Reconnect", onAction: () => actions++ },
        })}
      </div>`
    );
    const buttons = el.querySelectorAll(".error > wa-button");
    expect(buttons.length).to.equal(1);
    expect(buttons[0].textContent!.trim()).to.equal("Reconnect");
    expect(buttons[0].getAttribute("variant")).to.equal("brand");
    buttons[0].dispatchEvent(new MouseEvent("click"));
    expect(actions).to.equal(1);
  });

  it("draws every Try again alike", () => {
    let clicks = 0;
    const el = fixtureSync(
      html`<div>
        ${renderRetryButton(false, () => clicks++, {
          className: "storage-retry",
          disabled: true,
        })}
      </div>`
    );
    const retry = el.querySelector("wa-button")!;
    expect(retry.className).to.equal("storage-retry");
    expect(retry.getAttribute("variant")).to.equal("brand");
    expect(retry.getAttribute("appearance")).to.equal("outlined");
    expect(retry.hasAttribute("disabled")).to.be.true;
    expect(retry.textContent!.trim()).to.equal("Try again");
    retry.dispatchEvent(new MouseEvent("click"));
    expect(clicks).to.equal(1);
  });

  // The copies had drifted: an emoji or an icon, and a spinner of their own
  // that kept turning with reduced motion
  it("is styled by the shared rules on every step that loads", () => {
    for (const tag of STEPS) {
      const styles = (customElements.get(tag) as typeof LitElement)
        .elementStyles;
      expect(styles.includes(loadStateStyles), tag).to.be.true;
      expect(ownStyles(tag, loadStateStyles), tag).not.to.match(
        /(^|[\s}])(\.loading|\.loading-spinner|\.error|\.error-icon|\.error-message)\s*\{|@keyframes spin/
      );
    }
  });
});

describe("status row", () => {
  it("says what a check waits for next to a spinner screen readers skip", () => {
    const el = fixtureSync(
      html`<div>${renderStatusRow("loading", "Checking for UTM...")}</div>`
    );
    const row = el.querySelector(".status-row.status-loading")!;
    expect(
      row.querySelector("loading-spinner")!.getAttribute("aria-hidden")
    ).to.equal("true");
    expect(row.querySelector(".status-title")!.textContent).to.equal(
      "Checking for UTM..."
    );
    // Nothing under the title, not even an empty line
    expect(row.querySelector(".status-description")).to.be.null;
    expect(row.hasAttribute("data-focus-alert")).to.be.false;
  });

  for (const kind of ["success", "warning"] as const) {
    it(`shows a ${kind} as a result, with an icon screen readers skip`, () => {
      const el = fixtureSync(
        html`<div>${renderStatusRow(kind, "UTM is installed", "Ready")}</div>`
      );
      const row = el.querySelector(`.status-row.status-${kind}`)!;
      expect(
        row.querySelector("svg.status-icon")!.getAttribute("aria-hidden")
      ).to.equal("true");
      expect(row.querySelector(".status-title")!.textContent).to.equal(
        "UTM is installed"
      );
      expect(row.querySelector(".status-description")!.textContent).to.equal(
        "Ready"
      );
      // A result isn't something to stop at, and needs no help
      expect(row.hasAttribute("data-focus-alert")).to.be.false;
      expect(row.querySelector(".error-help")).to.be.null;
    });
  }

  it("marks an error to take the focus, and links to help", () => {
    const el = fixtureSync(
      html`<div>
        ${renderStatusRow("error", "Connection failed", "Could not connect.")}
      </div>`
    );
    const row = el.querySelector(".status-row.status-error")!;
    expect(row.hasAttribute("data-focus-alert")).to.be.true;
    expect(el.querySelectorAll("[data-focus-alert]")).to.have.length(1);
    expect(row.querySelector(".status-title")!.textContent).to.equal(
      "Connection failed"
    );
    expect(row.querySelector(".status-description")!.textContent).to.equal(
      "Could not connect."
    );
    expect(row.querySelector(".status-text .error-help a")).to.exist;
    // Try again belongs to whoever renders the row
    expect(row.querySelector("wa-button")).to.be.null;
  });

  // The copies had drifted: other sizes, colors that ignored the theme, and a
  // spinner of their own that kept turning with reduced motion
  it("is styled by the shared rules on every step that checks", () => {
    for (const tag of STATUS_STEPS) {
      const styles = (customElements.get(tag) as typeof LitElement)
        .elementStyles;
      expect(styles.includes(statusRowStyles), tag).to.be.true;
      const own = ownStyles(tag, statusRowStyles);
      expect(own, tag).not.to.match(
        /(^|[\s}])(\.status-row|\.status-icon|\.status-text|\.status-title|\.status-description|\.spinner)\s*\{|@keyframes spin/
      );
      expect(own, tag).not.to.match(/#4caf50|#ff9800|rgba\(244/i);
    }
  });
});
