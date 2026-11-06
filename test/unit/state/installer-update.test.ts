import { expect, waitUntil } from "@open-wc/testing";
import { installerUpdate } from "../../../src/state/installer-update.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

const UPDATE = {
  version: "2026.12.0",
  release_url:
    "https://github.com/home-assistant/installer/releases/tag/2026.12.0",
  installable: true,
};

/** Each update command waits until the test lets it answer. */
function deferUpdate() {
  const calls: string[] = [];
  const answers = new Map<string, () => void>();
  mockTauriIpc((cmd) => {
    calls.push(cmd);
    if (cmd === "check_for_update") return UPDATE;
    return new Promise<void>((resolve) => answers.set(cmd, resolve));
  });
  /** Let `cmd` answer, once it was called. */
  const answer = async (cmd: string) => {
    await waitUntil(() => answers.has(cmd), `${cmd} was never called`);
    answers.get(cmd)!();
  };
  return { calls, answer };
}

describe("installerUpdate", () => {
  beforeEach(() => installerUpdate.reset());

  afterEach(() => {
    installerUpdate.setVisible(false);
    installerUpdate.reset();
    restoreTauriIpc();
  });

  it("does nothing without an update to install or restart into", async () => {
    const { calls } = deferUpdate();

    await installerUpdate.update();
    await installerUpdate.restart();
    installerUpdate.dismiss();
    expect(installerUpdate.state.status).to.equal("none");
    expect(calls).to.deep.equal([]);
  });

  it("can't be put off while it downloads", async () => {
    const { answer } = deferUpdate();
    await installerUpdate.check();

    const updating = installerUpdate.update();
    installerUpdate.dismiss();
    expect(installerUpdate.state.status).to.equal("downloading");
    // Downloaded while the welcome screen is gone: the restart waits
    await answer("download_update");
    await updating;
    expect(installerUpdate.state.status).to.equal("ready");
  });

  for (const step of [
    "download_update",
    "install_update",
    "restart_after_update",
  ]) {
    it(`leaves the state alone when reset during ${step}`, async () => {
      const { calls, answer } = deferUpdate();
      installerUpdate.setVisible(true);
      await installerUpdate.check();

      const updating = installerUpdate.update();
      if (step !== "download_update") await answer("download_update");
      if (step === "restart_after_update") await answer("install_update");
      await waitUntil(() => calls.includes(step));
      installerUpdate.reset();
      await answer(step);
      await updating;

      expect(installerUpdate.state.status).to.equal("none");
      expect(installerUpdate.applying).to.be.false;
      // Nothing after the reset went on with the update
      expect(calls[calls.length - 1]).to.equal(step);
    });
  }
});
