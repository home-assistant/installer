import { expect } from "@open-wc/testing";
import { html, render } from "lit";
import { formatBytes } from "../../src/api/commands.js";
import { detectLanguage } from "../../src/localization/initialize.js";
import {
  formatNumber,
  getLanguage,
  localize,
  localizeContent,
  resolveLanguage,
  setLanguage,
} from "../../src/localization/localize.js";

describe("localization", () => {
  afterEach(() => setLanguage(["en"]));

  it("uses the English catalog and retains supported regional formatting", () => {
    expect(resolveLanguage(["en-gb"])).to.equal("en-GB");
    expect(resolveLanguage(["en-IN"])).to.equal("en-IN");
    expect(resolveLanguage(["de-DE", "en-GB"])).to.equal("en-GB");
    expect(resolveLanguage(["invalid_locale", "fr-FR"])).to.equal("en");
    expect(resolveLanguage([])).to.equal("en");
    setLanguage(["en-IN"]);
    expect(localize("common.next")).to.equal("Next");
    expect(formatNumber(1234567)).to.equal("12,34,567");
  });

  it("prefers the native OS locale over the browser and falls back safely", async () => {
    await detectLanguage(["en-US"], async () => "en-GB");
    expect(getLanguage()).to.equal("en-GB");
    await detectLanguage(["en-IN"], async () => null);
    expect(getLanguage()).to.equal("en-IN");
    await detectLanguage(["en-GB"], async () => "invalid_locale");
    expect(getLanguage()).to.equal("en-GB");
    await detectLanguage(["en-US"], async () => {
      throw new Error("locale unavailable");
    });
    expect(getLanguage()).to.equal("en-US");
    await detectLanguage(["fr-FR"]);
    expect(getLanguage()).to.equal("en");
  });

  it("does not let an unresponsive native locale command prevent startup", async () => {
    await detectLanguage(["en-GB"], () => new Promise(() => undefined));
    expect(getLanguage()).to.equal("en-GB");
  });

  it("formats ICU plural durations without changing the existing wording", () => {
    expect(
      localize(
        "views.proxmox.proxmox_progress_view.about_value_minutevalue_remaining",
        { value0: 1 }
      )
    ).to.equal("About 1 minute remaining");
    expect(
      localize(
        "views.proxmox.proxmox_progress_view.about_value_minutevalue_remaining",
        { value0: 2 }
      )
    ).to.equal("About 2 minutes remaining");
    expect(
      localize(
        "views.proxmox.proxmox_progress_view.about_valueh_valuem_remaining",
        { value0: 1, value1: 30 }
      )
    ).to.equal("About 1h 30m remaining");
  });

  it("preserves the existing decimal byte basis, unit labels, and flooring", () => {
    expect(formatBytes(0)).to.equal("0 B");
    expect(formatBytes(1000)).to.equal("1 KB");
    expect(formatBytes(1599)).to.equal("1.5 KB");
    expect(formatBytes(1000 ** 3)).to.equal("1 GB");
    expect(
      formatNumber(Number((1.25).toFixed(1)), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    ).to.equal("1.3");
    expect(
      formatNumber(0.125, { style: "percent", maximumFractionDigits: 20 })
    ).to.equal("12.5%");
  });

  it("renders dynamic data as text while preserving code-owned rich placeholders", () => {
    const drive = '<img src=x onerror="alert(1)">';
    const el = document.createElement("div");
    render(
      html`${localizeContent("components.confirm_dialog.erase_warning", {
        drive: html`<strong>${drive}</strong>`,
      })}`,
      el
    );
    expect(el.querySelector("img")).to.equal(null);
    expect(el.querySelector("strong")?.textContent).to.equal(drive);
    expect(el.textContent).to.equal(
      `All data on ${drive} will be permanently erased. This action cannot be undone.`
    );
    expect(
      localize("utm.update_timeout", { address: "http://192.0.2.1" })
    ).to.contain("http://192.0.2.1");
  });
});
