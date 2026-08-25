import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { LlmService } from "@tulipfarm/llm";
import {
  ajv,
  LlmNotConfiguredError,
  SKILL_ACTIVATE_SCHEMA,
  SKILL_CREATE_SCHEMA,
  SKILL_DELETE_SCHEMA,
  SKILL_GET_SCHEMA,
  SKILL_LIST_SCHEMA,
  SKILL_UPDATE_SCHEMA,
  serializeSkill,
  validateSkill,
} from "@tulipfarm/schema";
import {
  type BundledSkill,
  bumpPatch,
  DEFAULT_SKILL_VERSION,
  DISABLED_BUNDLED_SKILLS_FILE,
  type GitSyncService,
  isSkillVersion,
  mergedSkills,
  mutateSkillsLock,
  persistDisabledBundledSkills,
  readSkillsLock,
  resolveSkill,
  SKILLS_LOCK_FILE,
  type SkillSourceType,
  type SkillsLock,
  type SoulLoader,
  type SoulWrite,
  SoulWriteError,
  type SoulWriter,
  scanSkill,
  serializeSkillsLock,
  serializeSkillsLockWrites,
  skillTrustLevel,
  skillVersion,
} from "@tulipfarm/soul";
import {
  type ApiToolDefinition,
  defineApiTool,
  err,
  MARKETPLACE_SKILL_TOOLS,
  type MarketplaceSkillToolContext,
  ok,
  type ToolCallResult,
} from "@tulipfarm/tool-host";
import { firstError } from "../../platform/tool-args";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../../runtime/soul-writer";
import { soulCommitError } from "../../tools/soul-faults";
import { buildAudit } from "./audit.js";

export interface SkillToolContext extends MarketplaceSkillToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  llmService?: LlmService;
  bundledSkills: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills: Set<string>;
  /**
   * Skills hidden for this Turn only. Kept apart from {@link disabledBundledSkills} because that
   * set is persisted back to `skills/.bundled-disabled.json`; a live gate written into it would
   * become a permanent delete.
   */
  hiddenSkillNames?: () => Promise<ReadonlySet<string>>;
  readonly soulWriter: SoulWriter;
}

const SOUL_SKILL_TARGET = "soul.skill";

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Map a Soul write-gateway rejection onto this tool family's error vocabulary.
 *
 * `PRECONDITION_FAILED` is the one code whose meaning is site-specific — an "already exists" on
 * create, a "not found" on update/delete — so each caller supplies that mapping. The rest are
 * fixed: a rejected changeset (bad target or invalid content) is a `validation_error`, a moved base
 * is transient (`unavailable`), and a failed commit is classified by `soulCommitError` so git
 * contention is reported as `unavailable` rather than as a request the model should repair. The
 * gateway's message carries only structured evidence, never file content, so it is safe to surface.
 */
function mapSoulWriteError(
  e: SoulWriteError,
  onPrecondition: () => ToolCallResult
): ToolCallResult {
  switch (e.code) {
    case "PRECONDITION_FAILED":
      return onPrecondition();
    case "VALIDATION_FAILED":
    case "INVALID_TARGET":
      return err("validation_error", e.message);
    case "CONFLICT":
      return err("unavailable", e.message);
    default:
      return soulCommitError(e, e.message);
  }
}

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function skillTargets(args: unknown) {
  const id = stringArg(args, "name");
  // Soul targets use the same two-level name as their static resource (`soul.<thing>`).
  return id === undefined ? [] : [{ type: SOUL_SKILL_TARGET, id }];
}

function publicFrontmatter(frontmatter: Record<string, unknown>): {
  frontmatter: Record<string, unknown>;
  pendingAudit: boolean;
} {
  const { _pendingAudit: pendingAudit, ...publicFields } = frontmatter;
  return { frontmatter: publicFields, pendingAudit: pendingAudit === true };
}

// ── skill_create ──────────────────────────────────────────────────────────────

const validateCreate = ajv.compile(SKILL_CREATE_SCHEMA);

const skillCreate = defineApiTool<SkillToolContext>({
  name: "skill_create",
  description:
    "Create a new skill in the soul repo. Writes SKILL.md (pending audit), commits it to the soul repo, runs SkillAudit synchronously, and returns the audit report. The skill is not active in prompt assembly until confirmed via skill_activate.",
  tier: "system",
  mutating: true,
  inputSchema: SKILL_CREATE_SCHEMA,
  authorization: {
    action: "soul.skill.create",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate.errors));
    const { name, body, frontmatter } = args as {
      name: string;
      body: string;
      frontmatter: Record<string, unknown>;
    };

    // A Skill is versioned from birth so the lock records something meaningful for every entry.
    const version = skillVersion(frontmatter);
    const authoredFm = { ...frontmatter, version };
    const pendingFm = { ...authoredFm, _pendingAudit: true };
    const content = serializeSkill(pendingFm, body);
    const validation = validateSkill({ name, frontmatter: authoredFm, body, content });
    if (!validation.valid) return err("validation_error", validation.error);

    if (
      ctx.soulWriter.readCompanion("Skill", name, "SKILL.md") !== null ||
      ctx.bundledSkills.has(name)
    ) {
      return err("validation_error", "skill already exists");
    }

    // Fail fast before writing: SkillAudit requires a working LLM.
    if (!ctx.llmService) {
      return err(
        "audit_required",
        "LLM service not available — configure a provider before creating skills"
      );
    }
    let model: ReturnType<typeof ctx.llmService.effortModel>;
    try {
      model = ctx.llmService.effortModel("balanced");
    } catch (e) {
      if (e instanceof LlmNotConfiguredError) {
        return err(
          "audit_required",
          "LLM not configured — configure a provider before creating skills"
        );
      }
      return err("internal_error", reason(e));
    }

    // Commit with the _pendingAudit marker so the skill lands committed but inactive until an
    // operator confirms it. One companion put is the whole changeset — atomic through the gateway.
    try {
      await mutateSkillsLock(ctx.soulWriter, ctx.gitSync.path, (lock) => ({
        subject: `soul: add skill ${name}`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: [
          { op: "put", target: { kind: "Skill", slug: name, companion: "SKILL.md" }, content },
          curatedLockWrite(lock, name, version),
        ],
      }));
    } catch (e) {
      if (e instanceof SoulWriteError) {
        return mapSoulWriteError(e, () => err("validation_error", "skill already exists"));
      }
      return err("internal_error", reason(e));
    }

    // Run SkillAudit synchronously. Skill is already committed; surface errors but keep it pending.
    const deterministicScan = {
      ...scanSkill([{ path: "SKILL.md", content }]),
      trustLevel: skillTrustLevel("agent-created"),
    };
    let auditReport: Awaited<ReturnType<typeof buildAudit>>;
    try {
      auditReport = await buildAudit(
        model,
        {
          name,
          description: validation.frontmatter.description,
          body,
        },
        deterministicScan
      );
    } catch (e) {
      return err("internal_error", `skill committed as pending but audit failed: ${reason(e)}`);
    }

    // Return user-supplied frontmatter (without the internal _pendingAudit marker).
    return ok({ name, frontmatter, body, auditReport });
  },
});

// ── skill_update ──────────────────────────────────────────────────────────────

// NOTE: no top-level `anyOf` — OpenAI-family models reject tool parameter schemas with a top-level
// anyOf/oneOf/allOf/enum/not. The replacement-vs-patch constraints are enforced in the handler.
const validateUpdate = ajv.compile(SKILL_UPDATE_SCHEMA);

const skillUpdate = defineApiTool<SkillToolContext>({
  name: "skill_update",
  description:
    "Update an existing Skill. Prefer old_string/new_string for surgical body fixes; use body and/or frontmatter only for full replacements. Patch text must be unique unless replace_all is true. Updates preserve audit state and do not re-run SkillAudit. The change is committed to the soul repo.",
  tier: "system",
  mutating: true,
  inputSchema: SKILL_UPDATE_SCHEMA,
  authorization: {
    action: "soul.skill.update",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate.errors));
    const { name, body, frontmatter, old_string, new_string, replace_all } = args as {
      name: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
    };
    const hasReplacement = body !== undefined || frontmatter !== undefined;
    const hasPatch =
      old_string !== undefined || new_string !== undefined || replace_all !== undefined;
    if (!hasReplacement && !hasPatch) {
      return err(
        "validation_error",
        "provide body/frontmatter for replacement or old_string/new_string for a patch"
      );
    }
    if (hasReplacement && hasPatch) {
      return err("validation_error", "cannot combine a full replacement with a surgical patch");
    }
    if (hasPatch && !old_string) {
      return err("validation_error", "old_string is required for a surgical patch");
    }
    if (hasPatch && new_string === undefined) {
      return err(
        "validation_error",
        "new_string is required for a surgical patch; use an empty string to delete"
      );
    }

    const soulSkill = ctx.soulLoader.skills.get(name);
    const bundledSkill = ctx.bundledSkills.get(name);
    const existing = soulSkill ?? bundledSkill;
    if (!existing) return err("not_found", `skill not found: ${name}`);

    const existingPublic = publicFrontmatter(existing.frontmatter);
    let newBody = body ?? existing.body;
    if (hasPatch && old_string && new_string !== undefined) {
      const matchCount = existing.body.split(old_string).length - 1;
      if (matchCount === 0) {
        return err("validation_error", "old_string was not found in the Skill body");
      }
      if (!replace_all && matchCount > 1) {
        return err(
          "validation_error",
          `old_string matched ${matchCount} times; include more context or set replace_all`
        );
      }
      newBody = replace_all
        ? existing.body.replaceAll(old_string, new_string)
        : existing.body.replace(old_string, new_string);
    }
    // The author owns the version. When they leave it alone an edit still has to be
    // distinguishable from what it replaced, so the patch moves for them — but only if what is
    // there is a version we can move; anything else is theirs and survives untouched.
    const authoredFm = frontmatter ?? existingPublic.frontmatter;
    const declared = asVersionString(authoredFm.version);
    const previous = asVersionString(existingPublic.frontmatter.version) ?? DEFAULT_SKILL_VERSION;
    const version =
      declared !== undefined && declared !== previous
        ? declared
        : isSkillVersion(previous)
          ? bumpPatch(previous)
          : previous;
    const newFm = { ...authoredFm, version };
    const persistedFm = existingPublic.pendingAudit ? { ...newFm, _pendingAudit: true } : newFm;
    const content = serializeSkill(persistedFm, newBody);
    const validation = validateSkill({ name, frontmatter: newFm, body: newBody, content });
    if (!validation.valid) return err("validation_error", validation.error);

    // A pure Soul-skill edit is a single SKILL.md companion write — route it through the gateway.
    // Materializing a bundled Skill (copying its companion tree) or clearing a bundled tombstone
    // (`skills/.bundled-disabled.json`, which is not an addressable Soul artifact) cannot be
    // expressed as an artifact-addressed changeset, so those keep the git-sync commit below.
    if (soulSkill && !ctx.disabledBundledSkills.has(name)) {
      try {
        await mutateSkillsLock(ctx.soulWriter, ctx.gitSync.path, (lock) => ({
          subject: `soul: update skill ${name}`,
          source: "agent",
          actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [
            { op: "put", target: { kind: "Skill", slug: name, companion: "SKILL.md" }, content },
            curatedLockWrite(lock, name, version),
          ],
        }));
      } catch (e) {
        if (e instanceof SoulWriteError) {
          return mapSoulWriteError(e, () => err("not_found", `skill not found: ${name}`));
        }
        return err("internal_error", reason(e));
      }
      return ok({ name, frontmatter: validation.frontmatter, body: newBody });
    }

    const skillFile = join(ctx.gitSync.path, "skills", name, "SKILL.md");
    // This path writes the lock straight to the worktree, so it cannot carry a base revision the
    // gateway would check. Joining the same queue as every other lock writer is what keeps its
    // read-modify-write from losing a concurrent entry.
    const failure = await serializeSkillsLockWrites(ctx.gitSync.path, async () => {
      try {
        if (!soulSkill && bundledSkill) {
          // soul-write-exception: materialising a bundled Skill copies an arbitrary companion tree
          // out of the bundle, which is not an artifact-addressed write. The commit below stages
          // only these paths via `withSyncPaths`, so no unrelated worktree state is swept in.
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
        await writeFile(
          join(ctx.gitSync.path, SKILLS_LOCK_FILE),
          curatedLockContent(await readSkillsLock(ctx.gitSync.path), name, version),
          "utf8"
        );
      } catch (e) {
        return err("internal_error", reason(e));
      }

      try {
        // Materialising a bundled Skill copies a whole companion tree and clears the bundled
        // tombstone — neither is an artifact-addressed write, so this path cannot use the gateway.
        // `withSyncPaths` still names what it stages, so unrelated worktree state is never swept
        // in.
        await ctx.gitSync.withSyncPaths(
          `soul: update skill ${name}`,
          [join("skills", name), join("skills", DISABLED_BUNDLED_SKILLS_FILE), SKILLS_LOCK_FILE],
          ctx.requestContext?.actor
        );
      } catch (e) {
        return soulCommitError(e, reason(e));
      }
      return null;
    });
    if (failure !== null) return failure;

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, frontmatter: validation.frontmatter, body: newBody });
  },
});

function asVersionString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The lock content that records `name` as this instance's own Skill at `version`.
 *
 * Authoring is what makes a Skill yours: an edit to a bundled or installed Skill rewrites its entry
 * as `curated`, which is also how the boot sync learns to stop refreshing it from upstream.
 */
function curatedLockContent(lock: SkillsLock, name: string, version: string): string {
  // The lock is a comparable inventory, so it only ever holds a real version.
  lock.skills[name] = { sourceType: "curated", version: skillVersion({ version }) };
  return serializeSkillsLock(lock);
}

function curatedLockWrite(lock: SkillsLock, name: string, version: string): SoulWrite {
  return {
    op: "put",
    target: { kind: "SkillsLock" },
    content: curatedLockContent(lock, name, version),
  };
}

/**
 * Provenance for a Skill an Agent can see. The lock is authoritative; a Skill present only in the
 * image has no entry because the boot sync has not copied it in yet.
 */
function lockProvenance(lock: SkillsLock, name: string, inSoul: boolean): SkillSourceType {
  return lock.skills[name]?.sourceType ?? (inSoul ? "curated" : "bundled");
}

// ── skill_get ─────────────────────────────────────────────────────────────────

const validateGet = ajv.compile(SKILL_GET_SCHEMA);

const skillGet = defineApiTool<SkillToolContext>({
  name: "skill_get",
  description:
    "Get a Skill's frontmatter, markdown body, and provenance from the merged Soul-over-bundled view.",
  tier: "system",
  mutating: false,
  inputSchema: SKILL_GET_SCHEMA,
  authorization: {
    action: "soul.skill.read",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet.errors));
    const { name } = args as { name: string };
    const skill = resolveSkill(name, ctx.soulLoader, ctx.bundledSkills, ctx.disabledBundledSkills);
    if (!skill) return err("not_found", `skill not found: ${name}`);
    const lock = await readSkillsLock(ctx.gitSync.path);
    return ok({
      name: skill.name,
      frontmatter: skill.frontmatter,
      body: skill.body,
      provenance: lockProvenance(lock, name, ctx.soulLoader.skills.has(name)),
    });
  },
});

// ── skill_list ────────────────────────────────────────────────────────────────

const validateList = ajv.compile(SKILL_LIST_SCHEMA);

const skillList = defineApiTool<SkillToolContext>({
  name: "skill_list",
  description: "List Skills from the merged Soul-over-bundled view with provenance.",
  tier: "system",
  mutating: false,
  inputSchema: SKILL_LIST_SCHEMA,
  authorization: {
    action: "soul.skill.list",
    resources: ["soul.skill"],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList.errors));
    const live = await ctx.hiddenSkillNames?.();
    const hidden =
      live === undefined || live.size === 0
        ? ctx.disabledBundledSkills
        : new Set([...ctx.disabledBundledSkills, ...live]);
    const lock = await readSkillsLock(ctx.gitSync.path);
    const skills = Array.from(mergedSkills(ctx.soulLoader, ctx.bundledSkills, hidden).values())
      // A Skill installed from an untrusted source stays out of the catalogue until it is audited.
      .filter(({ frontmatter }) => frontmatter._pendingAudit !== true)
      .map(({ name, frontmatter }) => ({
        name,
        frontmatter,
        provenance: lockProvenance(lock, name, ctx.soulLoader.skills.has(name)),
      }));
    return ok({ skills });
  },
});

// ── skill_delete ──────────────────────────────────────────────────────────────

const validateDelete = ajv.compile(SKILL_DELETE_SCHEMA);

const skillDelete = defineApiTool<SkillToolContext>({
  name: "skill_delete",
  description:
    "Delete a Skill from the merged view. Soul Skills are removed; bundled Skills are hidden with a persistent tombstone. The change is committed to the soul repo.",
  tier: "system",
  mutating: true,
  inputSchema: SKILL_DELETE_SCHEMA,
  authorization: {
    action: "soul.skill.delete",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete.errors));
    const { name } = args as { name: string };

    const soulSkill = ctx.soulLoader.skills.get(name);
    const bundledSkill = ctx.bundledSkills.get(name);
    if (!soulSkill && (!bundledSkill || ctx.disabledBundledSkills.has(name))) {
      return err("not_found", `skill not found: ${name}`);
    }

    // Removing a Soul-authored Skill is a whole-artifact delete through the gateway. Disabling a
    // bundled Skill instead writes a tombstone to `skills/.bundled-disabled.json`, which is not an
    // addressable Soul artifact, so any path that touches it keeps the git-sync commit below.
    if (soulSkill && !bundledSkill) {
      try {
        await ctx.soulWriter.apply({
          subject: `soul: remove skill ${name}`,
          source: "agent",
          actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [{ op: "deleteArtifact", kind: "Skill", slug: name }],
        });
      } catch (e) {
        if (e instanceof SoulWriteError) {
          return mapSoulWriteError(e, () => err("not_found", `skill not found: ${name}`));
        }
        return err("internal_error", reason(e));
      }
      return ok({ name, deleted: true });
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
      // Same reason as the bundled materialisation above: the tombstone is not an addressable
      // artifact, so this residual path stages explicit paths instead of the whole worktree.
      await ctx.gitSync.withSyncPaths(
        `soul: remove skill ${name}`,
        [join("skills", name), join("skills", DISABLED_BUNDLED_SKILLS_FILE)],
        ctx.requestContext?.actor
      );
    } catch (e) {
      return soulCommitError(e, reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, deleted: true });
  },
});

// ── skill_activate ────────────────────────────────────────────────────────────

const validateActivate = ajv.compile(SKILL_ACTIVATE_SCHEMA);

const skillActivate = defineApiTool<SkillToolContext>({
  name: "skill_activate",
  description:
    "Activate a forge-created skill after the operator has reviewed its SkillAudit report. Removes the _pendingAudit marker, commits, and reloads — making the skill available in prompt assembly.",
  tier: "system",
  mutating: true,
  inputSchema: SKILL_ACTIVATE_SCHEMA,
  authorization: {
    action: "soul.skill.activate",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateActivate(args))
      return err("validation_error", firstError(validateActivate.errors));
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

    try {
      await ctx.soulWriter.apply({
        subject: `soul: activate skill ${name}`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: [
          { op: "put", target: { kind: "Skill", slug: name, companion: "SKILL.md" }, content },
        ],
      });
    } catch (e) {
      if (e instanceof SoulWriteError) {
        return mapSoulWriteError(e, () => err("not_found", `skill not found: ${name}`));
      }
      return err("internal_error", reason(e));
    }

    return ok({ name, activated: true });
  },
});

export const SKILL_TOOLS: ApiToolDefinition<SkillToolContext>[] = [
  skillCreate,
  skillUpdate,
  skillGet,
  skillList,
  skillDelete,
  skillActivate,
  ...MARKETPLACE_SKILL_TOOLS,
];
