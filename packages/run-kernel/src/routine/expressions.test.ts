import { describe, expect, it } from "vitest";
import { compileExpression, ExpressionError } from "./expressions";

const scope = {
  input: { issue: { id: 42, title: "Crash on save", labels: ["bug", "p1"] } },
  states: { Classify: { output: { label: "bug", score: 0.91 } } },
  trigger: { provider: "github" },
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
