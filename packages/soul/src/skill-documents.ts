import {
  DEFINITION_API_VERSION,
  parseFrontmatter,
  SchemaRegistry,
  SKILL_DEFINITION,
  type VersionedSchemaDocument,
} from "@tulipfarm/schema";
import { deriveDefinitionId, mapAllowlistedFields } from "./converters/shared";

/**
 * Runtime Skill definitions synthesized from a `SKILL.md`.
 *
 * `SKILL.md` is the only Skill format the product writes and the only one the wider ecosystem
 * ships, so a Skill carries no canonical envelope on disk. Without this projection every consumer
 * that reads definitions rather than frontmatter behaved as if the Skill did not exist: its
 * `commands` reached no bundle, so no Skill could contribute a sandbox Tool to a Routine.
 *
 * This mirrors {@link import("./agent-documents").agentDocumentFromLegacy}: the authored file stays
 * authoritative and nothing is written back to the tree; the canonical view is derived on read so
 * validation and compilation see one definition set.
 */

const registry = new SchemaRegistry([SKILL_DEFINITION]);

/** `SkillSpec` fields an author may set in frontmatter; `instructions` is derived, never copied. */
const SKILL_FRONTMATTER_ALLOWLIST = [
  "references",
  "templates",
  "examples",
  "schemas",
  "assets",
  "scripts",
  "commands",
  "dependencies",
  "requiredToolAbilities",
  "requiredSecrets",
  "allowedDomains",
  "trustTier",
] as const;

/**
 * Trust tier for a `SKILL.md` that names none.
 *
 * Deliberately the least-trusted tier rather than the Agent projection's `business_authored`: a
 * Skill package is routinely installed from a third-party remote, and `trustTier` gates Skill
 * resolution. Guessing upward here would silently widen what an Agent may load.
 */
const DEFAULT_TRUST_TIER = "third_party";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The canonical view of one `SKILL.md`, or `undefined` when the file does not yield a valid Skill.
 *
 * Returning `undefined` rather than throwing is deliberate: a Skill that cannot be projected must
 * not fail the publication of every other definition in the tree.
 */
export function skillDocumentFromMarkdown(
  slug: string,
  content: string,
  instructionsPath: string
): VersionedSchemaDocument | undefined {
  const { frontmatter } = parseFrontmatter(content);
  const fields = isRecord(frontmatter) ? frontmatter : {};
  // No frontmatter means the file is prose a reader renders, not configuration to project.
  if (Object.keys(fields).length === 0) return undefined;

  const { mapped } = mapAllowlistedFields(fields, SKILL_FRONTMATTER_ALLOWLIST);
  const displayName = typeof fields.name === "string" ? fields.name : slug;

  const document = {
    apiVersion: DEFINITION_API_VERSION,
    kind: "Skill",
    metadata: {
      id: deriveDefinitionId("Skill", displayName),
      slug,
      displayName,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      ...mapped,
      instructions: { path: instructionsPath },
      trustTier: mapped.trustTier ?? DEFAULT_TRUST_TIER,
    },
  };

  try {
    return registry.validate(document).document;
  } catch {
    // A projection that does not validate is no projection; the Skill stays frontmatter-only.
    return undefined;
  }
}
