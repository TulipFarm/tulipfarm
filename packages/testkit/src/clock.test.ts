import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock";

describe("FakeClock", () => {
  it("returns deterministic timestamps and advances explicitly", () => {
    const clock = new FakeClock("2026-07-22T00:00:00.000Z");

    expect(clock.now().toISOString()).toBe("2026-07-22T00:00:00.000Z");
    expect(clock.advance(1_500).toISOString()).toBe("2026-07-22T00:00:01.500Z");
    expect(clock.nowIso()).toBe("2026-07-22T00:00:01.500Z");
  });

  it("does not expose mutable clock state", () => {
    const clock = new FakeClock("2026-07-22T00:00:00.000Z");
    const snapshot = clock.now();

    snapshot.setUTCFullYear(2030);

    expect(clock.now().toISOString()).toBe("2026-07-22T00:00:00.000Z");
  });

  it("rejects invalid instants, negative advances, and backward movement", () => {
    expect(() => new FakeClock("not-a-date")).toThrow("valid instant");

    const clock = new FakeClock("2026-07-22T00:00:00.000Z");
    expect(() => clock.advance(-1)).toThrow("non-negative");
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow("finite");
    expect(() => clock.set("2026-07-21T23:59:59.999Z")).toThrow("backward");
  });

  it("rejects an out-of-range advance without corrupting its current time", () => {
    const clock = new FakeClock("2026-07-22T00:00:00.000Z");

    expect(() => clock.advance(9_000_000_000_000_000)).toThrow("valid Date range");
    expect(clock.nowIso()).toBe("2026-07-22T00:00:00.000Z");
  });
});
