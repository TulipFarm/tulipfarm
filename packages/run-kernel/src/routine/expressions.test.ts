import { describe, expect, it } from "vitest";
import {
  compileExpression,
  ExpressionError,
  parseTemplate,
  renderInterpolated,
} from "./expressions";

const scope = {
  input: { issue: { id: 42, title: "Crash on save", labels: ["bug", "p1"] } },
  states: { Classify: { output: { label: "bug", score: 0.91 } } },
};

describe("compileExpression", () => {
  it("evaluates a deterministic comparison over prior typed outputs", () => {
    const expr = compileExpression('states.Classify.output.label == "bug"');

    expect(expr.evaluate(scope)).toBe(true);
  });

  it("records the static references it reads so the compiler can prove them", () => {
    const expr = compileExpression(
      "states.Classify.output.score > 0.5 && len(input.issue.labels) > 1"
    );

    expect(expr.references).toEqual(["input.issue.labels", "states.Classify.output.score"]);
    expect(expr.evaluate(scope)).toBe(true);
  });

  it("is pure: the same source and scope always produce the same value", () => {
    const expr = compileExpression("input.issue.id * 2 + 1");

    expect(expr.evaluate(scope)).toBe(85);
    expect(expr.evaluate(scope)).toBe(85);
  });

  it("resolves a missing property to undefined instead of throwing", () => {
    expect(compileExpression("input.issue.missing").evaluate(scope)).toBeUndefined();
    expect(compileExpression('coalesce(input.issue.missing, "none")').evaluate(scope)).toBe("none");
  });

  it("rejects an unknown root so an expression cannot reach ambient state", () => {
    expect(() => compileExpression("process.env.SECRET")).toThrow(
      new ExpressionError("expression_unknown_root", "process")
    );
  });

  // A Trigger's payload crosses into a Run only through its `inputMapping`, so reading the
  // envelope here would bypass that allowlist — and did nothing but park the Run on its first tick.
  it("rejects the trigger root, which only an inputMapping may cross into a Run", () => {
    expect(() => compileExpression("trigger.scheduledTime")).toThrow(
      new ExpressionError("expression_unknown_root", "trigger")
    );
  });

  it("rejects prototype-reaching property access", () => {
    expect(() => compileExpression("input.__proto__.polluted")).toThrow(
      new ExpressionError("expression_forbidden_property", "__proto__")
    );
    expect(() => compileExpression("input.constructor")).toThrow(ExpressionError);
  });

  it("rejects a non-deterministic or unknown function rather than evaluating it", () => {
    expect(() => compileExpression("now()")).toThrow(
      new ExpressionError("expression_unknown_function", "now")
    );
    expect(() => compileExpression("random()")).toThrow(ExpressionError);
  });

  it("rejects assignment, sequencing, and other statement syntax", () => {
    expect(() => compileExpression("input.a = 1")).toThrow(ExpressionError);
    expect(() => compileExpression("input.a; input.b")).toThrow(ExpressionError);
  });

  it("bounds source length and nesting depth", () => {
    expect(() => compileExpression(`"${"x".repeat(2_000)}"`)).toThrow(
      new ExpressionError("expression_too_long", "")
    );
    expect(() => compileExpression(`${"(".repeat(64)}1${")".repeat(64)}`)).toThrow(
      new ExpressionError("expression_depth_exceeded", "")
    );
  });

  it("denies division by zero explicitly instead of yielding Infinity", () => {
    expect(() => compileExpression("1 / 0").evaluate(scope)).toThrow(
      new ExpressionError("expression_type", "divide_by_zero")
    );
  });

  it("never leaks evaluated values in an error message", () => {
    try {
      compileExpression("secretRoot.token");
      throw new Error("expected denial");
    } catch (error) {
      expect((error as ExpressionError).message).toBe("expression_unknown_root:secretRoot");
    }
  });
});

describe("parseTemplate", () => {
  it("splits text around an embedded expression", () => {
    expect(parseTemplate("stars: ${ n } today")).toEqual([
      { kind: "text", value: "stars: " },
      { kind: "expression", source: " n " },
      { kind: "text", value: " today" },
    ]);
  });

  it("reads every expression in the string, not just the first", () => {
    expect(parseTemplate("${a} is ${b}")).toEqual([
      { kind: "expression", source: "a" },
      { kind: "text", value: " is " },
      { kind: "expression", source: "b" },
    ]);
  });

  it("treats a string with no placeholder as one piece of text", () => {
    expect(parseTemplate("plain")).toEqual([{ kind: "text", value: "plain" }]);
  });

  it("unescapes $${ to a literal placeholder that is never evaluated", () => {
    expect(parseTemplate("$${ n }")).toEqual([{ kind: "text", value: "${ n }" }]);
  });

  it("ignores a closing brace inside a quoted string", () => {
    expect(parseTemplate("${ coalesce(x, '}') }")).toEqual([
      { kind: "expression", source: " coalesce(x, '}') " },
    ]);
  });

  it("refuses a placeholder that is never closed", () => {
    expect(() => parseTemplate("stars: ${ n")).toThrow(
      new ExpressionError("expression_syntax", "template")
    );
  });
});

describe("renderInterpolated", () => {
  it("renders the scalars a message can carry", () => {
    expect(renderInterpolated("tulip")).toBe("tulip");
    expect(renderInterpolated(7)).toBe("7");
    expect(renderInterpolated(true)).toBe("true");
  });

  it("refuses values that would coerce to a wrong-looking message", () => {
    for (const value of [null, undefined, { a: 1 }, [1, 2], Number.NaN]) {
      expect(() => renderInterpolated(value)).toThrow(
        new ExpressionError("expression_type", "interpolation")
      );
    }
  });
});
