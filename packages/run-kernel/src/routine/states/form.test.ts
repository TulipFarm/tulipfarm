import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { TypedOutputValidator } from "../../outputs";
import { planFormWait, resolveFormExpiry, resolveFormSubmission } from "./form";
import { RoutineStepError } from "./step";
import { compileStates, endAgent } from "./test-support";

const ctx = {
  businessId: "biz",
  runId: "run-1",
  waitId: "wait-1",
  now: "2026-07-25T10:00:00.000Z",
};

const schema = {
  type: "object",
  required: ["amount"],
  additionalProperties: false,
  properties: { amount: { type: "number" } },
};

function formRoutine(extra: Record<string, unknown> = {}) {
  const state: routineSchema.RoutineState = {
    type: "form",
    name: "Collect",
    formRef: { name: "expense", version: "1.0.0" },
    output: schema,
    deadlineMs: 900_000,
    transition: "Done",
    ...extra,
  };
  const handled = Array.isArray(state.onError) ? [endAgent("Fix")] : [];
  const compiled = compileStates([state, endAgent("Done"), ...handled], "Collect");
  const collect = compiled.states.get("Collect");
  if (collect === undefined) throw new Error("missing Collect");
  return { compiled, state: collect, validator: new TypedOutputValidator(compiled.outputSchemas) };
}

describe("planFormWait", () => {
  it("opens a bounded form wait whose schema reference is the State's own output schema", () => {
    const { compiled, state } = formRoutine();
    const input = planFormWait(state, { ...ctx, principals: ["user:u1"] });

    expect(input.kind).toBe("form");
    expect(input.schemaRef).toBe(`${compiled.digest}#/states/Collect/output`);
    expect(input.allowedPrincipals).toEqual(["user:u1"]);
    expect(input.deadlineAt).toBe("2026-07-25T10:15:00.000Z");
  });

  it("refuses a form wait that names no authorized submitter", () => {
    const { state } = formRoutine();

    expect(() => planFormWait(state, { ...ctx, principals: [] })).toThrow(
      new RoutineStepError("principals_not_declared", "Collect")
    );
  });
});

describe("resolveFormSubmission", () => {
  it("validates the submission against the declared schema before continuing", () => {
    const { state, validator } = formRoutine();
    const decision = resolveFormSubmission(state, validator, { amount: 42 });

    expect(decision).toEqual({
      kind: "continue",
      outcome: { kind: "transition", target: "Done" },
    });
  });

  it("fails a submission that does not satisfy the schema, without echoing it back", () => {
    const { state, validator } = formRoutine();

    expect(resolveFormSubmission(state, validator, { amount: "sk-live-abcdef" })).toEqual({
      kind: "failed",
      errorRef: "form_invalid",
    });
  });

  it("routes an invalid submission through an authored handler when one exists", () => {
    const { state, validator } = formRoutine({
      onError: [{ errorRef: "form_invalid", transition: "Fix" }],
    });

    expect(resolveFormSubmission(state, validator, { amount: "nope" })).toEqual({
      kind: "handled",
      errorRef: "form_invalid",
      outcome: { kind: "transition", target: "Fix" },
    });
  });

  it("refuses a form State that declared no output schema to validate against", () => {
    const { state, validator } = formRoutine({ output: undefined });

    expect(() => resolveFormSubmission(state, validator, { amount: 1 })).toThrow(
      new RoutineStepError("output_schema_not_declared", "Collect")
    );
  });

  it("parks an expired form for attention", () => {
    const { state } = formRoutine();

    expect(resolveFormExpiry(state)).toEqual({ kind: "attention", errorRef: "wait_expired" });
  });
});
