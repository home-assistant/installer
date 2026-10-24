import { expect } from "@open-wc/testing";
import { fireEvent, type HAIEvent } from "../../../src/utils/fire-event.js";

describe("fireEvent", () => {
  let host: HTMLElement;
  let sender: HTMLElement;

  // The sender sits in a shadow root, as a view does in the shell
  beforeEach(() => {
    host = document.createElement("div");
    sender = document.createElement("div");
    host.attachShadow({ mode: "open" }).append(sender);
    document.body.append(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("reaches listeners outside the sender's shadow root, with its detail", () => {
    const heard: HAIEvent<"navigate">[] = [];
    host.addEventListener("navigate", (event) => heard.push(event));

    fireEvent(sender, "navigate", { view: "welcome" });

    expect(heard).to.have.length(1);
    expect(heard[0].detail).to.deep.equal({ view: "welcome" });
    expect(heard[0].bubbles).to.be.true;
    expect(heard[0].composed).to.be.true;
  });

  it("carries no detail for an event that has none", () => {
    const heard: HAIEvent<"wizard-next">[] = [];
    host.addEventListener("wizard-next", (event) => heard.push(event));

    fireEvent(sender, "wizard-next");

    expect(heard).to.have.length(1);
    expect(heard[0].detail).to.equal(null);
  });

  it("rejects an event or detail the app doesn't declare at build time", () => {
    const send = () => {
      // @ts-expect-error: misspelled event
      fireEvent(sender, "wizard-nxt");
      // @ts-expect-error: wrong detail
      fireEvent(sender, "navigate", { view: "nowhere" });
      // @ts-expect-error: no detail
      fireEvent(sender, "resources-change");
    };
    expect(send).to.be.a("function");
  });
});
