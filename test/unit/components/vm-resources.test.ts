import { expect, fixture, html, oneEvent } from "@open-wc/testing";
import type WaSlider from "@home-assistant/webawesome/dist/components/slider/slider.js";
import "../../../src/components/vm-resources.js";
import type {
  VmResourceValues,
  VmResources,
} from "../../../src/components/vm-resources.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";

async function render(
  values: Partial<VmResourceValues> = {},
  coreOptions = [2, 4, 6, 8]
): Promise<VmResources> {
  const el = await fixture<VmResources>(
    html`<vm-resources
      .coreOptions=${coreOptions}
      .memoryOptions=${[2048, 4096, 8192]}
      .diskOptions=${[32, 64, 128]}
      .cpuCores=${values.cpuCores ?? 4}
      .memoryMb=${values.memoryMb ?? 4096}
      .diskSizeGb=${values.diskSizeGb ?? 32}
    ></vm-resources>`
  );
  await Promise.all([...slidersOf(el)].map((slider) => slider.updateComplete));
  return el;
}

function slidersOf(el: VmResources) {
  return el.shadowRoot!.querySelectorAll<WaSlider>("wa-slider");
}

const valueText = (slider: WaSlider) =>
  slider
    .shadowRoot!.querySelector('[role="slider"]')!
    .getAttribute("aria-valuetext");

describe("vm-resources", () => {
  it("steps each slider through its options and announces the option", async () => {
    const el = await render();
    const [cores, memory, disk] = slidersOf(el);
    expect([cores.max, memory.max, disk.max]).to.deep.equal([3, 2, 2]);
    expect([cores.value, memory.value, disk.value]).to.deep.equal([1, 1, 0]);
    expect([cores, memory, disk].map(valueText)).to.deep.equal([
      "4 cores",
      "4 GB",
      "32 GB",
    ]);
  });

  it("reports the option a slider moved to, with the other values", async () => {
    const el = await render();
    const memory = slidersOf(el)[1];
    memory.value = 2;
    setTimeout(() => memory.dispatchEvent(new Event("input")));
    const { detail } = await oneEvent(el, "resources-change");
    expect(detail).to.deep.equal({
      cpuCores: 4,
      memoryMb: 8192,
      diskSizeGb: 32,
    });
  });

  it("disables a slider with a single option", async () => {
    const el = await render({ cpuCores: 2 }, [2]);
    const cores = slidersOf(el)[0];
    expect(cores.disabled).to.be.true;
    expect(valueText(cores)).to.equal("2 cores");
  });

  it("shows a value the options don't have at the closest one below it", async () => {
    // A restored count while the options are still being looked up
    const el = await render({ cpuCores: 10 });
    const cores = slidersOf(el)[0];
    expect(cores.value).to.equal(3);
    expect(
      el.shadowRoot!.querySelector(".setting-value")!.textContent
    ).to.equal("10 cores");

    el.coreOptions = [2, 4, 6, 8, 10, 12];
    await el.updateComplete;
    await cores.updateComplete;
    expect(cores.value).to.equal(4);
    expect(valueText(cores)).to.equal("10 cores");
  });

  it("describes the cores the same way for every VM", async () => {
    const descriptions = async (cpuCores: number) =>
      (await render({ cpuCores }, [2, 4, 6, 8, 10]))
        .shadowRoot!.querySelector(".setting-description")!
        .textContent!.trim();
    expect(await descriptions(2)).to.contain("Minimum");
    expect(await descriptions(4)).to.contain("Recommended");
    expect(await descriptions(8)).to.contain("Better performance");
    expect(await descriptions(10)).to.contain("Maximum performance");
  });

  it("reads the advice out with each slider, as it changes", async () => {
    const el = await render();
    const descriptions = async () =>
      findByRole(await fullA11ySnapshot(), "slider").map(
        (node) => node.description
      );
    expect(await descriptions()).to.deep.equal([
      "Recommended for most users",
      "Recommended for most users",
      "Good for getting started",
    ]);

    // As the view does when it hears the change
    el.cpuCores = 8;
    el.diskSizeGb = 128;
    await el.updateComplete;
    expect(await descriptions()).to.deep.equal([
      "Better performance with many integrations",
      "Recommended for most users",
      "Plenty of space for long-term use",
    ]);
  });
});
