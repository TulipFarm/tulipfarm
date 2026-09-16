import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";
import {
  PACK_MAX_ARTIFACTS,
  PackCatalogSchema,
  PackSourceSchema,
  validatePackDefinition,
} from "./pack";

const pack = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Pack",
  name: "support",
  title: "Support",
  description: "Handle incoming support requests.",
  version: 1,
  category: "Support",
  artifacts: [
    {
      kind: "resource",
      name: "tickets",
      description: "Support tickets.",
      template: {
        name: "tickets",
        schema: { type: "object", properties: { subject: { type: "string" } } },
      },
    },
  ],
  plan: {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Plan",
    name: "support",
    version: 1,
    steps: [{ id: "Inspect", tool: "list_resource_types" }],
  },
};

describe("Pack contract", () => {
  it("preserves arbitrary JSON template data inside a closed envelope", () => {
    expect(validatePackDefinition(pack).document).toEqual(pack);
  });

  it.each([
    { kind: "Plan" },
    { apiVersion: "tulipfarm.ai/v2" },
    { category: "Other" },
    { version: 0 },
    { version: 1.5 },
    { name: "../escape" },
    { script: "install" },
    { artifacts: [] },
    { artifacts: Array.from({ length: PACK_MAX_ARTIFACTS + 1 }, () => pack.artifacts[0]) },
    { artifacts: [{ ...pack.artifacts[0], kind: "integration" }] },
    { artifacts: [{ ...pack.artifacts[0], executable: true }] },
    { artifacts: [{ ...pack.artifacts[0], template: [] }] },
    { plan: { ...pack.plan, grants: ["admin"] } },
    { requirements: Array.from({ length: 65 }, (_, index) => `requirement-${index}`) },
  ])("rejects unknown structure or invalid bounds: %j", (overrides) => {
    expect(() => validatePackDefinition({ ...pack, ...overrides })).toThrow();
  });

  it("requires exactly one Pack source", () => {
    const validate = ajv.compile(PackSourceSchema);
    expect(validate({ yaml: "source" })).toBe(true);
    expect(validate({ url: "https://example.com/pack" })).toBe(true);
    for (const source of [
      {},
      { yaml: "" },
      { yaml: "source", url: "https://example.com" },
      { yaml: "source", confirm: true },
    ]) {
      expect(validate(source)).toBe(false);
    }
  });

  it("closes and bounds the catalog", () => {
    const validate = ajv.compile(PackCatalogSchema);
    const entry = {
      name: pack.name,
      title: pack.title,
      description: pack.description,
      category: pack.category,
      version: pack.version,
      url: "https://example.com/pack",
    };
    expect(validate({ packs: [entry] })).toBe(true);
    expect(validate({ packs: [{ ...entry, plan: pack.plan }] })).toBe(false);
    expect(validate({ packs: Array.from({ length: 101 }, () => entry) })).toBe(false);
  });
});
