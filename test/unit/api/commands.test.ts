import { expect } from "@open-wc/testing";
import {
  downloadUtmImage,
  flashImage,
  formatBytes,
  proxmoxCreateVm,
} from "../../../src/api/commands.js";
import type { FlashProgress } from "../../../src/api/types.js";

type MockStep = FlashProgress | { wait: number };

/**
 * Run a browser-mock install with its waits skipped, returning its progress
 * events with each wait in between, in order.
 */
async function recordMockProgress(
  run: (onProgress: (progress: FlashProgress) => void) => Promise<unknown>
): Promise<MockStep[]> {
  const steps: MockStep[] = [];
  const setTimeout = window.setTimeout;
  window.setTimeout = ((callback: () => void, wait = 0) => {
    steps.push({ wait });
    queueMicrotask(callback);
    return 0;
  }) as typeof window.setTimeout;
  try {
    await run((progress) => steps.push(progress));
  } finally {
    window.setTimeout = setTimeout;
  }
  return steps;
}

function progressOf(steps: MockStep[], stage?: FlashProgress["stage"]) {
  return steps.filter(
    (step): step is FlashProgress =>
      "stage" in step && (!stage || step.stage === stage)
  );
}

function last<T>(items: T[]): T {
  return items[items.length - 1];
}

/** Each measured stage counts from 0 to 100 on its own, like the backend's. */
function expectStageLocal(events: FlashProgress[]) {
  const percentages = events.map((event) => event.progress);
  expect(percentages[0]).to.equal(0);
  expect(percentages[percentages.length - 1]).to.equal(100);
  expect(percentages).to.deep.equal([...percentages].sort((a, b) => a - b));
}

function expectBytes(events: FlashProgress[], total: number) {
  for (const event of events) expect(event.total_bytes).to.equal(total);
  expect(events[0].bytes_processed).to.equal(0);
  expect(events[events.length - 1].bytes_processed).to.equal(total);
}

describe("api/commands", () => {
  describe("browser mock progress", () => {
    it("reports each measured flash stage from 0 to 100, extraction against the archive", async () => {
      const steps = await recordMockProgress((onProgress) =>
        flashImage(
          {
            device_id: "/dev/mock",
            board: "rpi5-64",
            verify: true,
            expected_device: {},
          },
          onProgress,
          "flash-test"
        )
      );

      for (const stage of [
        "downloading",
        "extracting",
        "writing",
        "verifying",
      ] as const)
        expectStageLocal(progressOf(steps, stage));
      const compressed = progressOf(steps, "downloading")[0].total_bytes;
      const extracted = progressOf(steps, "writing")[0].total_bytes;
      expect(compressed).to.be.greaterThan(0);
      expect(extracted).to.be.greaterThan(compressed);
      expectBytes(progressOf(steps, "downloading"), compressed);
      expectBytes(progressOf(steps, "extracting"), compressed);
      expectBytes(progressOf(steps, "writing"), extracted);
      expectBytes(progressOf(steps, "verifying"), extracted);
      for (const event of progressOf(steps, "finalizing"))
        expect(event.total_bytes).to.equal(0);
      expect(last(progressOf(steps))).to.include({
        stage: "complete",
        progress: 100,
      });
    });

    it("reports the UTM download and extraction against the compressed image", async () => {
      const steps = await recordMockProgress((onProgress) =>
        downloadUtmImage(onProgress, "utm-test")
      );

      const downloading = progressOf(steps, "downloading");
      const compressed = downloading[0].total_bytes;
      expect(compressed).to.be.greaterThan(0);
      expectStageLocal(downloading);
      expectStageLocal(progressOf(steps, "extracting"));
      expectBytes(downloading, compressed);
      expectBytes(progressOf(steps, "extracting"), compressed);
    });

    it("sends the Proxmox upload over 5-95% and reports 100 after processing", async () => {
      const steps = await recordMockProgress((onProgress) =>
        proxmoxCreateVm(
          {
            server_url: "https://pve:8006",
            ticket: "test",
            csrf_token: "test",
          },
          {
            node: "pve",
            storage: "local",
            bridge: "vmbr0",
            vm_id: 100,
            name: "homeassistant",
            cpu_cores: 2,
            memory_mb: 4096,
            disk_size_gb: 32,
          },
          onProgress,
          "proxmox-test"
        )
      );

      for (const stage of ["downloading", "extracting"] as const)
        expectStageLocal(progressOf(steps, stage));
      const compressed = progressOf(steps, "downloading")[0].total_bytes;
      expect(compressed).to.be.greaterThan(0);
      expectBytes(progressOf(steps, "downloading"), compressed);
      expectBytes(progressOf(steps, "extracting"), compressed);
      for (const stage of ["creating_vm", "starting_vm"] as const)
        for (const event of progressOf(steps, stage))
          expect(event.total_bytes).to.equal(0);

      const upload = progressOf(steps, "uploading");
      const extracted = upload[0].total_bytes;
      expect(extracted).to.be.greaterThan(compressed);
      expectBytes(upload, extracted);
      const transfer = upload.slice(0, -1);
      expect(transfer[0].progress).to.equal(5);
      expect(last(transfer)).to.include({
        progress: 95,
        bytes_processed: extracted,
      });
      for (const event of transfer) {
        expect(event.progress).to.be.within(5, 95);
        expect(event.progress).to.equal(
          Math.round(5 + (event.bytes_processed / extracted) * 90)
        );
      }
      expect(last(upload).progress).to.equal(100);

      // Proxmox processes the upload for longer than a transfer step takes
      const lastTransfer = steps.indexOf(last(transfer));
      const done = steps.indexOf(last(upload));
      const stepWait = (
        steps[steps.indexOf(transfer[0]) + 1] as { wait: number }
      ).wait;
      const processing = steps
        .slice(lastTransfer + 1, done)
        .map((step) => (step as { wait: number }).wait);
      expect(Math.max(...processing)).to.be.greaterThan(stepWait);
    });
  });

  describe("formatBytes", () => {
    it("formats 0 bytes", () => {
      expect(formatBytes(0)).to.equal("0 bytes");
    });

    it("formats bytes", () => {
      expect(formatBytes(500)).to.equal("500 bytes");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(1000)).to.equal("1 kB");
      expect(formatBytes(1500)).to.equal("1.5 kB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(1000000)).to.equal("1 MB");
      expect(formatBytes(1500000)).to.equal("1.5 MB");
    });

    it("formats gigabytes", () => {
      expect(formatBytes(1000000000)).to.equal("1 GB");
      expect(formatBytes(16000000000)).to.equal("16 GB");
      expect(formatBytes(32000000000)).to.equal("32 GB");
    });

    it("formats terabytes", () => {
      expect(formatBytes(1000000000000)).to.equal("1 TB");
    });

    it("does not round a drive up to a capacity threshold", () => {
      expect(formatBytes(16_000_000_000 - 1)).to.equal("15.9 GB");
      expect(formatBytes(32_000_000_000 - 1)).to.equal("31.9 GB");
    });

    it("formats speeds", () => {
      expect(formatBytes(500, true)).to.equal("500 bytes per second");
      expect(formatBytes(1500000, true)).to.equal("1.5 MB/s");
    });

    it("handles invalid and oversized input without an undefined unit", () => {
      for (const invalid of [NaN, Infinity, -1]) {
        expect(formatBytes(invalid)).to.equal("Unknown size");
      }
      expect(formatBytes(1_000_000_000_000_000)).to.equal("1000 TB");
    });
  });
});
