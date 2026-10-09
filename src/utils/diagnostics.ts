import { invoke } from "@tauri-apps/api/core";

export type DiagnosticFlow = "flash" | "utm" | "proxmox" | "application";
const stages = [
  "preparing",
  "connecting",
  "downloading",
  "extracting",
  "writing",
  "verifying",
  "finalizing",
  "uploading",
  "creating",
  "creating_vm",
  "starting",
  "starting_vm",
  "waiting",
  "ready",
  "updating",
  "complete",
  "frontend",
] as const;
type Stage = (typeof stages)[number];

export interface Diagnostics {
  version: string;
  os: string;
  os_version: string;
  architecture: string;
  package_type: string;
  log_tail: string;
  context?: Failure;
}

export interface Failure {
  flow: DiagnosticFlow;
  stage: Stage;
  error: string;
}

let failure: Failure | undefined;
let pending: Promise<unknown> = Promise.resolve();

// Return fixed categories, never substrings of an error or a serialized object.
export function diagnosticError(error: unknown): string {
  // Structured command errors already carry a fixed category; accept only a
  // short snake_case code so no free text reaches the log this way
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z_]{0,39}$/.test(error.code)
  ) {
    return error.code;
  }
  const message = (
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : ""
  ).toLowerCase();
  for (const [needle, category] of [
    ["checksum", "checksum_mismatch"],
    ["verification failed", "verification_failed"],
    ["write-protected", "write_protected"],
    ["disconnected", "drive_disconnected"],
    ["permission", "permission_denied"],
    ["disk service unavailable", "disk_service_unavailable"],
    ["too large", "image_too_large"],
    ["larger than", "image_too_large"],
    ["timed out", "timeout"],
    ["timeout", "timeout"],
    ["network", "network_error"],
    ["download", "download_failed"],
    ["extract", "extraction_failed"],
    ["proxmox", "proxmox_error"],
    ["utm", "utm_error"],
    ["cancelled", "cancelled"],
  ]) {
    if (message.includes(needle)) return category;
  }
  return "operation_failed";
}

function log(
  flow: DiagnosticFlow,
  stage: Stage,
  outcome: string,
  elapsed: number,
  error?: string
) {
  // Serialize writes so opening diagnostics immediately after a failure includes it.
  pending = pending
    .then(() =>
      invoke("log_frontend_event", {
        flow,
        stage,
        outcome,
        error: error ?? null,
        elapsedMs: Math.min(0xffffffff, Math.max(0, Math.round(elapsed))),
      })
    )
    .catch(() => {
      /* Logging must not break installation or recurse on errors. */
    });
}

export class InstallDiagnostics {
  private stage: Stage = "preparing";
  private started = performance.now();
  constructor(private flow: DiagnosticFlow) {
    failure = undefined;
    log(flow, this.stage, "started", 0);
  }
  advance(value: string) {
    const stage = stages.find((stage) => stage === value);
    if (!stage || stage === this.stage) return;
    log(this.flow, this.stage, "finished", performance.now() - this.started);
    this.stage = stage;
    this.started = performance.now();
    log(this.flow, stage, "started", 0);
  }
  fail(error: unknown) {
    failure = {
      flow: this.flow,
      stage: this.stage,
      error: diagnosticError(error),
    };
    log(
      this.flow,
      this.stage,
      "failed",
      performance.now() - this.started,
      failure.error
    );
  }
}

export function installErrorLogging() {
  const report = (error: "frontend_error" | "unhandled_rejection") => {
    if (!failure || failure.flow === "application") {
      failure = { flow: "application", stage: "frontend", error };
    }
    log("application", "frontend", "failed", 0, error);
  };
  window.addEventListener("error", () => report("frontend_error"));
  window.addEventListener("unhandledrejection", () =>
    report("unhandled_rejection")
  );
}

export async function getDiagnostics(): Promise<Diagnostics> {
  await pending;
  const context = failure ? { ...failure } : undefined;
  return { ...(await invoke<Diagnostics>("get_diagnostics")), context };
}

export function logFrontendError(error: unknown) {
  log("application", "frontend", "failed", 0, diagnosticError(error));
}

export function diagnosticFields(data: Diagnostics, context = data.context) {
  return {
    version: data.version.slice(0, 128),
    platform: `${data.os} ${data.os_version}`.slice(0, 128),
    architecture: data.architecture.slice(0, 128),
    package: data.package_type.slice(0, 128),
    flow: context?.flow ?? "application",
    stage: context?.stage ?? "none",
    error: context?.error ?? "none",
    logs: data.log_tail.slice(-8192) || "No events in this session",
  };
}

export function diagnosticText(data: Diagnostics): string {
  return Object.entries(diagnosticFields(data))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export const REPORT_URL_LIMIT = 7500;

export function reportUrl(data: Diagnostics): {
  url: string;
  shortened: boolean;
} {
  const url = new URL("https://github.com/home-assistant/installer/issues/new");
  url.searchParams.set("template", "bug_report.yml");
  const fields = diagnosticFields(data);
  for (const [key, value] of Object.entries(fields))
    url.searchParams.set(key, value);
  let shortened = false;
  while (url.href.length > REPORT_URL_LIMIT && fields.logs.length) {
    shortened = true;
    fields.logs = fields.logs.slice(
      Math.max(1, Math.ceil(fields.logs.length / 4))
    );
    url.searchParams.set(
      "logs",
      `[Log tail shortened; use Copy diagnostics for the full tail]\n${fields.logs}`
    );
  }
  return { url: url.href, shortened };
}
