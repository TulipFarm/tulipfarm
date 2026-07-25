import { describe, expect, it } from "vitest";
import {
  assertNonAmplifying,
  deriveTargetKey,
  LimitError,
  narrowestWins,
  resolveLimits,
} from "./limits";

describe("resolveLimits", () => {
  it("keeps the narrowest value for every key and records its scope", () => {
    const resolved = resolveLimits([
      { scope: "deployment", limits: { tokens: 100_000, wallTimeMs: 600_000 } },
      { scope: "agent", limits: { tokens: 20_000 } },
      { scope: "state", limits: { tokens: 5_000, fanOut: 10 } },
    ]);

    expect(resolved.tokens).toEqual({ value: 5_000, scope: "state" });
    expect(resolved.wallTimeMs).toEqual({ value: 600_000, scope: "deployment" });
    expect(resolved.fanOut).toEqual({ value: 10, scope: "state" });
  });

  it("breaks an equal-value tie with the narrower scope so evidence is deterministic", () => {
    const resolved = resolveLimits([
      { scope: "routine", limits: { retries: 3 } },
      { scope: "deployment", limits: { retries: 3 } },
    ]);

    expect(resolved.retries).toEqual({ value: 3, scope: "routine" });
  });

  it("rejects a negative or non-integer limit instead of silently clamping it", () => {
    expect(() => resolveLimits([{ scope: "run", limits: { tokens: -1 } }])).toThrow(LimitError);
    expect(() => resolveLimits([{ scope: "run", limits: { tokens: 1.5 } }])).toThrow(LimitError);
  });

  it("leaves an undeclared key unbounded rather than inventing a default", () => {
    expect(resolveLimits([{ scope: "run", limits: { tokens: 10 } }]).costMicros).toBeUndefined();
  });
});

describe("narrowestWins", () => {
  it("returns the effective numeric ceiling for a key", () => {
    const resolved = resolveLimits([
      { scope: "deployment", limits: { sideEffects: 9 } },
      { scope: "tool", limits: { sideEffects: 2 } },
    ]);

    expect(narrowestWins(resolved, "sideEffects")).toBe(2);
    expect(narrowestWins(resolved, "tokens")).toBeNull();
  });
});

describe("assertNonAmplifying", () => {
  it("accepts a request that only narrows the resolved ceiling", () => {
    const resolved = resolveLimits([{ scope: "agent", limits: { tokens: 1_000 } }]);

    expect(() => assertNonAmplifying(resolved, { tokens: 500 })).not.toThrow();
  });

  it("accepts a new bound on an otherwise unbounded key", () => {
    const resolved = resolveLimits([{ scope: "agent", limits: { tokens: 1_000 } }]);

    expect(() => assertNonAmplifying(resolved, { fanOut: 3 })).not.toThrow();
  });

  it("denies an Agent request that would raise a resolved ceiling", () => {
    const resolved = resolveLimits([{ scope: "agent", limits: { tokens: 1_000 } }]);

    expect(() => assertNonAmplifying(resolved, { tokens: 1_001 })).toThrow(
      new LimitError("limit_amplification", "tokens")
    );
  });

  it("never leaks the requested value in the error message", () => {
    const resolved = resolveLimits([{ scope: "agent", limits: { costMicros: 10 } }]);

    try {
      assertNonAmplifying(resolved, { costMicros: 999_999 });
      throw new Error("expected denial");
    } catch (error) {
      expect((error as LimitError).message).toBe("limit_amplification:costMicros");
    }
  });
});

describe("deriveTargetKey", () => {
  it("is deterministic and order-independent over declared parts", () => {
    const a = deriveTargetKey({ routineId: "routine-1", issue: "42" });
    const b = deriveTargetKey({ issue: "42", routineId: "routine-1" });

    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("separates parts so concatenation collisions cannot occur", () => {
    expect(deriveTargetKey({ a: "xy", b: "z" })).not.toBe(deriveTargetKey({ a: "x", b: "yz" }));
  });

  it("rejects an empty target key rather than serializing everything together", () => {
    expect(() => deriveTargetKey({})).toThrow(LimitError);
  });
});
