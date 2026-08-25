import { SkillFrontmatterSchema } from "./skill-frontmatter";

/**
 * Argument schemas for the six Skill authoring Tools an Agent calls to build a Skill.
 *
 * They are the Agent-facing contract, not the stored shape: the frontmatter accepted here is
 * deliberately narrower than {@link SkillFrontmatterSchema}, because a Skill may carry
 * underscore-prefixed audit fields and authority grants that the runtime writes and an Agent must
 * never be able to set for itself.
 */

/** Frontmatter fields an Agent may author; everything else is runtime-owned. */
const SKILL_PUBLIC_FRONTMATTER_SCHEMA = {
  ...SkillFrontmatterSchema,
  properties: {
    name: SkillFrontmatterSchema.properties.name,
    description: SkillFrontmatterSchema.properties.description,
    category: SkillFrontmatterSchema.properties.category,
    version: SkillFrontmatterSchema.properties.version,
    author: SkillFrontmatterSchema.properties.author,
    license: SkillFrontmatterSchema.properties.license,
  },
} as const;

export const SKILL_CREATE_SCHEMA = {
  type: "object",
  required: ["name", "body", "frontmatter"],
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description:
        "Skill name using lowercase letters, numbers, dots, underscores, or hyphens. Becomes the soul directory name.",
    },
    body: { type: "string", description: "Markdown skill body (instructions/content)." },
    frontmatter: {
      ...SKILL_PUBLIC_FRONTMATTER_SCHEMA,
      description:
        "YAML frontmatter. name must match the Skill name and description is required. Unknown benign fields are allowed; underscore-prefixed and authority-grant fields are forbidden.",
    },
  },
} as const;

export const SKILL_UPDATE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to update." },
    body: { type: "string", description: "New markdown body (replaces existing)." },
    frontmatter: {
      ...SKILL_PUBLIC_FRONTMATTER_SCHEMA,
      description:
        "New complete frontmatter (replaces existing). name and description are required. Omit to keep current.",
    },
    old_string: {
      type: "string",
      description:
        "Exact Skill body text to replace in surgical patch mode. Must be unique unless replace_all is true.",
    },
    new_string: {
      type: "string",
      description:
        "Replacement text for surgical patch mode. Use an empty string to delete the matched text.",
    },
    replace_all: {
      type: "boolean",
      description:
        "Replace every old_string occurrence instead of requiring a unique match. Defaults to false.",
    },
  },
} as const;

export const SKILL_GET_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name." },
  },
} as const;

export const SKILL_LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const SKILL_DELETE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to delete." },
  },
} as const;

export const SKILL_ACTIVATE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to activate." },
  },
} as const;

export const SKILL_MARKETPLACE_BROWSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const SKILL_SOURCE_SCAN_SCHEMA = {
  type: "object",
  required: ["source"],
  additionalProperties: false,
  properties: {
    source: {
      type: "string",
      minLength: 1,
      description: "Git source to scan, optionally suffixed with #branch or #tag.",
    },
  },
} as const;

const SKILL_SCANNED_SELECTION_PROPERTIES = {
  scanId: {
    type: "string",
    minLength: 1,
    description: "Scan identifier returned by skill_source_scan.",
  },
  name: { type: "string", minLength: 1, description: "Exact Skill name returned by the scan." },
  skillPath: {
    type: "string",
    minLength: 1,
    description:
      "Exact SKILL.md path returned by the scan; use it to disambiguate same-named packages.",
  },
} as const;

export const SKILL_SCANNED_AUDIT_SCHEMA = {
  type: "object",
  required: ["scanId", "name", "skillPath"],
  additionalProperties: false,
  properties: SKILL_SCANNED_SELECTION_PROPERTIES,
} as const;

export const SKILL_SCANNED_INSTALL_SCHEMA = {
  type: "object",
  required: ["scanId", "name", "skillPath"],
  additionalProperties: false,
  properties: SKILL_SCANNED_SELECTION_PROPERTIES,
} as const;

export const SKILL_INSTALL_SCHEMA = {
  type: "object",
  required: ["source"],
  additionalProperties: false,
  properties: {
    source: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description:
        "Where the Skill lives: a skills.sh page URL, a GitHub repository or tree URL, or an owner/repo slug. Add #branch or #tag to pin a ref.",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description:
        "Which Skill to install. Only needed when the source holds several and the URL did not name one; the error lists the choices.",
    },
  },
} as const;

export const SKILL_MARKETPLACE_BROWSE_DESCRIPTION =
  "Browse the configured Skill marketplace. Returns a scanId and the exact skillPath for every available Skill; use those exact values to audit and install a package.";

export const SKILL_SOURCE_SCAN_DESCRIPTION =
  "Clone and scan a Git source for installable Skills. Returns the source, resolved ref, scanId, and exact skillPath for each package. Audit a selected package before installing it.";

export const SKILL_SCANNED_AUDIT_DESCRIPTION =
  "Run SkillAudit on one exact scanned package. Supply the scanId, Skill name, and skillPath returned by browsing or scanning before installation.";

export const SKILL_SCANNED_INSTALL_DESCRIPTION =
  "Install one audited Skill from a scan into the soul repository. Supply the exact scanId, name, and skillPath returned by the scan; the result preserves its source and resolved ref as provenance.";

export const SKILL_INSTALL_DESCRIPTION =
  "Install a Skill from a URL in one step. Accepts a skills.sh page URL, a GitHub repository or tree URL, or an owner/repo slug, then scans the source, audits the selected package and installs it. Prefer this over scanning and installing by hand; drop to skill_source_scan only to look through a source without installing.";

export const SKILL_MARKETPLACE_TOOL_DECLARATIONS = [
  {
    name: "skill_install",
    description: SKILL_INSTALL_DESCRIPTION,
    inputSchema: SKILL_INSTALL_SCHEMA,
  },
  {
    name: "skill_marketplace_browse",
    description: SKILL_MARKETPLACE_BROWSE_DESCRIPTION,
    inputSchema: SKILL_MARKETPLACE_BROWSE_SCHEMA,
  },
  {
    name: "skill_source_scan",
    description: SKILL_SOURCE_SCAN_DESCRIPTION,
    inputSchema: SKILL_SOURCE_SCAN_SCHEMA,
  },
  {
    name: "skill_scanned_audit",
    description: SKILL_SCANNED_AUDIT_DESCRIPTION,
    inputSchema: SKILL_SCANNED_AUDIT_SCHEMA,
  },
  {
    name: "skill_scanned_install",
    description: SKILL_SCANNED_INSTALL_DESCRIPTION,
    inputSchema: SKILL_SCANNED_INSTALL_SCHEMA,
  },
] as const;
