import { expect } from "@open-wc/testing";
import {
  diagnosticError,
  diagnosticFields,
  diagnosticText,
  getDiagnostics,
  InstallDiagnostics,
  reportUrl,
  REPORT_URL_LIMIT,
  type Diagnostics,
} from "../../../src/utils/diagnostics.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

const data: Diagnostics = {
  version: "0.1.0",
  os: "linux",
  os_version: "6.12",
  architecture: "x86_64",
  package_type: "AppImage",
  log_tail: "0ms application started",
};

describe("diagnostics privacy", () => {
  afterEach(restoreTauriIpc);

  it("never forwards private error details or unknown stage text to IPC or reports", async () => {
    const calls: unknown[] = [];
    mockTauriIpc(
      (cmd, args) => {
        if (cmd === "log_frontend_event") {
          calls.push(args);
          return;
        }
        if (cmd === "get_diagnostics") return data;
        throw new Error(cmd);
      },
      { includeLogs: true }
    );
    const run = new InstallDiagnostics("proxmox");
    run.advance("writing");
    run.advance("private-host password=secret");
    run.fail(
      "Proxmox API error: https://private-user:password-secret@private-host/?ticket=secret-ticket&csrf=secret-csrf\nInjected raw line"
    );
    const diagnostics = await getDiagnostics();
    const combined =
      JSON.stringify(calls) +
      diagnosticText(diagnostics) +
      reportUrl(diagnostics).url;
    for (const secret of [
      "private-user",
      "private-host",
      "password-secret",
      "secret-ticket",
      "secret-csrf",
      "Injected",
    ]) {
      expect(combined).not.to.contain(secret);
    }
    expect(diagnosticFields(diagnostics)).to.include({
      flow: "proxmox",
      stage: "writing",
      error: "proxmox_error",
    });
    expect(calls).to.have.length(4);
  });

  it("keeps a report snapshot stable when a retry starts", async () => {
    mockTauriIpc((cmd) => (cmd === "get_diagnostics" ? data : undefined));
    const run = new InstallDiagnostics("utm");
    run.advance("updating");
    run.fail(new Error("Timed out with private data"));
    const snapshot = await getDiagnostics();
    new InstallDiagnostics("flash");
    expect(diagnosticFields(snapshot)).to.include({
      flow: "utm",
      stage: "updating",
      error: "timeout",
    });
    expect(diagnosticFields(await getDiagnostics()).error).to.equal("none");
  });

  it("bounds encoded report URLs and preserves metadata while shortening logs", () => {
    const large = { ...data, log_tail: "😀%&?=".repeat(10000) };
    const report = reportUrl(large);
    const url = new URL(report.url);
    expect(report.shortened).to.be.true;
    expect(report.url.length).to.be.at.most(REPORT_URL_LIMIT);
    expect(url.searchParams.get("version")).to.equal(data.version);
    expect(url.searchParams.get("template")).to.equal("bug_report.yml");
    expect(diagnosticText(large)).to.contain(diagnosticFields(large).logs);
  });

  it("does not serialize object errors, messages, or arbitrary error names", () => {
    expect(
      diagnosticError({ message: "password=secret", ticket: "secret" })
    ).to.equal("operation_failed");
    expect(
      diagnosticError(new Error("Verification failed: /home/private/image"))
    ).to.equal("verification_failed");
  });
});
