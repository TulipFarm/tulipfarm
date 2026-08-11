import { createHash } from "node:crypto";
import {
  type ArtifactKind,
  type ClassifiedSoulPath,
  type ContentMode,
  classifySoulPath,
  DEFINITION_REGISTRATIONS,
  isDefinitionKind,
  parseFrontmatter,
  SchemaContractError,
  SchemaRegistry,
  TulipFarmValidationError,
  type ValidatedSchemaDocument,
  validateAgentFrontmatter,
  validateGuardrailsConfig,
  validateLegacyIntegrationManifest,
  validateResourceSchema,
  validateRoutineDefinition,
  validateSkill,
  validateSoulConfig,
  withinArtifactTree,
} from "@tulipfarm/schema";
import { parse as parseYaml } from "yaml";
import type { SoulChangesetValidationIssue, SoulFileChange } from "./changeset";

const registry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

export interface ParsedSoulFile {
  readonly hash: string;
  /** Null only for a delete of a path the layout registry does not recognize. */
  readonly kind: ArtifactKind | null;
  readonly slug: string | null;
  /** Which check actually admitted the content — the evidence a migration report is built from. */
  readonly mode: ContentMode | null;
  readonly definition?: ValidatedSchemaDocument;
}

interface ParseAttempt {
  readonly parsed?: ParsedSoulFile;
  readonly issue?: SoulChangesetValidationIssue;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function rejected(
  code: SoulChangesetValidationIssue["code"],
  path: string,
  field?: string
): ParseAttempt {
  return { issue: { code, path, ...(field ? { field } : {}) } };
}

function admitted(content: string, location: ClassifiedSoulPath, mode: ContentMode): ParseAttempt {
  return {
    parsed: { hash: sha256(content), kind: location.kind, slug: location.slug, mode },
  };
}

function parseYamlObject(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(content) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function hasFrontmatterBlock(content: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(content);
}

/**
 * Strict `apiVersion`/`kind` validation, plus the check the registry cannot make on its own: that
 * the document's `kind` agrees with the directory it was filed under. Without it an Agent could be
 * written under `roles/` and pass validation, and the loader would never find it again.
 */
function parseDefinition(
  content: string,
  location: ClassifiedSoulPath,
  path: string
): ParseAttempt {
  try {
    const definition = registry.validateYaml(content);
    if (definition.kind !== location.kind) return rejected("KIND_PATH_MISMATCH", path, "/kind");
    return {
      parsed: {
        hash: definition.hash,
        kind: location.kind,
        slug: location.slug,
        mode: "definition",
        definition,
      },
    };
  } catch (error) {
    if (error instanceof SchemaContractError) {
      return rejected(error.code, path, error.path || undefined);
    }
    return rejected("FILE_PARSE_FAILED", path);
  }
}

/**
 * The superseded, pre-envelope formats. They are still validated — admitting a legacy path is not
 * the same as trusting its contents — but by the validator that owns each shape rather than by the
 * definition registry, which these files predate.
 */
function parseLegacy(content: string, location: ClassifiedSoulPath, path: string): ParseAttempt {
  try {
    switch (location.kind) {
      case "Agent": {
        validateAgentFrontmatter(parseFrontmatter(content).frontmatter);
        return admitted(content, location, "legacy");
      }
      case "Skill": {
        const { frontmatter, body } = parseFrontmatter(content);
        // No frontmatter means this is the prose body a canonical `skill.yaml` points at, not a
        // legacy definition. Only the definition form carries configuration worth validating.
        if (Object.keys(frontmatter).length === 0) return admitted(content, location, "prose");
        const result = validateSkill({ name: location.slug ?? "", frontmatter, body, content });
        return result.valid
          ? admitted(content, location, "legacy")
          : rejected("SCHEMA_VALIDATION_FAILED", path);
      }
      case "Resource": {
        const parsed = parseYamlObject(content);
        if (!parsed) return rejected("FILE_PARSE_FAILED", path);
        validateResourceSchema(parsed);
        return admitted(content, location, "legacy");
      }
      case "Routine": {
        const parsed = parseYamlObject(content);
        if (!parsed) return rejected("FILE_PARSE_FAILED", path);
        validateRoutineDefinition(parsed);
        return admitted(content, location, "legacy");
      }
      case "Settings": {
        const parsed = parseYamlObject(content);
        if (!parsed) return rejected("FILE_PARSE_FAILED", path);
        validateSoulConfig(parsed);
        return admitted(content, location, "legacy");
      }
      case "Integration": {
        const parsed = parseYamlObject(content);
        if (!parsed) return rejected("FILE_PARSE_FAILED", path);
        validateLegacyIntegrationManifest(parsed);
        return admitted(content, location, "legacy");
      }
      default: {
        // Remaining legacy paths still carry hand-authored YAML whose canonical schema is the
        // migration target. Parse it — a file that is not even YAML is never admitted.
        return parseYamlObject(content)
          ? admitted(content, location, "legacy")
          : rejected("FILE_PARSE_FAILED", path);
      }
    }
  } catch (error) {
    if (error instanceof TulipFarmValidationError) {
      return rejected("SCHEMA_VALIDATION_FAILED", path, error.path || undefined);
    }
    return rejected("FILE_PARSE_FAILED", path);
  }
}

/**
 * Shapes owned by another package. `GuardrailsPolicy` is checked here because its validator
 * already lives in `@tulipfarm/schema`; the rest are content-addressed at this layer and validated
 * by their owner on load, since reaching into `@tulipfarm/surface` from here would invert the
 * package rank order.
 */
function parseDelegated(content: string, location: ClassifiedSoulPath, path: string): ParseAttempt {
  const parsed = parseYamlObject(content);
  if (!parsed) return rejected("FILE_PARSE_FAILED", path);
  if (location.kind === "GuardrailsPolicy") {
    try {
      validateGuardrailsConfig(parsed);
    } catch (error) {
      const field = error instanceof TulipFarmValidationError ? error.path : undefined;
      return rejected("SCHEMA_VALIDATION_FAILED", path, field || undefined);
    }
  }
  return admitted(content, location, "delegated");
}

/**
 * Classify one proposed file change and check its content against whatever contract governs that
 * path.
 *
 * Paths resolve through the single artifact layout table in `@tulipfarm/schema`, so this function
 * no longer carries its own idea of where artifacts live — the divergence that made its
 * predecessor reject nearly every real file, and the reason no write path ever adopted it.
 *
 * A path admitting several content modes (a migration in progress) is tried in the declared order,
 * canonical form first, and the mode that succeeded is reported so callers can measure how much of
 * the tree still needs migrating.
 */
export function parseSoulFile(change: SoulFileChange): ParseAttempt {
  const location = classifySoulPath(change.path);

  // A delete is admitted without the path having to be classifiable, but not without limit: it
  // must lie inside a directory this registry governs.
  //
  // The gate exists to stop invalid configuration *entering* the tree; removing a file cannot
  // violate that, and a stray file inside an artifact's directory — left by an older layout, or by
  // an edit made directly on the remote — has to be removable, or the only way to clean it up is
  // the raw-filesystem bypass being eliminated. What stays refused is a delete aimed anywhere else:
  // `.git/`, an invented top-level directory, anything outside the declared tree.
  if (change.operation === "delete") {
    if (!withinArtifactTree(change.path)) {
      return rejected("UNSUPPORTED_SOUL_PATH", change.path);
    }
    return {
      parsed: {
        hash: sha256(`delete\0${change.path}`),
        kind: location?.kind ?? null,
        slug: location?.slug ?? null,
        mode: location?.modes[0] ?? null,
      },
    };
  }

  if (!location) return rejected("UNSUPPORTED_SOUL_PATH", change.path);

  // A path that carries configuration must be admitted by a real contract. Silently hashing one
  // because its kind has no registered schema would let unvalidated config into the tree.
  if (location.modes.includes("definition") && !isDefinitionKind(location.kind)) {
    return rejected("UNKNOWN_KIND", change.path, "/kind");
  }

  let lastIssue: SoulChangesetValidationIssue | undefined;
  for (const mode of location.modes) {
    let attempt: ParseAttempt;
    switch (mode) {
      case "definition":
        attempt = parseDefinition(change.content, location, change.path);
        break;
      case "legacy":
        attempt = parseLegacy(change.content, location, change.path);
        if (attempt.issue && hasFrontmatterBlock(change.content)) return attempt;
        break;
      case "delegated":
        attempt = parseDelegated(change.content, location, change.path);
        break;
      default:
        attempt = admitted(change.content, location, mode);
        break;
    }
    if (attempt.parsed) return attempt;
    lastIssue = attempt.issue;
  }
  return lastIssue ? { issue: lastIssue } : rejected("FILE_PARSE_FAILED", change.path);
}
