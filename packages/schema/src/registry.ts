import { createHash } from "node:crypto";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { parseAllDocuments } from "yaml";
import { CANONICAL_HASH_ALGORITHM, canonicalize } from "./canonicalize";
import {
  DuplicateSchemaError,
  InvalidDiscriminatorError,
  InvalidSchemaError,
  SchemaValidationError,
  type SchemaValidationIssue,
  UnknownSchemaError,
  YamlParseError,
} from "./errors";

export interface SchemaRegistration {
  apiVersion: string;
  kind: string;
  schema: unknown;
}

export interface VersionedSchemaDocument extends Record<string, unknown> {
  apiVersion: string;
  kind: string;
}

export interface ValidatedSchemaDocument {
  apiVersion: string;
  kind: string;
  canonical: string;
  hash: string;
  document: Readonly<VersionedSchemaDocument>;
}

type JsonSchema = boolean | Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaPath(path: string, segment: string): string {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function childSchemas(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) return [];
  return Object.entries(value);
}

function assertExplicitObjectStrictness(
  schema: unknown,
  apiVersion: string,
  kind: string,
  path = ""
): void {
  if (typeof schema === "boolean") return;
  if (!isRecord(schema)) throw new InvalidSchemaError(apiVersion, kind, path);

  const describesObject =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    Object.hasOwn(schema, "properties") ||
    Object.hasOwn(schema, "patternProperties");
  if (
    describesObject &&
    !Object.hasOwn(schema, "additionalProperties") &&
    !Object.hasOwn(schema, "unevaluatedProperties")
  ) {
    throw new InvalidSchemaError(apiVersion, kind, path);
  }

  for (const keyword of [
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
    "properties",
  ] as const) {
    for (const [name, child] of childSchemas(schema[keyword])) {
      assertExplicitObjectStrictness(
        child,
        apiVersion,
        kind,
        schemaPath(schemaPath(path, keyword), name)
      );
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      assertExplicitObjectStrictness(
        child,
        apiVersion,
        kind,
        schemaPath(schemaPath(path, keyword), String(index))
      );
    });
  }
  for (const keyword of [
    "additionalProperties",
    "contains",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedProperties",
  ] as const) {
    const child = schema[keyword];
    if (typeof child === "boolean" || isRecord(child)) {
      assertExplicitObjectStrictness(child, apiVersion, kind, schemaPath(path, keyword));
    }
  }
}

function assertDiscriminatorSchema(
  schema: unknown,
  apiVersion: string,
  kind: string
): asserts schema is Record<string, unknown> {
  if (!isRecord(schema)) throw new InvalidSchemaError(apiVersion, kind, "");
  const required = schema.required;
  const properties = schema.properties;
  if (!Array.isArray(required) || !required.includes("apiVersion") || !required.includes("kind")) {
    throw new InvalidSchemaError(apiVersion, kind, "/required");
  }
  if (!isRecord(properties)) throw new InvalidSchemaError(apiVersion, kind, "/properties");
  const versionSchema = properties.apiVersion;
  const kindSchema = properties.kind;
  if (!isRecord(versionSchema) || versionSchema.const !== apiVersion) {
    throw new InvalidSchemaError(apiVersion, kind, "/properties/apiVersion/const");
  }
  if (!isRecord(kindSchema) || kindSchema.const !== kind) {
    throw new InvalidSchemaError(apiVersion, kind, "/properties/kind/const");
  }
}

function validationIssues(errors: ErrorObject[] | null | undefined): SchemaValidationIssue[] {
  return (errors ?? [])
    .map((error) => ({
      keyword: error.keyword,
      message: error.message ?? "validation failed",
      path: error.instancePath,
    }))
    .sort((left, right) => {
      const leftKey = `${left.path}\u0000${left.keyword}\u0000${left.message}`;
      const rightKey = `${right.path}\u0000${right.keyword}\u0000${right.message}`;
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      return 0;
    });
}

function discriminator(document: unknown): { apiVersion: string; kind: string } {
  if (!isRecord(document) || typeof document.apiVersion !== "string" || !document.apiVersion) {
    throw new InvalidDiscriminatorError("/apiVersion");
  }
  if (typeof document.kind !== "string" || !document.kind) {
    throw new InvalidDiscriminatorError("/kind");
  }
  return { apiVersion: document.apiVersion, kind: document.kind };
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function yamlValueToJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new YamlParseError("NON_FINITE_NUMBER");
    return value;
  }
  if (typeof value !== "object") throw new YamlParseError("UNSUPPORTED_VALUE");
  if (ancestors.has(value)) throw new YamlParseError("ALIAS_CYCLE");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => yamlValueToJson(item, ancestors));
    }
    if (value instanceof Map) {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of value) {
        if (typeof key !== "string") throw new YamlParseError("NON_STRING_KEY");
        if (Object.hasOwn(result, key)) throw new YamlParseError("KEY_COLLISION");
        result[key] = yamlValueToJson(item, ancestors);
      }
      return result;
    }
    throw new YamlParseError("UNSUPPORTED_VALUE");
  } finally {
    ancestors.delete(value);
  }
}

export function parseYamlDocument(source: string): unknown {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(source, {
      merge: false,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch {
    throw new YamlParseError("PARSER_FAILURE");
  }
  if (documents.length !== 1) throw new YamlParseError("DOCUMENT_COUNT");
  const document = documents[0];
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new YamlParseError(problem.code ?? "INVALID_DOCUMENT");
  try {
    return yamlValueToJson(document.toJS({ mapAsMap: true, maxAliasCount: 100 }));
  } catch (error) {
    if (error instanceof YamlParseError) throw error;
    throw new YamlParseError("INVALID_DOCUMENT");
  }
}

export class SchemaRegistry {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly validators = new Map<string, Map<string, ValidateFunction>>();

  constructor(registrations: readonly SchemaRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register({ apiVersion, kind, schema }: SchemaRegistration): void {
    if (!apiVersion) throw new InvalidSchemaError(apiVersion, kind, "/apiVersion");
    if (!kind) throw new InvalidSchemaError(apiVersion, kind, "/kind");
    if (this.validators.get(apiVersion)?.has(kind)) {
      throw new DuplicateSchemaError(apiVersion, kind);
    }
    assertDiscriminatorSchema(schema, apiVersion, kind);
    assertExplicitObjectStrictness(schema, apiVersion, kind);

    let validator: ValidateFunction;
    try {
      validator = this.ajv.compile(schema as JsonSchema);
    } catch {
      throw new InvalidSchemaError(apiVersion, kind, "");
    }
    const versionSchemas = this.validators.get(apiVersion) ?? new Map<string, ValidateFunction>();
    versionSchemas.set(kind, validator);
    this.validators.set(apiVersion, versionSchemas);
  }

  validate(document: unknown): ValidatedSchemaDocument {
    const canonical = canonicalize(document);
    const parsed = JSON.parse(canonical) as VersionedSchemaDocument;
    const { apiVersion, kind } = discriminator(parsed);
    const versionSchemas = this.validators.get(apiVersion);
    if (!versionSchemas) throw new UnknownSchemaError("UNKNOWN_API_VERSION", apiVersion);
    const validator = versionSchemas.get(kind);
    if (!validator) throw new UnknownSchemaError("UNKNOWN_KIND", apiVersion, kind);
    if (!validator(parsed)) {
      throw new SchemaValidationError(apiVersion, kind, validationIssues(validator.errors));
    }

    deepFreeze(parsed);
    return {
      apiVersion,
      kind,
      canonical,
      hash: createHash(CANONICAL_HASH_ALGORITHM).update(canonical, "utf8").digest("hex"),
      document: parsed,
    };
  }

  validateYaml(source: string): ValidatedSchemaDocument {
    return this.validate(parseYamlDocument(source));
  }
}
