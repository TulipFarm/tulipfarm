import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DuplicateSchemaError,
  InvalidSchemaError,
  SchemaRegistry,
  SchemaValidationError,
  UnknownSchemaError,
  YamlParseError,
} from "./index";

const apiVersion = "tulipfarm.ai/v1";
const kind = "TestDefinition";

const TestDefinitionSchema = {
  $id: "tulipfarm.ai/v1/TestDefinition",
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "spec"],
  properties: {
    apiVersion: { const: apiVersion },
    kind: { const: kind },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    },
    spec: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
    },
  },
} as const;

function createRegistry(): SchemaRegistry {
  return new SchemaRegistry([{ apiVersion, kind, schema: TestDefinitionSchema }]);
}

describe("SchemaRegistry", () => {
  it("selects a schema by explicit apiVersion/kind and returns safe digest evidence", () => {
    const result = createRegistry().validate({
      kind,
      spec: { enabled: true },
      apiVersion,
      metadata: { name: "general-assistant" },
    });

    expect(result).toMatchObject({ apiVersion, kind });
    expect(result.canonical).toBe(
      `{"apiVersion":"${apiVersion}","kind":"${kind}","metadata":{"name":"general-assistant"},"spec":{"enabled":true}}`
    );
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.document)).toBe(true);
    expect(Object.isFrozen(result.document.metadata)).toBe(true);
  });

  it("normalizes YAML comments and key ordering to the same hash across registry restarts", () => {
    const first = createRegistry().validateYaml(`
# formatting is not identity
kind: ${kind}
spec:
  enabled: true
apiVersion: ${apiVersion}
metadata: { name: general-assistant }
`);
    const restarted = createRegistry().validateYaml(`
apiVersion: ${apiVersion}
kind: ${kind}
metadata:
  name: general-assistant
spec: { enabled: true }
`);

    expect(first.hash).toBe(restarted.hash);
    expect(first.canonical).toBe(restarted.canonical);
  });

  it("fails closed for unknown versions and kinds", () => {
    expect(() =>
      createRegistry().validate({ apiVersion: "tulipfarm.ai/v2", kind, metadata: {}, spec: {} })
    ).toThrowError(
      expect.objectContaining({
        code: "UNKNOWN_API_VERSION",
        apiVersion: "tulipfarm.ai/v2",
      })
    );
    expect(() =>
      createRegistry().validate({ apiVersion, kind: "Unknown", metadata: {}, spec: {} })
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_KIND", apiVersion, kind: "Unknown" }));
  });

  it("rejects missing or non-string discriminators before schema selection", () => {
    expect(() => createRegistry().validate({ kind, spec: {} })).toThrowError(
      expect.objectContaining({ code: "INVALID_DISCRIMINATOR", path: "/apiVersion" })
    );
    expect(() => createRegistry().validate({ apiVersion, kind: 7, spec: {} })).toThrowError(
      expect.objectContaining({ code: "INVALID_DISCRIMINATOR", path: "/kind" })
    );
  });

  it("rejects unknown root and nested properties", () => {
    expect(() =>
      createRegistry().validate({
        apiVersion,
        kind,
        metadata: { name: "agent", ownerToken: "protected" },
        spec: { enabled: true },
      })
    ).toThrow(SchemaValidationError);
    expect(() =>
      createRegistry().validate({
        apiVersion,
        kind,
        metadata: { name: "agent" },
        spec: { enabled: true },
        typo: true,
      })
    ).toThrow(SchemaValidationError);
  });

  it("reports validation issues without including protected payload values", () => {
    try {
      createRegistry().validate({
        apiVersion,
        kind,
        metadata: { name: "do-not-disclose", secret: "soul-secret-value" },
        spec: { enabled: "yes" },
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect(error).toMatchObject({ code: "SCHEMA_VALIDATION_FAILED", apiVersion, kind });
      expect((error as Error).message).not.toContain("do-not-disclose");
      expect((error as Error).message).not.toContain("soul-secret-value");
    }
  });

  it("rejects duplicate registration replay", () => {
    const registry = createRegistry();

    expect(() => registry.register({ apiVersion, kind, schema: TestDefinitionSchema })).toThrow(
      DuplicateSchemaError
    );
  });

  it("rejects object schemas that do not make unknown-property behavior explicit", () => {
    expect(
      () =>
        new SchemaRegistry([
          {
            apiVersion,
            kind,
            schema: {
              type: "object",
              required: ["apiVersion", "kind"],
              properties: {
                apiVersion: { const: apiVersion },
                kind: { const: kind },
              },
            },
          },
        ])
    ).toThrow(InvalidSchemaError);
  });

  it("requires explicit unknown-property behavior for nullable object schemas", () => {
    expect(
      () =>
        new SchemaRegistry([
          {
            apiVersion,
            kind,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["apiVersion", "kind", "spec"],
              properties: {
                apiVersion: { const: apiVersion },
                kind: { const: kind },
                spec: { type: ["object", "null"] },
              },
            },
          },
        ])
    ).toThrow(InvalidSchemaError);
  });

  it("allows unknown properties only when the registered schema explicitly permits them", () => {
    const extensibleKind = "ExtensibleDefinition";
    const registry = new SchemaRegistry([
      {
        apiVersion,
        kind: extensibleKind,
        schema: {
          type: "object",
          additionalProperties: true,
          required: ["apiVersion", "kind"],
          properties: {
            apiVersion: { const: apiVersion },
            kind: { const: extensibleKind },
          },
        },
      },
    ]);

    expect(() =>
      registry.validate({ apiVersion, kind: extensibleKind, extension: { enabled: true } })
    ).not.toThrow();
  });

  it("fails closed for duplicate YAML keys, multiple documents, and malformed YAML", () => {
    const registry = createRegistry();
    const cases = [
      `apiVersion: ${apiVersion}\nkind: ${kind}\nkind: Other\n`,
      `apiVersion: ${apiVersion}\nkind: ${kind}\n---\napiVersion: ${apiVersion}\nkind: ${kind}\n`,
      `apiVersion: ${apiVersion}\nkind: [unterminated\n`,
    ];

    for (const source of cases) {
      expect(() => registry.validateYaml(source)).toThrow(YamlParseError);
    }
  });

  it("rejects non-string YAML keys before scalar coercion can collide", () => {
    const registry = createRegistry();
    const cases = [
      `apiVersion: ${apiVersion}\nkind: ${kind}\n1: first\n"1": second\n`,
      `apiVersion: ${apiVersion}\nkind: ${kind}\ntrue: first\n"true": second\n`,
      `apiVersion: ${apiVersion}\nkind: ${kind}\n42: standalone\n`,
    ];

    for (const source of cases) {
      expect(() => registry.validateYaml(source)).toThrow(YamlParseError);
    }
  });

  it("binds validation, the immutable document, and the hash to one canonical snapshot", () => {
    let descriptorReads = 0;
    const spec = new Proxy(
      { enabled: true },
      {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          if (!descriptor || property !== "enabled") return descriptor;
          const value = descriptorReads % 2 === 0;
          descriptorReads += 1;
          return { ...descriptor, value };
        },
      }
    );

    const result = createRegistry().validate({
      apiVersion,
      kind,
      metadata: { name: "snapshot" },
      spec,
    });

    expect(result.hash).toBe(createHash("sha256").update(result.canonical, "utf8").digest("hex"));
    expect(result.document).toEqual(JSON.parse(result.canonical));
  });

  it("does not silently fall back after YAML or schema selection errors", () => {
    expect(() =>
      createRegistry().validateYaml(`apiVersion: ${apiVersion}\nkind: Missing\n`)
    ).toThrow(UnknownSchemaError);
  });
});
