import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { RoutineInputResolutionError } from "../input";
import { computeStateOutput } from "./compute";
import { RoutineStepError } from "./step";
import { compileWithTargets, endAgent } from "./test-support";

function compute(
  input: Record<string, unknown>,
  before: readonly routineSchema.RoutineState[] = []
) {
  const state = {
    type: "compute",
    name: "Derive",
    input,
    transition: "Done",
  } as unknown as routineSchema.RoutineState;
  return compileWithTargets(state, before);
}

describe("computeStateOutput", () => {
  it("publishes authored literals verbatim", () => {
    expect(computeStateOutput(compute({ label: "need-triage", priority: 2 }), {})).toEqual({
      label: "need-triage",
      priority: 2,
    });
  });

  it("evaluates expressions against the Run scope, so a Trigger's mapped input reaches it", () => {
    const state = compute({
      isBug: "${contains(lower(input.title), 'bug')}",
      slug: "${lower(trim(input.title))}",
    });

    expect(computeStateOutput(state, { input: { title: "  BUG in checkout " } })).toEqual({
      isBug: true,
      slug: "bug in checkout",
    });
  });

  it("reads an earlier compute State's output", () => {
    const first = {
      type: "compute",
      name: "First",
      input: { label: "need-triage" },
      transition: "Derive",
    } as unknown as routineSchema.RoutineState;

    const second = compute({ echoed: "${states.First.output.label}" }, [first]);

    expect(
      computeStateOutput(second, { states: { First: { output: { label: "need-triage" } } } })
    ).toEqual({ echoed: "need-triage" });
  });

  it("refuses to resolve a mapping whose value is absent, rather than assigning undefined", () => {
    const state = compute({ missing: "${input.absent}" });

    expect(() => computeStateOutput(state, { input: {} })).toThrow(RoutineInputResolutionError);
  });

  it("refuses a State that is not a compute", () => {
    expect(() => computeStateOutput(compileWithTargets(endAgent("Ask")), {})).toThrow(
      RoutineStepError
    );
  });
});
