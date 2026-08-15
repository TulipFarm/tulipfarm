import { describe, expect, it, vi } from "vitest";
import { ModelCallWatchdog } from "./model-watchdog";

/**
 * The gap this closes was a *missing* bound, not a broken one: both production port
 * constructions omitted the optional signal, so nothing here was ever exercised in production.
 */
describe("ModelCallWatchdog", () => {
  it("aborts a provider that accepts the connection and never answers", async () => {
    vi.useFakeTimers();
    const watchdog = new ModelCallWatchdog({ stallTimeoutMs: 100, callTimeoutMs: 10_000 });

    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(101);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.expired).toBe("stalled");
    expect(watchdog.message()).toContain("100ms");
    watchdog.close();
    vi.useRealTimers();
  });

  it("does not cut short a long but productive answer", () => {
    vi.useFakeTimers();
    const watchdog = new ModelCallWatchdog({ stallTimeoutMs: 100, callTimeoutMs: 10_000 });

    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(90);
      watchdog.progress();
    }

    expect(watchdog.signal.aborted).toBe(false);
    watchdog.close();
    vi.useRealTimers();
  });

  it("still stops a provider that dribbles forever", () => {
    // A steady trickle resets the stall window indefinitely, so the absolute ceiling is what
    // actually bounds this case.
    vi.useFakeTimers();
    const watchdog = new ModelCallWatchdog({ stallTimeoutMs: 100, callTimeoutMs: 500 });

    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(90);
      watchdog.progress();
    }

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.expired).toBe("deadline");
    watchdog.close();
    vi.useRealTimers();
  });

  it("passes a drain abort through without calling it an expiry", () => {
    const drain = new AbortController();
    const watchdog = new ModelCallWatchdog({ signal: drain.signal, stallTimeoutMs: 10_000 });

    drain.abort(new Error("worker draining"));

    expect(watchdog.signal.aborted).toBe(true);
    // The caller cancelled deliberately; reporting a timeout would send an operator hunting a
    // provider fault that never happened.
    expect(watchdog.expired).toBeUndefined();
    watchdog.close();
  });

  it("honours a drain signal that was already aborted before the call started", () => {
    const drain = new AbortController();
    drain.abort(new Error("already draining"));

    const watchdog = new ModelCallWatchdog({ signal: drain.signal });

    expect(watchdog.signal.aborted).toBe(true);
    watchdog.close();
  });

  it("stops its timers on close, so a finished call holds nothing open", () => {
    vi.useFakeTimers();
    const watchdog = new ModelCallWatchdog({ stallTimeoutMs: 100, callTimeoutMs: 200 });

    watchdog.close();
    vi.advanceTimersByTime(1_000);

    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.expired).toBeUndefined();
    vi.useRealTimers();
  });
});
