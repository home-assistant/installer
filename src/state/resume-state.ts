import type { HaosConfig } from "../api/types.js";
import { findHaHardware } from "./ha-hardware.js";
import {
  stepsFor,
  type WizardFlow,
  type WizardSelections,
  type WizardState,
} from "./wizard-state.js";

/**
 * Where a flow was, so the installer can open it there again after it
 * restarted itself, as administrator on Windows. It goes through the command
 * line, which other programs can read, so it never holds a secret: only the
 * choices made before the drive step.
 */
export interface ResumeState {
  flow: WizardFlow;
  step: string;
  selections: Partial<WizardSelections>;
}

const VERSION = 1;

/** The command line of the restarted app must keep well under Windows' limit */
const MAX_LENGTH = 8192;

const FLOWS: readonly WizardFlow[] = [
  "sbc",
  "minipc",
  "ha-hardware",
  "proxmox",
  "vm",
];

/** Steps a flow can open on; later ones depend on what only this run knows */
const RESUMABLE_STEPS: readonly string[] = ["drive"];

type Validator = (value: unknown) => boolean;

const isText =
  (max: number): Validator =>
  (value) =>
    typeof value === "string" && value.length <= max;

const isSize: Validator = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isConfig(value: unknown): value is HaosConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.board === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(config.board) &&
    isSize(config.minimum_storage_bytes) &&
    isSize(config.recommended_storage_bytes)
  );
}

const isHaHardware: Validator = (value) => !!findHaHardware(value);

/** The selections that are kept, and what each must look like */
const SELECTIONS: { [K in keyof WizardSelections]?: Validator } = {
  device: isText(100),
  deviceName: isText(200),
  // Shown as an image: only the app's own pictures, as the catalog names them
  deviceImage: (value) =>
    value === "" ||
    (isText(200)(value) &&
      /^\/assets\/[\w-]+(\/[\w-]+)*\.(png|svg)$/.test(value as string)),
  deviceConfig: isConfig,
  haHardware: isHaHardware,
  yellowModules: (value) =>
    Array.isArray(value) &&
    value.length <= 4 &&
    value.every((module: unknown) => {
      if (typeof module !== "object" || module === null) return false;
      const { id, config } = module as Record<string, unknown>;
      return (id === "yellow-cm4" || id === "yellow-cm5") && isConfig(config);
    }),
  installMethod: (value) => value === "direct" || value === "usb-boot",
  liveMedia: (value) => value === "usb" || value === "iso",
};

function pickSelections(
  selections: Record<string, unknown>
): Partial<WizardSelections> {
  const kept: Record<string, unknown> = {};
  for (const [key, valid] of Object.entries(SELECTIONS)) {
    const value = selections[key];
    if (value !== undefined && valid!(value)) kept[key] = value;
  }
  return kept as Partial<WizardSelections>;
}

/** The flow on screen as text for the command line, if it can be resumed. */
export function encodeResumeState(state: WizardState): string | null {
  const flow = state.currentFlow;
  const step = state.steps[state.currentStepIndex]?.id;
  if (!flow || !step || !RESUMABLE_STEPS.includes(step)) return null;

  const json = JSON.stringify({
    v: VERSION,
    flow,
    step,
    selections: pickSelections(
      state.selections as unknown as Record<string, unknown>
    ),
  });
  const encoded = toBase64Url(new TextEncoder().encode(json));
  return encoded.length <= MAX_LENGTH ? encoded : null;
}

/**
 * Read what `encodeResumeState` wrote. Anything else, or a step the flow
 * doesn't have for those selections, is `null`: the app starts as usual.
 */
export function decodeResumeState(text: string): ResumeState | null {
  if (text.length > MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return null;

  let data: unknown;
  try {
    const bytes = fromBase64Url(text);
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;

  const { v, flow, step, selections } = data as Record<string, unknown>;
  if (
    v !== VERSION ||
    !FLOWS.includes(flow as WizardFlow) ||
    typeof step !== "string" ||
    !RESUMABLE_STEPS.includes(step) ||
    typeof selections !== "object" ||
    selections === null
  ) {
    return null;
  }

  const kept = pickSelections(selections as Record<string, unknown>);
  const steps = stepsFor(flow as WizardFlow, kept);
  if (!steps.some((candidate) => candidate.id === step)) return null;
  return { flow: flow as WizardFlow, step, selections: kept };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
