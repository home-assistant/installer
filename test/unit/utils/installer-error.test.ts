import { expect, fixtureSync, html } from "@open-wc/testing";
import {
  installerError,
  renderErrorHelp,
} from "../../../src/utils/installer-error.js";
import { ipcError } from "../tauri-ipc.js";

describe("installer errors", () => {
  it("maps stable codes without exposing raw service messages", () => {
    const result = installerError(ipcError("proxmox_api", "password=secret"));
    expect(result.message).to.contain("account permissions");
    expect(result.message).not.to.contain("secret");
    expect(result.retryable).to.be.false;
  });

  it("formats structured capacity details and rejects unsafe retry", () => {
    const result = installerError(
      ipcError("image_too_large", "raw bytes", false, {
        // Decimal units, like drive capacities
        image_size: 4_000_000_000,
        drive_size: 2_000_000_000,
      })
    );
    expect(result.message).to.equal(
      "The image needs 4 GB. This drive holds 2 GB. Choose a larger drive."
    );
    expect(result.retryable).to.be.false;
  });

  it("preserves native permission and retained-source instructions", () => {
    for (const code of [
      "permission_denied",
      "utm",
      "utm_operation_uncertain",
    ]) {
      const result = installerError(
        ipcError(code, "Open System Settings before continuing")
      );
      expect(result.message).to.equal("Open System Settings before continuing");
      expect(result.retryable).to.be.false;
    }
  });

  it("preserves installer-authored Proxmox corrective guidance", () => {
    const result = installerError(
      ipcError(
        "proxmox_action_required",
        "VM ID 100 can't be used. Choose a different ID."
      )
    );
    expect(result.message).to.contain("Choose a different ID");
  });

  it("does not infer a code or retryability from a string", () => {
    for (const error of [
      "drive disconnected",
      new Error("drive disconnected"),
    ]) {
      const result = installerError(error);
      expect(result.message).to.equal("drive disconnected");
      expect(result.code).to.equal("unknown");
      expect(result.retryable).to.be.false;
    }
  });

  it("handles malformed and future responses without object stringification", () => {
    for (const error of [
      null,
      undefined,
      {},
      42,
      " ",
      { code: "io", message: {} },
    ]) {
      expect(installerError(error, "Fallback").message).to.equal("Fallback");
    }
    expect(
      installerError(ipcError("future_code", "Useful future message")).message
    ).to.equal("Useful future message");
    expect(
      installerError(ipcError("toString", "Useful future message")).message
    ).to.equal("Useful future message");
  });

  it("only puts fixed public destinations in help and report links", () => {
    const el = fixtureSync(html`<div>${renderErrorHelp()}</div>`);
    const links = [...el.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).to.deep.equal([
      "Installation help",
    ]);
    // Reporting goes through the diagnostics dialog instead of a bare link
    expect(el.querySelector("diagnostics-actions")).to.exist;
    for (const link of links) expect(new URL(link.href).search).to.equal("");
  });
});
