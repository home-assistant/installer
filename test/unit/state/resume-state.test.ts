import { expect } from "@open-wc/testing";
import { MOCK_MANIFEST } from "../../../src/api/mock-data.js";
import {
  decodeResumeState,
  encodeResumeState,
} from "../../../src/state/resume-state.js";
import {
  wizardState,
  type WizardFlow,
} from "../../../src/state/wizard-state.js";

const rpi5 = MOCK_MANIFEST.devices[0];

function toBase64Url(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function onDriveStep(flow: WizardFlow) {
  wizardState.goToStep(
    wizardState.getState().steps.findIndex((step) => step.id === "drive")
  );
  expect(wizardState.currentStep?.id, flow).to.equal("drive");
}

describe("resume state", () => {
  afterEach(() => wizardState.reset());

  it("keeps the choices made before the drive step", () => {
    wizardState.startFlow("sbc");
    wizardState.setSelections({
      device: rpi5.id,
      deviceName: rpi5.name,
      deviceImage: rpi5.image_url!,
      deviceConfig: rpi5.haos,
    });
    onDriveStep("sbc");

    const encoded = encodeResumeState(wizardState.getState())!;
    expect(encoded).to.match(/^[A-Za-z0-9_-]+$/);
    expect(decodeResumeState(encoded)).to.deep.equal({
      flow: "sbc",
      step: "drive",
      selections: {
        device: rpi5.id,
        deviceName: rpi5.name,
        deviceImage: rpi5.image_url,
        deviceConfig: rpi5.haos,
      },
    });
  });

  it("keeps the USB stick path of the mini PC flow", () => {
    wizardState.startFlow("minipc");
    wizardState.setSelections({
      installMethod: "usb-boot",
      liveMedia: "usb",
      liveReady: true,
    });
    onDriveStep("minipc");

    const resume = decodeResumeState(
      encodeResumeState(wizardState.getState())!
    );
    // Whether the stick can be made is checked again after the restart
    expect(resume?.selections).to.deep.equal({
      installMethod: "usb-boot",
      liveMedia: "usb",
    });
  });

  it("keeps the Yellow's compute modules", () => {
    const yellow = MOCK_MANIFEST.devices.find((d) => d.id === "ha-yellow")!;
    wizardState.startFlow("ha-hardware");
    wizardState.setSelections({
      device: yellow.id,
      haHardware: "yellow-cm5",
      yellowModules: [{ id: "yellow-cm5", config: yellow.haos }],
      deviceConfig: yellow.haos,
    });
    onDriveStep("ha-hardware");

    const resume = decodeResumeState(
      encodeResumeState(wizardState.getState())!
    );
    expect(resume?.selections.haHardware).to.equal("yellow-cm5");
    expect(resume?.selections.yellowModules).to.deep.equal([
      { id: "yellow-cm5", config: yellow.haos },
    ]);
  });

  it("never passes on a secret or what only this run knows", () => {
    wizardState.startFlow("sbc");
    wizardState.setSelections({
      device: rpi5.id,
      deviceConfig: rpi5.haos,
      wifi: { ssid: "Home", password: "hunter22" },
      drive: "/dev/sdb",
      driveScanReady: true,
    });
    onDriveStep("sbc");

    const encoded = encodeResumeState(wizardState.getState())!;
    expect(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))).not.to.contain(
      "hunter22"
    );
    expect(decodeResumeState(encoded)?.selections).to.deep.equal({
      device: rpi5.id,
      deviceConfig: rpi5.haos,
    });
  });

  it("only resumes on the drive step", () => {
    expect(encodeResumeState(wizardState.getState())).to.equal(null);
    wizardState.startFlow("sbc");
    expect(encodeResumeState(wizardState.getState())).to.equal(null);

    const confirm = toBase64Url(
      JSON.stringify({ v: 1, flow: "sbc", step: "confirm", selections: {} })
    );
    expect(decodeResumeState(confirm)).to.equal(null);
  });

  it("refuses a step the flow doesn't have", () => {
    // Proxmox has no drive step
    const text = toBase64Url(
      JSON.stringify({ v: 1, flow: "proxmox", step: "drive", selections: {} })
    );
    expect(decodeResumeState(text)).to.equal(null);
  });

  it("starts as usual on anything it doesn't recognise", () => {
    const valid = { v: 1, flow: "sbc", step: "drive", selections: {} };
    for (const text of [
      "",
      "not base64!",
      toBase64Url("not json"),
      toBase64Url("null"),
      toBase64Url(JSON.stringify({ ...valid, v: 2 })),
      toBase64Url(JSON.stringify({ ...valid, flow: "other" })),
      toBase64Url(JSON.stringify({ ...valid, selections: null })),
      "a".repeat(8193),
    ]) {
      expect(decodeResumeState(text), text).to.equal(null);
    }
    expect(decodeResumeState(toBase64Url(JSON.stringify(valid)))).to.deep.equal(
      { flow: "sbc", step: "drive", selections: {} }
    );
  });

  it("drops selections that don't look like the installer's own", () => {
    const text = toBase64Url(
      JSON.stringify({
        v: 1,
        flow: "sbc",
        step: "drive",
        selections: {
          device: 5,
          deviceImage: "https://example.com/tracker.png",
          deviceConfig: {
            board: "../../etc",
            minimum_storage_bytes: 1,
            recommended_storage_bytes: 1,
          },
          installMethod: "network",
          drive: "/dev/sda",
        },
      })
    );
    expect(decodeResumeState(text)?.selections).to.deep.equal({});
  });
});
