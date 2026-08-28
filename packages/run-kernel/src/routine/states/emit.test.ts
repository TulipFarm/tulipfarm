import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { RoutineInputResolutionError } from "../input";
import { DEFAULT_EMITTED_EVENT_VERSION, planEmit } from "./emit";
import { RoutineStepError } from "./step";
import { compileWithTargets, endAgent } from "./test-support";

function emit(
  event: { type: string; version?: number },
  input: Record<string, unknown> = { ticketId: "t-1" }
) {
  const state = {
    type: "emit",
    name: "Announce",
    event,
    input,
    transition: "Done",
  } as unknown as routineSchema.RoutineState;
  return compileWithTargets(state);
}

describe("planEmit", () => {
  it("announces the authored event type with its payload resolved", () => {
    expect(planEmit(emit({ type: "ticket.triaged", version: 2 }), {})).toEqual({
      eventType: "ticket.triaged",
      eventVersion: 2,
      data: { ticketId: "t-1" },
    });
  });

  it("defaults the version when the author pinned none", () => {
    expect(planEmit(emit({ type: "ticket.triaged" }), {}).eventVersion).toBe(
      DEFAULT_EMITTED_EVENT_VERSION
    );
  });

  it("evaluates the payload against the Run scope", () => {
    const state = emit({ type: "ticket.triaged" }, { label: "${lower(input.label)}" });

    expect(planEmit(state, { input: { label: "NEED-TRIAGE" } }).data).toEqual({
      label: "need-triage",
    });
  });

  it("refuses a payload mapping whose value is absent, rather than announcing undefined", () => {
    const state = emit({ type: "ticket.triaged" }, { label: "${input.absent}" });

    expect(() => planEmit(state, { input: {} })).toThrow(RoutineInputResolutionError);
  });

  it("refuses a State that is not an emit", () => {
    expect(() => planEmit(compileWithTargets(endAgent("Ask")), {})).toThrow(RoutineStepError);
  });
});
