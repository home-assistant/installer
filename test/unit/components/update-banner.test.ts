import { expect, fixture, html, waitUntil } from "@open-wc/testing";
import type { Channel } from "@tauri-apps/api/core";
import type { UpdateProgress } from "../../../src/api/commands.js";
import "../../../src/components/update-banner.js";
import type { UpdateBanner } from "../../../src/components/update-banner.js";
import {
  installerUpdate,
  RESTART_TIMEOUT_MS,
} from "../../../src/state/installer-update.js";
import { ipcError, mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

const UPDATE = {
  version: "2026.12.0",
  release_url:
    "https://github.com/home-assistant/installer/releases/tag/2026.12.0",
  installable: true,
};

/** Mount a banner, and wait until its check settled. */
async function banner(): Promise<UpdateBanner> {
  const el = await fixture<UpdateBanner>(html`<update-banner></update-banner>`);
  await installerUpdate.check();
  await el.updateComplete;
  return el;
}

function message(el: UpdateBanner): string {
  return (
    el.shadowRoot!.querySelector("[role=status]")?.textContent?.trim() ?? ""
  );
}

function button(el: UpdateBanner, name: string): HTMLElement | null {
  return el.shadowRoot!.querySelector<HTMLElement>(`wa-button.${name}`);
}

/** Record the update commands; each answers as `answers` says. */
function mockUpdate(
  answers: Partial<Record<string, (args: unknown) => unknown>> = {}
): string[] {
  const calls: string[] = [];
  mockTauriIpc((cmd, args) => {
    calls.push(cmd);
    if (cmd in answers) return answers[cmd]!(args);
    if (cmd === "check_for_update") return UPDATE;
    if (
      cmd === "download_update" ||
      cmd === "install_update" ||
      cmd === "restart_after_update"
    )
      return undefined;
    throw new Error(`Unexpected IPC command: ${cmd}`);
  });
  return calls;
}

describe("update-banner", () => {
  afterEach(() => {
    installerUpdate.reset();
    restoreTauriIpc();
  });

  it("stays hidden without an update", async () => {
    mockUpdate({ check_for_update: () => null });
    const el = await banner();

    expect(el.hidden).to.be.true;
    expect(el.shadowRoot!.querySelector(".banner")).to.equal(null);
  });

  it("stays hidden when the check fails", async () => {
    mockUpdate({
      check_for_update: () => {
        throw ipcError("network", "offline", true);
      },
    });
    const el = await banner();

    expect(el.hidden).to.be.true;
  });

  it("downloads, installs and restarts, on the same busy button", async () => {
    let channel!: Channel<UpdateProgress>;
    let finishDownload!: () => void;
    const calls = mockUpdate({
      download_update: (args) => {
        channel = (args as { progress: Channel<UpdateProgress> }).progress;
        return new Promise<void>((resolve) => (finishDownload = resolve));
      },
    });
    const el = await banner();

    expect(el.hidden).to.be.false;
    expect(message(el)).to.contain("2026.12.0");
    const notes = el.shadowRoot!.querySelector<HTMLAnchorElement>("a.notes")!;
    expect(notes.textContent).to.equal("What's new");
    expect(notes.getAttribute("href")).to.equal(UPDATE.release_url);
    const install = button(el, "install")!;
    expect(install.textContent).to.contain("Update and restart");

    install.click();
    await waitUntil(() => channel);
    channel.onmessage({ downloaded: 0, total: null });
    await el.updateComplete;
    expect(message(el)).to.equal("Downloading the update...");
    expect(el.shadowRoot!.querySelector(".percent")).to.equal(null);
    channel.onmessage({ downloaded: 42, total: 100 });
    await el.updateComplete;
    // Shown, but outside the status, so screen readers don't read out each percent
    expect(message(el)).to.equal("Downloading the update...");
    expect(el.shadowRoot!.querySelector(".percent")!.textContent).to.equal(
      "42%"
    );
    // The same button, busy, so the focus stays on it; nothing else to do
    expect(button(el, "install")).to.equal(install);
    expect(install.hasAttribute("loading")).to.be.true;
    expect(button(el, "dismiss")).to.equal(null);

    finishDownload();
    await waitUntil(() => message(el).includes("restarts"));
    expect(install.hasAttribute("loading")).to.be.true;
    expect(calls.slice(1)).to.deep.equal([
      "download_update",
      "install_update",
      "restart_after_update",
    ]);
  });

  it("says when it installs, which may wait for a password", async () => {
    let finishInstall!: () => void;
    mockUpdate({
      install_update: () =>
        new Promise<void>((resolve) => (finishInstall = resolve)),
    });
    const el = await banner();

    button(el, "install")!.click();
    await waitUntil(() => finishInstall);
    await el.updateComplete;
    expect(message(el)).to.equal("Installing the update...");
    finishInstall();
    await waitUntil(() => message(el).includes("restarts"));
  });

  it("offers the restart again when the app is still there after a while", async () => {
    mockUpdate();
    const el = await banner();
    // Holds back only the restart's timeout; waitUntil needs the others
    const restartTimers: (() => void)[] = [];
    const setTimeout = window.setTimeout;
    window.setTimeout = ((
      handler: () => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout !== RESTART_TIMEOUT_MS)
        return setTimeout(handler, timeout, ...args);
      restartTimers.push(handler);
      return 0;
    }) as typeof window.setTimeout;
    try {
      button(el, "install")!.click();
      await waitUntil(() => message(el).includes("restarts"));
    } finally {
      window.setTimeout = setTimeout;
    }

    expect(restartTimers).to.have.length(1);
    restartTimers[0]();
    await el.updateComplete;
    expect(message(el)).to.equal(
      "The update is ready. Restart the installer to start using it."
    );
    expect(button(el, "install")!.textContent).to.contain("Restart now");
    expect(button(el, "dismiss")).to.exist;
  });

  it("restarts only once the user is back on the welcome screen", async () => {
    let finishDownload!: () => void;
    const calls = mockUpdate({
      download_update: () =>
        new Promise<void>((resolve) => (finishDownload = resolve)),
    });
    const el = await banner();

    button(el, "install")!.click();
    await waitUntil(() => finishDownload);
    // Off into a flow while the update downloads
    el.remove();
    finishDownload();
    await waitUntil(() => installerUpdate.state.status === "ready");
    expect(calls).not.to.include("install_update");
    expect(calls).not.to.include("restart_after_update");

    const back = await banner();
    expect(message(back)).to.equal(
      "The update is ready. Restart the installer to start using it."
    );
    button(back, "install")!.click();
    await waitUntil(() => message(back).includes("restarts"));
    expect(calls.slice(-2)).to.deep.equal([
      "install_update",
      "restart_after_update",
    ]);
  });

  it("waits for an installation that runs, until the user is back", async () => {
    let installing = true;
    mockUpdate({
      restart_after_update: () => {
        // It started while the install waited for a password
        if (installing)
          throw ipcError("operation_in_progress", "Finish it first", true);
      },
    });
    const el = await banner();

    button(el, "install")!.click();
    await waitUntil(() => message(el).includes("Finish the installation"));
    expect(message(el)).to.equal(
      "The update is ready. Finish the installation, then restart the installer to start using it."
    );
    expect(button(el, "install")!.textContent).to.contain("Restart now");

    // The flow ends on the welcome screen, which no installation outlasts
    installing = false;
    el.remove();
    const back = await banner();
    expect(message(back)).to.equal(
      "The update is ready. Restart the installer to start using it."
    );
    button(back, "install")!.click();
    await waitUntil(() => message(back).includes("restarts"));
  });

  it("offers the download page and a retry when updating fails", async () => {
    const opened: string[] = [];
    let downloads = 0;
    mockUpdate({
      download_update: () => {
        downloads++;
        throw ipcError(
          "update_failed",
          "The update could not be installed.",
          true
        );
      },
      "plugin:opener|open_url": (args) => {
        opened.push((args as { url: string }).url);
      },
    });
    const el = await banner();

    button(el, "install")!.click();
    await waitUntil(() => button(el, "download"));
    expect(message(el)).to.contain("could not be installed");
    expect(button(el, "install")!.textContent).to.contain("Try again");

    button(el, "download")!.click();
    await waitUntil(() => opened.length);
    expect(opened).to.deep.equal([UPDATE.release_url]);

    button(el, "install")!.click();
    await waitUntil(() => downloads === 2);
  });

  it("only offers the download where the app can't replace itself", async () => {
    mockUpdate({
      check_for_update: () => ({ ...UPDATE, installable: false }),
    });
    const el = await banner();

    expect(message(el)).to.contain("first move the installer");
    expect(button(el, "install")).to.equal(null);
    expect(button(el, "download")).to.exist;
  });

  it("checks once per run, and Not now holds for the rest of it", async () => {
    const calls = mockUpdate();
    const el = await banner();

    button(el, "dismiss")!.click();
    await el.updateComplete;
    expect(el.hidden).to.be.true;

    // The welcome screen, and so the banner, comes back after every flow
    el.remove();
    const again = await banner();
    expect(again.hidden).to.be.true;
    expect(calls.filter((cmd) => cmd === "check_for_update")).to.have.length(1);
  });
});
