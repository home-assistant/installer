import { expect } from "@open-wc/testing";
import { getPlatform } from "../../../src/utils/platform.js";

describe("getPlatform", () => {
  const setUserAgent = (value: string) => {
    Object.defineProperty(window.navigator, "userAgent", {
      value,
      configurable: true,
    });
  };

  // The stub shadows the prototype getter; deleting it restores the real UA.
  afterEach(() => {
    delete (window.navigator as { userAgent?: string }).userAgent;
  });

  const cases: Array<{ userAgent: string; platform: string }> = [
    {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      platform: "macos",
    },
    {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/130.0.0.0",
      platform: "windows",
    },
    {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      platform: "linux",
    },
    { userAgent: "Mozilla/5.0 (X11; FreeBSD amd64)", platform: "other" },
  ];

  for (const { userAgent, platform } of cases) {
    it(`detects ${platform}`, () => {
      setUserAgent(userAgent);
      expect(getPlatform()).to.equal(platform);
    });
  }
});
