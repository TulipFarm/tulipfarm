import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { ajv } from "@tulipfarm/validation";
import { stringify } from "yaml";
import { type ToolCallResult, err, ok } from "../../tools/types.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface SkillToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
}

export interface SkillTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: SkillToolContext) => Promise<ToolCallResult>;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstError(validate: ReturnType<typeof ajv.compile>): string {
  const e = validate.errors?.[0];
  if (!e) return "invalid arguments";
  return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim();
}

function serializeSkill(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `---\n${stringify(frontmatter)}---\n${body}`;
}

// ── skill_create ──────────────────────────────────────────────────────────────

const CREATE_SCHEMA = {
  type: "object",
  required: ["name", "body"],
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Skill name (kebab-case, e.g. 'code-review'). Becomes the soul directory name.",
    },
    body: { type: "string", description: "Markdown skill body (instructions/content)." },
    frontmatter: {
      type: "object",
      description: "Optional YAML frontmatter fields (arbitrary key-value pairs).",
    },
  },
} as const;

const validateCreate = ajv.compile(CREATE_SCHEMA);

const skillCreate: SkillTool = {
  name: "skill_create",
  // No approval gate by design: this system-tier tool lets an agent author skills
  // autonomously. That intentionally differs from the operator-facing HTTP install flow
  // (POST /api/v1/skills/install), which requires a SkillAudit because it pulls THIRD-PARTY
  // skills from a git source; authoring first-party skills here does not.
  description:
    "Create a new skill in the soul repo by writing its SKILL.md. Commits and pushes via withSync. No approval gate.",
  mutating: true,
  inputSchema: CREATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate));
    const {
      name,
      body,
      frontmatter = {},
    } = args as {
      name: string;
      body: string;
      frontmatter?: Record<string, unknown>;
    };

    if (!NAME_RE.test(name)) return err("validation_error", "invalid skill name");

    const skillDir = join(ctx.gitSync.path, "skills", name);
    if (existsSync(skillDir)) return err("validation_error", "skill already exists");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), serializeSkill(frontmatter, body), "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    let pushed: boolean | undefined;
    try {
      ({ pushed } = await ctx.gitSync.withSync(`soul: add skill ${name}`));
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    // `pushed` surfaces whether the commit reached the remote (false = committed locally
    // only; a later sync may hard-reset it away on genuine divergence).
    return ok({ name, frontmatter, body, pushed });
  },
};

// ── skill_update ──────────────────────────────────────────────────────────────

const UPDATE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to update." },
    body: { type: "string", description: "New markdown body (replaces existing)." },
    frontmatter: {
      type: "object",
      description: "New frontmatter (replaces existing). Omit to keep current.",
    },
  },
  anyOf: [{ required: ["body"] }, { required: ["frontmatter"] }],
} as const;

const validateUpdate = ajv.compile(UPDATE_SCHEMA);

const skillUpdate: SkillTool = {
  name: "skill_update",
  description:
    "Update an existing skill's body and/or frontmatter. At least one must be provided. Commits and pushes via withSync.",
  mutating: true,
  inputSchema: UPDATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate));
    const { name, body, frontmatter } = args as {
      name: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
    };

    const existing = ctx.soulLoader.skills.get(name);
    if (!existing) return err("not_found", `skill not found: ${name}`);

    const newBody = body ?? existing.body;
    const newFm = frontmatter ?? existing.frontmatter;

    const skillFile = join(ctx.gitSync.path, "skills", name, "SKILL.md");
    try {
      await writeFile(skillFile, serializeSkill(newFm, newBody), "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: update skill ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, frontmatter: newFm, body: newBody });
  },
};

// ── skill_get ─────────────────────────────────────────────────────────────────

const GET_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name." },
  },
} as const;

const validateGet = ajv.compile(GET_SCHEMA);

const skillGet: SkillTool = {
  name: "skill_get",
  description: "Get a skill's frontmatter and markdown body from the soul.",
  mutating: false,
  inputSchema: GET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet));
    const { name } = args as { name: string };
    const skill = ctx.soulLoader.skills.get(name);
    if (!skill) return err("not_found", `skill not found: ${name}`);
    return ok({ name: skill.name, frontmatter: skill.frontmatter, body: skill.body });
  },
};

// ── skill_list ────────────────────────────────────────────────────────────────

const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const validateList = ajv.compile(LIST_SCHEMA);

const skillList: SkillTool = {
  name: "skill_list",
  description: "List all skills defined in the soul repo.",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList));
    const skills = Array.from(ctx.soulLoader.skills.values()).map(({ name, frontmatter }) => ({
      name,
      frontmatter,
    }));
    return ok({ skills });
  },
};

// ── skill_delete ──────────────────────────────────────────────────────────────

const DELETE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to delete." },
  },
} as const;

const validateDelete = ajv.compile(DELETE_SCHEMA);

const skillDelete: SkillTool = {
  name: "skill_delete",
  description:
    "Delete a skill from the soul repo. Removes its directory, commits and pushes via withSync.",
  mutating: true,
  inputSchema: DELETE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete));
    const { name } = args as { name: string };

    if (!ctx.soulLoader.skills.has(name)) return err("not_found", `skill not found: ${name}`);

    const skillDir = join(ctx.gitSync.path, "skills", name);
    try {
      await rm(skillDir, { recursive: true, force: true });
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: remove skill ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, deleted: true });
  },
};

export const SKILL_TOOLS: SkillTool[] = [
  skillCreate,
  skillUpdate,
  skillGet,
  skillList,
  skillDelete,
];
