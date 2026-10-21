// Picks the version of the next release from the existing version tags.
//
// Until the first stable release, versions are prereleases of 0.0.0:
// 0.0.0-alpha.1, 0.0.0-alpha.2, ..., 0.0.0-beta.1, ... From the first stable
// release on, versions are calendar versions, YEAR.MONTH.PATCH (2026.11.0,
// 2026.11.1, 2026.12.0, ...), and an alpha or beta is a prerelease of the
// next one (2026.12.0-beta.1).
//
// Usage: node scripts/next-version.mjs <alpha|beta|stable> < tags
// Reads one tag per line on stdin and prints `version=`, `prerelease=` and
// `previous=` lines for $GITHUB_OUTPUT. `previous` is the tag the release
// notes start from, empty to let GitHub pick.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const CHANNELS = ["alpha", "beta", "stable"];
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/;

export function parse(tag) {
  const match = VERSION.exec(tag);
  if (!match) return null;
  const [, major, minor, patch, channel, number] = match;
  return {
    tag,
    core: [Number(major), Number(minor), Number(patch)],
    channel: channel ?? "stable",
    number: number === undefined ? 0 : Number(number),
  };
}

// Semver precedence for the versions `parse` accepts: a prerelease sorts
// before its stable version, alpha before beta.
export function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.channel !== b.channel) {
    return CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel);
  }
  return a.number - b.number;
}

function sameCore(a, b) {
  return a.every((part, i) => part === b[i]);
}

// The next stable version for `now`: the first of the month is PATCH 0,
// each further release in the same month counts PATCH up.
function nextStableCore(now, lastStable) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (!lastStable) return [year, month, 0];
  const [lastYear, lastMonth, lastPatch] = lastStable.core;
  if (lastYear === year && lastMonth === month) {
    return [year, month, lastPatch + 1];
  }
  if (lastYear > year || (lastYear === year && lastMonth > month)) {
    throw new Error(
      `The latest release ${lastStable.tag} is newer than ${year}.${month}`
    );
  }
  return [year, month, 0];
}

export function nextVersion(channel, tags, now = new Date()) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(
      `Unknown channel ${channel}, expected one of ${CHANNELS.join(", ")}`
    );
  }
  const versions = tags.map(parse).filter(Boolean).sort(compare);
  const stables = versions.filter((v) => v.channel === "stable");
  const lastStable = stables.at(-1);
  const latest = versions.at(-1);

  if (channel === "stable") {
    const core = nextStableCore(now, lastStable);
    return {
      version: core.join("."),
      prerelease: false,
      // A stable release lists everything since the previous stable one,
      // including what its alphas and betas already had.
      previous: lastStable?.tag ?? "",
    };
  }

  const core = lastStable ? nextStableCore(now, lastStable) : [0, 0, 0];
  const siblings = versions.filter((v) => sameCore(v.core, core));
  if (channel === "alpha" && siblings.some((v) => v.channel === "beta")) {
    throw new Error(
      `${core.join(".")} already has a beta, so an alpha would sort before it`
    );
  }
  const numbers = siblings
    .filter((v) => v.channel === channel)
    .map((v) => v.number);
  const number = Math.max(0, ...numbers) + 1;
  return {
    version: `${core.join(".")}-${channel}.${number}`,
    prerelease: true,
    previous: latest?.tag ?? "",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const channel = process.argv[2];
  const tags = fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  try {
    const { version, prerelease, previous } = nextVersion(channel, tags);
    console.log(`version=${version}`);
    console.log(`prerelease=${prerelease}`);
    console.log(`previous=${previous}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
