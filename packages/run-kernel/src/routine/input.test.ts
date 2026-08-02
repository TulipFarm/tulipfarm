import { describe, expect, it } from "vitest";
import { RoutineInputResolutionError, resolveRoutineStateInput } from "./input";
import { compileStates } from "./states/test-support";

const MAPPED_INPUT = `\${ input.region }`;

function mappedState() {
  const compiled = compileStates(
    [
      {
        type: "branch",
        name: "Map",
        input: { literal: "fixed", region: MAPPED_INPUT },
        default: { end: true },
      },
    ],
    "Map"
  ).states.get("Map");
  if (compiled === undefined) throw new Error("missing Map");
  return compiled;
}

describe("resolveRoutineStateInput", () => {
  it("resolves literal and expression mappings deterministically", () => {
    expect(resolveRoutineStateInput(mappedState(), { input: { region: "west" } })).toEqual({
      literal: "fixed",
      region: "west",
    });
  });

  it("fails closed without putting a missing value in persisted input", () => {
    expect(() => resolveRoutineStateInput(mappedState(), { input: {} })).toThrow(
      new RoutineInputResolutionError("input_not_evaluable", "Map")
    );
  });
});
