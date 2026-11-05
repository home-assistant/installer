import { expect } from "@open-wc/testing";
import {
  downloadUtmImage,
  flashImage,
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

/** No view shows a message, so the mocks leave it empty rather than translate it. */
function expectNoMessages(events: FlashProgress[]) {
  expect(events).to.not.be.empty;
  for (const event of events) expect(event.message).to.equal("");
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
      expectNoMessages(progressOf(steps));
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
      expectNoMessages(progressOf(steps));
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
      expectNoMessages(progressOf(steps));
    });
  });
});
