import { expect } from "@open-wc/testing";
import { isLinux, isMacOS } from "../../../src/utils/platform.js";

describe("utils/platform", () => {
  const originalUserAgent = navigator.userAgent;

  const setUserAgent = (value: string) => {
    Object.defineProperty(window.navigator, "userAgent", {
      value,
      configurable: true,
    });
  };

  afterEach(() => setUserAgent(originalUserAgent));

  // User agents as reported by the webview Tauri uses on each host.
  const cases: Array<{
    label: string;
    userAgent: string;
    mac: boolean;
    linux: boolean;
  }> = [
    {
      label: "macOS (WKWebView)",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      mac: true,
      linux: false,
    },
    {
      label: "Linux (WebKitGTK)",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      mac: false,
      linux: true,
    },
    {
      label: "Windows (WebView2)",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0",
      mac: false,
      linux: false,
    },
  ];

  for (const { label, userAgent, mac, linux } of cases) {
    it(`detects ${label}`, () => {
      setUserAgent(userAgent);
      expect(isMacOS()).to.equal(mac);
      expect(isLinux()).to.equal(linux);
    });
  }
});
