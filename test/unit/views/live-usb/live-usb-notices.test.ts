import { expect, fixture, fixtureSync, html } from "@open-wc/testing";
import { emulateMedia } from "@web/test-runner-commands";
import { LitElement } from "lit";
import { MOCK_BLOCK_DEVICES } from "../../../../src/api/mock-data.js";
import "../../../../src/components/inline-notice.js";
import { wizardState } from "../../../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../../../src/utils/drive-selection.js";
import "../../../../src/views/live-usb/live-usb-progress-view.js";
import type { LiveUsbProgressView } from "../../../../src/views/live-usb/live-usb-progress-view.js";
import { liveUsbStyles } from "../../../../src/views/live-usb/live-usb-styles.js";
import {
  deferred,
  mockTauriIpc,
  restoreTauriIpc,
  settle,
} from "../../tauri-ipc.js";

class LiveUsbNotices extends LitElement {
  static styles = liveUsbStyles;
  render() {
    return html`<div class="notice">Check</div>
      <div class="notice error">Failed</div>`;
  }
}
customElements.define("live-usb-notices", LiveUsbNotices);

function tint(element: Element) {
  const style = getComputedStyle(element);
  return { background: style.backgroundColor, border: style.borderTopColor };
}

async function inlineNotice(variant: "warning" | "error") {
  return fixture(html`<inline-notice variant=${variant}></inline-notice>`);
}

// They had colors of their own, with a dark set beside them, rather than the
// theme's
describe("live USB notices", () => {
  afterEach(async () => {
    await emulateMedia({ colorScheme: "light" });
    wizardState.reset();
    restoreTauriIpc();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    it(`are tinted like every other notice in ${colorScheme} mode`, async () => {
      await emulateMedia({ colorScheme });
      const el = await fixture<LiveUsbNotices>(
        html`<live-usb-notices></live-usb-notices>`
      );
      const [warning, error] = el.shadowRoot!.querySelectorAll(".notice");

      expect(tint(warning)).to.deep.equal(tint(await inlineNotice("warning")));
      expect(tint(error)).to.deep.equal(tint(await inlineNotice("error")));
    });

    it(`tints the reminder to keep the stick in like an error in ${colorScheme} mode`, async () => {
      await emulateMedia({ colorScheme });
      wizardState.startFlow("minipc");
      wizardState.setSelection("liveMedia", "usb");
      storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
      mockTauriIpc(() => deferred<unknown>().promise);
      const el = fixtureSync<LiveUsbProgressView>(
        html`<live-usb-progress-view></live-usb-progress-view>`
      );
      await settle();
      const reminder = el.shadowRoot!.querySelector(".keep-plugged-in")!;

      expect(tint(reminder)).to.deep.equal(tint(await inlineNotice("error")));
    });
  }
});
