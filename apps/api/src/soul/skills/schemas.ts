import { SKILL_AUDIT_REPORT_SCHEMA } from "@tulipfarm/built-in-agents";
import { SKILL_SOURCE_TYPES } from "@tulipfarm/soul";

/**
 * What a Skill reaches, as declared in its own `SKILL.md` frontmatter.
 *
 * These ship on the summary as well as the detail because they are what an operator filters and
 * compares a catalog by — "which of these touch the network" is a list question, and answering it
 * from the detail route would be one request per Skill.
 */
const SkillCapabilityPropertiesSchema = {
  /** Tool names the Skill narrows the model's view to. Focus, never authority. */
  tools: { type: "array", items: { type: "string" } },
  /** Hosts a Skill command may reach; absent means the sandbox runs with no network at all. */
  allowedDomains: { type: "array", items: { type: "string" } },
  /** Shell command patterns `SkillBashRunner` will admit. */
  allowedCommands: { type: "array", items: { type: "string" } },
  /** Secret names the Skill needs leased to it. */
  requiredSecrets: { type: "array", items: { type: "string" } },
} as const;

const SkillSummaryPropertiesSchema = {
  name: { type: "string" },
  description: { type: "string" },
  provenance: { type: "string", enum: SKILL_SOURCE_TYPES },
  version: { type: "string" },
  source: { type: "string" },
  category: { type: "string" },
  author: { type: "string" },
  updatedAt: { type: "string", format: "date-time" },
  ...SkillCapabilityPropertiesSchema,
} as const;

const MarketplaceSkillPropertiesSchema = {
  name: { type: "string" },
  skillPath: { type: "string" },
  skillId: { type: "string" },
  description: { type: "string" },
  category: { type: "string" },
  installs: { type: "number" },
  installed: { type: "boolean" },
  updateAvailable: { type: "boolean" },
} as const;

const SkillPackageFilePropertiesSchema = {
  path: { type: "string" },
  size: { type: "integer" },
} as const;

const SkillCommandPropertiesSchema = {
  name: { type: "string" },
  toolRef: { type: "string" },
  runtimeProfile: { type: "string" },
  entrypoint: { type: "string" },
  requiredCommands: { type: "array", items: { type: "string" } },
  runtimeAvailable: { type: "boolean" },
  blocker: { type: "string" },
} as const;

const ScannedSkillPropertiesSchema = {
  name: { type: "string" },
  /** Unique within one scan; `name` is not, so this is what a client keys a selection by. */
  skillPath: { type: "string" },
  description: { type: "string" },
  installed: { type: "boolean" },
  updateAvailable: { type: "boolean" },
} as const;

export const SkillListResponseSchema = {
  type: "object",
  required: ["skills"],
  properties: {
    skills: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "provenance"],
        properties: SkillSummaryPropertiesSchema,
      },
    },
  },
} as const;

export const SkillMarketplaceResponseSchema = {
  type: "object",
  required: ["scanId", "source", "skills"],
  properties: {
    scanId: { type: "string" },
    source: { type: "string" },
    skills: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "installed", "updateAvailable"],
        properties: MarketplaceSkillPropertiesSchema,
      },
    },
  },
} as const;

export const SkillNameParamsSchema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string" } },
} as const;

export const SkillDetailResponseSchema = {
  type: "object",
  required: ["name", "provenance", "body", "files", "commands"],
  properties: {
    ...SkillSummaryPropertiesSchema,
    license: { type: "string" },
    body: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "size"],
        properties: SkillPackageFilePropertiesSchema,
      },
    },
    commands: {
      type: "array",
      items: {
        type: "object",
        required: [
          "name",
          "toolRef",
          "runtimeProfile",
          "entrypoint",
          "requiredCommands",
          "runtimeAvailable",
        ],
        properties: SkillCommandPropertiesSchema,
      },
    },
  },
} as const;

export const SkillDeleteResponseSchema = {
  type: "null",
} as const;

/**
 * Reading one file out of a Skill package.
 *
 * The path is a querystring rather than a wildcard route segment because a Skill's own paths
 * contain slashes (`references/authoring-a-skill.md`), and a client that had to encode them into
 * the path would be one missed `encodeURIComponent` away from a different route.
 */
export const SkillFileQuerySchema = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
} as const;

export const SkillFileResponseSchema = {
  type: "object",
  required: ["path", "size", "content", "truncated"],
  properties: {
    path: { type: "string" },
    size: { type: "integer" },
    /** UTF-8 text. A file the server judged binary returns `content: ""` with `binary: true`. */
    content: { type: "string" },
    /** True when the file exceeded the read ceiling and `content` holds only its head. */
    truncated: { type: "boolean" },
    binary: { type: "boolean" },
  },
} as const;

export const SkillScanBodySchema = {
  type: "object",
  required: ["source"],
  additionalProperties: false,
  properties: { source: { type: "string", minLength: 1 } },
} as const;

export const SkillScanResponseSchema = {
  type: "object",
  required: ["scanId", "skills"],
  properties: {
    scanId: { type: "string" },
    skills: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "installed", "updateAvailable"],
        properties: ScannedSkillPropertiesSchema,
      },
    },
  },
} as const;

export const SkillAuditBodySchema = {
  type: "object",
  required: ["scanId", "name"],
  additionalProperties: false,
  properties: {
    scanId: { type: "string" },
    name: { type: "string" },
    /** Resolves the row exactly; `name` alone picks whichever row the scan listed first. */
    skillPath: { type: "string" },
  },
} as const;

export const SkillAuditResponseSchema = {
  type: "object",
  required: ["report"],
  properties: { report: SKILL_AUDIT_REPORT_SCHEMA },
} as const;

export const SkillInstallBodySchema = {
  type: "object",
  required: ["scanId"],
  additionalProperties: false,
  properties: {
    scanId: { type: "string" },
    /** Legacy selection; cannot distinguish two scanned skills that share a name. */
    names: { type: "array", items: { type: "string" }, minItems: 1 },
    /** `skillPath` values from the scan — unique per row, so this is the preferred selection. */
    paths: { type: "array", items: { type: "string" }, minItems: 1 },
  },
} as const;

export const SkillInstallResponseSchema = {
  type: "object",
  required: ["installed"],
  properties: { installed: { type: "array", items: { type: "string" } } },
} as const;
