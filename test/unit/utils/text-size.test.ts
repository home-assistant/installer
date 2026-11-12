import { expect } from "@open-wc/testing";
import { mockWindows } from "@tauri-apps/api/mocks";
import {
  initializeTextSize,
  setTextSize,
  textSize,
} from "../../../src/utils/text-size.js";
import { getPlatform } from "../../../src/utils/platform.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "../tauri-ipc.js";

const KEY = "hai:text-size";

function press(
  key: string,
  modifier = true,
  code = "",
  altKey = false
): KeyboardEvent {
  const macos = getPlatform() === "macos";
  const event = new KeyboardEvent("keydown", {
    key,
    code,
    ctrlKey: modifier && !macos,
    metaKey: modifier && macos,
    altKey,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("text size", () => {
  beforeEach(() => initializeTextSize());

  afterEach(() => {
    restoreTauriIpc();
    setTextSize(1);
    localStorage.removeItem(KEY);
  });

  it("zooms the web view and remembers the size", async () => {
    const zooms: unknown[] = [];
    mockTauriIpc((cmd, args) => {
      if (cmd !== "plugin:webview|set_webview_zoom") throw new Error(cmd);
      zooms.push((args as { value: number }).value);
    });
    mockWindows("main");

    setTextSize(1.5);
    await settle();

    expect(zooms).to.deep.equal([1.5]);
    expect(localStorage.getItem(KEY)).to.equal("1.5");
  });

  it("starts at the size chosen last time", () => {
    localStorage.setItem(KEY, "1.75");
    initializeTextSize();
    expect(textSize()).to.equal(1.75);
  });

  it("ignores a remembered size it doesn't offer", () => {
    localStorage.setItem(KEY, "7");
    initializeTextSize();
    expect(textSize()).to.equal(1);
  });

  it("steps through the sizes with the zoom keys, within the range", () => {
    expect(press("=").defaultPrevented).to.be.true;
    expect(textSize()).to.equal(1.25);
    press("+");
    expect(textSize()).to.equal(1.5);
    press("-");
    expect(textSize()).to.equal(1.25);
    press("-");
    press("-");
    expect(textSize()).to.equal(1);

    for (let i = 0; i < 6; i++) press("+");
    expect(textSize()).to.equal(2);
    press("0");
    expect(textSize()).to.equal(1);
  });

  it("resets with the top-row 0 key on a French AZERTY layout", () => {
    setTextSize(1.5);
    expect(press("à", true, "Digit0").defaultPrevented).to.be.true;
    expect(textSize()).to.equal(1);
  });

  it('lets AltGr type "@" on a French AZERTY layout', () => {
    setTextSize(1.5);
    expect(press("@", true, "Digit0", true).defaultPrevented).to.be.false;
    expect(textSize()).to.equal(1.5);
  });

  it("leaves the keys alone without Ctrl or Cmd", () => {
    expect(press("+", false).defaultPrevented).to.be.false;
    expect(press("a").defaultPrevented).to.be.false;
    expect(textSize()).to.equal(1);
  });
});
