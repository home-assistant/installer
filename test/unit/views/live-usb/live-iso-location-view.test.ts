import { expect, fixtureSync, html } from "@open-wc/testing";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { fireEvent } from "../../../../src/utils/fire-event.js";
import type { InlineNotice } from "../../../../src/components/inline-notice.js";
import "../../../../src/views/live-usb/live-iso-location-view.js";
import type { LiveIsoLocationView } from "../../../../src/views/live-usb/live-iso-location-view.js";
import {
  findByRole,
  fullA11ySnapshot,
  type AXNode,
} from "../../helpers/a11y.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

type FocusedAXNode = AXNode & { focused?: boolean; children?: FocusedAXNode[] };

function focusedNode(node: FocusedAXNode): FocusedAXNode | undefined {
  for (const child of node.children ?? []) {
    const focused = focusedNode(child);
    if (focused) return focused;
  }
  return node.focused && node.role !== "RootWebArea" ? node : undefined;
}

describe("live-iso-location-view", () => {
  let location: ReturnType<typeof deferred<{ exists: boolean }>>;

  beforeEach(() => {
    wizardState.startFlow("minipc");
    wizardState.setSelection("liveMedia", "iso");
    wizardState.setSelection("liveIsoFolder", "/home/me");
    wizardState.setSelection("liveIsoName", "stick.iso");
    location = deferred();
    mockTauriIpc((cmd) => {
      if (cmd === "live_usb_status") {
        return { hai_live_found: true };
      }
      if (cmd === "check_iso_location") return location.promise;
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    wizardState.reset();
    restoreTauriIpc();
  });

  it("asks before replacing an existing file", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    const checking = el.check();
    location.resolve({ exists: true });
    await settle();

    fireEvent(el.shadowRoot!.querySelector("info-dialog")!, "dialog-primary");
    expect(await checking).to.equal(true);
    expect(wizardState.getState().selections.liveIsoOverwrite).to.equal(true);
  });

  it("doesn't show a problem with a name that was changed during the check", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    await settle();
    const checking = el.check();
    const [, name] = el.shadowRoot!.querySelectorAll("wa-input");
    name.value = "fixed.iso";
    name.dispatchEvent(new Event("input"));
    location.reject(ipcError("invalid_file_name", "No separators"));

    expect(await checking).to.equal(false);
    await settle();
    expect(el.shadowRoot!.querySelector("inline-notice")).to.not.exist;
    expect(name.hasAttribute("custom-error")).to.be.false;
  });

  it("shows a problem with the location in an error notice, which takes the focus", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    await settle();
    const checking = el.check();
    location.reject(ipcError("io", "Could not read or write a file."));
    expect(await checking).to.equal(false);
    await settle();

    const notice = el.shadowRoot!.querySelector<InlineNotice>(
      ".card inline-notice"
    )!;
    expect(notice.variant).to.equal("error");
    const text = notice.textContent!.trim();
    expect(text).to.not.equal("");
    expect(el.shadowRoot!.activeElement).to.equal(notice);
    // Focused, it is read out by what it says
    const focused = focusedNode(await fullA11ySnapshot());
    expect(focused?.name?.trim()).to.equal(text);
    expect(findByRole(await fullA11ySnapshot(), "alert")).to.have.length(0);
  });

  for (const [code, field] of [
    ["invalid_file_name", "name"],
    ["folder_name_taken", "name"],
    ["folder_not_found", "folder"],
    ["folder_in_cache", "folder"],
  ] as const) {
    it(`puts ${code} on the ${field} field, which takes the focus`, async () => {
      const el = fixtureSync<LiveIsoLocationView>(
        html`<live-iso-location-view></live-iso-location-view>`
      );
      await settle();
      const checking = el.check();
      location.reject(ipcError(code, "Refused"));
      expect(await checking).to.equal(false);
      await settle();

      const input = el.shadowRoot!.querySelector<WaInput>(`wa-input.${field}`)!;
      expect(el.shadowRoot!.querySelector("inline-notice")).to.not.exist;
      expect(el.shadowRoot!.activeElement).to.equal(input);
      expect(input.input.getAttribute("aria-invalid")).to.equal("true");
      expect(input.querySelector('[slot="hint"]')!.textContent).to.not.equal(
        ""
      );
      for (const other of el.shadowRoot!.querySelectorAll<WaInput>(
        `wa-input:not(.${field})`
      )) {
        expect(other.hasAttribute("custom-error")).to.be.false;
      }

      // Typing in it takes the problem away
      input.value = "other";
      input.dispatchEvent(new Event("input"));
      await settle();
      expect(input.hasAttribute("custom-error")).to.be.false;
    });
  }

  // Next keeps the focus while it is busy; a notice that went away with it
  // outside the view would send the focus to the heading instead
  it("keeps the problem through another check, and reads it out again", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      const el = fixtureSync<LiveIsoLocationView>(
        html`<live-iso-location-view></live-iso-location-view>`
      );
      await settle();
      const refused = ipcError("io", "Could not read or write a file.");
      const first = el.check();
      location.reject(refused);
      expect(await first).to.equal(false);
      await settle();

      outside.focus();
      location = deferred();
      const second = el.check();
      await settle();
      expect(el.shadowRoot!.querySelector(".problem")).to.exist;
      expect(document.activeElement).to.equal(outside);

      location.reject(refused);
      expect(await second).to.equal(false);
      await settle();
      expect(el.shadowRoot!.activeElement).to.equal(
        el.shadowRoot!.querySelector(".problem")
      );
    } finally {
      outside.remove();
    }
  });

  it("asks for Next on Enter in the folder or the file name, not on Browse", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    await settle();
    let next = 0;
    el.addEventListener("wizard-next", () => next++);
    const enter = () =>
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        composed: true,
      });

    const browse = el.shadowRoot!.querySelector("wa-button")!;
    await browse.updateComplete;
    browse.shadowRoot!.querySelector("button")!.dispatchEvent(enter());
    expect(next).to.equal(0);

    const fields = [...el.shadowRoot!.querySelectorAll<WaInput>("wa-input")];
    await Promise.all(fields.map((field) => field.updateComplete));
    for (const field of fields) field.input.dispatchEvent(enter());
    expect(next).to.equal(2);
  });

  it("settles a check that answers after the view was left", async () => {
    const el = fixtureSync<LiveIsoLocationView>(
      html`<live-iso-location-view></live-iso-location-view>`
    );
    let result: boolean | undefined;
    void el.check().then((ok) => (result = ok));
    await settle();

    // Back or Cancel removes the view while the backend still checks
    el.remove();
    location.resolve({ exists: true });
    await settle();

    expect(result).to.equal(false);
    expect(wizardState.getState().selections.liveIsoOverwrite).to.not.equal(
      true
    );
  });
});
