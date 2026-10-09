import { expect } from "@open-wc/testing";
import { failMockOperation } from "../../../src/api/mock-failures.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

describe("browser mock failures", () => {
  afterEach(() => {
    sessionStorage.removeItem("hai:mock-failure");
    restoreTauriIpc();
  });

  for (const [scenario, operation, code, retryable] of [
    ["flash-write", "flash", "device_busy", true],
    ["flash-disconnected", "flash", "drive_disconnected", false],
    ["proxmox-install", "proxmox", "proxmox_api", false],
    ["utm-create", "utm", "utm", true],
  ] as const) {
    it(`rejects ${scenario} once like a native command error`, () => {
      sessionStorage.setItem("hai:mock-failure", scenario);
      let rejection: unknown;
      try {
        failMockOperation(operation);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).to.include({ code, retryable });
      expect(rejection).to.have.property("message").that.is.a("string");
      expect(sessionStorage.getItem("hai:mock-failure")).to.equal(null);
      expect(() => failMockOperation(operation)).not.to.throw();
    });
  }

  it("does not consume another operation's failure", () => {
    sessionStorage.setItem("hai:mock-failure", "utm-create");
    failMockOperation("flash");
    expect(sessionStorage.getItem("hai:mock-failure")).to.equal("utm-create");
  });

  it("ignores unknown scenarios", () => {
    sessionStorage.setItem("hai:mock-failure", "unknown");
    expect(() => failMockOperation("flash")).not.to.throw();
  });

  it("cannot inject failures into the native IPC path", () => {
    mockTauriIpc(() => undefined);
    sessionStorage.setItem("hai:mock-failure", "flash-write");
    expect(() => failMockOperation("flash")).not.to.throw();
    expect(sessionStorage.getItem("hai:mock-failure")).to.equal("flash-write");
  });
});
