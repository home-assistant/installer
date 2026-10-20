import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("catalog check is nonwriting and rejects mismatched placeholders", () => {
  const checker = fileURLToPath(
    new URL("./check-localization.mjs", import.meta.url)
  );
  const catalogPath = fileURLToPath(
    new URL("../src/localization/en.json", import.meta.url)
  );
  const original = fs.readFileSync(catalogPath, "utf8");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hai-localization-"));
  try {
    assert.match(
      execFileSync(process.execPath, [checker], { encoding: "utf8" }),
      /Checked \d+ catalog messages/
    );
    const catalog = JSON.parse(original);
    catalog["utm.update_timeout"] = catalog["utm.update_timeout"].replace(
      "{address}",
      "{wrong_address}"
    );
    const fixture = path.join(directory, "en.json");
    const mutated = JSON.stringify(catalog);
    fs.writeFileSync(fixture, mutated);
    const result = spawnSync(process.execPath, [checker, fixture], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /utm\.update_timeout placeholder mismatch/);
    assert.equal(fs.readFileSync(fixture, "utf8"), mutated);
    assert.equal(fs.readFileSync(catalogPath, "utf8"), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog check ties backend messages to the Rust code", () => {
  const checker = fileURLToPath(
    new URL("./check-localization.mjs", import.meta.url)
  );
  const catalogPath = fileURLToPath(
    new URL("../src/localization/en.json", import.meta.url)
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hai-localization-"));
  const check = (catalog) => {
    const fixture = path.join(directory, "en.json");
    fs.writeFileSync(fixture, JSON.stringify(catalog));
    return spawnSync(process.execPath, [checker, fixture], {
      encoding: "utf8",
    });
  };
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

    // Rust names a message the catalog doesn't have
    const missing = { ...catalog };
    delete missing["backend.proxmox.node_offline"];
    const missingResult = check(missing);
    assert.equal(missingResult.status, 1);
    assert.match(
      missingResult.stderr,
      /unknown key backend\.proxmox\.node_offline/
    );

    // Rust sends a parameter the catalog doesn't use
    const renamed = {
      ...catalog,
      "backend.proxmox.node_offline": catalog[
        "backend.proxmox.node_offline"
      ].replace("{node}", "{name}"),
    };
    const renamedResult = check(renamed);
    assert.equal(renamedResult.status, 1);
    assert.match(
      renamedResult.stderr,
      /backend\.proxmox\.node_offline placeholder mismatch/
    );

    // A backend message no Rust code sends
    const unused = check({ ...catalog, "backend.proxmox.never_sent": "Hi" });
    assert.equal(unused.status, 1);
    assert.match(unused.stderr, /backend\.proxmox\.never_sent/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
