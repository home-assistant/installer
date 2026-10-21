import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { nextVersion } from "./next-version.mjs";

const NOVEMBER = new Date("2026-11-20T12:00:00Z");

function next(channel, tags, now = NOVEMBER) {
  return nextVersion(channel, tags, now);
}

test("the first alpha and beta are prereleases of 0.0.0", () => {
  assert.deepEqual(next("alpha", []), {
    version: "0.0.0-alpha.1",
    prerelease: true,
    previous: "",
  });
  assert.deepEqual(next("beta", ["0.0.0-alpha.2"]), {
    version: "0.0.0-beta.1",
    prerelease: true,
    previous: "0.0.0-alpha.2",
  });
});

test("prerelease numbers count up numerically, not as text", () => {
  const tags = Array.from({ length: 10 }, (_, i) => `0.0.0-alpha.${i + 1}`);
  assert.equal(next("alpha", tags).version, "0.0.0-alpha.11");
  assert.equal(next("alpha", tags).previous, "0.0.0-alpha.10");
  assert.equal(
    next("beta", ["0.0.0-beta.9", "0.0.0-beta.10"]).version,
    "0.0.0-beta.11"
  );
});

test("an alpha after a beta of the same version is refused", () => {
  assert.throws(
    () => next("alpha", ["0.0.0-alpha.3", "0.0.0-beta.1"]),
    /0\.0\.0 already has a beta/
  );
});

test("the first stable release is the calendar version of this month", () => {
  assert.deepEqual(next("stable", ["0.0.0-alpha.4", "0.0.0-beta.2"]), {
    version: "2026.11.0",
    prerelease: false,
    previous: "",
  });
});

test("stable releases count the patch up within a month", () => {
  assert.equal(next("stable", ["2026.11.0"]).version, "2026.11.1");
  assert.equal(next("stable", ["2026.11.0", "2026.11.1"]).version, "2026.11.2");
  assert.equal(next("stable", ["2026.11.1"]).previous, "2026.11.1");
});

test("a new month starts at patch 0, without zero padding", () => {
  assert.equal(
    next("stable", ["2026.11.3"], new Date("2026-12-01T00:00:00Z")).version,
    "2026.12.0"
  );
  assert.equal(
    next("stable", ["2026.12.0"], new Date("2027-01-15T00:00:00Z")).version,
    "2027.1.0"
  );
});

test("after a stable release, prereleases lead up to the next one", () => {
  const december = new Date("2026-12-03T00:00:00Z");
  assert.deepEqual(next("beta", ["0.0.0-beta.2", "2026.11.0"], december), {
    version: "2026.12.0-beta.1",
    prerelease: true,
    previous: "2026.11.0",
  });
  assert.deepEqual(next("beta", ["2026.11.0", "2026.12.0-beta.1"], december), {
    version: "2026.12.0-beta.2",
    prerelease: true,
    previous: "2026.12.0-beta.1",
  });
  assert.equal(next("beta", ["2026.11.0"]).version, "2026.11.1-beta.1");
});

test("a stable release lists the changes since the previous stable one", () => {
  const tags = ["2026.11.0", "2026.12.0-beta.1", "2026.12.0-beta.2"];
  assert.deepEqual(next("stable", tags, new Date("2026-12-10T00:00:00Z")), {
    version: "2026.12.0",
    prerelease: false,
    previous: "2026.11.0",
  });
});

test("tags that aren't versions are ignored", () => {
  assert.equal(
    next("alpha", ["v1.0.0", "latest", "1.0.0-rc.1", "0.0.0-alpha1"]).version,
    "0.0.0-alpha.1"
  );
});

test("a latest release from a later month than the clock is refused", () => {
  assert.throws(() => next("stable", ["2026.12.0"]), /newer than 2026\.11/);
});

test("the command reads tags from stdin and prints GitHub outputs", () => {
  const script = fileURLToPath(new URL("./next-version.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "beta"], {
    input: "0.0.0-alpha.1\r\n0.0.0-beta.1\r\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "version=0.0.0-beta.2\nprerelease=true\nprevious=0.0.0-beta.1\n"
  );

  const refused = spawnSync(process.execPath, [script, "nightly"], {
    input: "",
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /::error::Unknown channel nightly/);
});
