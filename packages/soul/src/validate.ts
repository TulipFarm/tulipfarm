import type {
  SoulChangeset,
  SoulChangesetValidationIssue,
  SoulFileChange,
  ValidatedSoulFileChange,
} from "./changeset";
import { SOUL_CHANGESET_SOURCES } from "./changeset";
import { type ParsedSoulFile, parseSoulFile } from "./parse";

const CHANGESET_KEYS = new Set([
  "id",
  "businessId",
  "principalId",
  "source",
  "expectedBaseCommit",
  "files",
]);
const UPSERT_KEYS = new Set(["operation", "path", "content"]);
const DELETE_KEYS = new Set(["operation", "path"]);

function issueSort(
  left: SoulChangesetValidationIssue,
  right: SoulChangesetValidationIssue
): number {
  const leftKey = `${left.path}\u0000${left.code}\u0000${left.field ?? ""}`;
  const rightKey = `${right.path}\u0000${right.code}\u0000${right.field ?? ""}`;
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function unknownKeys(value: object, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
}

export function validateChangesetShape(changeset: SoulChangeset): SoulChangesetValidationIssue[] {
  const issues: SoulChangesetValidationIssue[] = [];
  if (typeof changeset !== "object" || changeset === null || Array.isArray(changeset)) {
    return [{ code: "INVALID_CHANGESET", path: "", field: "/" }];
  }
  for (const key of unknownKeys(changeset, CHANGESET_KEYS)) {
    issues.push({ code: "UNKNOWN_FIELD", path: "", field: `/${key}` });
  }
  for (const field of ["id", "businessId", "principalId", "expectedBaseCommit"] as const) {
    if (!nonEmptyString(changeset[field])) {
      issues.push({ code: "REQUIRED_FIELD", path: "", field: `/${field}` });
    }
  }
  if (!(SOUL_CHANGESET_SOURCES as readonly unknown[]).includes(changeset.source)) {
    issues.push({ code: "INVALID_SOURCE", path: "", field: "/source" });
  }
  if (!Array.isArray(changeset.files) || changeset.files.length === 0) {
    issues.push({ code: "EMPTY_CHANGESET", path: "", field: "/files" });
    return issues.sort(issueSort);
  }

  const paths = new Set<string>();
  for (const [index, file] of changeset.files.entries()) {
    const field = `/files/${index}`;
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      issues.push({ code: "INVALID_FILE_CHANGE", path: "", field });
      continue;
    }
    const allowed = file.operation === "delete" ? DELETE_KEYS : UPSERT_KEYS;
    for (const key of unknownKeys(file, allowed)) {
      issues.push({ code: "UNKNOWN_FIELD", path: "", field: `${field}/${key}` });
    }
    if (file.operation !== "upsert" && file.operation !== "delete") {
      issues.push({ code: "INVALID_OPERATION", path: "", field: `${field}/operation` });
    }
    if (!nonEmptyString(file.path) || !safePath(file.path)) {
      issues.push({
        code: "INVALID_PATH",
        path: nonEmptyString(file.path) ? file.path : "",
        field,
      });
      continue;
    }
    if (paths.has(file.path)) issues.push({ code: "DUPLICATE_PATH", path: file.path });
    paths.add(file.path);
    if (
      file.operation === "upsert" &&
      (typeof file.content !== "string" || !validUnicode(file.content))
    ) {
      issues.push({ code: "INVALID_CONTENT", path: file.path, field: `${field}/content` });
    }
  }
  return issues.sort(issueSort);
}

interface ValidatedFileResult {
  readonly file: ValidatedSoulFileChange;
  readonly definition?: ParsedSoulFile["definition"];
}

export function validateChangesetFiles(files: readonly SoulFileChange[]): {
  readonly files: readonly ValidatedFileResult[];
  readonly issues: readonly SoulChangesetValidationIssue[];
} {
  const validated: ValidatedFileResult[] = [];
  const issues: SoulChangesetValidationIssue[] = [];
  for (const change of files) {
    const result = parseSoulFile(change);
    if (result.issue) {
      issues.push(result.issue);
      continue;
    }
    if (!result.parsed) {
      issues.push({ code: "FILE_PARSE_FAILED", path: change.path });
      continue;
    }
    validated.push({
      file: { operation: change.operation, path: change.path, hash: result.parsed.hash },
      definition: result.parsed.definition,
    });
  }
  return { files: validated, issues: issues.sort(issueSort) };
}
