import { describe, expect, it } from "vitest";
import { validateRoutineForgeDefinitions } from "./routine-forge-validation";

function definition(states: readonly unknown[]): Record<string, unknown> {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: "11111111-2222-4333-8444-555555555555",
      slug: "quotes",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: { owner: "platform", start: "Start", states },
  };
}

describe("validateRoutineForgeDefinitions", () => {
  it("accepts a Routine that compiles", () => {
    const result = validateRoutineForgeDefinitions({
      name: "quotes",
      definition: definition([{ type: "compute", name: "Start", input: { ok: true }, end: true }]),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a Routine the compiler cannot build", () => {
    const result = validateRoutineForgeDefinitions({
      name: "quotes",
      definition: definition([
        {
          type: "compute",
          name: "Start",
          // Reads a State that only runs later, which no ordering can satisfy.
          input: { value: "${states.Report.output.total}" },
          transition: "Report",
        },
        { type: "compute", name: "Report", input: { total: 1 }, end: true },
      ]),
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message).toContain("does not compile");
  });

  it("rejects a mapping that reads a field the producing State does not declare", () => {
    const result = validateRoutineForgeDefinitions({
      name: "quotes",
      definition: definition([
        {
          type: "compute",
          name: "Start",
          input: { total: 1 },
          output: {
            type: "object",
            properties: { total: { type: "number" } },
            additionalProperties: false,
          },
          transition: "Report",
        },
        {
          type: "compute",
          name: "Report",
          input: { value: "${states.Start.output.subtotal}" },
          end: true,
        },
      ]),
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message).toContain("subtotal");
  });

  it("reports the unexpected additional property name when spec has additional properties", () => {
    const def = definition([{ type: "compute", name: "Start", input: { ok: true }, end: true }]);
    (def.spec as Record<string, unknown>).inputs = { requestCode: { type: "string" } };
    const result = validateRoutineForgeDefinitions({
      name: "quotes",
      definition: def,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      "must NOT have additional properties 'inputs'"
    );
  });

  it("accepts a bounded compute Routine with declared spec.input", () => {
    const def = definition([
      {
        type: "compute",
        name: "Start",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: routine expression syntax
        input: { requestCode: "${input.requestCode}", reviewStatus: "draft" },
        end: true,
      },
    ]);
    (def.spec as Record<string, unknown>).input = {
      type: "object",
      properties: { requestCode: { type: "string" } },
      required: ["requestCode"],
    };
    const result = validateRoutineForgeDefinitions({
      name: "quotes",
      definition: def,
    });
    expect(result.ok).toBe(true);
  });
});
