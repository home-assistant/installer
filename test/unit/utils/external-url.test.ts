import { expect } from "@open-wc/testing";
import { openExternalUrl } from "../../../src/utils/external-url.js";

describe("utils/external-url", () => {
  async function openedWithFallback(urls: string[]) {
    const originalOpen = window.open;
    const opened: Array<{
      features?: string;
      target?: string;
      url?: string | URL;
    }> = [];
    window.open = (url?: string | URL, target?: string, features?: string) => {
      opened.push({ features, target, url });
      return null;
    };

    try {
      for (const url of urls) {
        await openExternalUrl(url);
      }
    } finally {
      window.open = originalOpen;
    }
    return opened;
  }

  it("falls back to window.open when Tauri openUrl is unavailable", async () => {
    expect(
      await openedWithFallback([
        "https://www.home-assistant.io/",
        "http://homeassistant.local",
      ])
    ).to.deep.equal([
      {
        features: "noopener,noreferrer",
        target: "_blank",
        url: "https://www.home-assistant.io/",
      },
      {
        features: "noopener,noreferrer",
        target: "_blank",
        url: "http://homeassistant.local",
      },
    ]);
  });

  it("only opens web links in the fallback", async () => {
    expect(
      await openedWithFallback([
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,hi",
        "not a url",
      ])
    ).to.deep.equal([]);
  });
});
