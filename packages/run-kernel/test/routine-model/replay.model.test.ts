import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { RunLeaseManager } from "../../src/lease";
import {
  diffSimulation,
  LIVE_REPLAY_GRANT,
  MAX_EFFECT_IDENTITY_AGE_MS,
  planReplay,
  type RecordedRun,
  ReplayError,
} from "../../src/replay";
import { SimulatedCrash, SimulatedRunStore } from "../../src/resilience/simulator";
import { compileRoutine, type IdentityCeiling } from "../../src/routine/compiler";
import type { SimulationFixture } from "../../src/simulate";
import { DEFAULT_MAX_SIMULATION_STEPS, SimulationError, simulateRoutine } from "../../src/simulate";
import { forEachCase, intBetween } from "./support";

/**
 * Reference model: simulation is pure, bounded, has no live effects or Secret leases, live replay
 * needs fresh authority, and write-boundary crashes never double-commit.
 */

const IDENTITY_CEILING: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

function compileChain(length: number) {
  const states: routineSchema.RoutineState[] = Array.from({ length }, (_, index) => ({
    type: "tool",
    name: `Step${index}`,
    toolRef: { name: "github", version: "2.0.0" },
    action: "issues.addLabels",
    credentialRef: "github-app",
    input: { index },
    ...(index === length - 1 ? { end: true } : { transition: `Step${index + 1}` }),
  }));

  return compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "chain",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: { owner: "platform", start: "Step0", states },
    } as routineSchema.RoutineDefinition,
    { identityCeiling: IDENTITY_CEILING }
  );
}

/**
 * Compilation is deterministic in `length`, so the generated cases share one compiled graph per
 * length instead of paying for a compile on every case.
 */
const chains = new Map<number, ReturnType<typeof compileChain>>();

function chain(length: number) {
  const cached = chains.get(length);
  if (cached !== undefined) return cached;
  const compiled = compileChain(length);
  chains.set(length, compiled);
  return compiled;
}

function chainFixture(length: number, salt: number): SimulationFixture {
  const tools: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < length; index += 1) {
    tools[`Step${index}`] = { applied: true, salt };
  }
  return {
    startedAtMs: Date.UTC(2026, 6, 25, 10, 0, 0),
    tickMs: 1_000,
    input: { salt },
    model: {},
    tools,
    events: {},
  };
}

describe("simulation is deterministic, effect-free, and bounded", () => {
  it("produces the identical result for the identical fixture", () => {
    forEachCase(40, (random) => {
      const length = intBetween(random, 1, 8);
      const salt = intBetween(random, 0, 1_000);
      const routine = chain(length);
      const fixture = chainFixture(length, salt);

      expect(simulateRoutine(routine, fixture)).toEqual(simulateRoutine(routine, fixture));
    });
  });

  it("distinguishes fixtures that differ", () => {
    forEachCase(40, (random) => {
      const length = intBetween(random, 1, 8);
      const salt = intBetween(random, 0, 1_000);
      const routine = chain(length);

      expect(simulateRoutine(routine, chainFixture(length, salt)).resultHash).not.toBe(
        simulateRoutine(routine, chainFixture(length, salt + 1)).resultHash
      );
    });
  });

  it("never dispatches an effect or leases a Secret, whatever the graph", () => {
    forEachCase(40, (random) => {
      const length = intBetween(random, 1, 8);
      const result = simulateRoutine(chain(length), chainFixture(length, 1));

      expect(result.effects).toHaveLength(length);
      for (const effect of result.effects) {
        expect(effect.dispatched).toBe(false);
        expect(effect.secretLeased).toBe(false);
        // The declared reference travels; the Secret behind it is never resolved.
        expect(effect.credentialRef).toBe("github-app");
      }
    });
  });

  it("executes exactly one step per reachable State, inside the default budget", () => {
    forEachCase(40, (random) => {
      const length = intBetween(random, 1, 8);
      const result = simulateRoutine(chain(length), chainFixture(length, 1));

      expect(result.steps).toHaveLength(length);
      expect(result.steps.length).toBeLessThanOrEqual(DEFAULT_MAX_SIMULATION_STEPS);
    });
  });

  it("stops at the budget rather than running a longer graph unbounded", () => {
    forEachCase(25, (random) => {
      const length = intBetween(random, 2, 8);
      const maxSteps = intBetween(random, 1, length - 1);

      expect(() => simulateRoutine(chain(length), chainFixture(length, 1), { maxSteps })).toThrow(
        new SimulationError("step_budget_exceeded", `Step${maxSteps}`)
      );
    });
  });
});

describe("replay is a simulation unless live authority is proven", () => {
  function recorded(length: number, salt: number): RecordedRun {
    const routine = chain(length);
    const baseline = simulateRoutine(routine, chainFixture(length, salt));
    return {
      runId: RUN_ID,
      status: "succeeded",
      routine: {
        slug: routine.slug,
        authoredVersion: routine.authoredVersion,
        digest: routine.digest,
      },
      fixture: chainFixture(length, salt),
      steps: baseline.steps.map((step) => ({
        stateName: step.stateName,
        outputHash: step.outputHash,
      })),
    };
  }

  it("only reaches the live path with the grant and a fresh effect identity", () => {
    forEachCase(80, (random) => {
      const length = intBetween(random, 1, 5);
      const routine = chain(length);
      const live = random() < 0.5;
      const granted = random() < 0.5;
      const ageMs = intBetween(random, 0, 2) * MAX_EFFECT_IDENTITY_AGE_MS;

      const request = {
        mode: live ? ("live" as const) : ("simulation" as const),
        authorization: {
          grants: granted ? [LIVE_REPLAY_GRANT] : [],
          approvedByPrincipalId: "owner-1",
          effectIdentity: {
            principalKind: "service",
            principalId: "triage-bot",
            issuedAtMs: NOW - ageMs,
          },
        },
      };

      const fresh = ageMs <= MAX_EFFECT_IDENTITY_AGE_MS;
      const shouldGoLive = live && granted && fresh;

      if (!live) {
        expect(planReplay(recorded(length, 1), routine, request, NOW).mode).toBe("simulation");
        return;
      }
      if (shouldGoLive) {
        const plan = planReplay(recorded(length, 1), routine, request, NOW);
        expect(plan.mode).toBe("live");
        expect(plan.dispatch).toBe(true);
        return;
      }
      expect(() => planReplay(recorded(length, 1), routine, request, NOW)).toThrow(ReplayError);
    });
  });

  it("never dispatches on the default path, whatever the recorded Run looked like", () => {
    forEachCase(40, (random) => {
      const length = intBetween(random, 1, 5);
      const plan = planReplay(recorded(length, intBetween(random, 0, 50)), chain(length), {}, NOW);
      if (plan.mode !== "simulation") throw new Error("expected a simulation plan");

      expect(plan.dispatch).toBe(false);
      expect(plan.result.effects.every((effect) => effect.dispatched === false)).toBe(true);
    });
  });

  it("calls a replay identical exactly when every recorded State output is reproduced", () => {
    forEachCase(40, (random) => {
      const length = intBetween(random, 1, 5);
      const salt = intBetween(random, 0, 50);
      const drift = random() < 0.5;
      const source = recorded(length, salt);
      const replayed = drift ? { ...source, fixture: chainFixture(length, salt + 1) } : source;

      const plan = planReplay(replayed, chain(length), {}, NOW);
      if (plan.mode !== "simulation") throw new Error("expected a simulation plan");

      const simulated = new Map(plan.result.steps.map((step) => [step.stateName, step.outputHash]));
      const reproduced =
        replayed.steps.length === plan.result.steps.length &&
        replayed.steps.every((step) => simulated.get(step.stateName) === step.outputHash);

      expect(plan.diff.identical).toBe(reproduced);
      expect(plan.diff).toEqual(diffSimulation(replayed.steps, plan.result));
      // A drifted fixture must be visible as drift, never silently accepted as a clean replay.
      if (drift) expect(plan.diff.identical).toBe(false);
    });
  });
});

describe("a crash at a durable write boundary never commits twice", () => {
  it("leaves the Run claimable, or claimed exactly once, for either crash timing", async () => {
    for (const when of ["before", "after"] as const) {
      const store = new SimulatedRunStore();
      store.seedRun({ status: "queued" });
      const leases = new RunLeaseManager(store);
      const claim = {
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        owner: "worker-1",
        now: new Date(NOW),
        leaseDurationMs: 60_000,
        expectedVersion: 0,
        expectedStatus: "queued" as const,
        status: "claimed" as const,
      };

      if (when === "before") store.crashBefore("transitionRun");
      else store.crashAfter("transitionRun");

      await expect(leases.claim(claim)).rejects.toBeInstanceOf(SimulatedCrash);

      // The worker retries blindly; storage decides, and the ledger shows a single commit.
      const retried = await leases.claim(claim);
      expect(retried.claimed).toBe(when === "before");
      expect(store.transitions.filter((entry) => entry.to === "claimed")).toHaveLength(1);
    }
  });
});
