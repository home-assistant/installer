import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { updaterManifest } from "./updater-manifest.mjs";

const VERSION = "2026.11.0-beta.1";
const NOW = new Date("2026-11-20T12:00:00Z");
const DOWNLOADS = `https://github.com/home-assistant/installer/releases/download/${encodeURIComponent(VERSION)}`;

// What the build jobs upload, with GitHub's dots for the spaces
function releaseFiles() {
  const files = {};
  for (const name of [
    "Home.Assistant.Installer.app.tar.gz",
    `Home.Assistant.Installer_${VERSION}_x64-setup.exe`,
    `Home.Assistant.Installer_${VERSION}_amd64.deb`,
    `Home.Assistant.Installer-${VERSION}-1.x86_64.rpm`,
    `Home.Assistant.Installer_${VERSION}_amd64.AppImage`,
  ]) {
    files[name] = "";
    files[`${name}.sig`] = `signature of ${name}\n`;
  }
  // Not an update itself
  files[`Home.Assistant.Installer_${VERSION}_universal.dmg`] = "";
  return files;
}

test("lists the signed update of every platform", () => {
  const manifest = updaterManifest(
    "home-assistant/installer",
    VERSION,
    releaseFiles(),
    NOW
  );
  const app = {
    signature: "signature of Home.Assistant.Installer.app.tar.gz",
    url: `${DOWNLOADS}/Home.Assistant.Installer.app.tar.gz`,
  };
  assert.deepEqual(manifest, {
    version: VERSION,
    pub_date: "2026-11-20T12:00:00.000Z",
    platforms: {
      "darwin-aarch64-app": app,
      "darwin-x86_64-app": app,
      "windows-x86_64-nsis": {
        signature: `signature of Home.Assistant.Installer_${VERSION}_x64-setup.exe`,
        url: `${DOWNLOADS}/Home.Assistant.Installer_${VERSION}_x64-setup.exe`,
      },
      "linux-x86_64-deb": {
        signature: `signature of Home.Assistant.Installer_${VERSION}_amd64.deb`,
        url: `${DOWNLOADS}/Home.Assistant.Installer_${VERSION}_amd64.deb`,
      },
      "linux-x86_64-rpm": {
        signature: `signature of Home.Assistant.Installer-${VERSION}-1.x86_64.rpm`,
        url: `${DOWNLOADS}/Home.Assistant.Installer-${VERSION}-1.x86_64.rpm`,
      },
      "linux-x86_64-appimage": {
        signature: `signature of Home.Assistant.Installer_${VERSION}_amd64.AppImage`,
        url: `${DOWNLOADS}/Home.Assistant.Installer_${VERSION}_amd64.AppImage`,
      },
    },
  });
});

test("refuses a platform without exactly one update", () => {
  const files = releaseFiles();
  delete files[`Home.Assistant.Installer_${VERSION}_amd64.deb`];
  assert.throws(
    () => updaterManifest("home-assistant/installer", VERSION, files),
    /exactly one update for linux-x86_64-deb, found 0/
  );

  const twice = releaseFiles();
  twice["Old.app.tar.gz"] = "";
  assert.throws(
    () => updaterManifest("home-assistant/installer", VERSION, twice),
    /exactly one update for darwin-aarch64-app, darwin-x86_64-app, found 2/
  );
});

test("refuses an update without a signature", () => {
  const files = releaseFiles();
  delete files[`Home.Assistant.Installer_${VERSION}_x64-setup.exe.sig`];
  assert.throws(
    () => updaterManifest("home-assistant/installer", VERSION, files),
    /x64-setup\.exe has no signature/
  );
});

test("refuses names GitHub would change on upload", () => {
  const files = releaseFiles();
  delete files["Home.Assistant.Installer.app.tar.gz"];
  files["Home Assistant Installer.app.tar.gz"] = "";
  files["Home Assistant Installer.app.tar.gz.sig"] = "signature";
  assert.throws(
    () => updaterManifest("home-assistant/installer", VERSION, files),
    /has a space in its name/
  );
});

test("prints the manifest of the files in a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-manifest-"));
  try {
    for (const [name, content] of Object.entries(releaseFiles())) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    const script = fileURLToPath(
      new URL("./updater-manifest.mjs", import.meta.url)
    );
    const result = spawnSync(
      process.execPath,
      [script, "home-assistant/installer", VERSION, dir],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.version, VERSION);
    assert.equal(
      manifest.platforms["linux-x86_64-rpm"].signature,
      `signature of Home.Assistant.Installer-${VERSION}-1.x86_64.rpm`
    );

    fs.rmSync(path.join(dir, "Home.Assistant.Installer.app.tar.gz.sig"));
    const failed = spawnSync(
      process.execPath,
      [script, "home-assistant/installer", VERSION, dir],
      { encoding: "utf8" }
    );
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /::error::.*has no signature/);

    const missing = spawnSync(
      process.execPath,
      [script, "home-assistant/installer", VERSION, path.join(dir, "missing")],
      { encoding: "utf8" }
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /::error::.*no such file or directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
