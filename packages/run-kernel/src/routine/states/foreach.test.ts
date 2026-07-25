import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type CompiledState, compileRoutine, type IdentityCeiling } from "../compiler";
import {
  assertUnchangedCollection,
  type ForeachProgress,
  initForeachProgress,
  joinForeach,
  planForeach,
  resolveForeachItems,
  settleForeachItem,
} from "./foreach";
import { RoutineStepError } from "./step";

const identityCeiling: IdentityCeiling = {
  principalKind: "service",
  principalId: "triage-bot",
  grants: ["github:issues:write"],
  maxRiskClass: "low",
};

function agent(name: string): routineSchema.RoutineState {
  return { type: "agent", name, agentRef: { name: "triage", version: "1.0.0" }, end: true };
}

function foreach(maxItems: number, maxConcurrency: number): CompiledState {
  const fan: routineSchema.RoutineState = {
    type: "foreach",
    name: "Fan",
    items: "input.rows",
    body: "Work",
    maxItems,
    maxConcurrency,
    transition: "Done",
  };
  const compiled = compileRoutine(
    {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Routine",
      metadata: {
        id: "01J0000000000000000000ROUT",
        slug: "fan-each",
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: { owner: "platform", start: "Fan", states: [fan, agent("Work"), agent("Done")] },
    } as routineSchema.RoutineDefinition,
    { identityCeiling }
  );
  const state = compiled.states.get("Fan");
  if (state === undefined) throw new Error("missing Fan");
  return state;
}

const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe("resolveForeachItems", () => {
  it("resolves the authored collection expression deterministically", () => {
    const state = foreach(10, 2);

    expect(resolveForeachItems(state, { input: { rows } })).toEqual(rows);
  });

  it("fails closed when the collection expression did not yield an array", () => {
    const state = foreach(10, 2);

    expect(() => resolveForeachItems(state, { input: { rows: "nope" } })).toThrow(
      new RoutineStepError("collection_not_array", "Fan")
    );
    expect(() => resolveForeachItems(state, { input: {} })).toThrow(
      new RoutineStepError("collection_not_array", "Fan")
    );
  });

  it("refuses a collection larger than the compiled item bound", () => {
    const state = foreach(2, 2);

    expect(() => resolveForeachItems(state, { input: { rows } })).toThrow(
      new RoutineStepError("item_cap_exceeded", "Fan")
    );
  });

  it("never leaks collection contents in the error message", () => {
    const state = foreach(1, 2);

    try {
      resolveForeachItems(state, { input: { rows: ["sk-live-abcdef", "b"] } });
      throw new Error("expected denial");
    } catch (error) {
      expect((error as RoutineStepError).message).toBe("item_cap_exceeded:Fan");
    }
  });
});

describe("planForeach", () => {
  it("pins the collection at fan-out so later steps iterate an immutable snapshot", () => {
    const state = foreach(10, 2);
    const progress = initForeachProgress(state, rows);

    expect(progress.total).toBe(3);
    expect(progress.itemsDigest).toBe(initForeachProgress(state, rows).itemsDigest);
    expect(() => initForeachProgress(state, [{ id: 1 }])).not.toThrow();
  });

  it("dispatches item indices in order, bounded by the concurrency cap", () => {
    const state = foreach(10, 2);

    expect(planForeach(state, initForeachProgress(state, rows))).toEqual({
      dispatch: [0, 1],
      settled: false,
    });
  });

  it("resumes after a crash without repeating settled or in-flight items", () => {
    const state = foreach(10, 2);
    const crashed: ForeachProgress = {
      total: 3,
      itemsDigest: initForeachProgress(state, rows).itemsDigest,
      entries: ["succeeded", "running", "pending"],
    };

    expect(planForeach(state, crashed).dispatch).toEqual([2]);
  });

  it("fails closed if the collection changed between attempts", () => {
    const state = foreach(10, 2);
    const progress = initForeachProgress(state, rows);

    expect(() => assertUnchangedCollection(state, progress, rows)).not.toThrow();
    expect(() =>
      assertUnchangedCollection(state, progress, [{ id: 9 }, { id: 2 }, { id: 3 }])
    ).toThrow(new RoutineStepError("collection_changed", "Fan"));
  });
});

describe("settleForeachItem and joinForeach", () => {
  it("records item results immutably and is idempotent on replay", () => {
    const state = foreach(10, 2);
    const progress = settleForeachItem(state, initForeachProgress(state, rows), 0, "succeeded");

    expect(progress.entries).toEqual(["succeeded", "pending", "pending"]);
    expect(settleForeachItem(state, progress, 0, "succeeded")).toEqual(progress);
    expect(() => settleForeachItem(state, progress, 0, "running")).toThrow(
      new RoutineStepError("item_already_settled", "Fan")
    );
    expect(() => settleForeachItem(state, progress, 7, "succeeded")).toThrow(
      new RoutineStepError("unknown_item", "Fan")
    );
  });

  it("joins only when every item succeeded, and fails as soon as one item failed", () => {
    const state = foreach(10, 2);
    const base = initForeachProgress(state, rows);

    expect(joinForeach(state, base)).toEqual({ kind: "pending" });
    expect(
      joinForeach(state, { ...base, entries: ["succeeded", "succeeded", "succeeded"] })
    ).toEqual({
      kind: "satisfied",
      outcome: { kind: "transition", target: "Done" },
      cancel: [],
    });
    expect(joinForeach(state, { ...base, entries: ["succeeded", "failed", "running"] })).toEqual({
      kind: "failed",
      failures: ["1"],
    });
  });
});
