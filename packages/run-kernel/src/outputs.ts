import { canonicalHash } from "@tulipfarm/schema";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

export type JsonObject = Record<string, unknown>;

export interface OutputSchemaRegistration {
  /** Stable reference stored on the Artifact, e.g. `<bundle digest>#/states/classify/output`. */
  readonly ref: string;
  readonly schema: JsonObject;
}

export interface ValidatedOutput {
  readonly schemaRef: string;
  readonly content: JsonObject;
  /** Canonical SHA-256 over the validated content (`@tulipfarm/schema` canonicalization). */
  readonly contentHash: string;
}

export type TypedOutputErrorCode =
  | "duplicate_output_schema"
  | "invalid_output_schema"
  | "output_not_object"
  | "output_schema_invalid"
  | "unknown_output_schema";

/**
 * Typed-output rejection. The message carries the code, the schema reference, and the failing
 * JSON path only — never the rejected payload, which may hold protected data or Secret values.
 */
export class TypedOutputError extends Error {
  readonly name = "TypedOutputError";

  constructor(
    readonly code: TypedOutputErrorCode,
    readonly schemaRef: string,
    readonly path = ""
  ) {
    super(`${code}:${schemaRef}${path ? ` at ${path}` : ""}`);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * AJV validation for every State output boundary (SPEC §9.1). Output that does not satisfy its
 * declared schema is rejected here, before it can be stored as an Artifact or reach a downstream
 * Context.
 */
export class TypedOutputValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(registrations: readonly OutputSchemaRegistration[]) {
    for (const { ref, schema } of registrations) {
      if (this.validators.has(ref)) throw new TypedOutputError("duplicate_output_schema", ref);
      try {
        this.validators.set(ref, this.ajv.compile(schema));
      } catch {
        throw new TypedOutputError("invalid_output_schema", ref);
      }
    }
  }

  /** Validates a value against a registered schema and returns it with its canonical hash. */
  validate(schemaRef: string, value: unknown): ValidatedOutput {
    const validator = this.validators.get(schemaRef);
    if (!validator) throw new TypedOutputError("unknown_output_schema", schemaRef);
    if (!isJsonObject(value)) throw new TypedOutputError("output_not_object", schemaRef);
    if (!validator(value)) {
      const failure = validator.errors?.[0];
      throw new TypedOutputError("output_schema_invalid", schemaRef, failure?.instancePath ?? "");
    }
    return { schemaRef, content: value, contentHash: canonicalHash(value) };
  }
}
