import { expect } from "@open-wc/testing";
import { render } from "lit";
import {
  LIVE_USB_STEPS,
  WIZARD_STEPS,
  wizardStep,
  type WizardStepView,
} from "../../../src/components/wizard-steps.js";
import {
  MINIPC_STEPS,
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
  // The Yellow's compute modules add their step to the hardware flow
  wizardState.setSelections({
    yellowModules: [{ id: "yellow-cm4", config: WIFI_BOARD }],
    deviceConfig: WIFI_BOARD,
  });
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
      // A drive picked earlier waits for the scan that confirms it
      expect(readyWith(flow, "drive", { drive: "/dev/sdb" }), flow).to.be.false;
      expect(readyWith(flow, "drive", { driveScanReady: true }), flow).to.be
        .false;
      expect(
        readyWith(flow, "drive", { drive: "/dev/sdb", driveScanReady: true }),
        flow
      ).to.be.true;
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
    expect(readyWith("ha-hardware", "module", { device: "ha-yellow" })).to.be
      .false;
    expect(
      readyWith("ha-hardware", "module", {
        haHardware: "yellow-cm5",
        deviceConfig: WIFI_BOARD,
      })
    ).to.be.true;
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

  it("only holds Next for Proxmox and the official hardware", () => {
    expect(wizardStep("proxmox", "connection")?.beforeNext?.until).to.equal(
      "flow"
    );
    expect(wizardStep("proxmox", "configure")?.beforeNext?.until).to.equal(
      "selections"
    );
    // Asks whether the hardware, which ships ready to use, should be reinstalled
    expect(wizardStep("ha-hardware", "device")?.beforeNext?.until).to.equal(
      "flow"
    );
    const held = new Set([
      "proxmox/connection",
      "proxmox/configure",
      "ha-hardware/device",
    ]);
    for (const flow of FLOWS) {
      for (const [id, step] of Object.entries(WIZARD_STEPS[flow])) {
        if (held.has(`${flow}/${id}`)) continue;
        expect(step.beforeNext === undefined, `${flow}/${id}`).to.be.true;
      }
    }
  });

  // A drive is erased, so picking one still takes Next
  it("goes on when a card is picked on the steps that choose what to install on, or how", () => {
    const picked = [
      ...FLOWS.flatMap((flow) =>
        Object.entries(WIZARD_STEPS[flow]).map(
          ([id, step]) => [`${flow}/${id}`, step] as const
        )
      ),
      ...Object.entries(LIVE_USB_STEPS).map(
        ([id, step]) => [`minipc/usb/${id}`, step] as const
      ),
    ].flatMap(([path, step]) => (step.goesOnWhenPicked ? [path] : []));

    expect(picked).to.deep.equal([
      "sbc/device",
      "ha-hardware/device",
      "ha-hardware/module",
      "minipc/method",
      "minipc/architecture",
      "minipc/usb/media",
    ]);
  });

  it("leaves the hardware device step only when the reinstall is confirmed", async () => {
    const run = wizardStep("ha-hardware", "device")!.beforeNext!.run;
    for (const answer of [true, false]) {
      let asked = 0;
      const view = Object.assign(document.createElement("div"), {
        confirmReinstall: () => {
          asked++;
          return Promise.resolve(answer);
        },
      }) as unknown as WizardStepView;
      expect(await run(view)).to.equal(answer);
      expect(asked).to.equal(1);
    }
  });

  describe("booting the mini PC from USB", () => {
    const usbBoot: WizardSelections = { installMethod: "usb-boot" };
    const liveStep = (stepId: string, selections: WizardSelections = usbBoot) =>
      wizardStep("minipc", stepId, selections);

    it("has a view for every step of both media", () => {
      for (const steps of [MINIPC_STEPS.usb, MINIPC_STEPS.iso]) {
        for (const { id } of steps) {
          const step = liveStep(id);
          expect(step, id).to.exist;
          const container = document.createElement("div");
          render(step!.render(), container);
          expect(container.firstElementChild?.tagName.includes("-"), id).to.be
            .true;
        }
      }
      expect(Object.keys(LIVE_USB_STEPS)).to.have.members([
        ...new Set(
          [...MINIPC_STEPS.usb, ...MINIPC_STEPS.iso]
            .map(({ id }) => id)
            .filter((id) => id !== "method")
        ),
      ]);
    });

    it("shows its own views only on the USB path", () => {
      expect(liveStep("drive")).to.equal(LIVE_USB_STEPS.drive);
      expect(liveStep("method")).to.equal(WIZARD_STEPS.minipc.method);
      expect(liveStep("drive", { installMethod: "direct" })).to.equal(
        WIZARD_STEPS.minipc.drive
      );
      expect(wizardStep("minipc", "drive")).to.equal(WIZARD_STEPS.minipc.drive);
    });

    it("holds Next until the program for the stick is there", () => {
      const ready = (stepId: string, selections: WizardSelections) =>
        liveStep(stepId)!.ready!({ ...usbBoot, ...selections });
      expect(ready("drive", { drive: "/dev/sdb" })).to.be.false;
      // The stick is still being rescanned, as when coming back from the summary
      expect(ready("drive", { drive: "/dev/sdb", liveReady: true })).to.be
        .false;
      expect(
        ready("drive", {
          drive: "/dev/sdb",
          driveScanReady: true,
          liveReady: true,
        })
      ).to.be.true;
      const location = {
        liveReady: true,
        liveIsoFolder: "/tmp",
        liveIsoName: "haos.iso",
      };
      expect(ready("location", location)).to.be.true;
      expect(ready("location", { ...location, liveReady: false })).to.be.false;
      expect(ready("location", { ...location, liveIsoFolder: "  " })).to.be
        .false;
      expect(ready("location", { ...location, liveIsoName: "" })).to.be.false;
    });

    it("checks the save location before leaving it", async () => {
      const beforeNext = liveStep("location")!.beforeNext!;
      expect(beforeNext.until).to.equal("selections");
      for (const answer of [true, false]) {
        const view = Object.assign(document.createElement("div"), {
          check: () => Promise.resolve(answer),
        }) as unknown as WizardStepView;
        expect(await beforeNext.run(view)).to.equal(answer);
      }
    });
  });
});
