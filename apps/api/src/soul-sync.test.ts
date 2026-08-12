import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSoulSync, SOUL_SYNC_INTERVAL_MS } from "./soul-sync";

const REMOTE = "https://github.com/example/soul.git";

describe("registerSoulSync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs every five minutes when a remote is configured", async () => {
    vi.useFakeTimers();
    const syncer = { syncOnce: vi.fn(async () => {}) };

    const interval = registerSoulSync(syncer, REMOTE);
    await vi.advanceTimersByTimeAsync(SOUL_SYNC_INTERVAL_MS);

    expect(interval).toBeDefined();
    expect(syncer.syncOnce).toHaveBeenCalledOnce();
    clearInterval(interval);
  });

  it("does not overlap pulls when one interval is still running", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const syncer = {
      syncOnce: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      ),
    };

    const interval = registerSoulSync(syncer, REMOTE);
    await vi.advanceTimersByTimeAsync(SOUL_SYNC_INTERVAL_MS * 2);

    expect(syncer.syncOnce).toHaveBeenCalledOnce();
    finish?.();
    await Promise.resolve();
    clearInterval(interval);
  });

  it("reconciles the active bundle to HEAD after each pull", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const syncer = {
      syncOnce: vi.fn(async () => {
        order.push("sync");
      }),
    };
    const reconcile = vi.fn(async () => {
      order.push("reconcile");
    });

    const interval = registerSoulSync(syncer, REMOTE, { reconcile });
    await vi.advanceTimersByTimeAsync(SOUL_SYNC_INTERVAL_MS);

    expect(syncer.syncOnce).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(order).toEqual(["sync", "reconcile"]);
    clearInterval(interval);
  });

  it("registers nothing when no git remote is configured", async () => {
    vi.useFakeTimers();
    const syncer = { syncOnce: vi.fn(async () => {}) };

    const interval = registerSoulSync(syncer, undefined);
    await vi.advanceTimersByTimeAsync(SOUL_SYNC_INTERVAL_MS);

    expect(interval).toBeUndefined();
    expect(syncer.syncOnce).not.toHaveBeenCalled();
  });
});
