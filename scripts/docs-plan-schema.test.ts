import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "../apps/docs/lib/shared";
import { PLAN_SCHEMA_PATH, renderPlanSchema } from "../apps/docs/scripts/generate-plan-schema";
import { ajv, parseYamlDocument } from "../packages/schema/src";

const ROOT = resolve(import.meta.dirname, "..");
const schemaPath = resolve(ROOT, "apps/docs/public", PLAN_SCHEMA_PATH);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const validate = ajv.compile(schema);
const plan = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Plan",
  name: "check-time",
  version: 1,
  steps: [{ id: "Read", tool: "get_current_time" }],
};

describe("public YAML Plan schema", () => {
  it("keeps the committed artifact identical to the TypeBox source", () => {
    expect(schema, "run pnpm --filter @tulipfarm/docs generate:plan-schema").toEqual(
      JSON.parse(renderPlanSchema())
    );
  });

  it("publishes a self-identifying standalone JSON Schema", () => {
    expect(schema.$id).toBe(`${SITE_URL}/${PLAN_SCHEMA_PATH}`);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  it("validates every supported step kind using the published artifact", () => {
    for (const step of [
      { id: "Read", tool: "get_current_time" },
      { id: "Explain", agent: { name: "operations", version: "1" }, prompt: "Explain the input." },
      { id: "Report", routine: { name: "report", version: "1" } },
    ]) {
      expect(validate({ ...plan, steps: [step] }), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("retains strict field, execution-kind, and required-prompt validation", () => {
    for (const candidate of [
      { ...plan, $schema: `${SITE_URL}/${PLAN_SCHEMA_PATH}` },
      { ...plan, kind: "Routine" },
      { ...plan, steps: [] },
      { ...plan, steps: [{ id: "Read", needs: ["A", "A"], tool: "get_current_time" }] },
      { ...plan, steps: [{ id: "Explain", agent: { name: "operations", version: "1" } }] },
      {
        ...plan,
        steps: [
          { id: "Read", tool: "get_current_time", routine: { name: "report", version: "1" } },
        ],
      },
    ]) {
      expect(validate(candidate)).toBe(false);
    }
  });

  it("validates the documented YAML example with its editor schema directive", () => {
    const docs = readFileSync(
      resolve(ROOT, "apps/docs/content/docs/reference/yaml-plans.mdx"),
      "utf8"
    );
    const example = docs.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(example).toContain("# yaml-language-server: $schema=");
    if (example === undefined) throw new Error("YAML Plan example is missing");
    expect(
      validate(parseYamlDocument(example.replaceAll("{{SITE_URL}}", SITE_URL))),
      JSON.stringify(validate.errors)
    ).toBe(true);
  });
});
