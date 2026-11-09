// Writes the latest.json of a release, which the installer's updater reads
// to update to it: for each platform, the release asset to install and its
// signature. Tauri's bundler signs the assets in the build jobs.
//
// Usage: node scripts/updater-manifest.mjs <repository> <version> <dir>
// Reads the installers and their .sig files from <dir>, named as they are
// uploaded to the release, and prints latest.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The updater looks for `{os}-{arch}-{bundle type}`. The macOS update is the
// universal app, for both architectures.
const PLATFORMS = [
  [["darwin-aarch64-app", "darwin-x86_64-app"], /\.app\.tar\.gz$/],
  [["windows-x86_64-nsis"], /_x64-setup\.exe$/],
  [["linux-x86_64-deb"], /_amd64\.deb$/],
  [["linux-x86_64-rpm"], /\.x86_64\.rpm$/],
  [["linux-x86_64-appimage"], /_amd64\.AppImage$/],
];

export function updaterManifest(repository, version, files, now = new Date()) {
  const names = Object.keys(files);
  const platforms = {};
  for (const [keys, pattern] of PLATFORMS) {
    const matches = names.filter((name) => pattern.test(name));
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one update for ${keys.join(", ")}, found ${matches.length}: ${matches.join(", ")}`
      );
    }
    const [name] = matches;
    // GitHub renames assets with spaces, which would break the URL
    if (/\s/.test(name)) {
      throw new Error(`${name} has a space in its name`);
    }
    const signature = files[`${name}.sig`];
    if (!signature) {
      throw new Error(`${name} has no signature`);
    }
    const update = {
      signature: signature.trim(),
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(name)}`,
    };
    for (const key of keys) platforms[key] = update;
  }
  return { version, pub_date: now.toISOString(), platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repository, version, dir] = process.argv.slice(2);
  try {
    // Only the signatures are read: the updater needs their text
    const files = Object.fromEntries(
      fs
        .readdirSync(dir)
        .map((name) => [
          name,
          name.endsWith(".sig")
            ? fs.readFileSync(path.join(dir, name), "utf8")
            : "",
        ])
    );
    console.log(
      JSON.stringify(updaterManifest(repository, version, files), null, 2)
    );
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
