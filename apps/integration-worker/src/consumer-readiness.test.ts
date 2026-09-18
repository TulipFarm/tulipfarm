import { describe, expect, it } from "vitest";
import { ConsumerReadiness } from "./consumer-readiness";

describe("ConsumerReadiness", () => {
  it("requires successful cycles, fails after a caught error or stale heartbeat, and recovers", async () => {
    let now = 0;
    let fail = false;
    const readiness = new ConsumerReadiness(() => now, 100);
    const cycle = readiness.track("delivery", async () => {
      if (fail) throw new Error("database unavailable");
    });
    expect(readiness.isReady()).toBe(false);
    await cycle();
    expect(readiness.isReady()).toBe(true);
    fail = true;
    await expect(cycle()).rejects.toThrow();
    expect(readiness.isReady()).toBe(false);
    fail = false;
    await cycle();
    expect(readiness.isReady()).toBe(true);
    now = 101;
    expect(readiness.isReady()).toBe(false);
  });
});
