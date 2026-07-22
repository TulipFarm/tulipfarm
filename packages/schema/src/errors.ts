export type SchemaContractErrorCode =
  | "CANONICALIZATION_FAILED"
  | "DUPLICATE_SCHEMA"
  | "INVALID_DISCRIMINATOR"
  | "INVALID_SCHEMA"
  | "SCHEMA_VALIDATION_FAILED"
  | "UNKNOWN_API_VERSION"
  | "UNKNOWN_KIND"
  | "YAML_PARSE_FAILED";

export class SchemaContractError extends Error {
  readonly code: SchemaContractErrorCode;
  readonly path: string;

  constructor(code: SchemaContractErrorCode, message: string, path = "") {
    super(message);
    this.name = "SchemaContractError";
    this.code = code;
    this.path = path;
  }
}

export class CanonicalizationError extends SchemaContractError {
  constructor(path: string) {
    super("CANONICALIZATION_FAILED", `Value cannot be canonicalized at ${path || "/"}`, path);
    this.name = "CanonicalizationError";
  }
}

export class InvalidDiscriminatorError extends SchemaContractError {
  constructor(path: "/apiVersion" | "/kind") {
    super("INVALID_DISCRIMINATOR", `A non-empty string is required at ${path}`, path);
    this.name = "InvalidDiscriminatorError";
  }
}

export class UnknownSchemaError extends SchemaContractError {
  readonly apiVersion: string;
  readonly kind?: string;

  constructor(code: "UNKNOWN_API_VERSION" | "UNKNOWN_KIND", apiVersion: string, kind?: string) {
    const message =
      code === "UNKNOWN_API_VERSION"
        ? `No schemas are registered for apiVersion ${apiVersion}`
        : `No schema is registered for ${apiVersion}/${kind ?? ""}`;
    super(code, message, code === "UNKNOWN_API_VERSION" ? "/apiVersion" : "/kind");
    this.name = "UnknownSchemaError";
    this.apiVersion = apiVersion;
    this.kind = kind;
  }
}

export class DuplicateSchemaError extends SchemaContractError {
  readonly apiVersion: string;
  readonly kind: string;

  constructor(apiVersion: string, kind: string) {
    super("DUPLICATE_SCHEMA", `Schema already registered for ${apiVersion}/${kind}`);
    this.name = "DuplicateSchemaError";
    this.apiVersion = apiVersion;
    this.kind = kind;
  }
}

export class InvalidSchemaError extends SchemaContractError {
  readonly apiVersion: string;
  readonly kind: string;

  constructor(apiVersion: string, kind: string, path: string) {
    super("INVALID_SCHEMA", `Invalid schema for ${apiVersion}/${kind} at ${path || "/"}`, path);
    this.name = "InvalidSchemaError";
    this.apiVersion = apiVersion;
    this.kind = kind;
  }
}

export interface SchemaValidationIssue {
  keyword: string;
  message: string;
  path: string;
}

export class SchemaValidationError extends SchemaContractError {
  readonly apiVersion: string;
  readonly kind: string;
  readonly issues: readonly SchemaValidationIssue[];

  constructor(apiVersion: string, kind: string, issues: readonly SchemaValidationIssue[]) {
    const first = issues[0] ?? {
      keyword: "validation",
      message: "schema validation failed",
      path: "",
    };
    super(
      "SCHEMA_VALIDATION_FAILED",
      `Schema validation failed for ${apiVersion}/${kind} at ${first.path || "/"}: ${first.message}`,
      first.path
    );
    this.name = "SchemaValidationError";
    this.apiVersion = apiVersion;
    this.kind = kind;
    this.issues = issues;
  }
}

export class YamlParseError extends SchemaContractError {
  readonly reason: string;

  constructor(reason: string) {
    super("YAML_PARSE_FAILED", `YAML parsing failed: ${reason}`);
    this.name = "YamlParseError";
    this.reason = reason;
  }
}
