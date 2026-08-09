import { createHash } from "node:crypto";
import {
  DEFINITION_REGISTRATIONS,
  SchemaContractError,
  SchemaRegistry,
  type ValidatedSchemaDocument,
} from "@tulipfarm/schema";
import type { SoulChangesetValidationIssue, SoulFileChange } from "./changeset";

const registry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

const DEFINITION_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^agents\/[^/]+\/agent\.ya?ml$/, "Agent"],
  [/^skills\/[^/]+\/skill\.ya?ml$/, "Skill"],
  [/^tools\/[^/]+\.ya?ml$/, "ToolContract"],
  [/^routines\/[^/]+\.ya?ml$/, "Routine"],
  [/^triggers\/[^/]+\.ya?ml$/, "Trigger"],
  [/^roles\/[^/]+\.ya?ml$/, "Role"],
  [/^guardrails\/[^/]+\.ya?ml$/, "Guardrail"],
  [/^integrations\/providers\/[^/]+\.ya?ml$/, "IntegrationAdapter"],
  [/^integrations\/apps\/[^/]+\.ya?ml$/, "App"],
  [/^integrations\/[^/]+\.ya?ml$/, "Integration"],
  [/^knowledge\/[^/]+\.ya?ml$/, "KnowledgeSource"],
  [/^forms\/[^/]+\.ya?ml$/, "Form"],
  [/^soul\.ya?ml$/, "Settings"],
];

const COMPANION_PATHS = [
  /^agents\/[^/]+\/instructions\.md$/,
  /^skills\/[^/]+\/SKILL\.md$/,
  /^skills\/[^/]+\/(?:assets|references|schemas)\/.+$/,
  /^skills\/[^/]+\/scripts\/.+$/,
] as const;

export interface ParsedSoulFile {
  readonly hash: string;
  readonly definition?: ValidatedSchemaDocument;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function expectedKind(path: string): string | undefined {
  return DEFINITION_PATHS.find(([pattern]) => pattern.test(path))?.[1];
}

function companionPath(path: string): boolean {
  return COMPANION_PATHS.some((pattern) => pattern.test(path));
}

export function parseSoulFile(change: SoulFileChange): {
  parsed?: ParsedSoulFile;
  issue?: SoulChangesetValidationIssue;
} {
  if (change.operation === "delete") {
    if (!expectedKind(change.path) && !companionPath(change.path)) {
      return { issue: { code: "UNSUPPORTED_SOUL_PATH", path: change.path } };
    }
    return { parsed: { hash: sha256(`delete\0${change.path}`) } };
  }

  const kind = expectedKind(change.path);
  if (!kind) {
    if (companionPath(change.path)) return { parsed: { hash: sha256(change.content) } };
    return { issue: { code: "UNSUPPORTED_SOUL_PATH", path: change.path } };
  }

  try {
    const definition = registry.validateYaml(change.content);
    if (definition.kind !== kind) {
      return {
        issue: {
          code: "KIND_PATH_MISMATCH",
          path: change.path,
          field: "/kind",
        },
      };
    }
    return { parsed: { hash: definition.hash, definition } };
  } catch (error) {
    if (error instanceof SchemaContractError) {
      return {
        issue: {
          code: error.code,
          path: change.path,
          ...(error.path ? { field: error.path } : {}),
        },
      };
    }
    return { issue: { code: "FILE_PARSE_FAILED", path: change.path } };
  }
}
