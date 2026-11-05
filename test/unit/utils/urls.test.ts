import { expect } from "@open-wc/testing";
import * as urls from "../../../src/utils/urls.js";

describe("utils/urls", () => {
  const all = Object.entries(urls);

  it("only links to web pages over HTTPS", () => {
    expect(all.length).to.be.greaterThan(0);
    for (const [name, url] of all) {
      expect(new URL(url).protocol, name).to.equal("https:");
    }
  });

  it("writes each page once, with or without its trailing slash", () => {
    // /odroid and /odroid/ are one page: it may only be written one way
    const pages = all.map(([, url]) => url.replace(/\/(?=#|\?|$)/, ""));
    expect(new Set(pages).size).to.equal(pages.length);
  });

  it("carries no credentials", () => {
    for (const [name, url] of all) {
      expect(new URL(url).username, name).to.equal("");
      expect(new URL(url).password, name).to.equal("");
    }
  });
});
