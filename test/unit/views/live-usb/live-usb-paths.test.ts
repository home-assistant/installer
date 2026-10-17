import { expect } from "@open-wc/testing";
import { isoTargetPath } from "../../../../src/views/live-usb/live-usb-paths.js";

describe("isoTargetPath", () => {
  const setUserAgent = (value: string) => {
    Object.defineProperty(window.navigator, "userAgent", {
      value,
      configurable: true,
    });
  };

  afterEach(() => {
    delete (window.navigator as { userAgent?: string }).userAgent;
  });

  it("joins folders, keeping the separator of a root folder", () => {
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    expect(isoTargetPath("/home/me/", "a.iso")).to.equal("/home/me/a.iso");
    expect(isoTargetPath("/", "a.iso")).to.equal("/a.iso");
    expect(isoTargetPath("", "a.iso")).to.equal("a.iso");
    // A backslash is a valid last character of a Unix folder name
    expect(isoTargetPath("/tmp/out\\", "a.iso")).to.equal("/tmp/out\\/a.iso");

    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isoTargetPath("C:\\Users\\me\\", "a.iso")).to.equal(
      "C:\\Users\\me\\a.iso"
    );
    expect(isoTargetPath("C:\\", "a.iso")).to.equal("C:\\a.iso");
  });
});
