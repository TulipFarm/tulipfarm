import type { routine as routineSchema } from "@tulipfarm/schema";
import type { PersistedWait } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { compileRoutine, type IdentityCeiling } from "../../src/routine/compiler";
import { decideBranch } from "../../src/routine/states/branch";
import {
  isSettled,
  nextDispatchSlots,
  resolveJoin,
  type WorkStatus,
} from "../../src/routine/states/step";
import { isWaitSatisfied } from "../../src/waits";
import { forEachCase, intBetween, pick } from "./support";

/**
 * Reference model for the State processors and wait aggregation (SPEC §9.1, §9.2).
 *
 * Each property is stated over the processor's whole input space rather than one authored graph:
 * a fan-out never exceeds its concurrency bound, a join is in exactly one of three states and
 * agrees with a counting model, an aggregation is monotone in its signals, and a branch is a
 * function of its Context. These are the invariants a Run's durability rests on, so they are
 * checked over generated inputs instead of examples.
 */

const IDENTITY_CEILING: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

const STATUSES: readonly WorkStatus[] = ["pending", "running", "succeeded", "failed"];

function buildFanOut(maxConcurrency: number) {
  const states: routineSchema.RoutineState[] = [
    {
      type: "parallel",
      name: "Fan",
      branches: ["Done"],
      maxConcurrency,
      transition: "Done",
    },
    { type: "agent", name: "Done", agentRef: { name: "triage", version: "1.0.0" }, end: true },
  ];
  const compiled = compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "fan-out",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: { owner: "platform", start: "Fan", states },
    } as routineSchema.RoutineDefinition,
    { identityCeiling: IDENTITY_CEILING }
  );
  const state = compiled.states.get("Fan");
  if (state === undefined) throw new Error("missing Fan");
  return state;
}

/** One compiled graph per concurrency bound — compilation is deterministic in that bound. */
const fanOuts = new Map<number, ReturnType<typeof buildFanOut>>();

function compileFanOut(maxConcurrency: number) {
  const cached = fanOuts.get(maxConcurrency);
  if (cached !== undefined) return cached;
  const compiled = buildFanOut(maxConcurrency);
  fanOuts.set(maxConcurrency, compiled);
  return compiled;
}

function randomStatuses(random: () => number, size: number): WorkStatus[] {
  return Array.from({ length: size }, () => pick(random, STATUSES));
}

describe("fan-out dispatch never exceeds its authored bound", () => {
  it("starts only pending units, in order, within the free concurrency slots", () => {
    forEachCase(120, (random) => {
      const cap = intBetween(random, 1, 6);
      const statuses = randomStatuses(random, intBetween(random, 0, 12));
      const state = compileFanOut(cap);

      const { indices, settled } = nextDispatchSlots(state, statuses);
      const running = statuses.filter((status) => status === "running").length;

      expect(indices.length).toBeLessThanOrEqual(Math.max(0, cap - running));
      expect(new Set(indices).size).toBe(indices.length);
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
      for (const index of indices) expect(statuses[index]).toBe("pending");
      expect(settled).toBe(statuses.every(isSettled));
    });
  });

  it("never leaves a free slot idle while a unit is still pending", () => {
    forEachCase(120, (random) => {
      const cap = intBetween(random, 1, 6);
      const statuses = randomStatuses(random, intBetween(random, 0, 12));
      const state = compileFanOut(cap);

      const { indices } = nextDispatchSlots(state, statuses);
      const pending = statuses.filter((status) => status === "pending").length;
      const running = statuses.filter((status) => status === "running").length;

      expect(indices.length).toBe(Math.min(pending, Math.max(0, cap - running)));
    });
  });
});

describe("join resolution agrees with the counting model", () => {
  it("is in exactly one of pending, satisfied, or failed, and matches the counts", () => {
    forEachCase(120, (random) => {
      const size = intBetween(random, 1, 8);
      const statuses = randomStatuses(random, size);
      const keys = statuses.map((_, index) => `unit-${index}`);
      const need = intBetween(random, 1, size);
      const state = compileFanOut(size);

      const decision = resolveJoin(state, keys, statuses, need);
      const succeeded = statuses.filter((status) => status === "succeeded").length;
      const unsettled = statuses.filter((status) => !isSettled(status)).length;

      if (succeeded >= need) {
        expect(decision.kind).toBe("satisfied");
      } else if (succeeded + unsettled < need) {
        expect(decision.kind).toBe("failed");
      } else {
        expect(decision.kind).toBe("pending");
      }
    });
  });

  it("only ever asks the caller to cancel units that are still unsettled", () => {
    forEachCase(120, (random) => {
      const size = intBetween(random, 1, 8);
      const statuses = randomStatuses(random, size);
      const keys = statuses.map((_, index) => `unit-${index}`);
      const decision = resolveJoin(
        compileFanOut(size),
        keys,
        statuses,
        intBetween(random, 1, size)
      );
      if (decision.kind !== "satisfied") return;

      for (const key of decision.cancel) {
        const index = keys.indexOf(key);
        expect(isSettled(statuses[index] as WorkStatus)).toBe(false);
      }
    });
  });
});

describe("wait aggregation is monotone and never satisfied by nothing", () => {
  function wait(overrides: Partial<PersistedWait>): PersistedWait {
    return {
      id: "wait-1",
      businessId: "business-1",
      runId: "run-1",
      stateKey: "Approve",
      kind: "event",
      aggregation: "all",
      status: "pending",
      schemaRef: "schema-1",
      allowedPrincipals: ["user:user-1"],
      expectedSignals: 1,
      quorum: null,
      deadlineAt: "2026-07-25T11:00:00.000Z",
      createdAt: "2026-07-25T10:00:00.000Z",
      resolvedAt: null,
      version: 0,
      ...overrides,
    };
  }

  it("requires at least one signal for every aggregation", () => {
    forEachCase(40, (random) => {
      const expectedSignals = intBetween(random, 1, 6);
      const aggregation = pick(random, ["first", "all", "quorum", "window"] as const);
      const quorum = aggregation === "quorum" ? intBetween(random, 1, expectedSignals) : null;

      expect(isWaitSatisfied(wait({ aggregation, expectedSignals, quorum }), 0)).toBe(false);
    });
  });

  it("stays satisfied once satisfied, as further signals arrive", () => {
    forEachCase(40, (random) => {
      const expectedSignals = intBetween(random, 1, 6);
      const aggregation = pick(random, ["first", "all", "quorum", "window"] as const);
      const quorum = aggregation === "quorum" ? intBetween(random, 1, expectedSignals) : null;
      const persisted = wait({ aggregation, expectedSignals, quorum });

      let seenSatisfied = false;
      for (let count = 0; count <= expectedSignals + 2; count += 1) {
        const satisfied = isWaitSatisfied(persisted, count);
        if (seenSatisfied) expect(satisfied).toBe(true);
        seenSatisfied = seenSatisfied || satisfied;
      }
    });
  });

  it("never satisfies a quorum that `all` would not also satisfy", () => {
    forEachCase(40, (random) => {
      const expectedSignals = intBetween(random, 1, 6);
      const quorum = intBetween(random, 1, expectedSignals);
      const count = intBetween(random, 0, expectedSignals + 2);

      const all = isWaitSatisfied(wait({ aggregation: "all", expectedSignals }), count);
      const byQuorum = isWaitSatisfied(
        wait({ aggregation: "quorum", expectedSignals, quorum }),
        count
      );

      if (all) expect(byQuorum).toBe(true);
    });
  });

  it("never closes a window on signal count alone", () => {
    forEachCase(25, (random) => {
      const count = intBetween(random, 0, 20);

      expect(isWaitSatisfied(wait({ aggregation: "window", expectedSignals: 3 }), count)).toBe(
        false
      );
    });
  });
});

describe("branch selection is a function of its Context", () => {
  function compileBranch() {
    const states: routineSchema.RoutineState[] = [
      {
        type: "branch",
        name: "Decide",
        conditions: [
          { condition: "input.score > 10", transition: "High" },
          { condition: "input.score > 5", transition: "Medium" },
        ],
        default: { transition: "Low" },
      },
      { type: "agent", name: "High", agentRef: { name: "a", version: "1.0.0" }, end: true },
      { type: "agent", name: "Medium", agentRef: { name: "a", version: "1.0.0" }, end: true },
      { type: "agent", name: "Low", agentRef: { name: "a", version: "1.0.0" }, end: true },
    ];
    const compiled = compileRoutine(
      {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "01J0000000000000000000ROUT",
          slug: "branching",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "published",
        },
        spec: { owner: "platform", start: "Decide", states },
      } as routineSchema.RoutineDefinition,
      { identityCeiling: IDENTITY_CEILING }
    );
    const state = compiled.states.get("Decide");
    if (state === undefined) throw new Error("missing Decide");
    return state;
  }

  it("takes the first matching arm and repeats that choice for the same Context", () => {
    const state = compileBranch();

    forEachCase(80, (random) => {
      const score = intBetween(random, 0, 20);
      const scope = { input: { score } };

      const first = decideBranch(state, scope);
      expect(decideBranch(state, scope)).toEqual(first);

      const expected = score > 10 ? "High" : score > 5 ? "Medium" : "Low";
      expect(first.outcome).toEqual({ kind: "transition", target: expected });
    });
  });
});
