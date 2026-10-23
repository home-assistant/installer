import { expect, fixtureSync, html } from "@open-wc/testing";
import {
  MOCK_BLOCK_DEVICES,
  MOCK_HAOS_RELEASE,
  MOCK_MANIFEST,
} from "../../src/api/mock-data.js";
import messages from "../../src/localization/en.json";
import {
  formatList,
  formatListParts,
  setLanguage,
  type MessageKey,
} from "../../src/localization/localize.js";
import { wizardState } from "../../src/state/wizard-state.js";
import { storeDriveSelection } from "../../src/utils/drive-selection.js";
import {
  HaSetupStalledError,
  haSetupProblemMessage,
} from "../../src/utils/ha-setup.js";
import "../../src/views/live-usb/live-usb-summary-view.js";
import "../../src/views/proxmox/proxmox-success-view.js";
import { enabledImportStorageList } from "../../src/views/proxmox/proxmox-success-view.js";
import "../../src/views/sbc/confirmation-view.js";
import { mockTauriIpc, restoreTauriIpc, settle } from "./tauri-ipc.js";

// Text made of several parts is one message, so a translation can reorder it
// or use its own separators, and lists follow the language's own rules
describe("composed text", () => {
  const original = { ...messages };

  afterEach(() => {
    Object.assign(messages, original);
    setLanguage("en");
    wizardState.reset();
    restoreTauriIpc();
  });

  function replace(key: MessageKey, text: string) {
    messages[key] = text;
    setLanguage("en");
  }

  describe("lists", () => {
    it("separates items the way the language does", () => {
      expect(formatList([])).to.equal("");
      expect(formatList(["a"])).to.equal("a");
      expect(formatList(["a", "b"])).to.equal("a and b");
      expect(formatList(["a", "b", "c"])).to.equal("a, b, and c");
      setLanguage("en-GB");
      expect(formatList(["a", "b", "c"])).to.equal("a, b and c");
      setLanguage("de");
      expect(formatList(["a", "b", "c"])).to.equal("a, b und c");
    });

    it("tells the items from what goes between them", () => {
      expect(formatListParts(["a", "b", "c"])).to.deep.equal([
        { type: "element", value: "a" },
        { type: "literal", value: ", " },
        { type: "element", value: "b" },
        { type: "literal", value: ", and " },
        { type: "element", value: "c" },
      ]);
    });
  });

  describe("a stalled Home Assistant install", () => {
    it("says what Supervisor reports, then what the user can do", () => {
      expect(
        new HaSetupStalledError("no_internet", "http://192.0.2.50").message
      ).to.equal(
        `${haSetupProblemMessage("no_internet")} The installation made no progress for 10 minutes. Open http://192.0.2.50 to see what Home Assistant reports, or try again to keep waiting.`
      );
    });

    it("lets a translation put the problem anywhere", () => {
      replace("utils.ha_setup.stalled", "{address} / {problem}");
      expect(
        new HaSetupStalledError("free_space", "http://192.0.2.50").message
      ).to.equal(`http://192.0.2.50 / ${haSetupProblemMessage("free_space")}`);
    });
  });

  describe("the drive's size and model", () => {
    async function detail() {
      wizardState.startFlow("sbc");
      storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
      wizardState.setSelections({
        deviceConfig: MOCK_MANIFEST.devices[0].haos,
        driveSize: 32 * 1000 * 1000 * 1000,
        driveVendor: "SanDisk",
        driveModel: "Ultra",
      });
      mockTauriIpc(() => MOCK_HAOS_RELEASE);
      const view = fixtureSync(html`<confirmation-view></confirmation-view>`);
      await settle();
      // The drive is the second summary row, after the device
      return view
        .shadowRoot!.querySelectorAll(".summary-row")[1]
        .querySelector(".summary-detail")!;
    }

    it("puts a dot between them, the model read on its own", async () => {
      const line = await detail();
      expect(line.textContent!.trim()).to.equal("32 GB · SanDisk Ultra");
      expect(line.querySelector("bdi")!.textContent).to.equal("SanDisk Ultra");
    });

    it("lets a translation reorder them", async () => {
      replace(
        "views.sbc.confirmation_view.drive_size_and_model",
        "{model}, {size}"
      );
      const line = await detail();
      expect(line.textContent!.trim()).to.equal("SanDisk Ultra, 32 GB");
      expect(line.querySelector("bdi")!.textContent).to.equal("SanDisk Ultra");
    });

    it("shows only the size for a drive without a model", async () => {
      wizardState.startFlow("sbc");
      storeDriveSelection(MOCK_BLOCK_DEVICES[0]);
      wizardState.setSelections({
        deviceConfig: MOCK_MANIFEST.devices[0].haos,
        driveSize: 32 * 1000 * 1000 * 1000,
        driveVendor: undefined,
        driveModel: undefined,
      });
      mockTauriIpc(() => MOCK_HAOS_RELEASE);
      const view = fixtureSync(html`<confirmation-view></confirmation-view>`);
      await settle();
      const line = view
        .shadowRoot!.querySelectorAll(".summary-row")[1]
        .querySelector(".summary-detail")!;
      expect(line.textContent!.trim()).to.equal("32 GB");
    });
  });

  describe("the storages Import was enabled on", () => {
    const session = {
      server_url: "https://pve:8006",
      ticket: "test",
      csrf_token: "test",
    };
    const enable = (...storages: string[]) => {
      wizardState.startFlow("proxmox");
      wizardState.setSelections({
        proxmoxSession: session,
        proxmoxImportChanges: storages.map((storage) => ({
          serverOrigin: "https://pve:8006",
          storage,
        })),
      });
    };

    async function reminder() {
      const view = fixtureSync(
        html`<proxmox-success-view></proxmox-success-view>`
      );
      await settle();
      return view.shadowRoot!.querySelector("inline-notice p")!;
    }

    it("names them in a list, each quoted", () => {
      enable();
      expect(
        enabledImportStorageList(wizardState.getState().selections)
      ).to.equal("");
      for (const [storages, text] of [
        [["local"], '"local"'],
        [["local", "backup"], '"local" and "backup"'],
        [["local", "backup", "ssd"], '"local", "backup", and "ssd"'],
      ] as const) {
        enable(...storages);
        expect(
          enabledImportStorageList(wizardState.getState().selections)
        ).to.equal(text);
      }
    });

    it("follows the language's list and quotes", async () => {
      setLanguage("de", {
        "views.proxmox.proxmox_success_view.quoted_storage": "„{storage}“",
      });
      enable("local", "backup", "ssd");
      expect(
        enabledImportStorageList(wizardState.getState().selections)
      ).to.equal("„local“, „backup“ und „ssd“");

      const text = await reminder();
      expect(text.textContent).to.contain("„local“, „backup“ und „ssd“");
    });

    it("sets each storage in bold, and not the words between", async () => {
      enable("local", "backup");
      const text = await reminder();
      expect(
        [...text.querySelectorAll("strong")].map((strong) => strong.textContent)
      ).to.deep.equal(['"local"', '"backup"']);
      expect(text.textContent).to.contain(
        'enabled Import on "local" and "backup". This is a cluster-wide setting'
      );
    });
  });

  describe("the USB stick", () => {
    async function stick() {
      mockTauriIpc(() => MOCK_HAOS_RELEASE);
      wizardState.startFlow("minipc");
      wizardState.setSelections({
        liveMedia: "usb",
        driveName: "My stick",
        driveSize: 32 * 1000 * 1000 * 1000,
      });
      const view = fixtureSync(
        html`<live-usb-summary-view></live-usb-summary-view>`
      );
      await settle();
      return view.shadowRoot!;
    }

    it("shows its size after its name", async () => {
      const root = await stick();
      expect(root.querySelector("dd:nth-of-type(2)")!.textContent).to.equal(
        "My stick (32 GB)"
      );
      expect(root.querySelector(".notice strong")!.textContent).to.equal(
        "My stick (32 GB)"
      );
    });

    it("lets a translation write the size its own way", async () => {
      replace(
        "views.live_usb.live_usb_summary_view.drive_name_and_size",
        "{name}（{size}）"
      );
      const root = await stick();
      expect(root.querySelector(".notice strong")!.textContent).to.equal(
        "My stick（32 GB）"
      );
    });

    it("shows only the name when the size is unknown", async () => {
      mockTauriIpc(() => MOCK_HAOS_RELEASE);
      wizardState.startFlow("minipc");
      wizardState.setSelections({
        liveMedia: "usb",
        driveName: "My stick",
        driveSize: undefined,
      });
      const view = fixtureSync(
        html`<live-usb-summary-view></live-usb-summary-view>`
      );
      await settle();
      expect(
        view.shadowRoot!.querySelector(".notice strong")!.textContent
      ).to.equal("My stick");
    });
  });
});
