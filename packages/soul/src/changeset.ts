import type { SchemaContractErrorCode, ValidatedSchemaDocument } from "@tulipfarm/schema";
import { validateChangesetFiles, validateChangesetShape } from "./validate";

export const SOUL_CHANGESET_SOURCES = [
  "ui",
  "api",
  "import",
  "migration",
  "agent",
  "discovery",
] as const;

export type SoulChangesetSource = (typeof SOUL_CHANGESET_SOURCES)[number];

/** Zero-OID sentinel for an unborn Soul branch; changeset bases must be non-empty. */
export const SOUL_UNBORN_BASE = "0".repeat(40);

/** True when `base` names the unborn branch rather than a real commit. */
export function isUnbornBase(base: string): boolean {
  return base === "" || base === SOUL_UNBORN_BASE;
}

export type SoulFileChange =
  | { readonly operation: "upsert"; readonly path: string; readonly content: string }
  | { readonly operation: "delete"; readonly path: string };

/** The sole input contract for proposed writes to the authored Soul tree. */
export interface SoulChangeset {
  readonly id: string;
  readonly businessId: string;
  readonly principalId: string;
  readonly source: SoulChangesetSource;
  readonly expectedBaseCommit: string;
  readonly files: readonly SoulFileChange[];
}

export type SoulChangesetErrorCode =
  | "INVALID_CHANGESET"
  | "BASE_MISMATCH"
  | "FILE_VALIDATION_FAILED";

export type SoulChangesetValidationIssueCode =
  | SchemaContractErrorCode
  | "DUPLICATE_PATH"
  | "EMPTY_CHANGESET"
  | "FILE_PARSE_FAILED"
  | "INVALID_CHANGESET"
  | "INVALID_CONTENT"
  | "INVALID_FILE_CHANGE"
  | "INVALID_OPERATION"
  | "INVALID_PATH"
  | "INVALID_SOURCE"
  | "KIND_PATH_MISMATCH"
  | "REQUIRED_FIELD"
  | "UNKNOWN_FIELD"
  | "UNSUPPORTED_SOUL_PATH";

export interface SoulChangesetValidationIssue {
  readonly code: SoulChangesetValidationIssueCode;
  readonly path: string;
  readonly field?: string;
}

/** A deterministic, payload-safe changeset rejection suitable for boundary evidence. */
export class SoulChangesetValidationError extends Error {
  readonly code: SoulChangesetErrorCode;
  readonly issues: readonly SoulChangesetValidationIssue[];

  constructor(code: SoulChangesetErrorCode, issues: readonly SoulChangesetValidationIssue[]) {
    super(
      code === "BASE_MISMATCH"
        ? "Soul changeset expected base does not match the current base"
        : `Soul changeset validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"})`
    );
    this.name = "SoulChangesetValidationError";
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

export interface ValidatedSoulFileChange {
  readonly operation: SoulFileChange["operation"];
  readonly path: string;
  readonly hash: string;
  readonly apiVersion?: string;
  readonly kind?: string;
}

export interface ValidatedSoulChangeset {
  readonly id: string;
  readonly businessId: string;
  readonly principalId: string;
  readonly source: SoulChangesetSource;
  readonly expectedBaseCommit: string;
  readonly files: readonly ValidatedSoulFileChange[];
  readonly evidence: {
    readonly outcome: "validated";
    readonly fileCount: number;
  };
}

function freezeValidatedFile(
  file: ValidatedSoulFileChange,
  definition?: ValidatedSchemaDocument
): ValidatedSoulFileChange {
  return Object.freeze({
    ...file,
    ...(definition ? { apiVersion: definition.apiVersion, kind: definition.kind } : {}),
  });
}

/** Validate base and files before any atomic writer side effects. */
export function validateSoulChangeset(
  changeset: SoulChangeset,
  currentBaseCommit: string
): ValidatedSoulChangeset {
  const shapeIssues = validateChangesetShape(changeset);
  if (shapeIssues.length > 0) {
    throw new SoulChangesetValidationError("INVALID_CHANGESET", shapeIssues);
  }
  if (changeset.expectedBaseCommit !== currentBaseCommit) {
    throw new SoulChangesetValidationError("BASE_MISMATCH", []);
  }

  const validation = validateChangesetFiles(changeset.files);
  if (validation.issues.length > 0) {
    throw new SoulChangesetValidationError("FILE_VALIDATION_FAILED", validation.issues);
  }

  const files = validation.files.map(({ file, definition }) =>
    freezeValidatedFile(file, definition)
  );
  return Object.freeze({
    id: changeset.id,
    businessId: changeset.businessId,
    principalId: changeset.principalId,
    source: changeset.source,
    expectedBaseCommit: changeset.expectedBaseCommit,
    files: Object.freeze(files),
    evidence: Object.freeze({ outcome: "validated" as const, fileCount: files.length }),
  });
}
