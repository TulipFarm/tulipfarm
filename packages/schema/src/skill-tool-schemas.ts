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
    eager: SkillFrontmatterSchema.properties.eager,
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
