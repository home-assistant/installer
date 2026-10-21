import { expect, fixture, html } from "@open-wc/testing";
import "../../../src/components/diagnostics-actions.js";
import type { DiagnosticsActions } from "../../../src/components/diagnostics-actions.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../tauri-ipc.js";

describe("diagnostics-actions", () => {
  afterEach(restoreTauriIpc);

  it("shows runtime version, public warning, and the copied report payload", async () => {
    mockTauriIpc((cmd) => {
      if (cmd === "plugin:app|version") return "2.3.4";
      if (cmd === "get_diagnostics")
        return {
          version: "2.3.4",
          os: "linux",
          os_version: "6.12",
          architecture: "x86_64",
          package_type: "Deb",
          log_tail: "0ms application started",
        };
      throw new Error(cmd);
    });
    const el = await fixture<DiagnosticsActions>(
      html`<diagnostics-actions about></diagnostics-actions>`
    );
    el.shadowRoot!.querySelector<HTMLElement>("wa-button")!.click();
    await settle();
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).to.contain(
      "Home Assistant Installer 2.3.4"
    );
    expect(el.shadowRoot!.textContent).to.contain("GitHub issues are public");
    expect(el.shadowRoot!.querySelector("textarea")!.value).to.contain(
      "package: Deb"
    );
  });

  it("lines the error launcher up with its text, but pads the dialog buttons", async () => {
    const el = await fixture<DiagnosticsActions>(
      // The theme that sets the button padding isn't loaded in unit tests
      html`<diagnostics-actions
        style="--wa-form-control-padding-inline: 1rem"
      ></diagnostics-actions>`
    );
    const buttons = [...el.shadowRoot!.querySelectorAll("wa-button")];
    await Promise.all(buttons.map((button) => button.updateComplete));
    const padding = buttons.map(
      (button) =>
        getComputedStyle(button.shadowRoot!.querySelector("[part~=base]")!)
          .paddingInlineStart
    );

    expect(buttons[0].classList.contains("launcher")).to.be.true;
    expect(padding[0]).to.equal("0px");
    expect(padding.slice(1)).to.have.length.greaterThan(0);
    for (const value of padding.slice(1)) {
      expect(value).to.equal("16px");
    }
  });

  it("keeps logs available and reports failure when diagnostics cannot load", async () => {
    let opened = false;
    mockTauriIpc((cmd) => {
      if (cmd === "open_logs_folder") {
        opened = true;
        return;
      }
      throw new Error("unavailable");
    });
    const el = await fixture<DiagnosticsActions>(
      html`<diagnostics-actions></diagnostics-actions>`
    );
    el.shadowRoot!.querySelector<HTMLElement>("wa-button")!.click();
    await settle();
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).to.contain(
      "Diagnostics could not be loaded"
    );
    expect(
      el
        .shadowRoot!.querySelector("wa-button[variant='brand']")!
        .hasAttribute("disabled")
    ).to.be.true;
    const buttons = [
      ...el.shadowRoot!.querySelectorAll<HTMLElement>("wa-button"),
    ];
    buttons
      .find((button) => button.textContent?.trim() === "Open logs folder")!
      .click();
    await settle();
    expect(opened).to.be.true;
  });
});
