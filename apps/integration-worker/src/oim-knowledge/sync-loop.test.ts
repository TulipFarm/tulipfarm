import { describe, expect, it } from "vitest";
import { startOimKnowledgeSyncLoop } from "./sync-loop";

describe("startOimKnowledgeSyncLoop", () => {
  it("drains only after the in-flight sync settles", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const loop = startOimKnowledgeSyncLoop(controller.signal, {
      registrations: async () => [
        {
          id: "wiki:connection-1/page/space-1",
          async sync() {
            started = true;
            await running;
            return { failures: [] };
          },
        },
      ],
      wait: async () => {},
      pollIntervalMs: 1,
      log: { warn() {} },
    });

    await Promise.resolve();
    expect(started).toBe(true);
    controller.abort();
    let settled = false;
    loop.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await loop.settled;
    expect(settled).toBe(true);
  });

  it("isolates failures and retries durable checkpoint-backed registrations", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const warnings: string[] = [];
    let waits = 0;
    const loop = startOimKnowledgeSyncLoop(controller.signal, {
      registrations: async () => [
        {
          id: "failed",
          async sync() {
            calls.push("failed");
            return { failures: [{ code: "deletion_failed" }] };
          },
        },
        {
          id: "healthy",
          async sync() {
            calls.push("healthy");
            return { failures: [] };
          },
        },
      ],
      pollIntervalMs: 1,
      wait: async () => {
        waits += 1;
        if (waits === 2) controller.abort();
      },
      log: {
        warn(message) {
          warnings.push(message);
        },
      },
    });

    await loop.settled;

    expect(calls).toEqual(["failed", "healthy", "failed", "healthy"]);
    expect(warnings).toEqual([
      "OIM Knowledge sync failed for failed: deletion_failed",
      "OIM Knowledge sync failed for failed: deletion_failed",
    ]);
  });
});
