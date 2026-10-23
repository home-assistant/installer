import { expect, waitUntil } from "@open-wc/testing";
import { setLanguage } from "../../../src/localization/localize.js";
import { BUG_REPORT_URL } from "../../../src/utils/diagnostics.js";
import { showStartupFailure } from "../../../src/utils/startup-failure.js";
import { mockTauriIpc, restoreTauriIpc } from "../tauri-ipc.js";

describe("utils/startup-failure", () => {
  let body: Node[];
  let consoleError: typeof console.error;
  let printed: unknown[];

  beforeEach(() => {
    body = [...document.body.childNodes];
    consoleError = console.error;
    printed = [];
    console.error = (error: unknown) => printed.push(error);
  });

  afterEach(() => {
    document.body.replaceChildren(...body);
    console.error = consoleError;
    setLanguage("en");
    restoreTauriIpc();
  });

  it("replaces the blank window with a way to report the problem", async () => {
    const logged: unknown[] = [];
    const opened: string[] = [];
    mockTauriIpc(
      (cmd, args) => {
        if (cmd === "log_frontend_event") logged.push(args);
        else if (cmd === "plugin:opener|open_url")
          opened.push((args as { url: string }).url);
        else throw new Error(`Unexpected IPC command: ${cmd}`);
      },
      { includeLogs: true }
    );
    document.body.replaceChildren(document.createElement("app-shell"));
    const error = new TypeError("Importing a module script failed.");

    showStartupFailure(error);

    expect(document.querySelector("app-shell")).to.equal(null);
    expect(document.querySelector("main h1")?.textContent).to.equal(
      "The installer couldn't start"
    );
    const link = document.querySelector<HTMLAnchorElement>("main a")!;
    expect(link.href).to.equal(BUG_REPORT_URL);
    link.click();
    expect(opened).to.deep.equal([BUG_REPORT_URL]);

    // A category reaches the log, the error itself only the console
    await waitUntil(() => logged.length > 0);
    expect(logged).to.deep.equal([
      {
        flow: "application",
        stage: "frontend",
        outcome: "failed",
        error: "operation_failed",
        elapsedMs: 0,
      },
    ]);
    expect(printed).to.deep.equal([error]);
  });

  it("is in the user's language once it loaded", () => {
    setLanguage("nl", {
      "utils.startup_failure.title": "De installer kon niet starten",
    });

    showStartupFailure(new Error("app-shell failed"));

    expect(document.querySelector("main h1")?.textContent).to.equal(
      "De installer kon niet starten"
    );
    // A message the catalog lacks stays English
    expect(document.querySelector("main a")?.textContent).to.equal(
      "Report a problem on GitHub"
    );
  });
});
