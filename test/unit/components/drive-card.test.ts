import { expect, fixture, fixtureSync, html } from "@open-wc/testing";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "../../../src/components/drive-card.js";
import type { DriveCard } from "../../../src/components/drive-card.js";

describe("drive-card", () => {
  it("renders with drive name", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="My USB Drive"></drive-card>
    `);

    const name = el.shadowRoot!.querySelector(".name");
    expect(name).to.exist;
    expect(name!.textContent).to.equal("My USB Drive");
  });

  it("renders with formatted size", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" capacity="32000000000"></drive-card>
    `);

    const size = el.shadowRoot!.querySelector(".size");
    expect(size).to.exist;
    expect(size!.textContent).to.equal("30 GB");
  });

  it("formats large sizes in TB", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" capacity="2000000000000"></drive-card>
    `);

    const size = el.shadowRoot!.querySelector(".size");
    expect(size!.textContent).to.equal("1.8 TB");
  });

  it("displays 0 GB for zero size", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" capacity="0"></drive-card>
    `);

    const size = el.shadowRoot!.querySelector(".size");
    expect(size!.textContent).to.equal("0 GB");
  });

  it("shows the selected indicator when checked", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test"></drive-card>
    `);

    expect(el.shadowRoot!.querySelector(".selected-indicator")).to.be.null;

    el.checked = true;
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector(".selected-indicator")).to.exist;
  });

  it("reports disabled to assistive technology", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" disabled></drive-card>
    `);

    expect(el.getAttribute("aria-disabled")).to.equal("true");
    expect(el.tabIndex).to.equal(-1);
  });

  it("displays disabled reason when provided", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card
        name="Test"
        disabled
        disabledReason="Drive is too small"
      ></drive-card>
    `);

    const details = el.shadowRoot!.querySelector(".details");
    expect(details!.textContent!.trim()).to.equal("Drive is too small");
  });

  it("renders SD card icon for sd_card type", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="sd_card"></drive-card>
    `);

    const icon = el.shadowRoot!.querySelector(".icon-container svg");
    expect(icon).to.exist;
  });

  it("renders USB icon for usb_drive type", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="usb_drive"></drive-card>
    `);

    const icon = el.shadowRoot!.querySelector(".icon-container svg");
    expect(icon).to.exist;
  });

  it("renders SSD icon for ssd type", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="ssd"></drive-card>
    `);

    const icon = el.shadowRoot!.querySelector(".icon-container svg");
    expect(icon).to.exist;
  });

  it("renders HDD icon for hdd type", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="hdd"></drive-card>
    `);

    const icon = el.shadowRoot!.querySelector(".icon-container svg");
    expect(icon).to.exist;
  });

  it("renders SSD icon for nvme type", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="nvme"></drive-card>
    `);

    const icon = el.shadowRoot!.querySelector(".icon-container svg");
    expect(icon).to.exist;
  });

  it("renders generic icon for unknown type", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="unknown"></drive-card>
    `);

    const icon = el.shadowRoot!.querySelector(".icon-container svg");
    expect(icon).to.exist;
  });

  it("displays vendor and model in details", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" vendor="SanDisk" model="Ultra"></drive-card>
    `);

    const details = el.shadowRoot!.querySelector(".details");
    expect(details!.textContent!.trim()).to.equal("SanDisk Ultra");
  });

  it("displays type label when vendor/model not provided", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="usb_drive"></drive-card>
    `);

    const details = el.shadowRoot!.querySelector(".details");
    expect(details!.textContent!.trim()).to.equal("USB drive");
  });

  it("shows description for SD card", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="sd_card"></drive-card>
    `);

    const description = el.shadowRoot!.querySelector(".description");
    expect(description!.textContent).to.equal(
      "Great for Raspberry Pi and similar single-board computers"
    );
  });

  it("shows description for USB drive", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="usb_drive"></drive-card>
    `);

    const description = el.shadowRoot!.querySelector(".description");
    expect(description!.textContent).to.equal("Portable and easy to set up");
  });

  it("shows description for SSD", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="ssd"></drive-card>
    `);

    const description = el.shadowRoot!.querySelector(".description");
    expect(description!.textContent).to.equal(
      "Fast and reliable for daily use"
    );
  });

  it("shows description for HDD", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="hdd"></drive-card>
    `);

    const description = el.shadowRoot!.querySelector(".description");
    expect(description!.textContent).to.equal("High capacity storage option");
  });

  it("shows description for NVMe", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="nvme"></drive-card>
    `);

    const description = el.shadowRoot!.querySelector(".description");
    expect(description!.textContent).to.equal("Maximum performance storage");
  });

  it("does not show description when disabled", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="ssd" disabled></drive-card>
    `);

    const description = el.shadowRoot!.querySelector(".description");
    expect(description).to.be.null;
  });

  it("has the correct structure", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test"></drive-card>
    `);

    expect(el.shadowRoot!.querySelector(".card")).to.exist;
    expect(el.shadowRoot!.querySelector(".icon-container")).to.exist;
    expect(el.shadowRoot!.querySelector(".info")).to.exist;
    expect(el.shadowRoot!.querySelector(".name")).to.exist;
    expect(el.shadowRoot!.querySelector(".details")).to.exist;
    expect(el.shadowRoot!.querySelector(".size")).to.exist;
  });

  it("stores value property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card value="/dev/sda" name="Test"></drive-card>
    `);

    expect(el.value).to.equal("/dev/sda");
  });

  it("stores name property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="My Drive"></drive-card>
    `);

    expect(el.name).to.equal("My Drive");
  });

  it("stores capacity property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" capacity="64000000000"></drive-card>
    `);

    expect(el.capacity).to.equal(64000000000);
  });

  it("stores deviceType property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" deviceType="usb_drive"></drive-card>
    `);

    expect(el.deviceType).to.equal("usb_drive");
  });

  it("stores model property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" model="XYZ123"></drive-card>
    `);

    expect(el.model).to.equal("XYZ123");
  });

  it("stores vendor property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" vendor="Samsung"></drive-card>
    `);

    expect(el.vendor).to.equal("Samsung");
  });

  it("stores disabled property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" disabled></drive-card>
    `);

    expect(el.disabled).to.be.true;
  });

  it("stores disabledReason property", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card name="Test" disabledReason="Too small"></drive-card>
    `);

    expect(el.disabledReason).to.equal("Too small");
  });

  it("exposes radio semantics", async () => {
    const el = await fixture<DriveCard>(html`
      <drive-card value="/dev/sda" name="Test"></drive-card>
    `);

    expect(el.getAttribute("role")).to.equal("radio");
    expect(el.getAttribute("aria-checked")).to.equal("false");
  });

  // Keyboard handling belongs to <wa-radio-group>; these check the contract.
  describe("inside a wa-radio-group", () => {
    // See device-card: fixture() on a non-Lit root waits on rAF and hangs.
    const group = async () => {
      const root = fixtureSync<HTMLElement>(html`
        <wa-radio-group radio-tag="drive-card" aria-label="Target drive">
          <drive-card .value=${"a"} .name=${"A"} .capacity=${64e9}></drive-card>
          <drive-card
            .value=${"small"}
            .name=${"Too small"}
            .capacity=${1e9}
            .disabled=${true}
            .disabledReason=${"\u26a0 Minimum 8 GB required"}
          ></drive-card>
          <drive-card .value=${"c"} .name=${"C"} .capacity=${32e9}></drive-card>
        </wa-radio-group>
      `);
      await (root as HTMLElement & { updateComplete: Promise<unknown> })
        .updateComplete;
      await Promise.all(
        Array.from(
          root.querySelectorAll<DriveCard>("drive-card"),
          (c) => c.updateComplete
        )
      );
      return root;
    };

    const cards = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<DriveCard>("drive-card"));

    it("keeps a disabled drive out of the tab order", async () => {
      const root = await group();
      const [, small] = cards(root);

      expect(small!.getAttribute("aria-disabled")).to.equal("true");
      expect(small!.tabIndex).to.equal(-1);
    });

    it("skips disabled drives when arrowing through the list", async () => {
      const root = await group();
      const list = cards(root);

      list[0]!.click();
      await (root as HTMLElement & { updateComplete: Promise<unknown> })
        .updateComplete;

      root.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
      await (root as HTMLElement & { updateComplete: Promise<unknown> })
        .updateComplete;

      // a -> c, skipping the too-small drive in between.
      expect((root as HTMLElement & { value: string }).value).to.equal("c");
      expect(list[1]!.checked).to.be.false;
    });

    it("does not select a disabled drive on click", async () => {
      const root = await group();
      const [, small] = cards(root);

      small!.click();
      await (root as HTMLElement & { updateComplete: Promise<unknown> })
        .updateComplete;

      expect(small!.checked).to.be.false;
    });
  });
});
