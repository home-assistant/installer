import { getPlatform } from "../../utils/platform.js";

/** The ISO path as shown before saving; the backend reports the real one afterwards. */
export function isoTargetPath(folder: string, name: string): string {
  if (!folder) return name;
  const windows = getPlatform() === "windows";
  const separator = windows ? "\\" : "/";
  // A root such as `/` or `C:\` trims to "" or "C:", so adding one separator back is right.
  // On Unix a trailing backslash is part of the folder name.
  const trimmed = folder.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  return `${trimmed}${separator}${name}`;
}
