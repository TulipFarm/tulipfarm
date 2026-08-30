import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, test } from "vitest";
import type { RoutineSummary, RoutineTrigger } from "../routines";
import {
  groupByTriggerKind,
  matchesRoutineQuery,
  riskLabel,
  riskTone,
  routineEffects,
  routineFacts,
  runHealth,
  triggerKind,
  triggerPhrase,
} from "./facts";

function definition(
  states: routineSchema.RoutineDefinition["spec"]["states"],
  spec: Partial<routineSchema.RoutineDefinition["spec"]> = {}
): routineSchema.RoutineDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "demo",
      displayName: "Demo",
      schemaVersion: 1,
      authoredVersion: 3,
      lifecycle: "active",
    },
    spec: { owner: "user:owner", start: states[0].name, states, ...spec },
  };
}

describe("triggers", () => {
  test("every trigger type lands in one of the four kinds a person recognises", () => {
    expect(triggerKind({ type: "interval" })).toBe("schedule");
    expect(triggerKind({ type: "cron" })).toBe("schedule");
    expect(triggerKind({ type: "webhook" })).toBe("request");
    expect(triggerKind({ type: "manual" })).toBe("human");
  });

  test("an unknown trigger type is a request, never a crash", () => {
    expect(triggerKind({ type: "something-new" })).toBe("request");
  });

  test("the phrase prefers the author's own summary over the type name", () => {
    const trigger: RoutineTrigger = {
      slug: "nightly",
      type: "cron",
      summary: "Every weekday at 09:00",
    };
    expect(triggerPhrase(trigger)).toContain("Every weekday at 09:00");
    expect(triggerPhrase({ slug: "manual", type: "manual", summary: "manual" })).toBe(
      "Started by hand"
    );
  });
});

describe("effects", () => {
  test("one row per consequence, in state order, keeping repeats apart", () => {
    const effects = routineEffects(
      definition([
        {
          type: "tool",
          name: "Notify",
          toolRef: { name: "slack", version: "1" },
          action: "post",
          transition: "NotifyAgain",
        },
        {
          type: "tool",
          name: "NotifyAgain",
          toolRef: { name: "slack", version: "1" },
          action: "post",
          end: true,
        },
      ])
    );
    expect(effects).toHaveLength(2);
    expect(effects.map((effect) => effect.state)).toEqual(["Notify", "NotifyAgain"]);
    expect(effects[0].kind).toBe("tool");
  });

  test("a routine that only computes reaches nothing", () => {
    const effects = routineEffects(
      definition([{ type: "compute", name: "Derive", input: {}, end: true }])
    );
    expect(effects).toEqual([]);
  });

  test("a step that needs a person is an effect, because the run stops there", () => {
    const effects = routineEffects(
      definition([
        {
          type: "approval",
          name: "Sign off",
          approverRoles: ["finance"],
          transition: "Done",
        },
        { type: "compute", name: "Done", input: {}, end: true },
      ])
    );
    expect(effects.map((effect) => effect.kind)).toContain("human");
  });
});

describe("facts", () => {
  const facts = routineFacts(
    definition([
      {
        type: "tool",
        name: "Charge",
        toolRef: { name: "stripe", version: "1" },
        action: "charge",
        credentialRef: "stripe-live",
        retry: { maxAttempts: 3, backoffMs: 100 },
        onError: [{ errorRef: "any", transition: "Refund" }],
        transition: "Done",
      },
      { type: "compute", name: "Refund", input: {}, end: true },
      { type: "compute", name: "Done", input: {}, end: true },
    ])
  );

  test("names the secret a tool step leases, so a reader can see what is unlocked", () => {
    expect(facts.credentials).toEqual(["stripe-live"]);
  });

  test("separates the steps that retry from the steps that catch", () => {
    expect(facts.retryingStates).toEqual(["Charge"]);
    expect(facts.guardedStates).toEqual(["Charge"]);
  });

  test("lists every exit, not just the first", () => {
    expect(facts.terminalStates).toEqual(["Refund", "Done"]);
  });
});

describe("risk", () => {
  /*
   * The inversion that matters: a routine declaring no ceiling is *less* constrained than one
   * declaring `high`, so an undeclared ceiling must never render as the calmest thing on screen.
   */
  test("an undeclared ceiling warns rather than reading as low", () => {
    expect(riskTone(null)).toBe("warning");
    expect(riskLabel(null)).toMatch(/no risk ceiling/i);
    expect(riskTone("low")).toBe("neutral");
  });

  test("the ceiling is the highest any single step declares", () => {
    const facts = routineFacts(
      definition([
        {
          type: "tool",
          name: "A",
          toolRef: { name: "t", version: "1" },
          action: "a",
          permissionCeiling: { maxRiskClass: "low" },
          transition: "B",
        },
        {
          type: "tool",
          name: "B",
          toolRef: { name: "t", version: "1" },
          action: "b",
          permissionCeiling: { maxRiskClass: "high" },
          end: true,
        },
      ])
    );
    expect(facts.maxRiskClass).toBe("high");
  });
});

describe("health", () => {
  test("never run is its own state, not a success and not a failure", () => {
    expect(runHealth(undefined)).toBe("never-run");
    expect(runHealth({ status: "succeeded" })).toBe("healthy");
    expect(runHealth({ status: "failed" })).toBe("failing");
  });
});

describe("catalog", () => {
  const routine = (over: Partial<RoutineSummary>): RoutineSummary => ({
    id: "id",
    slug: "expense-report",
    displayName: "Expense report",
    authoredVersion: 1,
    triggers: [],
    summary: {
      owner: "user:finance",
      stateCount: 1,
      stateTypes: ["compute"],
      effects: [],
      toolAbilities: [],
      maxRiskClass: null,
      requiresApproval: false,
      concurrencyPolicy: null,
      compensationPolicy: null,
    },
    ...over,
  });

  test("search reaches the slug and the owner, not only the display name", () => {
    expect(matchesRoutineQuery(routine({}), "expense")).toBe(true);
    expect(matchesRoutineQuery(routine({}), "finance")).toBe(true);
    expect(matchesRoutineQuery(routine({}), "nothing-like-this")).toBe(false);
  });

  test("an untriggered routine is grouped as such rather than dropped", () => {
    const groups = new Map(groupByTriggerKind([routine({})]));
    expect(groups.get("untriggered")).toHaveLength(1);
  });

  /*
   * Filed once, under its first kind in group order. A catalog whose group totals exceed its item
   * count cannot be counted by eye, and the row lists every trigger anyway.
   */
  test("a routine with two kinds of trigger is filed once, not twice", () => {
    const groups = groupByTriggerKind([
      routine({
        triggers: [
          { slug: "a", type: "cron", summary: "0 9 * * 1" },
          { slug: "b", type: "webhook", summary: "POST /hook" },
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0][0]).toBe("schedule");
  });
});
