import { expect } from "@open-wc/testing";
import { render } from "lit";
import {
  WIZARD_STEPS,
  wizardStep,
} from "../../../src/components/wizard-steps.js";
import {
  wizardState,
  type WizardFlow,
  type WizardSelections,
} from "../../../src/state/wizard-state.js";

const FLOWS = Object.keys(WIZARD_STEPS) as WizardFlow[];

/** A board that can join Wi-Fi, so the flows that write a drive show that step */
const WIFI_BOARD = {
  board: "rpi5-64",
  minimum_storage_bytes: 0,
  recommended_storage_bytes: 0,
};

/** Every step `flow` can show */
function stepsOf(flow: WizardFlow): string[] {
  wizardState.startFlow(flow);
  wizardState.setSelection("deviceConfig", WIFI_BOARD);
  return wizardState.getState().steps.map(({ id }) => id);
}

const readyWith = (
  flow: WizardFlow,
  stepId: string,
  selections: WizardSelections
) => wizardStep(flow, stepId)?.ready?.(selections) ?? true;

describe("wizard-steps", () => {
  afterEach(() => wizardState.reset());

  it("has a view for every step of every flow", () => {
    for (const flow of FLOWS) {
      for (const id of stepsOf(flow)) {
        const step = wizardStep(flow, id);
        expect(step, `${flow}/${id}`).to.exist;
        const container = document.createElement("div");
        render(step!.render(), container);
        expect(
          container.firstElementChild?.tagName.includes("-"),
          `${flow}/${id} renders a view`
        ).to.be.true;
      }
    }
  });

  it("has no step a flow doesn't have", () => {
    for (const flow of FLOWS) {
      expect(Object.keys(WIZARD_STEPS[flow]), flow).to.have.members(
        stepsOf(flow)
      );
    }
  });

  it("holds Next until the step has what it needs", () => {
    for (const flow of ["sbc", "ha-hardware", "minipc"] as const) {
      expect(readyWith(flow, "drive", {}), flow).to.be.false;
      expect(readyWith(flow, "drive", { drive: "/dev/sdb" }), flow).to.be.true;
      expect(readyWith(flow, "wifi", { deviceConfig: WIFI_BOARD }), flow).to.be
        .true;
      expect(
        readyWith(flow, "wifi", {
          deviceConfig: WIFI_BOARD,
          wifi: { ssid: "", password: "" },
        }),
        flow
      ).to.be.false;
      expect(
        readyWith(flow, "wifi", {
          deviceConfig: WIFI_BOARD,
          wifi: { ssid: "Home", password: "12345678" },
        }),
        flow
      ).to.be.true;
    }
    const pickDevice = (flow: WizardFlow, stepId: string) => [
      readyWith(flow, stepId, { device: "rpi5" }),
      readyWith(flow, stepId, { device: "rpi5", deviceCatalogReady: true }),
    ];
    expect(pickDevice("sbc", "device")).to.deep.equal([false, true]);
    expect(pickDevice("minipc", "architecture")).to.deep.equal([false, true]);
    expect(readyWith("vm", "check", {})).to.be.false;
    expect(readyWith("vm", "check", { utmInstalled: true })).to.be.true;
    expect(readyWith("vm", "configure", {})).to.be.true;
    expect(readyWith("vm", "configure", { vmName: "My Home" })).to.be.true;
    expect(readyWith("vm", "configure", { vmName: "" })).to.be.false;
    expect(readyWith("vm", "configure", { vmName: "  " })).to.be.false;

    const configured: WizardSelections = {
      proxmoxConfigureReady: true,
      proxmoxNode: "pve",
      proxmoxStorage: "local",
      proxmoxBridge: "vmbr0",
      proxmoxBridgeReady: true,
      proxmoxImportReady: true,
    };
    expect(readyWith("proxmox", "configure", configured)).to.be.true;
    expect(
      readyWith("proxmox", "configure", {
        ...configured,
        proxmoxImportReady: false,
      })
    ).to.be.false;
  });

  it("connects and checks the Proxmox settings before leaving those steps", () => {
    expect(wizardStep("proxmox", "connection")?.beforeNext?.until).to.equal(
      "flow"
    );
    expect(wizardStep("proxmox", "configure")?.beforeNext?.until).to.equal(
      "selections"
    );
    for (const flow of FLOWS) {
      for (const [id, step] of Object.entries(WIZARD_STEPS[flow])) {
        if (flow === "proxmox" && (id === "connection" || id === "configure"))
          continue;
        expect(step.beforeNext, `${flow}/${id}`).to.be.undefined;
      }
    }
  });
});
