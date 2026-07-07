import { expect } from "@open-wc/testing";
import { openExternalUrl } from "../../../src/utils/external-url.js";

describe("utils/external-url", () => {
  it("falls back to window.open when Tauri openUrl is unavailable", async () => {
    const originalOpen = window.open;
    const openedUrls: Array<{ target?: string; url?: string | URL }> = [];
    window.open = (url?: string | URL, target?: string) => {
      openedUrls.push({ target, url });
      return null;
    };

    try {
      await openExternalUrl("https://www.home-assistant.io/");
    } finally {
      window.open = originalOpen;
    }

    expect(openedUrls).to.deep.equal([
      { target: "_blank", url: "https://www.home-assistant.io/" },
    ]);
  });
});
