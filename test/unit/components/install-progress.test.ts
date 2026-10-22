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
      <div style="width: 650px; height: 400px; overflow-y: auto">
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
    const dots = el.shadowRoot!.querySelectorAll(".stage-dot");
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
    expect(dots[0].classList.contains("complete")).to.be.true;
    expect(dots[1].classList.contains("active")).to.be.true;
    el.stage = "complete";
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelectorAll(".stage-dot.complete").length
    ).to.equal(3);
    expect(el.shadowRoot!.querySelectorAll("li .sr-only").length).to.equal(3);
    expect(el.shadowRoot!.querySelector("[aria-current]")).to.not.exist;
    expect(el.shadowRoot!.querySelector(".thinking-cloud")).to.not.exist;
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
      /KB\/s$/
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
