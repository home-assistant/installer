import { expect } from "@open-wc/testing";
import { wizardState } from "../../../src/state/wizard-state.js";

describe("wizard-state", () => {
  beforeEach(() => {
    wizardState.reset();
  });

  it("starts with initial state", () => {
    const state = wizardState.getState();
    expect(state.currentFlow).to.be.null;
    expect(state.currentStepIndex).to.equal(0);
    expect(state.steps).to.have.length(0);
    expect(state.selections).to.deep.equal({});
  });

  it("changes the flow generation only for a new flow or reset", () => {
    const initial = wizardState.flowGeneration;
    wizardState.startFlow("vm");
    const generation = wizardState.flowGeneration;
    expect(generation).to.not.equal(initial);

    wizardState.nextStep();
    wizardState.previousStep();
    wizardState.goToStep(3);
    wizardState.setSelection("cpuCores", 4);
    expect(wizardState.flowGeneration).to.equal(generation);

    wizardState.startFlow("vm");
    const nextGeneration = wizardState.flowGeneration;
    expect(nextGeneration).to.not.equal(generation);
    wizardState.reset();
    expect(wizardState.flowGeneration).to.not.equal(nextGeneration);
  });

  it("starts an SBC flow with correct steps", () => {
    wizardState.startFlow("sbc");
    const state = wizardState.getState();

    expect(state.currentFlow).to.equal("sbc");
    expect(state.currentStepIndex).to.equal(0);
    expect(state.steps.length).to.be.greaterThan(0);
    expect(state.steps[0].id).to.equal("device");
  });

  it("starts a mini PC flow with correct steps", () => {
    wizardState.startFlow("minipc");
    const state = wizardState.getState();

    expect(state.currentFlow).to.equal("minipc");
    expect(state.steps[0].id).to.equal("method");
  });

  it("navigates to next step", () => {
    wizardState.startFlow("sbc");
    expect(wizardState.getState().currentStepIndex).to.equal(0);

    wizardState.nextStep();
    expect(wizardState.getState().currentStepIndex).to.equal(1);
  });

  it("navigates to previous step", () => {
    wizardState.startFlow("sbc");
    wizardState.nextStep();
    wizardState.nextStep();
    expect(wizardState.getState().currentStepIndex).to.equal(2);

    wizardState.previousStep();
    expect(wizardState.getState().currentStepIndex).to.equal(1);
  });

  it("does not go before first step", () => {
    wizardState.startFlow("sbc");
    expect(wizardState.getState().currentStepIndex).to.equal(0);

    wizardState.previousStep();
    expect(wizardState.getState().currentStepIndex).to.equal(0);
  });

  it("does not go past last step", () => {
    wizardState.startFlow("vm");
    const lastIndex = wizardState.getState().steps.length - 1;

    // Go to last step
    for (let i = 0; i < 10; i++) {
      wizardState.nextStep();
    }

    expect(wizardState.getState().currentStepIndex).to.equal(lastIndex);
  });

  it("tracks isFirstStep correctly", () => {
    wizardState.startFlow("sbc");
    expect(wizardState.isFirstStep).to.be.true;

    wizardState.nextStep();
    expect(wizardState.isFirstStep).to.be.false;
  });

  it("tracks isLastStep correctly", () => {
    wizardState.startFlow("vm");
    const lastIndex = wizardState.getState().steps.length - 1;
    expect(wizardState.isLastStep).to.be.false;

    // Go to last step
    for (let i = 0; i < lastIndex; i++) {
      wizardState.nextStep();
    }
    expect(wizardState.isLastStep).to.be.true;
  });

  it("sets selections", () => {
    wizardState.startFlow("sbc");
    wizardState.setSelection("device", "raspberry-pi-5");
    wizardState.setSelection("drive", "/dev/sda");

    const state = wizardState.getState();
    expect(state.selections.device).to.equal("raspberry-pi-5");
    expect(state.selections.drive).to.equal("/dev/sda");
  });

  it("resets state", () => {
    wizardState.startFlow("sbc");
    wizardState.nextStep();
    wizardState.setSelection("device", "test");

    wizardState.reset();

    const state = wizardState.getState();
    expect(state.currentFlow).to.be.null;
    expect(state.currentStepIndex).to.equal(0);
    expect(state.selections).to.deep.equal({});
  });

  it("calculates progress correctly", () => {
    wizardState.startFlow("vm");
    const stepCount = wizardState.getState().steps.length;
    expect(wizardState.progress).to.be.closeTo(1 / stepCount, 0.01);

    wizardState.nextStep();
    expect(wizardState.progress).to.be.closeTo(2 / stepCount, 0.01);

    // Advance to the final step
    while (!wizardState.isLastStep) {
      wizardState.nextStep();
    }
    expect(wizardState.progress).to.equal(1);
  });

  it("notifies subscribers on state change", () => {
    let notifyCount = 0;
    const unsubscribe = wizardState.subscribe(() => {
      notifyCount++;
    });

    wizardState.startFlow("sbc");
    expect(notifyCount).to.equal(1);

    wizardState.nextStep();
    expect(notifyCount).to.equal(2);

    unsubscribe();
    wizardState.nextStep();
    expect(notifyCount).to.equal(2); // Should not increment after unsubscribe
  });

  it("goes to specific step", () => {
    wizardState.startFlow("sbc");
    wizardState.goToStep(2);
    expect(wizardState.getState().currentStepIndex).to.equal(2);
  });

  it("returns current step", () => {
    wizardState.startFlow("sbc");
    expect(wizardState.currentStep?.id).to.equal("device");

    wizardState.nextStep();
    expect(wizardState.currentStep?.id).to.equal("drive");
  });

  it("invalidates catalog readiness before notifying a step change", () => {
    for (const move of [
      () => wizardState.nextStep(),
      () => wizardState.previousStep(),
      () => wizardState.goToStep(2),
    ]) {
      wizardState.startFlow("sbc");
      wizardState.goToStep(1);
      wizardState.setSelection("device", "rpi5");
      wizardState.setSelection("drive", "saved-drive");
      wizardState.setSelection("deviceCatalogReady", true);
      const unsubscribe = wizardState.subscribe((state) => {
        expect(state.selections.deviceCatalogReady).to.equal(false);
        expect(state.selections.device).to.equal("rpi5");
        expect(state.selections.drive).to.equal("saved-drive");
      });
      move();
      unsubscribe();
    }
  });

  it("preserves catalog readiness when the current step is selected again", () => {
    wizardState.startFlow("sbc");
    wizardState.setSelection("deviceCatalogReady", true);
    wizardState.goToStep(0);
    expect(wizardState.getState().selections.deviceCatalogReady).to.equal(true);
  });
});
