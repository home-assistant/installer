import { expect } from "@open-wc/testing";
import {
  createExternalLink,
  homeAssistantUrl,
  openExternalUrl,
} from "../../../src/utils/external-url.js";
import { captureOpenedUrls, restoreTauriIpc, settle } from "../tauri-ipc.js";

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

  it("points at Home Assistant's address, or its name while there is none", () => {
    expect(homeAssistantUrl("192.0.2.50")).to.equal("http://192.0.2.50");
    for (const address of [undefined, null, ""]) {
      expect(homeAssistantUrl(address)).to.equal("http://homeassistant.local");
    }
  });

  describe("createExternalLink", () => {
    afterEach(() => {
      restoreTauriIpc();
    });

    it("is an external link like the ones the views render", async () => {
      const opened = captureOpenedUrls();
      const link = createExternalLink(
        "https://www.home-assistant.io/",
        "Report a problem"
      );
      expect(link.getAttribute("href")).to.equal(
        "https://www.home-assistant.io/"
      );
      expect(link.target).to.equal("_blank");
      expect(link.rel).to.equal("noopener noreferrer");
      expect(link.textContent).to.equal(
        "Report a problem Opens in your browser."
      );
      // Hidden once it is on the page
      document.body.append(link);
      try {
        expect(getComputedStyle(link.querySelector("span")!).position).to.equal(
          "absolute"
        );
      } finally {
        link.remove();
      }

      const click = new MouseEvent("click", { cancelable: true });
      link.dispatchEvent(click);
      await settle();
      expect(click.defaultPrevented).to.be.true;
      expect(opened).to.deep.equal(["https://www.home-assistant.io/"]);
    });
  });
});
