import { expect, fixtureSync, html } from "@open-wc/testing";
import {
  installerError,
  isDriveFailure,
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

  it("keeps internals of a configuration error out of the message", () => {
    const result = installerError(
      ipcError("invalid_config", "Cannot parse board from: haos_x.img.xz")
    );
    expect(result.message).to.equal(
      "The installer couldn't prepare this installation. Report the problem if it continues."
    );
    expect(
      installerError(ipcError("proxmox_session_expired", "raw")).message
    ).to.contain("Reconnect to Proxmox");
  });

  it("says when the release, not the installer, is the problem", () => {
    const result = installerError(
      ipcError("release_unavailable", "No raw image in release", true)
    );
    expect(result.message).to.equal(
      "The latest Home Assistant OS release can't be used right now. Try again later."
    );
    expect(result.retryable).to.be.true;
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

  it("shows backend messages from the catalog, by key", () => {
    const result = installerError(
      ipcError("proxmox_action_required", "English from Rust", false, {
        message_key: "backend.proxmox.node_offline",
        message_params: { node: "pve" },
      })
    );
    expect(result.message).to.equal(
      'Node "pve" is offline. Choose an online node or start it in Proxmox.'
    );
  });

  it("shows permission, two-factor, rate-limit and size errors from the catalog", () => {
    for (const [code, key, params, expected] of [
      [
        "permission_denied",
        "backend.disk.removable_volumes_blocked",
        { device: "/dev/rdisk4" },
        "macOS blocked access to /dev/rdisk4.",
      ],
      [
        "proxmox_two_factor",
        "backend.proxmox.two_factor_http_error",
        { status: 500 },
        "Proxmox returned HTTP 500 while completing the second-factor login.",
      ],
      [
        "rate_limited",
        "backend.download.github_rate_limited",
        { minutes: 3 },
        "Wait at least 3 minutes, then try again.",
      ],
      [
        "rate_limited",
        "backend.download.github_rate_limited",
        { minutes: 1 },
        "Wait at least 1 minute, then try again.",
      ],
      [
        "drive_too_small",
        "backend.disk.drive_too_small",
        { size: 32 },
        "At least a 32 GB drive is required.",
      ],
      [
        "proxmox_action_required",
        "backend.proxmox.import_storage_too_small",
        { size_mb: 1536, storages: "local" },
        "Not enough free space for the 1,536 MB image on import storage: local.",
      ],
    ] as const) {
      const result = installerError(
        ipcError(code, "English from Rust", false, {
          message_key: key,
          message_params: params,
        })
      );
      expect(result.message, code).to.contain(expected);
    }
  });

  it("shows a message inside a backend message in the user's language", () => {
    const result = installerError(
      ipcError("utm_vm_created", "English from Rust", false, {
        message_key: "backend.utm.vm_created_not_started",
        message_params: {
          name: "My home",
          detail: { key: "backend.utm.automation_denied", params: {} },
        },
      })
    );
    expect(result.message).to.contain('"My home" was created');
    expect(result.message).to.contain("Privacy & Security > Automation");
    expect(result.message).not.to.contain("English from Rust");
  });

  it("never shows an empty backend message", () => {
    // osascript killed without output leaves UTM's "{detail}" empty
    const result = installerError(
      ipcError("utm_operation_uncertain", "", false, {
        message_key: "backend.utm.no_answer",
        message_params: { detail: "" },
      }),
      "Fallback"
    );
    expect(result.message).to.equal("Fallback");
  });

  it("keeps the backend's English when the catalog can't help", () => {
    for (const details of [
      // A key this frontend doesn't know yet
      { message_key: "backend.proxmox.from_the_future" },
      // Only backend keys, never the frontend's own
      { message_key: "common.installation_help" },
      // A parameter the message needs is missing
      { message_key: "backend.proxmox.node_offline", message_params: {} },
      // Values that aren't plain text or numbers are dropped
      {
        message_key: "backend.proxmox.node_offline",
        message_params: { node: { name: "pve" } },
      },
      {
        message_key: "backend.proxmox.node_offline",
        message_params: { node: true },
      },
      // A message inside it that this frontend doesn't know
      {
        message_key: "backend.utm.vm_created_not_started",
        message_params: {
          name: "My home",
          detail: { key: "backend.utm.from_the_future", params: {} },
        },
      },
    ]) {
      const result = installerError(
        ipcError("proxmox_action_required", "English from Rust", false, details)
      );
      expect(result.message).to.equal("English from Rust");
    }
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
      "Installation help Opens in your browser.",
    ]);
    // Reporting goes through the diagnostics dialog instead of a bare link
    expect(el.querySelector("diagnostics-actions")).to.exist;
    for (const link of links) {
      expect(new URL(link.href).search).to.equal("");
      expect(link.target).to.equal("_blank");
      expect(link.rel).to.equal("noopener noreferrer");
    }
  });

  describe("isDriveFailure", () => {
    for (const code of [
      "device_not_found",
      "drive_disconnected",
      "drive_too_small",
      "image_too_large",
      "write_protected",
    ]) {
      it(`blames the drive for ${code} at any stage`, () => {
        expect(isDriveFailure(code, false)).to.be.true;
        expect(isDriveFailure(code, true)).to.be.true;
      });
    }

    // Before the write, these are about this computer's storage or the image
    for (const code of ["io", "verification_failed"]) {
      it(`blames the drive for ${code} only once the write reached it`, () => {
        expect(isDriveFailure(code, false)).to.be.false;
        expect(isDriveFailure(code, true)).to.be.true;
      });
    }

    for (const code of [
      "json",
      "invalid_config",
      "internal",
      "operation_in_progress",
      "unsupported_platform",
      "unknown",
    ]) {
      it(`never blames the drive for ${code}`, () => {
        expect(isDriveFailure(code, false)).to.be.false;
        expect(isDriveFailure(code, true)).to.be.false;
      });
    }
  });
});
