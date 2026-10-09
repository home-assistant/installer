import { expect, fixture, fixtureSync, html } from "@open-wc/testing";
import type { InstallProgress } from "../../../src/components/install-progress.js";
import "../../../src/components/install-progress.js";

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
    expect(el.shadowRoot!.querySelectorAll(".stage-status").length).to.equal(3);
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
