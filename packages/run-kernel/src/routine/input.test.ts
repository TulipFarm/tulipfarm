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
        conditions: [{ condition: 'input.region == "never"', end: true }],
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

/**
 * An expression surrounded by text used to compile to a literal, so a Routine sent the text of its
 * own expression to a provider — a Slack message reading `stars: ${states.Count.output.n}`.
 */
describe("resolveRoutineStateInput with interpolated strings", () => {
  function notifyState(text: string) {
    const compiled = compileStates(
      [
        {
          type: "action",
          name: "Notify",
          action: "send_slack_message",
          input: { text },
          end: true,
        },
      ],
      "Notify"
    ).states.get("Notify");
    if (compiled === undefined) throw new Error("missing Notify");
    return compiled;
  }

  const scope = { input: { stars: 7, repo: "tulipfarm", nothing: null, shape: { a: 1 } } };

  it("substitutes an expression that sits inside surrounding text", () => {
    expect(
      resolveRoutineStateInput(notifyState("TulipFarm stars: ${ input.stars } (ok)"), scope)
    ).toEqual({ text: "TulipFarm stars: 7 (ok)" });
  });

  it("substitutes every expression in the string", () => {
    expect(
      resolveRoutineStateInput(notifyState("${ input.repo } has ${ input.stars } stars"), scope)
    ).toEqual({ text: "tulipfarm has 7 stars" });
  });

  it("keeps a whole-string expression's own type so a number stays a number", () => {
    expect(resolveRoutineStateInput(notifyState("${ input.stars }"), scope)).toEqual({ text: 7 });
  });

  it("leaves an escaped placeholder as text", () => {
    expect(resolveRoutineStateInput(notifyState("$${ input.stars }"), scope)).toEqual({
      text: "${ input.stars }",
    });
  });

  it("refuses rather than writing null or [object Object] into the message", () => {
    for (const text of ["got ${ input.nothing }", "got ${ input.shape }"]) {
      expect(() => resolveRoutineStateInput(notifyState(text), scope)).toThrow(
        new RoutineInputResolutionError("input_not_evaluable", "Notify")
      );
    }
  });
});
