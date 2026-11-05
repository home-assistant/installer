import { expect, fixture, html } from "@open-wc/testing";
import messages from "../../src/localization/en.json";
import { setLanguage } from "../../src/localization/localize.js";
import {
  MINIPC_STEPS,
  minipcDirectSteps,
  wizardState,
  type WizardFlow,
  type WizardStep,
} from "../../src/state/wizard-state.js";
import "../../src/views/other-options-view.js";
import type { OtherOptionsView } from "../../src/views/other-options-view.js";
import type { OptionCard } from "../../src/components/option-card.js";

// Both modules above load in English, before this file picks another language,
// the way a module loaded ahead of localization would. A label localized when
// its module loads would still read English after the switch below.
const translation = Object.fromEntries(
  Object.keys(messages).map((key) => [key, `«${key}»`])
);

function titles(steps: WizardStep[]) {
  return steps.map((step) => step.title);
}

describe("labels localized when shown", () => {
  afterEach(() => {
    setLanguage("en");
    wizardState.reset();
  });

  const flows: WizardFlow[] = ["sbc", "minipc", "ha-hardware", "proxmox", "vm"];
  for (const flow of flows) {
    it(`titles the ${flow} steps in the current language`, () => {
      wizardState.startFlow(flow);
      const english = titles(wizardState.getState().steps);
      expect(english.every((title) => !title.startsWith("«"))).to.be.true;

      setLanguage("de", translation);
      const translated = titles(wizardState.getState().steps);
      expect(translated).to.have.length(english.length);
      for (const title of translated) {
        expect(title).to.match(/^«[a-z_.]+»$/);
      }

      setLanguage("en");
      expect(titles(wizardState.getState().steps)).to.deep.equal(english);
    });
  }

  it("titles the steps that depend on the selections in the current language", () => {
    setLanguage("de", translation);
    // The Wi-Fi step comes with a board that has Wi-Fi, the module step with
    // the Yellow's compute modules
    wizardState.startFlow("ha-hardware");
    wizardState.setSelections({
      yellowModules: [
        { id: "yellow-cm4", config: { board: "yellow" } as never },
      ],
      deviceConfig: { board: "yellow" } as never,
    });
    const steps = wizardState.getState().steps;
    expect(steps.map((step) => step.id)).to.include.members(["module", "wifi"]);
    for (const title of titles(steps)) {
      expect(title).to.match(/^«[a-z_.]+»$/);
    }
  });

  it("titles the mini PC paths in the current language", () => {
    setLanguage("de", translation);
    for (const steps of [
      MINIPC_STEPS.direct,
      MINIPC_STEPS.usb,
      MINIPC_STEPS.iso,
      minipcDirectSteps({}),
    ]) {
      expect(steps.length).to.be.greaterThan(0);
      for (const title of titles(steps)) {
        expect(title).to.match(/^«[a-z_.]+»$/);
      }
    }
  });

  it("shows the other installation methods in the current language", async () => {
    setLanguage("de", translation);
    const el = await fixture<OtherOptionsView>(
      html`<other-options-view></other-options-view>`
    );
    const cards = [
      ...el.shadowRoot!.querySelectorAll<OptionCard>("option-card"),
    ];
    expect(cards).to.have.length(5);
    for (const card of cards) {
      expect(card.heading).to.match(/^«views\.other_options_view\.[a-z_]+»$/);
      expect(card.description).to.match(
        /^«views\.other_options_view\.[a-z_]+»$/
      );
    }
  });
});
