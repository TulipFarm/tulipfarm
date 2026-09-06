import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { lintRoutine } from "./routine-lint";

function definition(states: readonly unknown[], start = "Start"): routineSchema.RoutineDefinition {
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
    spec: { owner: "platform", start, states },
  } as unknown as routineSchema.RoutineDefinition;
}

function lint(states: readonly unknown[], start?: string) {
  return lintRoutine({
    slug: "quotes",
    digest: "sha256:abc",
    definition: definition(states, start),
  });
}

describe("lintRoutine", () => {
  it("passes a Routine whose States and references all resolve", () => {
    expect(
      lint([
        { type: "compute", name: "Start", input: { ok: true }, transition: "Next" },
        {
          type: "compute",
          name: "Next",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a Routine expression is literal text, not a template
          input: { echo: "${ states.Start.output.ok }" },
          end: true,
        },
      ])
    ).toEqual([]);
  });

  it("reports a Routine that does not compile, with the compiler's own code and pointer", () => {
    const found = lint([
      { type: "compute", name: "Start", input: { ok: true }, transition: "Nowhere" },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: "routine_uncompilable",
      severity: "broken",
      at: "/spec/states/0/transition",
      subject: { kind: "routine", id: "quotes", digest: "sha256:abc" },
    });
    expect(found[0]?.detail).toContain("unknown_transition_target");
  });

  // The staging failure in miniature: `record_list` publishes `items`, the Routine read `records`.
  it("reports a field the producer's declared output schema does not publish", () => {
    const found = lint(
      [
        {
          type: "compute",
          name: "LoadQuoteHistory",
          input: { items: [] },
          output: {
            type: "object",
            additionalProperties: false,
            properties: { items: { type: "array" }, nextCursor: { type: "string" } },
          },
          transition: "SendQuote",
        },
        {
          type: "compute",
          name: "SendQuote",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a Routine expression is literal text, not a template
          input: { rows: "${ states.LoadQuoteHistory.output.records }" },
          end: true,
        },
      ],
      "LoadQuoteHistory"
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: "undeclared_output_field",
      severity: "broken",
      at: "SendQuote:states.LoadQuoteHistory.output.records",
    });
    expect(found[0]?.detail).toContain("`records`");
  });

  it("stays silent when the producer's output schema is open, because absence proves nothing", () => {
    expect(
      lint(
        [
          {
            type: "compute",
            name: "LoadQuoteHistory",
            input: { items: [] },
            output: { type: "object", properties: { items: { type: "array" } } },
            transition: "SendQuote",
          },
          {
            type: "compute",
            name: "SendQuote",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a Routine expression is literal text, not a template
            input: { rows: "${ states.LoadQuoteHistory.output.records }" },
            end: true,
          },
        ],
        "LoadQuoteHistory"
      )
    ).toEqual([]);
  });

  it("reports an `action` State that names no Tool", () => {
    const found = lint([{ type: "action", name: "Start", input: {}, end: true }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "missing_action_name", at: "Start" });
  });

  it("fingerprints the same defect identically and a different digest differently", () => {
    const states = [{ type: "compute", name: "Start", input: { ok: true }, transition: "Nowhere" }];
    const a = lint(states)[0];
    const b = lint(states)[0];
    const other = lintRoutine({
      slug: "quotes",
      digest: "sha256:def",
      definition: definition(states),
    })[0];
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(a?.fingerprint).not.toBe(other?.fingerprint);
  });
});
