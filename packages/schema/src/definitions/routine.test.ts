import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors";
import { ROUTINE_STATE_TYPES, type RoutineDefinition, validateRoutineDefinition } from "./routine";

const apiVersion = "tulipfarm.ai/v1";
const kind = "Routine";
const metadata = {
  id: "77777777-7777-4777-8777-777777777777",
  slug: "issue-triage",
  schemaVersion: 1,
  authoredVersion: 1,
  lifecycle: "draft",
};

function routine(states: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    apiVersion,
    kind,
    metadata,
    spec: {
      owner: "team-platform",
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: false },
      start: states[0]?.name,
      states,
    },
  };
}

const agentState = {
  type: "agent",
  name: "Classify",
  agentRef: { name: "triager", version: "1.0.0" },
  output: { type: "object", additionalProperties: false },
  end: true,
};

describe("Routine schema", () => {
  it("accepts a minimal agent+tool routine graph", () => {
    const result: RoutineDefinition = validateRoutineDefinition(
      routine([
        {
          type: "agent",
          name: "Classify",
          agentRef: { name: "t", version: "1" },
          transition: "Label",
        },
        {
          type: "tool",
          name: "Label",
          toolRef: { name: "gh", version: "1" },
          action: "add_label",
          end: true,
        },
      ])
    ).document;
    expect(result.spec.states).toHaveLength(2);
    expect(ROUTINE_STATE_TYPES).toContain("repeat_until");
  });

  it("rejects plain credentialRef values on Tool states", () => {
    expect(() =>
      validateRoutineDefinition(
        routine([
          {
            type: "tool",
            name: "Label",
            toolRef: { name: "gh", version: "1" },
            action: "add_label",
            credentialRef: "github-installation",
            end: true,
          },
        ])
      )
    ).toThrow(SchemaValidationError);
  });

  it("exposes every SPEC §9.1 typed state type", () => {
    expect([...ROUTINE_STATE_TYPES].sort()).toEqual(
      [
        "agent",
        "approval",
        "branch",
        "child_routine",
        "compensate",
        "foreach",
        "form",
        "human_task",
        "parallel",
        "repeat_until",
        "tool",
        "wait",
      ].sort()
    );
  });

  it("rejects an unbounded foreach fan-out (missing concurrency cap or item bound)", () => {
    const missingConcurrency = {
      type: "foreach",
      name: "FanOut",
      items: "output.items",
      maxItems: 100,
      end: true,
    };
    expect(() => validateRoutineDefinition(routine([missingConcurrency]))).toThrow(
      SchemaValidationError
    );

    const missingItems = {
      type: "foreach",
      name: "FanOut",
      items: "output.items",
      maxConcurrency: 4,
      end: true,
    };
    expect(() => validateRoutineDefinition(routine([missingItems]))).toThrow(SchemaValidationError);

    const bounded = {
      type: "foreach",
      name: "FanOut",
      items: "output.items",
      maxItems: 100,
      maxConcurrency: 4,
      end: true,
    };
    expect(() => validateRoutineDefinition(routine([bounded]))).not.toThrow();
  });

  it("rejects an unbounded repeat_until loop (missing iteration or duration bound)", () => {
    const missingIterations = {
      type: "repeat_until",
      name: "Poll",
      condition: "output.done",
      maxDurationMs: 60000,
      end: true,
    };
    expect(() => validateRoutineDefinition(routine([missingIterations]))).toThrow(
      SchemaValidationError
    );

    const bounded = {
      type: "repeat_until",
      name: "Poll",
      condition: "output.done",
      maxIterations: 10,
      maxDurationMs: 60000,
      end: true,
    };
    expect(() => validateRoutineDefinition(routine([bounded]))).not.toThrow();
  });

  it("rejects an unbounded parallel fan-out (missing concurrency cap)", () => {
    const unbounded = {
      type: "parallel",
      name: "Split",
      branches: ["A", "B"],
      end: true,
    };
    expect(() => validateRoutineDefinition(routine([unbounded]))).toThrow(SchemaValidationError);
  });

  it("rejects an unbounded retry policy (missing or oversized maxAttempts)", () => {
    const missingMax = {
      ...agentState,
      retry: { backoffMs: 1000 },
    };
    expect(() => validateRoutineDefinition(routine([missingMax]))).toThrow(SchemaValidationError);

    const oversized = {
      ...agentState,
      retry: { maxAttempts: 10_000 },
    };
    expect(() => validateRoutineDefinition(routine([oversized]))).toThrow(SchemaValidationError);

    const bounded = { ...agentState, retry: { maxAttempts: 3, backoffMs: 1000 } };
    expect(() => validateRoutineDefinition(routine([bounded]))).not.toThrow();
  });

  it("rejects unknown state types and unknown state properties", () => {
    expect(() =>
      validateRoutineDefinition(routine([{ type: "goto", name: "Bad", end: true }]))
    ).toThrow(SchemaValidationError);

    expect(() => validateRoutineDefinition(routine([{ ...agentState, smuggled: true }]))).toThrow(
      SchemaValidationError
    );
  });

  it("requires at least one state", () => {
    const empty = routine([]);
    (empty.spec as Record<string, unknown>).start = "Only";
    expect(() => validateRoutineDefinition(empty)).toThrow(SchemaValidationError);
  });

  it("requires a start state reference", () => {
    const doc = routine([agentState]);
    delete (doc.spec as Record<string, unknown>).start;
    expect(() => validateRoutineDefinition(doc)).toThrow(SchemaValidationError);
  });

  it("requires canonical definition metadata and Routine ownership", () => {
    const missingOwner = routine([agentState]);
    delete (missingOwner.spec as Record<string, unknown>).owner;
    expect(() => validateRoutineDefinition(missingOwner)).toThrow(SchemaValidationError);

    const legacyMetadata = routine([agentState]);
    legacyMetadata.metadata = { name: "issue-triage" };
    expect(() => validateRoutineDefinition(legacyMetadata)).toThrow(SchemaValidationError);
  });

  it("accepts explicit State authority and evidence controls", () => {
    const controlled = {
      ...agentState,
      identity: { principalKind: "agent", principalId: "triager" },
      permissionCeiling: { grants: ["ticket.read"], maxRiskClass: "low" },
      retention: { resultDays: 30, evidenceDays: 365 },
      observability: { level: "standard", captureInputs: false, captureOutputs: true },
    };
    expect(() => validateRoutineDefinition(routine([controlled]))).not.toThrow();
  });

  it("fails closed for the wrong kind discriminator", () => {
    const doc = routine([agentState]);
    doc.kind = "Trigger";
    expect(() => validateRoutineDefinition(doc)).toThrow();
  });
});
