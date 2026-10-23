import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import type WaRadio from "@home-assistant/webawesome/dist/components/radio/radio.js";
import "../../../../src/views/minipc/architecture-selection-view.js";
import type { MiniPCArchitectureSelectionView } from "../../../../src/views/minipc/architecture-selection-view.js";
import { MOCK_MANIFEST } from "../../../../src/api/mock-data.js";
import type { DeviceManifest } from "../../../../src/api/types.js";
import { findByRole, fullA11ySnapshot } from "../../helpers/a11y.js";
import {
  deferred,
  ipcError,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";
import { wizardState } from "../../../../src/state/wizard-state.js";

describe("minipc-architecture-selection-view focus", () => {
  afterEach(() => {
    restoreTauriIpc();
    wizardState.reset();
  });

  it("focuses its heading and does not refocus on ordinary updates", async () => {
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    await waitUntil(() => !!el.shadowRoot!.activeElement);
    // The shared view policy focuses the new view's heading first
    expect(el.shadowRoot!.activeElement!.tagName).to.equal("H2");
    const button = fixtureSync<HTMLButtonElement>(
      html`<button>Cancel</button>`
    );
    button.focus();
    el.requestUpdate();
    await el.updateComplete;
    expect(document.activeElement).to.equal(button);
  });

  it("focuses the retry control if loading fails", async () => {
    mockTauriIpc(() => Promise.reject("Manifest unavailable"));
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    // A loading failure focuses its alert, next to the retry control. The
    // heading, there while it loads, has the focus until then.
    await waitUntil(
      () => el.shadowRoot!.activeElement?.getAttribute("role") === "alert",
      "the alert never got the focus"
    );
  });

  it("does not steal focus moved elsewhere while the manifest loads", async () => {
    const manifest = deferred<DeviceManifest>();
    mockTauriIpc((cmd) => {
      if (cmd === "get_manifest") return manifest.promise;
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    const button = fixtureSync<HTMLButtonElement>(
      html`<button>Cancel</button>`
    );
    button.focus();
    manifest.resolve(MOCK_MANIFEST);
    await settle();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelectorAll("wa-radio")).to.have.length(2);
    expect(document.activeElement).to.equal(button);
  });
});

describe("minipc-architecture-selection-view choices", () => {
  afterEach(() => {
    // The stub shadows the prototype getter; deleting it restores the real UA.
    delete (window.navigator as { userAgent?: string }).userAgent;
    restoreTauriIpc();
    wizardState.reset();
  });

  async function renderChoices(
    manifest: () => unknown = () => MOCK_MANIFEST,
    utmSupported = true
  ) {
    wizardState.startFlow("minipc");
    mockTauriIpc((cmd) => {
      if (cmd === "utm_supported") return utmSupported;
      expect(cmd).to.equal("get_manifest");
      return manifest();
    });
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    await waitUntil(
      () => !el.shadowRoot!.querySelector(".loading"),
      "manifest load never settled"
    );
    return el;
  }

  function radios(el: MiniPCArchitectureSelectionView) {
    return [...el.shadowRoot!.querySelectorAll<WaRadio>("wa-radio")];
  }

  it("offers the x86-64 and ARM64 images as a named radio group", async () => {
    const el = await renderChoices();
    expect(radios(el).map((radio) => radio.value)).to.deep.equal([
      "generic-x86-64",
      "generic-aarch64",
    ]);
    expect(radios(el)[0].textContent).to.contain("Intel/AMD (x86-64)");
    expect(radios(el)[1].textContent).to.contain("ARM (aarch64)");
    await el.shadowRoot!.querySelector("wa-radio-group")!.updateComplete;

    const groups = findByRole(await fullA11ySnapshot(), "radiogroup");
    expect(groups).to.have.length(1);
    expect(groups[0]!.name).to.equal("Processor");
    expect(findByRole(groups[0]!, "radio")).to.have.length(2);
  });

  it("leaves out an architecture the catalog does not list", async () => {
    const el = await renderChoices(() => ({
      ...MOCK_MANIFEST,
      devices: MOCK_MANIFEST.devices.filter(
        (device) => device.category !== "generic_arm64"
      ),
    }));
    expect(radios(el).map((radio) => radio.value)).to.deep.equal([
      "generic-x86-64",
    ]);
  });

  it("stores the chosen architecture for the following steps", async () => {
    const el = await renderChoices();
    const arm = radios(el).find((radio) => radio.value === "generic-aarch64")!;

    arm.click();
    await waitUntil(
      () => wizardState.getState().selections.device === "generic-aarch64",
      "choice never stored"
    );

    const selections = wizardState.getState().selections;
    expect(selections.deviceName).to.equal("ARM (aarch64)");
    expect(selections.deviceImage).to.equal("/assets/icons/chip.svg");
    expect(selections.deviceConfig!.board).to.equal("generic-aarch64");
  });

  it("marks the chosen architecture with a check, not only a color", async () => {
    const el = await renderChoices();
    const checks = () =>
      radios(el).map((radio) => !!radio.querySelector(".selected-indicator"));
    expect(checks()).to.deep.equal([false, false]);

    radios(el)[1].click();
    await waitUntil(() => checks()[1], "choice never marked");
    expect(checks()).to.deep.equal([false, true]);
    const check = radios(el)[1].querySelector(".selected-indicator")!;
    expect(check.getAttribute("aria-hidden")).to.equal("true");
    // The check sits in the radio's corner, out of the centered content
    const radioBox = radios(el)[1].getBoundingClientRect();
    const checkBox = check.getBoundingClientRect();
    expect(checkBox.width).to.be.greaterThan(0);
    expect(radioBox.right - checkBox.right).to.be.within(8, 10);
    expect(checkBox.top - radioBox.top).to.be.within(8, 10);

    radios(el)[0].click();
    await waitUntil(() => checks()[0], "new choice never marked");
    expect(checks()).to.deep.equal([true, false]);
  });

  it("keeps the processor logos from screen readers", async () => {
    const el = await renderChoices();
    await el.shadowRoot!.querySelector("wa-radio-group")!.updateComplete;
    const tree = await fullA11ySnapshot();

    expect(findByRole(tree, "image")).to.deep.equal([]);
    expect(findByRole(tree, "radio")[0]!.name).to.contain("Intel/AMD (x86-64)");
  });

  // Apple silicon Macs also report "Intel Mac OS X"
  const macUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  for (const [machine, userAgent, utmSupported, pointed] of [
    ["a Mac with Apple silicon", macUserAgent, true, true],
    ["an Intel Mac", macUserAgent, false, false],
    [
      "Linux",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      false,
      false,
    ],
  ] as const) {
    it(`${pointed ? "points" : "does not point"} users on ${machine} to the virtual machine path`, async () => {
      Object.defineProperty(window.navigator, "userAgent", {
        value: userAgent,
        configurable: true,
      });
      const el = await renderChoices(undefined, utmSupported);
      const note = el.shadowRoot!.querySelector(".mac-note");
      if (pointed) {
        expect(note!.textContent).to.contain("on this Mac itself");
        expect(note!.querySelector("strong")!.textContent).to.equal(
          "Virtual machine"
        );
      } else {
        expect(note === null).to.equal(true);
      }
    });
  }

  it("does not ask whether UTM runs on a computer other than a Mac", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
      configurable: true,
    });
    const commands: string[] = [];
    wizardState.startFlow("minipc");
    mockTauriIpc((cmd) => {
      commands.push(cmd);
      return MOCK_MANIFEST;
    });
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    await waitUntil(() => radios(el).length === 2, "catalog never loaded");
    await settle();
    expect(commands).to.deep.equal(["get_manifest"]);
  });

  it("offers the architectures without waiting to hear whether the Mac runs UTM", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: macUserAgent,
      configurable: true,
    });
    const utm = deferred<boolean>();
    wizardState.startFlow("minipc");
    mockTauriIpc((cmd) =>
      cmd === "utm_supported" ? utm.promise : MOCK_MANIFEST
    );
    const el = await fixture<MiniPCArchitectureSelectionView>(
      html`<minipc-architecture-selection-view></minipc-architecture-selection-view>`
    );
    await waitUntil(() => radios(el).length === 2, "catalog waited for UTM");
    expect(el.shadowRoot!.querySelector(".mac-note") === null).to.be.true;

    utm.resolve(true);
    await waitUntil(
      () => el.shadowRoot!.querySelector(".mac-note"),
      "note never shown"
    );
  });

  it("loads the architectures again on Try again", async () => {
    let attempts = 0;
    const el = await renderChoices(() =>
      ++attempts === 1
        ? Promise.reject(ipcError("network", "offline", true))
        : MOCK_MANIFEST
    );
    expect(
      el.shadowRoot!.querySelector('[role="alert"]')!.textContent
    ).to.contain("Could not connect");

    const retry = [...el.shadowRoot!.querySelectorAll("wa-button")].find(
      (button) => button.textContent!.includes("Try again")
    )!;
    retry.click();
    await waitUntil(() => radios(el).length === 2, "catalog never reloaded");

    expect(attempts).to.equal(2);
    expect(el.shadowRoot!.querySelector('[role="alert"]')).to.not.exist;
  });
});
