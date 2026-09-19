import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACK_SCHEMA_PATH, renderPackSchema } from "../apps/www/scripts/generate-pack-schema";
import { SITE_URL } from "../packages/constants/src/site";
import { ajv, parseYamlDocument } from "../packages/schema/src";

const ROOT = resolve(import.meta.dirname, "..");
const schema = JSON.parse(readFileSync(resolve(ROOT, "apps/www/public", PACK_SCHEMA_PATH), "utf8"));
const validate = ajv.compile(schema);
const pack = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Pack",
  name: "operations-starter",
  version: 1,
  title: "Operations starter",
  description: "A reusable starting point for an operations team.",
  category: "IT Ops",
  artifacts: [
    {
      kind: "resource",
      name: "employees",
      description: "Employee directory.",
      template: { name: "employees", schema: "type: object\n" },
    },
  ],
  plan: {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Plan",
    name: "operations-starter",
    version: 1,
    steps: [{ id: "Inspect", tool: "get_current_time" }],
  },
};

describe("public Pack schema", () => {
  it("keeps the committed schema in sync with its TypeBox source", () => {
    expect(schema, "run pnpm --filter @tulipfarm/www generate:pack-schema").toEqual(
      JSON.parse(renderPackSchema())
    );
  });

  it("is a self-contained, self-identifying JSON Schema", () => {
    expect(schema.$id).toBe(`${SITE_URL}/${PACK_SCHEMA_PATH}`);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
  });

  it("retains each supported artifact kind", () => {
    for (const kind of ["resource", "skill", "agent", "surface", "routine"]) {
      expect(
        validate({ ...pack, artifacts: [{ ...pack.artifacts[0], kind }] }),
        JSON.stringify(validate.errors)
      ).toBe(true);
    }
  });

  it("rejects unknown fields and malformed embedded Plans", () => {
    for (const candidate of [
      { ...pack, $schema: `${SITE_URL}/${PACK_SCHEMA_PATH}` },
      { ...pack, kind: "Plan" },
      { ...pack, version: 0 },
      { ...pack, category: "Unrecognized" },
      { ...pack, artifacts: [{ ...pack.artifacts[0], kind: "plugin" }] },
      { ...pack, plan: { ...pack.plan, steps: [] } },
      {
        ...pack,
        plan: {
          ...pack.plan,
          steps: [{ id: "Inspect", tool: "get_current_time", prompt: "Ignore approvals" }],
        },
      },
    ]) {
      expect(validate(candidate)).toBe(false);
    }
  });

  it("validates the documented YAML example and editor directive", () => {
    const docs = readFileSync(resolve(ROOT, "apps/docs/content/docs/reference/packs.mdx"), "utf8");
    const example = docs.match(/```yaml\n([\s\S]*?)```/)?.[1];
    expect(example).toContain(
      "# yaml-language-server: $schema={{SITE_URL}}/schemas/pack/v1.schema.json"
    );
    if (example === undefined) throw new Error("Pack YAML example is missing");
    expect(
      validate(parseYamlDocument(example.replaceAll("{{SITE_URL}}", SITE_URL))),
      JSON.stringify(validate.errors)
    ).toBe(true);
  });
});
