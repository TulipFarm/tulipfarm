import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAudit, SKILL_AUDIT } from "@tulipfarm/built-in-agents";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { LlmService } from "@tulipfarm/llm";
import {
  ajv,
  LlmNotConfiguredError,
  SKILL_CREATE_SCHEMA,
  SKILL_DELETE_SCHEMA,
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
  lockProvenance,
  mergedSkills,
  mutateSkillsLock,
  persistDisabledBundledSkills,
  readSkillsLock,
  SKILLS_LOCK_FILE,
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
import type { SkillDraft } from "./drafts";
import { putSkillDraft, skillBodyDigest, takeSkillDraft } from "./drafts";

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

/**
 * Frontmatter as an author sees it.
 *
 * `_pendingAudit` is legacy: Skills once landed in the Soul unreviewed and carried this marker
 * until an operator activated them. Nothing writes or reads it now — a Skill reaches the Soul only
 * after its audit is confirmed — but Souls written before that change still carry it, so it is
 * stripped here rather than copied forward into an edit.
 */
function publicFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const { _pendingAudit: _legacy, ...publicFields } = frontmatter;
  return publicFields;
}

/** Read defensively: `classify` runs against arguments no validator has seen yet. */
function confirmTokenOf(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const confirm = (args as Record<string, unknown>).confirm;
  return typeof confirm === "string" && confirm.length > 0 ? confirm : undefined;
}

/**
 * Splits every Skill write into an auditing call and a writing call.
 *
 * The audit only informs a decision if it is delivered before the write, so the first call performs
 * none: it audits and parks the result. The second spends the token, and is the call that mutates
 * and asks a human — which is why an Agent that can read the report cannot also act on it alone.
 */
function classifyByConfirmation(args: unknown): { mutating: boolean; requiresApproval: boolean } {
  const confirmed = confirmTokenOf(args) !== undefined;
  return { mutating: confirmed, requiresApproval: confirmed };
}

/** Told to the model, so a refused or expired token leads back to the audit rather than a retry. */
const STALE_DRAFT_HINT =
  "call it again without `confirm` to re-audit, then confirm the token that call returns";

/**
 * The wall clock a Skill write gets, because it runs SkillAudit inline and the host's 30s default
 * is narrower than the audit's own 45s ceiling — leaving the audit no way to fail cleanly, since
 * the deadline always fired first and reported a committed write as `indeterminate`. Derived from
 * `SKILL_AUDIT.timeoutMs` so raising the audit cannot silently re-open that gap, plus headroom for
 * the commit and Soul reload that follow it.
 */
const SKILL_AUDIT_TOOL_TIMEOUT_MS = SKILL_AUDIT.timeoutMs + 15_000;

// ── skill_create ──────────────────────────────────────────────────────────────

const validateCreate = ajv.compile(SKILL_CREATE_SCHEMA);

const skillCreate = defineApiTool<SkillToolContext>({
  name: "skill_create",
  description:
    "Create a new Skill. Call it with name, body and frontmatter to run SkillAudit and get a report plus a confirm token — nothing is written. Show the operator the report, then call it again with name and that confirm token to write the audited Skill to the soul repo. The second call requires human approval.",
  tier: "system",
  mutating: true,
  timeout: { wallClockMs: SKILL_AUDIT_TOOL_TIMEOUT_MS },
  inputSchema: SKILL_CREATE_SCHEMA,
  authorization: {
    action: "soul.skill.create",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  classify: classifyByConfirmation,
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate.errors));
    const { name, body, frontmatter, confirm } = args as {
      name: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
      confirm?: string;
    };

    if (confirm !== undefined) {
      const draft = takeSkillDraft(confirm);
      if (!draft || draft.kind !== "create" || draft.name !== name) {
        return err(
          "validation_error",
          `no audited draft of "${name}" is waiting to be written — ${STALE_DRAFT_HINT}`
        );
      }
      // One companion put plus the lock entry is the whole changeset — atomic through the gateway.
      try {
        await mutateSkillsLock(ctx.soulWriter, ctx.gitSync.path, (lock) => ({
          subject: `soul: add skill ${name}`,
          source: "agent",
          actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [
            { op: "put", target: { kind: "Skill", slug: name }, content: draft.content },
            curatedLockWrite(lock, name, draft.version),
          ],
        }));
      } catch (e) {
        if (e instanceof SoulWriteError) {
          return mapSoulWriteError(e, () => err("validation_error", "skill already exists"));
        }
        return err("internal_error", reason(e));
      }
      return ok({
        status: "created",
        name,
        frontmatter: draft.frontmatter,
        body: draft.body,
      });
    }

    if (body === undefined || frontmatter === undefined) {
      return err("validation_error", "body and frontmatter are required when confirm is not set");
    }

    // A Skill is versioned from birth so the lock records something meaningful for every entry.
    const version = skillVersion(frontmatter);
    const authoredFm = { ...frontmatter, version };
    const content = serializeSkill(authoredFm, body);
    const validation = validateSkill({ name, frontmatter: authoredFm, body, content });
    if (!validation.valid) return err("validation_error", validation.error);

    if (
      ctx.soulWriter.readCompanion("Skill", name, "SKILL.md") !== null ||
      ctx.bundledSkills.has(name)
    ) {
      return err("validation_error", "skill already exists");
    }

    if (!ctx.llmService) {
      return err(
        "audit_required",
        "LLM service not available — configure a provider before creating skills"
      );
    }
    let model: ReturnType<typeof ctx.llmService.effortModel>;
    try {
      model = ctx.llmService.effortModel(SKILL_AUDIT.rung);
    } catch (e) {
      if (e instanceof LlmNotConfiguredError) {
        return err(
          "audit_required",
          "LLM not configured — configure a provider before creating skills"
        );
      }
      return err("internal_error", reason(e));
    }

    const deterministicScan = {
      ...scanSkill([{ path: "SKILL.md", content }]),
      trustLevel: skillTrustLevel("agent-created"),
    };
    let auditReport: Awaited<ReturnType<typeof buildAudit>>;
    try {
      auditReport = await buildAudit(
        model,
        { name, description: validation.frontmatter.description, body },
        deterministicScan
      );
    } catch (e) {
      return err("internal_error", `SkillAudit failed, so nothing was written: ${reason(e)}`);
    }

    return ok({
      status: "needs_confirmation",
      instruction:
        "Nothing has been written. Show the operator the risk rating and every finding, then call skill_create again with this `confirm` token only if they agree.",
      name,
      frontmatter,
      body,
      auditReport,
      confirm: putSkillDraft({ kind: "create", name, version, body, frontmatter, content }),
    });
  },
});

// ── skill_update ──────────────────────────────────────────────────────────────

// NOTE: no top-level `anyOf` — OpenAI-family models reject tool parameter schemas with a top-level
// anyOf/oneOf/allOf/enum/not. The replacement-vs-patch constraints are enforced in the handler.
const validateUpdate = ajv.compile(SKILL_UPDATE_SCHEMA);

const skillUpdate = defineApiTool<SkillToolContext>({
  name: "skill_update",
  description:
    "Update an existing Skill. Prefer old_string/new_string for surgical body fixes; use body and/or frontmatter only for full replacements. Patch text must be unique unless replace_all is true. Call it with the edit to run SkillAudit on the result and get a report plus a confirm token — nothing is written. Show the operator the report, then call it again with name and that confirm token to commit the audited edit. The second call requires human approval.",
  tier: "system",
  mutating: true,
  timeout: { wallClockMs: SKILL_AUDIT_TOOL_TIMEOUT_MS },
  inputSchema: SKILL_UPDATE_SCHEMA,
  authorization: {
    action: "soul.skill.update",
    resources: ["soul.skill"],
    targets: skillTargets,
    dataClasses: ["soul_definition"],
  },
  classify: classifyByConfirmation,
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate.errors));
    const { name, body, frontmatter, old_string, new_string, replace_all, confirm } = args as {
      name: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
      confirm?: string;
    };

    if (confirm !== undefined) {
      const draft = takeSkillDraft(confirm);
      if (!draft || draft.kind !== "update" || draft.name !== name) {
        return err(
          "validation_error",
          `no audited edit of "${name}" is waiting to be written — ${STALE_DRAFT_HINT}`
        );
      }
      const current = ctx.soulLoader.skills.get(name) ?? ctx.bundledSkills.get(name);
      if (!current) return err("not_found", `skill not found: ${name}`);
      // The edit was computed against a body that has since moved, so writing it would revert
      // whatever landed in between. Re-audit against the new base rather than guess at a merge.
      if (draft.baseDigest !== undefined && skillBodyDigest(current.body) !== draft.baseDigest) {
        return err(
          "unavailable",
          `"${name}" changed since it was audited, so the edit was not applied — ${STALE_DRAFT_HINT}`
        );
      }
      return await applySkillUpdate(ctx, name, draft);
    }

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

    const existingFm = publicFrontmatter(existing.frontmatter);
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
    const authoredFm = frontmatter ?? existingFm;
    const declared = asVersionString(authoredFm.version);
    const previous = asVersionString(existingFm.version) ?? DEFAULT_SKILL_VERSION;
    const version =
      declared !== undefined && declared !== previous
        ? declared
        : isSkillVersion(previous)
          ? bumpPatch(previous)
          : previous;
    const newFm = { ...authoredFm, version };

    // An edit that changes what SkillAudit reads has to be audited like a birth, or the gate is one
    // Tool call wide: get a clean Skill written, then edit it into anything. Version is excluded
    // because this Tool bumps it on every call, which would make every edit look like a rewrite.
    const auditedSurfaceChanged =
      newBody !== existing.body || !sameAuditedFrontmatter(existingFm, newFm);

    let model: ReturnType<NonNullable<typeof ctx.llmService>["effortModel"]> | undefined;
    if (auditedSurfaceChanged) {
      // Fail before parking anything, so a missing provider cannot yield a confirmable draft.
      if (!ctx.llmService) {
        return err(
          "audit_required",
          "LLM service not available — configure a provider before updating skills"
        );
      }
      try {
        model = ctx.llmService.effortModel(SKILL_AUDIT.rung);
      } catch (e) {
        if (e instanceof LlmNotConfiguredError) {
          return err(
            "audit_required",
            "LLM not configured — configure a provider before updating skills"
          );
        }
        return err("internal_error", reason(e));
      }
    }

    const content = serializeSkill(newFm, newBody);
    const validation = validateSkill({ name, frontmatter: newFm, body: newBody, content });
    if (!validation.valid) return err("validation_error", validation.error);

    const draft: SkillDraft = {
      kind: "update",
      name,
      version,
      body: newBody,
      frontmatter: validation.frontmatter,
      content,
      baseDigest: skillBodyDigest(existing.body),
    };

    // A version-only bump changes nothing SkillAudit reads, so there is no report to show — but it
    // is still a write, and every write of a Skill is confirmed. One rule, no exception to misjudge.
    if (!model) {
      return ok({
        status: "needs_confirmation",
        instruction:
          "Nothing has been written. This edit does not change what SkillAudit reads, so there is no new report. Call skill_update again with this `confirm` token once the operator agrees.",
        name,
        frontmatter: validation.frontmatter,
        body: newBody,
        confirm: putSkillDraft(draft),
      });
    }

    const deterministicScan = {
      ...scanSkill([{ path: "SKILL.md", content }]),
      trustLevel: skillTrustLevel("agent-created"),
    };
    let auditReport: Awaited<ReturnType<typeof buildAudit>>;
    try {
      auditReport = await buildAudit(
        model,
        { name, description: validation.frontmatter.description, body: newBody },
        deterministicScan
      );
    } catch (e) {
      return err("internal_error", `SkillAudit failed, so nothing was written: ${reason(e)}`);
    }

    return ok({
      status: "needs_confirmation",
      instruction:
        "Nothing has been written. Show the operator the risk rating and every finding, then call skill_update again with this `confirm` token only if they agree.",
      name,
      frontmatter: validation.frontmatter,
      body: newBody,
      auditReport,
      confirm: putSkillDraft(draft),
    });
  },
});

/**
 * Writes a confirmed edit.
 *
 * A pure Soul-skill edit is a single SKILL.md definition write — route it through the gateway.
 * Materializing a bundled Skill (copying its companion tree) or clearing a bundled tombstone
 * (`skills/.bundled-disabled.json`, which is not an addressable Soul artifact) cannot be expressed
 * as an artifact-addressed changeset, so those keep the git-sync commit below.
 */
async function applySkillUpdate(
  ctx: SkillToolContext,
  name: string,
  draft: SkillDraft
): Promise<ToolCallResult> {
  const { content, version } = draft;
  const soulSkill = ctx.soulLoader.skills.get(name);
  const bundledSkill = ctx.bundledSkills.get(name);
  const written = { status: "updated", name, frontmatter: draft.frontmatter, body: draft.body };

  if (soulSkill && !ctx.disabledBundledSkills.has(name)) {
    try {
      await mutateSkillsLock(ctx.soulWriter, ctx.gitSync.path, (lock) => ({
        subject: `soul: update skill ${name}`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: [
          { op: "put", target: { kind: "Skill", slug: name }, content },
          curatedLockWrite(lock, name, version),
        ],
      }));
    } catch (e) {
      if (e instanceof SoulWriteError) {
        return mapSoulWriteError(e, () => err("not_found", `skill not found: ${name}`));
      }
      return err("internal_error", reason(e));
    }
    return ok(written);
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
      // `withSyncPaths` still names what it stages, so unrelated worktree state is never swept in.
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

  return ok(written);
}

/**
 * Whether two frontmatters agree on everything SkillAudit reads.
 *
 * `version` is excluded because `skill_update` bumps it on every call, so including it would make
 * every edit — even a no-op — look like a change to the audited surface.
 */
function sameAuditedFrontmatter(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): boolean {
  const strip = ({ version: _version, ...rest }: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
  return strip(before) === strip(after);
}

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
    const skills = Array.from(mergedSkills(ctx.soulLoader, ctx.bundledSkills, hidden).values()).map(
      ({ name, frontmatter }) => ({
        name,
        frontmatter,
        provenance: lockProvenance(lock, name, ctx.soulLoader.skills.has(name)),
      })
    );
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

export const SKILL_TOOLS: ApiToolDefinition<SkillToolContext>[] = [
  skillCreate,
  skillUpdate,
  skillList,
  skillDelete,
  ...MARKETPLACE_SKILL_TOOLS,
];
