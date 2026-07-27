import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmService } from "@tulipfarm/llm";
import {
  ajv,
  LlmNotConfiguredError,
  SkillFrontmatterSchema,
  serializeSkill,
  validateSkill,
} from "@tulipfarm/schema";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { err, ok, type ToolCallResult } from "../../tools/types.js";
import { buildAudit } from "./audit.js";
import { type BundledSkill, persistDisabledBundledSkills } from "./bundled.js";
import { mergedSkills, resolveSkill } from "./registry.js";

export interface SkillToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  llmService?: LlmService;
  bundledSkills: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills: Set<string>;
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

const PUBLIC_FRONTMATTER_SCHEMA = {
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

function publicFrontmatter(frontmatter: Record<string, unknown>): {
  frontmatter: Record<string, unknown>;
  pendingAudit: boolean;
} {
  const { _pendingAudit: pendingAudit, ...publicFields } = frontmatter;
  return { frontmatter: publicFields, pendingAudit: pendingAudit === true };
}

// ── skill_create ──────────────────────────────────────────────────────────────

const CREATE_SCHEMA = {
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
      ...PUBLIC_FRONTMATTER_SCHEMA,
      description:
        "YAML frontmatter. name must match the Skill name and description is required. Unknown benign fields are allowed; underscore-prefixed and authority-grant fields are forbidden.",
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
    const { name, body, frontmatter } = args as {
      name: string;
      body: string;
      frontmatter: Record<string, unknown>;
    };

    const pendingFm = { ...frontmatter, _pendingAudit: true };
    const content = serializeSkill(pendingFm, body);
    const validation = validateSkill({ name, frontmatter, body, content });
    if (!validation.valid) return err("validation_error", validation.error);

    const skillDir = join(ctx.gitSync.path, "skills", name);
    if (existsSync(skillDir) || ctx.bundledSkills.has(name)) {
      return err("validation_error", "skill already exists");
    }

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
    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
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
        description: validation.frontmatter.description,
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
      ...PUBLIC_FRONTMATTER_SCHEMA,
      description:
        "New complete frontmatter (replaces existing). name and description are required. Omit to keep current. At least one of body or frontmatter must be provided.",
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

    const soulSkill = ctx.soulLoader.skills.get(name);
    const bundledSkill = ctx.bundledSkills.get(name);
    const existing = soulSkill ?? bundledSkill;
    if (!existing) return err("not_found", `skill not found: ${name}`);

    const existingPublic = publicFrontmatter(existing.frontmatter);
    const newBody = body ?? existing.body;
    const newFm = frontmatter ?? existingPublic.frontmatter;
    const persistedFm = existingPublic.pendingAudit ? { ...newFm, _pendingAudit: true } : newFm;
    const content = serializeSkill(persistedFm, newBody);
    const validation = validateSkill({ name, frontmatter: newFm, body: newBody, content });
    if (!validation.valid) return err("validation_error", validation.error);

    const skillFile = join(ctx.gitSync.path, "skills", name, "SKILL.md");
    try {
      if (!soulSkill && bundledSkill) {
        await mkdir(join(ctx.gitSync.path, "skills"), { recursive: true });
        await cp(bundledSkill.directory, join(ctx.gitSync.path, "skills", name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      await writeFile(skillFile, content, "utf8");
      if (ctx.disabledBundledSkills.delete(name)) {
        await persistDisabledBundledSkills(ctx.gitSync.path, ctx.disabledBundledSkills);
      }
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

    return ok({ name, frontmatter: validation.frontmatter, body: newBody });
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
  description:
    "Get a Skill's frontmatter, markdown body, and provenance from the merged Soul-over-bundled view.",
  mutating: false,
  inputSchema: GET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet));
    const { name } = args as { name: string };
    const soulSkill = ctx.soulLoader.skills.get(name);
    const skill = resolveSkill(name, ctx.soulLoader, ctx.bundledSkills, ctx.disabledBundledSkills);
    if (!skill) return err("not_found", `skill not found: ${name}`);
    return ok({
      name: skill.name,
      frontmatter: skill.frontmatter,
      body: skill.body,
      provenance: soulSkill ? "soul" : "builtin",
    });
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
  description: "List Skills from the merged Soul-over-bundled view with provenance.",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList));
    const skills = Array.from(
      mergedSkills(ctx.soulLoader, ctx.bundledSkills, ctx.disabledBundledSkills).values()
    ).map(({ name, frontmatter }) => ({
      name,
      frontmatter,
      provenance: ctx.soulLoader.skills.has(name) ? "soul" : "builtin",
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
    "Delete a Skill from the merged view. Soul Skills are removed; bundled Skills are hidden with a persistent tombstone. Commits and pushes via withSync.",
  mutating: true,
  inputSchema: DELETE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete));
    const { name } = args as { name: string };

    const soulSkill = ctx.soulLoader.skills.get(name);
    const bundledSkill = ctx.bundledSkills.get(name);
    if (!soulSkill && (!bundledSkill || ctx.disabledBundledSkills.has(name))) {
      return err("not_found", `skill not found: ${name}`);
    }

    const skillDir = join(ctx.gitSync.path, "skills", name);
    try {
      if (soulSkill) await rm(skillDir, { recursive: true, force: true });
      if (bundledSkill) {
        ctx.disabledBundledSkills.add(name);
        await persistDisabledBundledSkills(ctx.gitSync.path, ctx.disabledBundledSkills);
      }
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
    const content = serializeSkill(activeFm, skill.body);
    const validation = validateSkill({
      name,
      frontmatter: activeFm,
      body: skill.body,
      content,
    });
    if (!validation.valid) return err("validation_error", validation.error);

    const skillFile = join(ctx.gitSync.path, "skills", name, "SKILL.md");
    try {
      await writeFile(skillFile, content, "utf8");
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
