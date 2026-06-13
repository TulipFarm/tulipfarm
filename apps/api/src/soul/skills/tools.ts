import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LlmNotConfiguredError, type LlmService } from "@tulipfarm/llm";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { ajv } from "@tulipfarm/validation";
import { stringify } from "yaml";
import { err, ok, type ToolCallResult } from "../../tools/types.js";
import { buildAudit } from "./audit.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface SkillToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  llmService?: LlmService;
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
  description:
    "Create a new skill in the soul repo. Writes SKILL.md (pending audit), commits via withSync, runs SkillAudit synchronously, and returns the audit report. The skill is not active in prompt assembly until confirmed via skill_activate.",
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

    // Fail fast before writing: SkillAudit requires a working LLM (AC-V1-002).
    if (!ctx.llmService) {
      return err(
        "audit_required",
        "LLM service not available — configure a provider before creating skills"
      );
    }
    let model: ReturnType<typeof ctx.llmService.select>;
    try {
      model = ctx.llmService.select({ model: "standard" });
    } catch (e) {
      if (e instanceof LlmNotConfiguredError) {
        return err(
          "audit_required",
          "LLM not configured — configure a provider before creating skills"
        );
      }
      return err("internal_error", reason(e));
    }

    // Write with _pendingAudit marker so the skill is committed but inactive until operator confirms.
    const pendingFm = { ...frontmatter, _pendingAudit: true };
    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), serializeSkill(pendingFm, body), "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: add skill ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    // Run SkillAudit synchronously. Skill is already committed; surface errors but keep it pending.
    let auditReport: Awaited<ReturnType<typeof buildAudit>>;
    try {
      auditReport = await buildAudit(model, {
        name,
        description:
          typeof frontmatter.description === "string" ? frontmatter.description : undefined,
        body,
      });
    } catch (e) {
      return err("internal_error", `skill committed as pending but audit failed: ${reason(e)}`);
    }

    // Return user-supplied frontmatter (without the internal _pendingAudit marker).
    return ok({ name, frontmatter, body, auditReport });
  },
};

// ── skill_update ──────────────────────────────────────────────────────────────

// NOTE: no top-level `anyOf` — OpenAI-family models reject tool parameter schemas with a top-level
// anyOf/oneOf/allOf/enum/not. The "at least one of body/frontmatter" rule is enforced in the handler.
const UPDATE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to update." },
    body: { type: "string", description: "New markdown body (replaces existing)." },
    frontmatter: {
      type: "object",
      description:
        "New frontmatter (replaces existing). Omit to keep current. At least one of body or frontmatter must be provided.",
    },
  },
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
    if (body === undefined && frontmatter === undefined)
      return err("validation_error", "at least one of body or frontmatter must be provided");

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

// ── skill_activate ────────────────────────────────────────────────────────────

const ACTIVATE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to activate." },
  },
} as const;

const validateActivate = ajv.compile(ACTIVATE_SCHEMA);

const skillActivate: SkillTool = {
  name: "skill_activate",
  description:
    "Activate a forge-created skill after the operator has reviewed its SkillAudit report. Removes the _pendingAudit marker, commits, and reloads — making the skill available in prompt assembly.",
  mutating: true,
  inputSchema: ACTIVATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateActivate(args)) return err("validation_error", firstError(validateActivate));
    const { name } = args as { name: string };

    const skill = ctx.soulLoader.skills.get(name);
    if (!skill) return err("not_found", `skill not found: ${name}`);
    if (!skill.frontmatter._pendingAudit) {
      return err("validation_error", `skill '${name}' is already active`);
    }

    const { _pendingAudit: _removed, ...activeFm } = skill.frontmatter;
    const skillFile = join(ctx.gitSync.path, "skills", name, "SKILL.md");
    try {
      await writeFile(skillFile, serializeSkill(activeFm, skill.body), "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: activate skill ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, activated: true });
  },
};

export const SKILL_TOOLS: SkillTool[] = [
  skillCreate,
  skillUpdate,
  skillGet,
  skillList,
  skillDelete,
  skillActivate,
];
