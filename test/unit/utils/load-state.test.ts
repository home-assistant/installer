import { expect, fixtureSync, html } from "@open-wc/testing";
import type { LitElement } from "lit";
import {
  loadStateStyles,
  renderLoadError,
  renderLoading,
  renderRetryButton,
} from "../../../src/utils/load-state.js";
import type { InstallerError } from "../../../src/utils/installer-error.js";
import "../../../src/views/ha-hardware/device-selection-view.js";
import "../../../src/views/minipc/architecture-selection-view.js";
import "../../../src/views/sbc/device-selection-view.js";
import "../../../src/views/sbc/drive-selection-view.js";

const STEPS = [
  "ha-hardware-device-selection-view",
  "minipc-architecture-selection-view",
  "device-selection-view",
  "drive-selection-view",
];

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
      const own = styles
        .filter((style) => style !== loadStateStyles)
        .map((style) => ("cssText" in style ? style.cssText : ""))
        .join("\n");
      expect(own, tag).not.to.match(
        /(^|[\s}])(\.loading|\.loading-spinner|\.error|\.error-icon|\.error-message)\s*\{|@keyframes spin/
      );
    }
  });
});
