import {
  expect,
  fixture,
  fixtureSync,
  html,
  waitUntil,
} from "@open-wc/testing";
import type WaButton from "@home-assistant/webawesome/dist/components/button/button.js";
import { wizardState } from "../../../src/state/wizard-state.js";
import { renderBackHeader } from "../../../src/utils/page-header.js";
import "../../../src/components/confirm-dialog.js";
import "../../../src/components/wizard-shell.js";
import "../../../src/views/welcome-view.js";
import "../../../src/views/sbc/drive-selection-view.js";
import type { DriveSelectionView } from "../../../src/views/sbc/drive-selection-view.js";
import { MOCK_MANIFEST } from "../../../src/api/mock-data.js";
import { findByRole, fullA11ySnapshot } from "../helpers/a11y.js";
import { flush, holdDeviceScan } from "../helpers/hold-device-scan.js";

/**
 * The arrows and symbols drawn next to a button's label are decoration: a
 * screen reader that reads them says "left arrow Back" instead of "Back".
 */
async function buttonNames() {
  return findByRole(await fullA11ySnapshot(), "button").map((button) =>
    button.name?.trim()
  );
}

describe("decorative glyphs in accessible names", () => {
  beforeEach(() => {
    wizardState.startFlow("sbc");
    wizardState.setSelection("deviceConfig", MOCK_MANIFEST.devices[0].haos);
  });
  afterEach(() => wizardState.reset());

  it("leaves the arrow out of Back in the wizard header", async () => {
    await fixture(html`<wizard-shell></wizard-shell>`);

    expect(await buttonNames()).to.include("Back");
  });

  it("leaves the arrow out of Back on the screens before the wizard", async () => {
    // fixtureSync + updateComplete rather than fixture(): a plain div root
    // makes fixture() wait for an animation frame, which never comes while
    // the test page is backgrounded.
    const header = fixtureSync<HTMLElement>(
      html`${renderBackHeader(() => {})}`
    );
    await (header.querySelector("wa-button") as WaButton).updateComplete;

    expect(await buttonNames()).to.deep.equal(["Back"]);
  });

  it("leaves the arrow out of Let's go", async () => {
    await fixture(html`<welcome-view></welcome-view>`);

    expect(await buttonNames()).to.include("Let's go");
  });

  it("leaves the warning sign out of the erase dialog's name", async () => {
    await fixture(html`<confirm-dialog open></confirm-dialog>`);

    const tree = await fullA11ySnapshot();
    expect(findByRole(tree, "dialog").map((d) => d.name)).to.deep.equal([
      "Erase drive and install?",
    ]);
    expect(findByRole(tree, "heading").map((h) => h.name?.trim())).to.include(
      "Erase drive and install?"
    );
  });

  describe("Refresh on the drive step", () => {
    it("leaves the symbol out when no drive was found", async () => {
      const scan = holdDeviceScan();
      try {
        await fixture<DriveSelectionView>(
          html`<drive-selection-view></drive-selection-view>`
        );
        scan.resolve([]);
        await flush();

        expect(await buttonNames()).to.include("Refresh");
      } finally {
        scan.restore();
      }
    });

    it("leaves the symbol out above the list of drives", async () => {
      const el = await fixture<DriveSelectionView>(
        html`<drive-selection-view></drive-selection-view>`
      );
      await waitUntil(
        () => el.shadowRoot!.querySelectorAll("drive-card").length > 0,
        "drives never finished loading"
      );

      expect(await buttonNames()).to.include("Refresh");
    });
  });
});
