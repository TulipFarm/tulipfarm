import { describe, expect, it } from "vitest";
import { planCompileTool } from "./plan-compile";
import { PLATFORM_RUNTIME_TOOLS } from "./tools";

const yaml = `apiVersion: tulipfarm.ai/v1
kind: Plan
name: check-time
version: 1
steps:
  - id: Read
    tool: get_current_time
  - id: Check
    needs: [Read]
    tool: validate_artifact
    input:
      artifact: "\${states.Read.output.current}"
      schema:
        type: string
`;

describe("plan_compile", () => {
  it("previews a compiled graph without claiming it executed or declaring Chat tool progress", async () => {
    const result = await planCompileTool.handler({ yaml }, {});
    expect(result).toMatchObject({
      success: true,
      data: {
        executed: false,
        definition: { kind: "Routine", metadata: { slug: "check-time" } },
        steps: [
          expect.objectContaining({ id: "Read", needs: [] }),
          expect.objectContaining({ id: "Check", needs: ["Read"] }),
        ],
      },
    });
    if (!result.success) throw new Error(result.error.message);
    expect(result.data).not.toHaveProperty("plan");
  });

  it.each([
    {},
    { yaml, execute: true },
    { yaml: "steps: [" },
    { yaml: yaml.replace("needs: [Read]", "needs: [Missing]") },
    { yaml: "x".repeat(131_073) },
  ])("returns an explicit validation error for invalid input", async (args) => {
    expect(await planCompileTool.handler(args, {})).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
  });

  it("is registered on both hosts without granting new authority", () => {
    expect(PLATFORM_RUNTIME_TOOLS).toContain(planCompileTool);
    expect(planCompileTool.mutating).toBe(false);
    expect(planCompileTool.authorization.action).toBe("platform.plan.declare");
  });
});
