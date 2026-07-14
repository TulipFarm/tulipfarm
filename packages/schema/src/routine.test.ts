import { describe, expect, it } from "vitest";
import { TulipFarmValidationError } from "./error";
import { type RoutineDefinition, validateRoutineDefinition } from "./routine";

function baseRoutine(): Record<string, unknown> {
  return {
    id: "reimbursement-approval",
    version: "1.0",
    name: "Reimbursement Approval",
    start: "CheckAmount",
    "x-triggers": [{ type: "manual" }],
    functions: [
      { name: "createRecord", operation: "tool:resource_create" },
      { name: "notify", operation: "agent:general-assistant" },
      { name: "computeTotal", operation: "hook:computeTotal" },
    ],
    retries: [{ name: "default", maxAttempts: 3, delay: "PT5S", multiplier: 2 }],
    states: [
      {
        name: "CheckAmount",
        type: "switch",
        dataConditions: [{ condition: "context.amount > 500", transition: "NeedsApproval" }],
        defaultCondition: { transition: "Record" },
      },
      {
        name: "NeedsApproval",
        type: "operation",
        "x-autonomy-level": "human_approval",
        "x-approval-channel": ["ui", "slack"],
        actions: [{ functionRef: { refName: "notify", arguments: { task: "review" } } }],
        transition: "Record",
      },
      {
        name: "Wait",
        type: "sleep",
        duration: "PT10M",
        transition: "Record",
      },
      {
        name: "Seed",
        type: "inject",
        data: { approved: true },
        transition: "Record",
      },
      {
        name: "Record",
        type: "foreach",
        inputCollection: "context.items",
        iterationParam: "item",
        actions: [
          {
            functionRef: { refName: "createRecord" },
            retryRef: "default",
            actionDataFilter: { results: "result.id", toStateData: "context.lastId" },
          },
        ],
        end: true,
      },
    ],
  };
}

describe("validateRoutineDefinition", () => {
  it("accepts a valid routine using all five V1 state types", () => {
    const def: RoutineDefinition = validateRoutineDefinition(baseRoutine());
    expect(def.id).toBe("reimbursement-approval");
    expect(def.states).toHaveLength(5);
  });

  it("accepts all five V1 trigger types", () => {
    const routine = baseRoutine();
    routine["x-triggers"] = [
      { type: "manual" },
      { type: "cron", schedule: "0 9 * * 1", timezone: "UTC" },
      { type: "webhook", secret_ref: "my-hook-secret" },
      { type: "event", event: "resource.created", filter: "trigger.payload.resourceType === 'x'" },
      { type: "agent" },
    ];
    expect(() => validateRoutineDefinition(routine)).not.toThrow();
  });

  it("rejects a parallel state with a deferred-in-V1 error and JSON pointer", () => {
    const routine = baseRoutine();
    (routine.states as unknown[]).push({ name: "Fan", type: "parallel", branches: [] });
    expect(() => validateRoutineDefinition(routine)).toThrowError(/deferred in V1/);
    try {
      validateRoutineDefinition(routine);
    } catch (err) {
      expect(err).toBeInstanceOf(TulipFarmValidationError);
      expect((err as TulipFarmValidationError).path).toBe("/states/5/type");
    }
  });

  it("rejects an event state as deferred", () => {
    const routine = baseRoutine();
    (routine.states as unknown[]).push({ name: "Park", type: "event", onEvents: [] });
    expect(() => validateRoutineDefinition(routine)).toThrowError(/deferred in V1/);
  });

  it("rejects subFlowRef (sub-routine) as deferred", () => {
    const routine = baseRoutine();
    const states = routine.states as Array<Record<string, unknown>>;
    const needsApproval = states[1];
    (needsApproval.actions as unknown[]).push({ subFlowRef: "other-routine" });
    expect(() => validateRoutineDefinition(routine)).toThrowError(/deferred in V1/);
  });

  it("rejects datetime and integration triggers as deferred", () => {
    for (const type of ["datetime", "integration"]) {
      const routine = baseRoutine();
      routine["x-triggers"] = [{ type }];
      expect(() => validateRoutineDefinition(routine)).toThrowError(/deferred in V1/);
    }
  });

  it("accepts an integration.event trigger with a filter", () => {
    const routine = baseRoutine();
    routine["x-triggers"] = [
      {
        type: "event",
        event: "integration.event",
        filter:
          "trigger.payload.integration === 'slack' && trigger.payload.event === 'member_joined_channel'",
      },
    ];
    expect(() => validateRoutineDefinition(routine)).not.toThrow();
  });

  it("rejects an unknown event name on an event trigger", () => {
    const routine = baseRoutine();
    routine["x-triggers"] = [{ type: "event", event: "nonexistent.event" }];
    expect(() => validateRoutineDefinition(routine)).toThrow(TulipFarmValidationError);
  });

  it("rejects a webhook trigger without secret_ref", () => {
    const routine = baseRoutine();
    routine["x-triggers"] = [{ type: "webhook" }];
    expect(() => validateRoutineDefinition(routine)).toThrow(TulipFarmValidationError);
  });

  it("rejects a start state that does not exist", () => {
    const routine = baseRoutine();
    routine.start = "Nope";
    expect(() => validateRoutineDefinition(routine)).toThrowError(/start state "Nope" not found/);
  });

  it("rejects a dangling transition target", () => {
    const routine = baseRoutine();
    const states = routine.states as Array<Record<string, unknown>>;
    states[2].transition = "Ghost";
    expect(() => validateRoutineDefinition(routine)).toThrowError(/"Ghost" not found/);
  });

  it("rejects an action referencing an unknown function", () => {
    const routine = baseRoutine();
    const states = routine.states as Array<Record<string, unknown>>;
    (states[1].actions as Array<Record<string, unknown>>)[0] = {
      functionRef: { refName: "missingFn" },
    };
    expect(() => validateRoutineDefinition(routine)).toThrowError(/"missingFn" not found/);
  });

  it("rejects an unknown retryRef", () => {
    const routine = baseRoutine();
    const states = routine.states as Array<Record<string, unknown>>;
    const action = (states[4].actions as Array<Record<string, unknown>>)[0];
    action.retryRef = "aggressive";
    expect(() => validateRoutineDefinition(routine)).toThrowError(/"aggressive" not found/);
  });

  it("rejects human_approval on a non-operation state", () => {
    const routine = baseRoutine();
    const states = routine.states as Array<Record<string, unknown>>;
    states[2]["x-autonomy-level"] = "human_approval";
    expect(() => validateRoutineDefinition(routine)).toThrowError(/only valid on operation/);
  });

  it("rejects a bad function operation format", () => {
    const routine = baseRoutine();
    (routine.functions as unknown[]).push({ name: "bad", operation: "shell:rm -rf" });
    expect(() => validateRoutineDefinition(routine)).toThrow(TulipFarmValidationError);
  });

  it("rejects malformed ISO durations", () => {
    const routine = baseRoutine();
    const states = routine.states as Array<Record<string, unknown>>;
    states[2].duration = "10 minutes";
    expect(() => validateRoutineDefinition(routine)).toThrow(TulipFarmValidationError);
  });

  it("rejects unknown top-level keys", () => {
    const routine = baseRoutine();
    routine.bogus = true;
    expect(() => validateRoutineDefinition(routine)).toThrow(TulipFarmValidationError);
  });

  it("accepts email/sms approval channels at schema level (runtime falls back to ui)", () => {
    const routine = baseRoutine();
    const states = routine.states as Array<Record<string, unknown>>;
    states[1]["x-approval-channel"] = ["email", "sms"];
    expect(() => validateRoutineDefinition(routine)).not.toThrow();
  });
});
