import { expect } from "@open-wc/testing";
import { emulateMedia } from "@web/test-runner-commands";
import {
  darkTheme,
  initializeTheme,
  setTheme,
  theme,
} from "../../../src/utils/theme.js";

const KEY = "hai:theme";

const shownDark = () => document.documentElement.classList.contains("wa-dark");

describe("theme", () => {
  afterEach(async () => {
    setTheme("system");
    localStorage.removeItem(KEY);
    await emulateMedia({ colorScheme: "light" });
  });

  it("matches the system's at first, and follows it", async () => {
    initializeTheme();
    expect(theme()).to.equal("system");
    expect(shownDark()).to.be.false;

    // The class follows on the change event, which waits for a rendered
    // frame: none comes while the test page is backgrounded
    await emulateMedia({ colorScheme: "dark" });
    expect(darkTheme()).to.be.true;
  });

  it("wins over the system's, and is remembered", async () => {
    initializeTheme();
    await emulateMedia({ colorScheme: "dark" });

    setTheme("light");

    expect(shownDark()).to.be.false;
    expect(localStorage.getItem(KEY)).to.equal("light");
  });

  it("starts with the theme chosen last time", () => {
    localStorage.setItem(KEY, "dark");
    initializeTheme();

    expect(theme()).to.equal("dark");
    expect(shownDark()).to.be.true;
  });

  it("ignores a remembered theme it doesn't offer", () => {
    localStorage.setItem(KEY, "sepia");
    initializeTheme();

    expect(theme()).to.equal("system");
  });
});
