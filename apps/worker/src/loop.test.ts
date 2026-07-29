import { describe, expect, it, vi } from "vitest";
import { backoffDelay, type LoopLogger, runLoop } from "./loop";

function recordingLogger(): LoopLogger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    error(message: string, error: unknown) {
      calls.push([message, error]);
    },
  };
}

describe("backoffDelay", () => {
  it("grows exponentially from the poll interval", () => {
    const noJitter = () => 1;
    expect(backoffDelay(0, 1_000, 30_000, noJitter)).toBe(1_000);
    expect(backoffDelay(1, 1_000, 30_000, noJitter)).toBe(2_000);
    expect(backoffDelay(2, 1_000, 30_000, noJitter)).toBe(4_000);
  });

  it("caps at the ceiling so a recovered dependency is picked up promptly", () => {
    expect(backoffDelay(20, 1_000, 30_000, () => 1)).toBe(30_000);
  });

  it("applies full jitter across the lower half of the window", () => {
    expect(backoffDelay(1, 1_000, 30_000, () => 0)).toBe(1_000);
    expect(backoffDelay(1, 1_000, 30_000, () => 1)).toBe(2_000);
  });
});

describe("runLoop", () => {
  it("stops once the signal aborts", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const settled = runLoop({
      name: "test",
      intervalMs: 1,
      signal: controller.signal,
      logger: recordingLogger(),
      wait: async () => {},
      tick: async () => {
        ticks += 1;
        if (ticks === 3) controller.abort();
      },
    });

    await expect(settled).resolves.toBeUndefined();
    expect(ticks).toBe(3);
  });

  it("does not run a tick at all when it starts already aborted", async () => {
    const tick = vi.fn(async () => {});
    await runLoop({
      name: "test",
      intervalMs: 1,
      signal: AbortSignal.abort(),
      logger: recordingLogger(),
      wait: async () => {},
      tick,
    });
    expect(tick).not.toHaveBeenCalled();
  });

  it("logs a throwing tick and keeps going with backoff instead of killing the process", async () => {
    const controller = new AbortController();
    const logger = recordingLogger();
    const delays: number[] = [];
    let ticks = 0;

    await runLoop({
      name: "run-dispatch",
      intervalMs: 1_000,
      maxBackoffMs: 30_000,
      signal: controller.signal,
      logger,
      wait: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 3) controller.abort();
      },
      tick: async () => {
        ticks += 1;
        throw new Error(`boom ${ticks}`);
      },
    });

    expect(ticks).toBe(3);
    expect(logger.calls).toHaveLength(3);
    expect(logger.calls[0]?.[0]).toBe('worker loop "run-dispatch" tick failed');
    // Full jitter keeps each delay inside [half, full] of the exponential step.
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(1_000);
    expect(delays[1]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeLessThanOrEqual(2_000);
    expect(delays[2]).toBeGreaterThanOrEqual(2_000);
    expect(delays[2]).toBeLessThanOrEqual(4_000);
  });

  it("returns to the plain poll interval after one success", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let ticks = 0;

    await runLoop({
      name: "test",
      intervalMs: 1_000,
      signal: controller.signal,
      logger: recordingLogger(),
      wait: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 2) controller.abort();
      },
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error("boom");
      },
    });

    expect(delays[1]).toBe(1_000);
  });

  it("resolves only after the in-flight tick settles, which is what makes a drain clean", async () => {
    const controller = new AbortController();
    let released = false;
    let finished = false;

    const settled = runLoop({
      name: "test",
      intervalMs: 1,
      signal: controller.signal,
      logger: recordingLogger(),
      wait: async () => {},
      tick: async () => {
        controller.abort();
        await Promise.resolve();
        released = true;
      },
    }).then(() => {
      finished = true;
    });

    expect(released).toBe(false);
    await settled;
    expect(released).toBe(true);
    expect(finished).toBe(true);
  });
});
