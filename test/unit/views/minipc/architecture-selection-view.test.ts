import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import type { OptionCard } from "../../../../src/components/option-card.js";
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
    // A loading failure focuses its message, next to the retry control. The
    // heading, there while it loads, has the focus until then.
    await waitUntil(
      () => el.shadowRoot!.activeElement?.hasAttribute("data-focus-alert"),
      "the error never got the focus"
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
    expect(el.shadowRoot!.querySelectorAll("option-card")).to.have.length(2);
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

  function cards(el: MiniPCArchitectureSelectionView) {
    return [...el.shadowRoot!.querySelectorAll<OptionCard>("option-card")];
  }

  it("offers the x86-64 and ARM64 images as a named group of buttons", async () => {
    const el = await renderChoices();
    expect(cards(el).map((card) => card.value)).to.deep.equal([
      "generic-x86-64",
      "generic-aarch64",
    ]);
    expect(cards(el).map((card) => card.heading)).to.deep.equal([
      "Intel/AMD (x86-64)",
      "ARM (aarch64)",
    ]);
    expect(cards(el)[0].textContent).to.contain("Intel NUC");

    const groups = findByRole(await fullA11ySnapshot(), "group").filter(
      (group) => group.name === "Processor"
    );
    expect(groups).to.have.length(1);
    expect(findByRole(groups[0]!, "button")).to.have.length(2);
  });

  it("leaves out an architecture the catalog does not list", async () => {
    const el = await renderChoices(() => ({
      ...MOCK_MANIFEST,
      devices: MOCK_MANIFEST.devices.filter(
        (device) => device.category !== "generic_arm64"
      ),
    }));
    expect(cards(el).map((card) => card.value)).to.deep.equal([
      "generic-x86-64",
    ]);
  });

  it("stores the chosen architecture for the following steps", async () => {
    const el = await renderChoices();
    const arm = cards(el).find((card) => card.value === "generic-aarch64")!;

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

  it("keeps the processor logos from screen readers", async () => {
    const el = await renderChoices();
    await Promise.all(cards(el).map((card) => card.updateComplete));
    const tree = await fullA11ySnapshot();

    expect(findByRole(tree, "image")).to.deep.equal([]);
    expect(findByRole(tree, "button")[0]!.name).to.contain(
      "Intel/AMD (x86-64)"
    );
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
    await waitUntil(() => cards(el).length === 2, "catalog never loaded");
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
    await waitUntil(() => cards(el).length === 2, "catalog waited for UTM");
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
      el.shadowRoot!.querySelector("[data-focus-alert]")!.textContent
    ).to.contain("Could not connect");

    const retry = [...el.shadowRoot!.querySelectorAll("wa-button")].find(
      (button) => button.textContent!.includes("Try again")
    )!;
    retry.click();
    await waitUntil(() => cards(el).length === 2, "catalog never reloaded");

    expect(attempts).to.equal(2);
    expect(el.shadowRoot!.querySelector("[data-focus-alert]")).to.not.exist;
  });
});
