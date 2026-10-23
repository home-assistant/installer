import { expect } from "@open-wc/testing";
import { html, nothing, render, type ReactiveControllerHost } from "lit";
import type { HaosRelease } from "../../../src/api/types.js";
import {
  HaosVersion,
  renderHaosVersionRow,
  renderSummaryIcon,
  renderSummaryRow,
  summaryStyles,
} from "../../../src/components/summary-card.js";
import { mdiMonitor } from "../../../src/utils/icons.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../tauri-ipc.js";

function rendered(template: unknown): HTMLDivElement {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

/** Each line of a summary row's text, as its paragraphs show it. */
function lines(row: Element) {
  return [...row.querySelectorAll("p")].map((p) =>
    p.textContent!.replace(/\s+/g, " ").trim()
  );
}

/** A host that counts the updates its controller asks for. */
function host() {
  const result = {
    updates: 0,
    addController() {},
    removeController() {},
    requestUpdate() {
      result.updates++;
    },
    updateComplete: Promise.resolve(true),
  };
  return result satisfies ReactiveControllerHost & { updates: number };
}

describe("summary-card", () => {
  afterEach(() => {
    restoreTauriIpc();
  });

  it("renders a row's icon, label, value and details in order", () => {
    const container = rendered(
      renderSummaryRow(
        renderSummaryIcon(mdiMonitor),
        "Virtual machine",
        "Home Assistant",
        html`<p class="summary-detail">4 CPU cores</p>
          <p class="summary-detail">32 GB</p>`
      )
    );
    const row = container.querySelector(".summary-row")!;
    expect(
      row.querySelector(".icon-container svg path")!.getAttribute("d")
    ).to.equal(mdiMonitor);
    expect(row.querySelector(".summary-label")!.textContent).to.equal(
      "Virtual machine"
    );
    expect(row.querySelector(".summary-value")!.textContent).to.equal(
      "Home Assistant"
    );
    expect(lines(row)).to.deep.equal([
      "Virtual machine",
      "Home Assistant",
      "4 CPU cores",
      "32 GB",
    ]);
  });

  for (const value of [
    "Realtek USB 3.0 Card Reader SD/MMC USB Device",
    "HomeAssistantOnTheMiniPcInTheLivingRoom",
  ]) {
    it(`wraps ${value} instead of cutting it off`, () => {
      // The content's width in the smallest window at 200% zoom. A plain
      // container: fixture() would wait for a frame, which a background
      // test page never paints
      const host = document.createElement("div");
      host.style.width = "368px";
      const root = host.attachShadow({ mode: "open" });
      root.adoptedStyleSheets = [summaryStyles.styleSheet!];
      render(
        html`<div class="summary-card">
          ${renderSummaryRow(
            renderSummaryIcon(mdiMonitor),
            "Target drive",
            value
          )}
        </div>`,
        root
      );
      document.body.append(host);
      try {
        const card = root.querySelector(".summary-card")!;
        const shown = root.querySelector<HTMLElement>(".summary-value")!;
        const range = document.createRange();
        range.selectNodeContents(shown);

        expect(range.getClientRects().length).to.be.greaterThan(1);
        expect(shown.scrollWidth).to.equal(shown.clientWidth);
        expect(range.getBoundingClientRect().right).to.be.at.most(
          card.getBoundingClientRect().right
        );
      } finally {
        host.remove();
      }
    });
  }

  it("leaves out details a row doesn't have", () => {
    const row = rendered(
      renderSummaryRow(nothing, "Wi-Fi", "Garden-Net")
    ).querySelector(".summary-row")!;
    expect(lines(row)).to.deep.equal(["Wi-Fi", "Garden-Net"]);
  });

  for (const [version, value] of [
    [undefined, "Loading..."],
    ["", "Loading..."],
    [null, "Version Unknown"],
    ["16.3", "Version 16.3"],
  ] as const) {
    it(`shows the Home Assistant OS version ${JSON.stringify(version)} as ${value}`, () => {
      const row = rendered(renderHaosVersionRow(version)).querySelector(
        ".summary-row"
      )!;
      expect(row.querySelector(".icon-container svg.ha-icon")).to.exist;
      expect(lines(row)).to.deep.equal([
        "Home Assistant Operating System",
        value,
        "Latest stable release",
      ]);
    });
  }

  describe("HaosVersion", () => {
    const release: HaosRelease = { version: "16.3", images: [] };

    it("looks the version up each time the view is shown", async () => {
      const view = host();
      let lookups = 0;
      const version = new HaosVersion(view, () => {
        lookups++;
        return Promise.resolve(release);
      });
      expect(version.version).to.equal(undefined);

      version.hostConnected();
      await settle();
      expect(version.version).to.equal("16.3");
      expect(view.updates).to.equal(1);

      version.hostConnected();
      await settle();
      expect(lookups).to.equal(2);
    });

    for (const [how, lookup] of [
      ["rejects", () => Promise.reject(new Error("Release unavailable"))],
      [
        "throws",
        () => {
          throw new Error("No board selected");
        },
      ],
    ] as const) {
      it(`logs a lookup that ${how} and shows the version as unknown`, async () => {
        const logged: unknown[] = [];
        mockTauriIpc(
          (cmd, args) => {
            expect(cmd).to.equal("log_frontend_event");
            logged.push(args);
          },
          { includeLogs: true }
        );
        const view = host();
        const version = new HaosVersion(view, lookup);

        version.hostConnected();
        await settle();
        await settle();
        expect(version.version).to.equal(null);
        expect(view.updates).to.equal(1);
        expect(logged).to.have.length(1);
        expect(logged[0]).to.include({ stage: "frontend", outcome: "failed" });
      });
    }

    it("leaves a view with no release to show alone", async () => {
      const view = host();
      const version = new HaosVersion(view, () => undefined);

      version.hostConnected();
      await settle();
      expect(version.version).to.equal(undefined);
      expect(view.updates).to.equal(0);
    });
  });
});
