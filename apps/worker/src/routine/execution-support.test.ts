import { compileExpression, DEFAULT_EXPRESSION_ROOTS } from "@tulipfarm/run-kernel";
import { describe, expect, it } from "vitest";
import {
  assertSupportedExpression,
  RoutineExecutionRefusal,
  SUPPORTED_ROOTS,
} from "./execution-support";

describe("assertSupportedExpression", () => {
  // The compiler is the first gate and the executor the second. They can only stay honest if the
  // executor can rebuild every root the compiler admits; a root added to one and not the other
  // ships a Routine that authors cleanly and then parks on its first tick.
  it("can reconstruct every root the compiler admits", () => {
    for (const root of DEFAULT_EXPRESSION_ROOTS) {
      expect(SUPPORTED_ROOTS.has(root)).toBe(true);
    }
  });

  it("parks a State whose expression names a root the request Artifact cannot rebuild", () => {
    const expression = compileExpression("secrets.token", { roots: ["secrets"] });

    expect(() => assertSupportedExpression(expression, "Start")).toThrow(
      new RoutineExecutionRefusal("unsupported_context", "Start")
    );
  });
});
