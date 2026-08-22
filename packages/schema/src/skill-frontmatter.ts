import { stringify } from "yaml";
import { ajv } from "./ajv";
import { SKILL_FORBIDDEN_GRANT_KEYS } from "./definitions/skill";

const MAX_SKILL_CONTENT_CHARS = 100_000;

export const SkillFrontmatterSchema = {
  type: "object",
  required: ["name", "description"],
  additionalProperties: true,
  properties: {
    name: {
      type: "string",
      maxLength: 64,
      pattern: "^[a-z0-9][a-z0-9._-]*$",
    },
    description: { type: "string", minLength: 1, maxLength: 1024 },
    eager: { type: "boolean" },
    category: {
      type: "string",
      maxLength: 64,
      pattern: "^[a-z0-9][a-z0-9._-]*$",
    },
    version: { type: "string" },
    author: { type: "string" },
    license: { type: "string" },
    requiredSecrets: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
    },
    allowedDomains: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 253,
        pattern: "^(?!.*\\*)(?!.*://)(?!.*[/@])[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$",
      },
    },
    _pendingAudit: { type: "boolean" },
  },
} as const;

export interface SkillFrontmatter {
  name: string;
  description: string;
  eager?: boolean;
  category?: string;
  version?: string;
  author?: string;
  license?: string;
  requiredSecrets?: string[];
  allowedDomains?: string[];
  _pendingAudit?: boolean;
  [key: string]: unknown;
}

export interface SkillValidationInput {
  name: string;
  frontmatter: unknown;
  body: string;
  /** Exact raw or would-be-written SKILL.md content used for the character limit. */
  content: string;
  /**
   * Where the frontmatter came from.
   *
   * `authored` — the default — is the strict form every author-facing surface uses, and is what
   * stops an Agent granting itself a runtime-owned field. `stored` validates a SKILL.md the server
   * itself wrote, where {@link SKILL_RUNTIME_FRONTMATTER_KEYS} are expected: re-checking those as
   * author input rejects the very file the write gateway just accepted.
   */
  origin?: "authored" | "stored";
}

export type SkillValidationResult =
  | { valid: true; frontmatter: SkillFrontmatter }
  | { valid: false; error: string };

const checkFrontmatter = ajv.compile(SkillFrontmatterSchema);
const forbiddenGrantKeys = new Set<string>(SKILL_FORBIDDEN_GRANT_KEYS);

/** Top-level frontmatter keys the runtime writes for itself; an author may never set them. */
export const SKILL_RUNTIME_FRONTMATTER_KEYS = ["_pendingAudit"] as const;

function withoutRuntimeFields(frontmatter: SkillFrontmatter): Record<string, unknown> {
  const authored: Record<string, unknown> = { ...frontmatter };
  for (const key of SKILL_RUNTIME_FRONTMATTER_KEYS) delete authored[key];
  return authored;
}

function firstSchemaError(): string {
  const error = checkFrontmatter.errors?.[0];
  if (!error) return "invalid Skill frontmatter";
  return `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`.trim();
}

function reservedKeyError(
  value: unknown,
  path = "frontmatter",
  seen = new Set<object>()
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const error = reservedKeyError(item, `${path}[${index}]`, seen);
      if (error) return error;
    }
    return undefined;
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const keyPath = `${path}.${key}`;
    if (key.startsWith("_")) {
      return `${keyPath} is reserved for server use`;
    }
    if (forbiddenGrantKeys.has(key)) {
      return `${keyPath} is forbidden because a Skill cannot grant authority`;
    }
    const error = reservedKeyError((value as Record<string, unknown>)[key], keyPath, seen);
    if (error) return error;
  }
  return undefined;
}

/** Validate SKILL.md without throwing; `content` must be the exact value to be written. */
export function validateSkill(input: SkillValidationInput): SkillValidationResult {
  if (!checkFrontmatter(input.frontmatter)) {
    return { valid: false, error: firstSchemaError() };
  }

  const frontmatter = input.frontmatter as SkillFrontmatter;
  if (frontmatter.name !== input.name) {
    return {
      valid: false,
      error: `frontmatter.name must equal the Skill directory name "${input.name}"`,
    };
  }

  const keyError = reservedKeyError(
    input.origin === "stored" ? withoutRuntimeFields(frontmatter) : frontmatter
  );
  if (keyError) return { valid: false, error: keyError };

  if (input.body.trim().length === 0) {
    return { valid: false, error: "SKILL.md body must not be empty" };
  }

  if (input.content.length > MAX_SKILL_CONTENT_CHARS) {
    return {
      valid: false,
      error: `SKILL.md content exceeds ${MAX_SKILL_CONTENT_CHARS.toLocaleString("en-US")} characters`,
    };
  }

  return { valid: true, frontmatter };
}

/** Serialize a validated Skill; pass this exact output back to `validateSkill` for size checks. */
export function serializeSkill(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter)}---\n${body}`;
}
