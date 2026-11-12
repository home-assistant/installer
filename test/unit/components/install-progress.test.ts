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

/** End the open or close transitions, which a background page never paints */
function finishTransitions(el: InstallProgress) {
  for (const animation of el.shadowRoot!.getAnimations()) {
    if (animation instanceof CSSTransition) animation.finish();
  }
}

describe("install-progress", () => {
  it("puts Casita beside the column the heading starts when wide, and above it when narrow", async () => {
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

    // The smallest window leaves 736px: Casita stands beside the column, and
    // all of its text starts on the same edge, the heading's included
    expect(bounds("casita-mascot").right).to.be.at.most(
      bounds(".details").left
    );
    expect(bounds(".parts").top).to.equal(bounds(".details").top);
    for (const selector of [".parts", "h2", "progress-bar"]) {
      expect(bounds(selector).left, selector).to.equal(bounds(".details").left);
    }
    expect(bounds("casita-mascot").width).to.equal(120);
    expect(bounds(".details").right).to.be.at.most(
      container.getBoundingClientRect().right
    );

    container.style.width = "500px";
    await waitUntil(
      () => bounds("casita-mascot").bottom <= bounds(".parts").top,
      "Casita should stand above the column"
    );
    expect(bounds("h2").left).to.equal(bounds(".details").left);
  });

  for (const width of [320, 440, 639]) {
    it(`fits the open stages and the progress into ${width}px`, async () => {
      const label = "Downloading and preparing the Home Assistant OS install";
      const container = fixtureSync<HTMLDivElement>(html`
        <div>
          <install-progress
            .stages=${["a", "b", "c"].map((id) => ({ id, label }))}
            stage="b"
            .description=${label}
            .bytesProcessed=${512}
            .totalBytes=${1024}
            .address=${"http://192.0.2.50"}
          ></install-progress>
        </div>
      `);
      container.style.width = `${width}px`;
      const el = container.querySelector("install-progress")!;
      await el.updateComplete;
      el.shadowRoot!.querySelector<HTMLElement>(".parts")!.click();
      await el.updateComplete;
      finishTransitions(el);

      const outer = container.getBoundingClientRect();
      for (const part of el.shadowRoot!.querySelectorAll(".details *")) {
        const box = part.getBoundingClientRect();
        if (!box.width) continue;
        expect(box.left, part.className).to.be.at.least(outer.left);
        expect(box.right, part.className).to.be.at.most(outer.right);
      }
      const casita = el
        .shadowRoot!.querySelector("casita-mascot")!
        .getBoundingClientRect();
      const toggle = el
        .shadowRoot!.querySelector(".parts")!
        .getBoundingClientRect();
      expect(casita.bottom).to.be.at.most(toggle.top);
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
        "Checking Home Assistant at http://192.0.2.50 Opens in your browser."
      );
      const link = address.querySelector("a")!;
      expect(link.textContent).to.equal(
        "http://192.0.2.50 Opens in your browser."
      );
      expect(link.getAttribute("target")).to.equal("_blank");
      expect(link.getAttribute("rel")).to.equal("noopener noreferrer");
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

    el.stopping = true;
    await el.updateComplete;
    expect(region.textContent?.trim()).to.equal("Stopping...");

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

  it("names the part, and keeps the other stages hidden until asked", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .stages=${[
          { id: "downloading", label: "Download image" },
          { id: "writing", label: "Write image" },
          { id: "verifying", label: "Verify image" },
        ]}
        stage="writing"
        description="Writing the image"
      ></install-progress>`
    );
    const root = el.shadowRoot!;
    const toggle = root.querySelector<HTMLButtonElement>("button.parts")!;
    const list = root.querySelector("ol")!;
    expect(toggle.textContent!.trim()).to.equal("Step 2 of 3");
    expect(toggle.getAttribute("aria-expanded")).to.equal("false");
    expect(root.getElementById(toggle.getAttribute("aria-controls")!)).to.equal(
      list
    );
    // Closed, only the heading shows, and it isn't a list of one
    expect(list.getAttribute("role")).to.equal("none");
    expect(list.hasAttribute("aria-label")).to.be.false;
    expect(root.querySelector("[aria-current]")).to.not.exist;
    expect(root.querySelector("h2")!.textContent!.trim()).to.equal(
      "Writing the image"
    );
    for (const stage of root.querySelectorAll(".stage")) {
      expect(getComputedStyle(stage).visibility).to.equal("hidden");
    }
    expect(root.querySelector("casita-mascot")!.mood).to.equal("focusing");
  });

  it("opens the stages around the heading, which becomes the current stage's row", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .stages=${[
          { id: "downloading", label: "Download image" },
          { id: "writing", label: "Write image" },
          { id: "verifying", label: "Verify image" },
        ]}
        stage="writing"
        description="Writing the image"
      ></install-progress>`
    );
    const root = el.shadowRoot!;
    const toggle = root.querySelector<HTMLButtonElement>("button.parts")!;
    const heading = root.querySelector("h2")!;
    toggle.click();
    await el.updateComplete;

    const list = root.querySelector("ol")!;
    expect(toggle.getAttribute("aria-expanded")).to.equal("true");
    expect(list.getAttribute("role")).to.equal("list");
    expect(list.getAttribute("aria-label")).to.equal("Installation stages");
    const items = [...list.children];
    expect(items.map((item) => item.textContent!.trim())).to.deep.equal([
      "Download image (completed)",
      "Writing the image",
      "Verify image",
    ]);
    // Nothing shows twice: the heading is the current stage's row
    expect(items[1].getAttribute("aria-current")).to.equal("step");
    expect(items[1].querySelector("h2")).to.equal(heading);
    expect(root.querySelectorAll("[aria-current]").length).to.equal(1);
    for (const stage of root.querySelectorAll(".stage")) {
      expect(getComputedStyle(stage).visibility).to.equal("visible");
    }
    const dots = [...root.querySelectorAll(".status-dot")];
    expect(
      dots.map((dot) =>
        ["completed", "active"].filter((state) => dot.classList.contains(state))
      )
    ).to.deep.equal([["completed"], ["active"], []]);
    expect(dots.every((dot) => dot.closest('[aria-hidden="true"]') !== null)).to
      .be.true;

    // Open across stages: the next one takes the heading's place
    el.stage = "verifying";
    el.description = "Verifying the image";
    await el.updateComplete;
    expect(toggle.getAttribute("aria-expanded")).to.equal("true");
    expect(root.querySelector("h2")).to.equal(heading);
    expect(
      [...list.children].map((item) => item.textContent!.trim())
    ).to.deep.equal([
      "Download image (completed)",
      "Write image (completed)",
      "Verifying the image",
    ]);
    expect(toggle.textContent!.trim()).to.equal("Step 3 of 3");

    toggle.click();
    await el.updateComplete;
    expect(toggle.getAttribute("aria-expanded")).to.equal("false");
    expect(list.getAttribute("role")).to.equal("none");
    expect(root.querySelector("[aria-current]")).to.not.exist;
    expect(root.querySelector("h2")).to.equal(heading);
  });

  it("has no parts to open for a single stage, once complete, or while stopping", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .stages=${[{ id: "waiting", label: "Wait" }]}
        stage="waiting"
        description="Waiting"
      ></install-progress>`
    );
    const root = el.shadowRoot!;
    expect(root.querySelector(".parts")).to.not.exist;

    el.stages = [
      { id: "downloading", label: "Download image" },
      { id: "writing", label: "Write image" },
    ];
    el.stage = "complete";
    el.description = "Done";
    await el.updateComplete;
    expect(root.querySelector(".parts")).to.not.exist;
    expect(root.querySelector("h2")!.textContent!.trim()).to.equal("Done");
    expect(root.querySelector("casita-mascot")!.mood).to.equal("happy");

    // The heading says it stops instead of naming a stage to list it with
    el.stage = "writing";
    el.stopping = true;
    await el.updateComplete;
    expect(root.querySelector(".parts")).to.not.exist;
    expect(root.querySelector("ol")!.className).to.not.contain("open");
    expect(root.querySelector("h2")!.textContent!.trim()).to.equal(
      "Stopping..."
    );

    el.stopping = false;
    await el.updateComplete;
    expect(root.querySelector(".parts")).to.exist;
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

  it("estimates from the percent where a stage counts no bytes, given where it started", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress
        .progress=${40}
        .stageStartProgress=${10}
        .stageStartTime=${Date.now() - 290_000}
      ></install-progress>`
    );
    const eta = async () => {
      await el.updateComplete;
      return el.shadowRoot!.querySelector(".eta")!.textContent;
    };
    // 30% in just under 5 minutes leaves 60% for just under 10
    expect(await eta()).to.equal("About 10 minutes remaining");

    el.stageStartTime = Date.now();
    expect(await eta()).to.equal("Calculating...");

    // Without a start, as a VM shows the download, there is no estimate
    el.stageStartProgress = null;
    expect(await eta()).to.equal("");
  });

  it("keeps one Casita through the stages, success and failure", async () => {
    const el = await fixture<InstallProgress>(
      html`<install-progress stage="downloading"></install-progress>`
    );
    const casita = el.shadowRoot!.querySelector("casita-mascot")!;

    el.stage = "complete";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("casita-mascot")).to.equal(casita);
    expect(casita.mood).to.equal("happy");

    el.error = "Failed";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("casita-mascot")).to.equal(casita);
    expect(casita.mood).to.equal("problem");
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

    // Like the heading and the live region
    el.stopping = true;
    await el.updateComplete;
    expect((await progressbar()).getAttribute("aria-label")).to.equal(
      "Stopping..."
    );
  });
});
