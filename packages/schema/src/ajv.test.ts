import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";

describe("shared ajv instance", () => {
  it("compiles a draft-07 tool inputSchema without throwing", () => {
    const draft07Schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
    };
    expect(() => ajv.compile(draft07Schema)).not.toThrow();
  });

  it("compiles a draft-06 tool inputSchema without throwing", () => {
    const draft06Schema = {
      $schema: "http://json-schema.org/draft-06/schema#",
      type: "object",
      properties: { query: { type: "string" } },
    };
    expect(() => ajv.compile(draft06Schema)).not.toThrow();
  });

  it("still validates data against a compiled draft-07 schema", () => {
    const validateFn = ajv.compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    expect(validateFn({ count: 3 })).toBe(true);
    expect(validateFn({ count: "nope" })).toBe(false);
  });

  it("compiles a 2020-12 schema (default draft) without regression", () => {
    const draft2020Schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { id: { type: "string" } },
    };
    expect(() => ajv.compile(draft2020Schema)).not.toThrow();
  });
});
