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

function wheel(deltaY: number, ctrlKey = true): WheelEvent {
  const event = new WheelEvent("wheel", { deltaY, ctrlKey, cancelable: true });
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
    localStorage.setItem(KEY, "1.4");
    initializeTextSize();
    expect(textSize()).to.equal(1.4);
  });

  it("ignores a remembered size it doesn't offer", () => {
    localStorage.setItem(KEY, "1.25");
    initializeTextSize();
    expect(textSize()).to.equal(1);
  });

  it("steps through the sizes with the zoom keys, from 20% to 1000%", () => {
    expect(press("=").defaultPrevented).to.be.true;
    expect(textSize()).to.equal(1.2);
    press("+");
    expect(textSize()).to.equal(1.4);
    press("-");
    press("-");
    press("-");
    expect(textSize()).to.equal(0.8);

    for (let i = 0; i < 10; i++) press("-");
    expect(textSize()).to.equal(0.2);
    for (let i = 0; i < 60; i++) press("+");
    expect(textSize()).to.equal(10);
    press("0");
    expect(textSize()).to.equal(1);
  });

  it("zooms with Ctrl and the mouse wheel, a step per notch", () => {
    expect(wheel(-100).defaultPrevented).to.be.true;
    expect(textSize()).to.equal(1.2);
    wheel(100);
    wheel(100);
    expect(textSize()).to.equal(0.8);
  });

  it("adds up a touchpad's small turns to a step", () => {
    wheel(-20);
    wheel(-20);
    expect(textSize()).to.equal(1);
    wheel(-20);
    expect(textSize()).to.equal(1.2);
    // Turning back starts over
    wheel(-20);
    wheel(30);
    expect(textSize()).to.equal(1.2);
  });

  it("leaves the wheel to scrolling without Ctrl", () => {
    expect(wheel(-100, false).defaultPrevented).to.be.false;
    expect(textSize()).to.equal(1);
  });

  it("resets with the top-row 0 key on a French AZERTY layout", () => {
    setTextSize(1.4);
    expect(press("à", true, "Digit0").defaultPrevented).to.be.true;
    expect(textSize()).to.equal(1);
  });

  it('lets AltGr type "@" on a French AZERTY layout', () => {
    setTextSize(1.4);
    expect(press("@", true, "Digit0", true).defaultPrevented).to.be.false;
    expect(textSize()).to.equal(1.4);
  });

  it("leaves the keys alone without Ctrl or Cmd", () => {
    expect(press("+", false).defaultPrevented).to.be.false;
    expect(press("a").defaultPrevented).to.be.false;
    expect(textSize()).to.equal(1);
  });
});
