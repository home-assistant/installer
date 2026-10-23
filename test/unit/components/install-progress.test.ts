import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import type { InstallProgress } from "../../../src/components/install-progress.js";
import "../../../src/components/install-progress.js";
import { captureOpenedUrls, restoreTauriIpc, settle } from "../tauri-ipc.js";
import { expectThemeLink } from "../helpers/link-style.js";

describe("install-progress", () => {
  it("keeps the thought bubble inside a short scroll container", async () => {
    const container = fixtureSync<HTMLDivElement>(html`
      <div style="width: 650px; height: 300px; overflow-y: auto">
        <install-progress
          .stages=${Array.from({ length: 7 }, (_, id) => ({
            id: `${id}`,
            label: "A wrapping installation stage description",
          }))}
          stage="1"
        ></install-progress>
      </div>
    `);
    const layout = container.querySelector("install-progress")!;
    await layout.updateComplete;
    const cloud = layout.shadowRoot!.querySelector(".thinking-cloud")!;
    const bounds = container.getBoundingClientRect();
    const bubble = cloud.getBoundingClientRect();
    expect(bubble.top).to.be.at.least(bounds.top);
    expect(bubble.left).to.be.at.least(bounds.left);
    expect(bubble.right).to.be.at.most(bounds.right);
    expect(container.scrollHeight).to.be.greaterThan(container.clientHeight);
  });

  it("puts Casita beside the stages under the heading when wide, and above it when narrow", async () => {
    const container = fixtureSync<HTMLDivElement>(html`
      <div style="width: 736px">
        <install-progress
          .stages=${[
            { id: "downloading", label: "Downloading" },
            { id: "extracting", label: "Extracting" },
          ]}
          stage="extracting"
        ></install-progress>
      </div>
    `);
    const el = container.querySelector("install-progress")!;
    await el.updateComplete;
    const bounds = (selector: string) =>
      el.shadowRoot!.querySelector(selector)!.getBoundingClientRect();

    // The smallest window leaves 736px: the cloud fits beside Casita, the
    // stages beside both, and the heading spans them all
    expect(bounds(".thinking-cloud").right).to.be.at.most(
      bounds(".details").left
    );
    expect(bounds("h2").bottom).to.be.at.most(bounds(".thinking-cloud").top);
    expect(bounds("h2").bottom).to.be.at.most(bounds(".details").top);
    expect(bounds("h2").left).to.be.at.most(bounds("casita-mascot").left);
    expect(bounds("h2").right).to.be.at.least(bounds(".details").right);
    expect(bounds("casita-mascot").width).to.equal(120);
    expect(bounds(".details").right).to.be.at.most(
      container.getBoundingClientRect().right
    );

    container.style.width = "500px";
    await waitUntil(
      () => bounds("casita-mascot").bottom <= bounds("h2").top,
      "Casita should stand above the heading"
    );
  });

  for (const width of [320, 440, 520, 521, 560, 600, 639]) {
    it(`keeps the cloud inside ${width}px and clear of Casita's roof`, async () => {
      const container = fixtureSync<HTMLDivElement>(html`
        <div><install-progress stage="downloading"></install-progress></div>
      `);
      container.style.width = `${width}px`;
      const el = container.querySelector("install-progress")!;
      await el.updateComplete;
      // The bumps, not the box they sit in: some reach past it
      const bumps = [...el.shadowRoot!.querySelectorAll(".cloud-bump")].map(
        (bump) => bump.getBoundingClientRect()
      );
      const cloud = {
        top: Math.min(...bumps.map((bump) => bump.top)),
        bottom: Math.max(...bumps.map((bump) => bump.bottom)),
        left: Math.min(...bumps.map((bump) => bump.left)),
        right: Math.max(...bumps.map((bump) => bump.right)),
      };
      const casita = el
        .shadowRoot!.querySelector("casita-mascot")!
        .getBoundingClientRect();
      const outer = container.getBoundingClientRect();
      expect(cloud.left).to.be.at.least(outer.left);
      expect(cloud.right).to.be.at.most(outer.right);
      expect(cloud.top).to.be.at.least(outer.top);
      // Above Casita, or beside its roof's peak, never over it
      expect(
        cloud.bottom <= casita.top ||
          cloud.left >= casita.left + casita.width / 2
      ).to.be.true;
    });
  }

  it("shows where Home Assistant is checked, as a link to open it", async () => {
    const opened = captureOpenedUrls();
    try {
      const el = await fixture<InstallProgress>(
        html`<install-progress stage="ready"></install-progress>`
      );
      expect(el.shadowRoot!.querySelector(".address")).to.be.null;

      el.address = "http://192.0.2.50";
      await el.updateComplete;
      const address = el.shadowRoot!.querySelector(".address")!;
      expect(address.textContent).to.contain(
        "Checking Home Assistant at http://192.0.2.50."
      );
      const link = address.querySelector("a")!;
      expect(link.textContent).to.equal("http://192.0.2.50");
      expectThemeLink(link);
      link.click();
      await settle();
      expect(opened).to.deep.equal(["http://192.0.2.50"]);

      // An error replaces the progress, address included
      el.error = "Home Assistant did not respond";
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector(".address")).to.be.null;
      expectThemeLink(el.shadowRoot!.querySelector(".error-help a")!);
    } finally {
      restoreTauriIpc();
    }
  });

  it("announces the stage in a live region that is mounted empty first", async () => {
    const el = fixtureSync<InstallProgress>(
      html`<install-progress
        stage="downloading"
        stage-title="Downloading"
      ></install-progress>`
    );
    await el.updateComplete;
    const region = el.shadowRoot!.querySelector('.sr-only[role="status"]')!;
    expect(region.textContent?.trim()).to.equal("");

    await waitUntil(
      () => region.textContent?.trim() === "Downloading",
      "the stage was never announced",
      { timeout: 3000 }
    );

    // It stays through an error, so a retry is announced too
    el.error = "Cannot write this drive";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.sr-only[role="status"]')).to.equal(
      region
    );
    expect(region.textContent?.trim()).to.equal("");
  });

  it("announces a problem in a warning region that is mounted empty first", async () => {
    // Set from the start, as a view could
    const el = fixtureSync<InstallProgress>(
      html`<install-progress
        stage="updating"
        .warning=${"Home Assistant can't reach the internet."}
      ></install-progress>`
    );
    await el.updateComplete;
    const region = el.shadowRoot!.querySelector(".warning")!;
    expect(region.getAttribute("role")).to.equal("status");
    expect(region.textContent?.trim()).to.equal("");
    expect(region.querySelector("inline-notice")).to.be.null;
    // Empty, it takes no room between the progress and the address
    expect(region.getBoundingClientRect().height).to.equal(0);

    // The same region gets the text, once screen readers watch it
    await waitUntil(
      () => region.textContent?.trim() !== "",
      "the warning never showed",
      { timeout: 3000 }
    );
    expect(el.shadowRoot!.querySelector(".warning")).to.equal(region);
    expect(region.textContent?.trim()).to.equal(
      "Home Assistant can't reach the internet."
    );
    // In the notice every warning uses
    expect(region.querySelector("inline-notice")).to.exist;

    el.warning = "Home Assistant couldn't download an update.";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector(".warning")).to.equal(region);
    expect(region.textContent?.trim()).to.equal(
      "Home Assistant couldn't download an update."
    );

    el.warning = null;
    await el.updateComplete;
    expect(region.textContent?.trim()).to.equal("");
    expect(region.querySelector("inline-notice")).to.be.null;

    // An error replaces the progress, warning included
    el.error = "The installation made no progress for 10 minutes.";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector(".warning")).to.be.null;
  });

  it("asks to keep the window open only while leaving would stop something", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress stage="creating_vm"></install-progress>`
    );
    const keepOpen = () =>
      el.shadowRoot!.querySelector(".stage-description")?.textContent ?? "";
    expect(keepOpen()).to.contain("keep this window open");

    el.leavable = true;
    await el.updateComplete;
    expect(keepOpen()).to.equal("");
  });

  it("renders the stage labels, active stage and completion", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .stages=${[
          { id: "downloading", label: "Download image" },
          { id: "writing", label: "Write image" },
          { id: "verifying", label: "Verify image" },
        ]}
        stage="writing"
      ></install-progress>`
    );
    const dots = el.shadowRoot!.querySelectorAll(".status-dot");
    const stages = el.shadowRoot!.querySelectorAll(".stage");
    expect(
      el.shadowRoot!.querySelector("ol")!.getAttribute("aria-label")
    ).to.equal("Installation stages");
    expect(stages[0].querySelector(".stage-label")!.textContent).to.equal(
      "Download image (completed)"
    );
    expect(stages[1].querySelector(".stage-label")!.textContent).to.equal(
      "Write image"
    );
    expect(stages[2].querySelector(".stage-label")!.textContent).to.equal(
      "Verify image"
    );
    expect(stages[0].hasAttribute("aria-current")).to.be.false;
    expect(stages[1].getAttribute("aria-current")).to.equal("step");
    expect(stages[2].hasAttribute("aria-current")).to.be.false;
    expect(
      Array.from(dots).every(
        (dot) => dot.getAttribute("aria-hidden") === "true"
      )
    ).to.be.true;
    expect(el.shadowRoot!.querySelector(".stages-indicator [tabindex]")).to.not
      .exist;
    expect(dots[0].classList.contains("completed")).to.be.true;
    expect(dots[1].classList.contains("active")).to.be.true;
    expect(el.shadowRoot!.querySelector("casita-mascot")!.mood).to.equal(
      "focusing"
    );
    el.stage = "complete";
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelectorAll(".status-dot.completed").length
    ).to.equal(3);
    expect(el.shadowRoot!.querySelectorAll("li .sr-only").length).to.equal(3);
    expect(el.shadowRoot!.querySelector("[aria-current]")).to.not.exist;
    expect(el.shadowRoot!.querySelector(".thinking-cloud")).to.not.exist;
    expect(el.shadowRoot!.querySelector("casita-mascot")!.mood).to.equal(
      "happy"
    );
  });

  it("draws each stage state as its own shape, not only its own color", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .stages=${[
          { id: "downloading", label: "Download image" },
          { id: "writing", label: "Write image" },
          { id: "verifying", label: "Verify image" },
        ]}
        stage="writing"
      ></install-progress>`
    );
    const [complete, current, pending] = [
      ...el.shadowRoot!.querySelectorAll(".status-dot"),
    ].map((dot) => getComputedStyle(dot));
    const empty = "rgba(0, 0, 0, 0)";

    // Pending: an empty ring
    expect(pending.backgroundColor).to.equal(empty);
    expect(pending.borderTopStyle).to.equal("solid");
    expect(pending.borderTopWidth).to.equal("2px");
    expect(pending.outlineStyle).to.equal("none");
    // Complete: a filled dot
    expect(complete.backgroundColor).to.not.equal(empty);
    expect(complete.outlineStyle).to.equal("none");
    // Current: a dot in a ring, which stays while the dot pulses
    expect(current.outlineStyle).to.equal("solid");
    expect(current.outlineWidth).to.equal("2px");
  });

  it("calculates speed and ETA from the owning view's stage baseline", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .bytesProcessed=${5 * 1024}
        .totalBytes=${9 * 1024}
        .stageStartBytes=${1024}
        .stageStartTime=${Date.now() - 2000}
        .progress=${55}
      ></install-progress>`
    );
    expect(el.shadowRoot!.querySelector(".speed")!.textContent).to.match(
      /kB\/s$/
    );
    expect(el.shadowRoot!.querySelector(".eta")!.textContent).to.equal(
      "Less than a minute remaining"
    );
    el.stageStartTime = Date.now();
    el.stageStartBytes = el.bytesProcessed;
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector(".speed")!.textContent).to.equal("");
    expect(el.shadowRoot!.querySelector(".eta")!.textContent).to.equal(
      "Calculating..."
    );
  });

  it("shows a whole percentage from 0 to 100", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress .progress=${33.3333}></install-progress>`
    );
    const percentage = async (progress: number) => {
      el.progress = progress;
      await el.updateComplete;
      return el.shadowRoot!.querySelector(".percentage")!.textContent;
    };
    expect(await percentage(33.3333)).to.equal("33%");
    expect(await percentage(66.6666)).to.equal("67%");
    expect(await percentage(99.4)).to.equal("99%");
    expect(await percentage(150)).to.equal("100%");
    expect(await percentage(-5)).to.equal("0%");
  });

  it("starts the bar afresh for a stage that counts from 0 again", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        stage="downloading"
        .progress=${100}
      ></install-progress>`
    );
    const inner = async () => {
      await el.updateComplete;
      const bar = el.shadowRoot!.querySelector("progress-bar")!;
      await bar.updateComplete;
      return bar.shadowRoot!.querySelector("wa-progress-bar")!;
    };
    const downloading = await inner();

    el.stage = "extracting";
    el.progress = 0;
    // A new bar, with no width to slide back from
    expect((await inner()) === downloading).to.be.false;
  });

  it("rounds the ETA up to whole minutes before splitting off the hours", async () => {
    // 100 bytes a second over the last 100 seconds
    const eta = async (remainingSeconds: number) => {
      const el = await fixture<InstallProgress>(
        html`<install-progress
          .bytesProcessed=${10_000}
          .totalBytes=${10_000 + remainingSeconds * 100}
          .stageStartTime=${Date.now() - 100_000}
        ></install-progress>`
      );
      return el.shadowRoot!.querySelector(".eta")!.textContent;
    };
    expect(await eta(30 * 60 - 10)).to.equal("About 30 minutes remaining");
    expect(await eta(60 * 60 - 10)).to.equal("About 1h 0m remaining");
    expect(await eta(90 * 60 + 10)).to.equal("About 1h 31m remaining");
    expect(await eta(120 * 60 - 10)).to.equal("About 2h 0m remaining");
  });

  it("shows error text safely while leaving retry to the owning flow's footer", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .error=${"<b>Installation failed</b>"}
      ></install-progress>`
    );
    expect(
      el.shadowRoot!.querySelector(".error-message")!.textContent
    ).to.equal("<b>Installation failed</b>");
    expect(el.shadowRoot!.querySelector(".error-message b")).to.not.exist;
    expect(el.shadowRoot!.querySelector("progress-bar")).to.not.exist;
    expect(el.shadowRoot!.querySelector("button")).to.not.exist;
    expect(el.shadowRoot!.querySelector("casita-mascot")!.mood).to.equal(
      "problem"
    );
  });

  it("names the progress bar after the current stage", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress stage-title="Writing"></install-progress>`
    );
    const bar = el.shadowRoot!.querySelector("progress-bar")!;
    const progressbar = async () => {
      await bar.updateComplete;
      const inner = bar.shadowRoot!.querySelector("wa-progress-bar")!;
      await inner.updateComplete;
      return inner.shadowRoot!.querySelector('[role="progressbar"]')!;
    };
    expect((await progressbar()).getAttribute("aria-label")).to.equal(
      "Writing"
    );

    el.stageTitle = "Waiting for Home Assistant";
    await el.updateComplete;
    expect((await progressbar()).getAttribute("aria-label")).to.equal(
      "Waiting for Home Assistant"
    );
  });

  it("places the keep-window-open notice after the progress bar", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress></install-progress>`
    );
    const bar = el.shadowRoot!.querySelector("progress-bar")!;
    const notice = el.shadowRoot!.querySelector(".stage-description")!;
    expect(
      bar.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING
    ).to.not.equal(0);
  });
});
