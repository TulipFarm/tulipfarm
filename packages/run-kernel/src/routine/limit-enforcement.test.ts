import { describe, expect, it } from "vitest";
import { resolveLimits } from "../limits";
import type { CompiledBounds } from "./compiler";
import { narrowBoundsByLimits, routineBudgetScopedLimits } from "./limit-enforcement";

const UNBOUNDED: CompiledBounds = {
  maxItems: null,
  maxConcurrency: null,
  maxIterations: null,
  maxDurationMs: null,
};

describe("narrowBoundsByLimits", () => {
  it("leaves bounds alone when no limit names them", () => {
    const bounds: CompiledBounds = { ...UNBOUNDED, maxItems: 10 };
    expect(narrowBoundsByLimits(bounds, resolveLimits([]))).toEqual(bounds);
  });

  it("supplies a bound the author left unbounded", () => {
    const resolved = resolveLimits([
      { scope: "routine", limits: { fanOut: 3, parallelism: 2, iterations: 5, wallTimeMs: 900 } },
    ]);
    expect(narrowBoundsByLimits(UNBOUNDED, resolved)).toEqual({
      maxItems: 3,
      maxConcurrency: 2,
      maxIterations: 5,
      maxDurationMs: 900,
    });
  });

  it("narrows a bound the limit undercuts", () => {
    const bounds: CompiledBounds = { ...UNBOUNDED, maxItems: 100 };
    const resolved = resolveLimits([{ scope: "routine", limits: { fanOut: 4 } }]);
    expect(narrowBoundsByLimits(bounds, resolved).maxItems).toBe(4);
  });

  it("never raises a bound the limit exceeds", () => {
    const bounds: CompiledBounds = { ...UNBOUNDED, maxItems: 4 };
    const resolved = resolveLimits([{ scope: "routine", limits: { fanOut: 100 } }]);
    expect(narrowBoundsByLimits(bounds, resolved).maxItems).toBe(4);
  });

  it("lets the narrower of the two authored scopes win", () => {
    const resolved = resolveLimits([
      { scope: "routine", limits: { fanOut: 10 } },
      { scope: "state", limits: { fanOut: 2 } },
    ]);
    expect(narrowBoundsByLimits(UNBOUNDED, resolved).maxItems).toBe(2);
  });

  it("does not let a State scope raise the Routine ceiling", () => {
    const resolved = resolveLimits([
      { scope: "routine", limits: { fanOut: 2 } },
      { scope: "state", limits: { fanOut: 10 } },
    ]);
    expect(narrowBoundsByLimits(UNBOUNDED, resolved).maxItems).toBe(2);
  });
});

describe("routineBudgetScopedLimits", () => {
  it("is undefined when the Routine declared nothing the ledger meters", () => {
    expect(routineBudgetScopedLimits({ limits: {} })).toBeUndefined();
    expect(routineBudgetScopedLimits({ limits: { fanOut: 3, iterations: 2 } })).toBeUndefined();
  });

  it("carries the metered ceilings at Routine scope", () => {
    expect(routineBudgetScopedLimits({ limits: { tokens: 1_000, costMicros: 5_000 } })).toEqual({
      scope: "routine",
      limits: { tokens: 1_000, costMicros: 5_000 },
    });
  });

  it("drops keys the Run budget ledger never charges", () => {
    expect(
      routineBudgetScopedLimits({
        limits: { tokens: 10, wallTimeMs: 1, activeTimeMs: 1, sideEffects: 1, networkBytes: 1 },
      })
    ).toEqual({ scope: "routine", limits: { tokens: 10 } });
  });
});
