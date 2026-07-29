import type { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ajv, TulipFarmValidationError, validateRoutineDefinition } from "@tulipfarm/schema";
import type {
  GitSyncService,
  SoulAgent,
  SoulLoader,
  SoulRoutine,
  SoulSkill,
} from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";
import type { BundledSkill } from "../soul/skills/bundled";
import { resolveSkill } from "../soul/skills/registry";
import type { RequestContext } from "../tools/types";
import { err, ok, type ToolCallResult } from "./tool-result";

export interface PlatformToolContext {
  soulLoader?: {
    skills: Map<string, SoulSkill>;
    agents: Map<string, SoulAgent>;
    routines?: Map<string, SoulRoutine>;
  };
  soulPath?: string;
  gitSync?: GitSyncService;
  routineContext?: { routineId: string; runId: string };
  /** Starts a routine run (agent trigger, v0.11). Errors are thrown with a `.code`-like name. */
  triggerRoutine?: (slug: string, inputs?: Record<string, unknown>) => Promise<{ runId: string }>;
  /** Post-write hook after routine_forge: registry revalidate + cron schedule reconcile. */
  onRoutinesChanged?: () => Promise<void>;
  /** Read-only bundled Skill overlay, resolved after Soul Skills by name. */
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  /** Bundled Skill names hidden persistently by an operator delete. */
  disabledBundledSkills?: ReadonlySet<string>;
  /** Reserved names of the code-defined platform agents, valid `transfer_to_agent` targets. */
  platformAgentNames?: ReadonlySet<string>;
  /** Per-call state supplied by the Tool registry, never captured at startup. */
  requestContext?: RequestContext;
  /** Best-effort metrics bus; listeners must never affect tool correctness. */
  events?: EventEmitter;
}

export interface PlatformTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: PlatformToolContext) => Promise<ToolCallResult>;
}

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

// `oneOf` fan-out can make AJV report the failure
// against the outermost branch it tried first, not the field that's actually wrong several
// levels down. Prefer the deepest non-"oneOf" error so the message points at the real defect.
function bestError(errors: AjvErrors): NonNullable<AjvErrors>[number] | undefined {
  if (!errors || errors.length === 0) return undefined;
  const specific = errors.filter((e) => e.keyword !== "oneOf");
  const pool = specific.length > 0 ? specific : errors;
  return pool.reduce((deepest, e) =>
    e.instancePath.length > deepest.instancePath.length ? e : deepest
  );
}

function firstError(errors: AjvErrors): string {
  const e = bestError(errors);
  return e
    ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim()
    : "invalid arguments";
}

// ── load_skill ────────────────────────────────────────────────────────────────

const LOAD_SKILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name as registered in the soul." },
  },
};
const validateLoadSkill = ajv.compile(LOAD_SKILL_SCHEMA);

export const loadSkillTool: PlatformTool = {
  name: "load_skill",
  description:
    "Load a Skill's frontmatter and body by name so the agent can apply its instructions. Resolves Soul Skills before the read-only bundled overlay. Graceful not_found when the Skill is absent.",
  mutating: false,
  inputSchema: LOAD_SKILL_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateLoadSkill(args))
      return err("validation_error", firstError(validateLoadSkill.errors));
    const { name } = args as { name: string };
    const skill = resolveSkill(
      name,
      ctx.soulLoader as SoulLoader | undefined,
      ctx.bundledSkills,
      ctx.disabledBundledSkills
    );
    if (skill) return ok({ name: skill.name, frontmatter: skill.frontmatter, body: skill.body });
    return err("not_found", `Skill "${name}" not found.`);
  },
};

// ── load_skill_reference ──────────────────────────────────────────────────────

const LOAD_SKILL_REFERENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "reference"],
  properties: {
    skill: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9][a-z0-9._-]*$",
      description: "Skill name as registered in the Soul or bundled overlay.",
    },
    reference: {
      type: "string",
      minLength: 1,
      description:
        "Reference filename (e.g. 'migration-playbook.md') within the skill's references/ directory.",
    },
  },
};
const validateLoadSkillRef = ajv.compile(LOAD_SKILL_REFERENCE_SCHEMA);

export const loadSkillReferenceTool: PlatformTool = {
  name: "load_skill_reference",
  description:
    "Load a reference file from a skill's references/ directory. Use this to pull in supporting material (playbooks, templates) that are too large to include in the skill body.",
  mutating: false,
  inputSchema: LOAD_SKILL_REFERENCE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateLoadSkillRef(args))
      return err("validation_error", firstError(validateLoadSkillRef.errors));
    const { skill, reference } = args as { skill: string; reference: string };
    const soulSkill = ctx.soulLoader?.skills.get(skill);
    const bundledSkill = ctx.disabledBundledSkills?.has(skill)
      ? undefined
      : ctx.bundledSkills?.get(skill);
    const base =
      !soulSkill && bundledSkill
        ? resolve(bundledSkill.directory, "references")
        : ctx.soulPath
          ? resolve(ctx.soulPath, "skills", skill, "references")
          : undefined;
    if (!base) return err("not_found", `Skill "${skill}" references directory not available.`);
    // Contain the read to the selected Skill's references directory — `reference` is
    // LLM-controlled, so a `../` escape must not read outside either Soul or bundled storage.
    const refPath = resolve(base, reference);
    const rel = relative(base, refPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return err(
        "validation_error",
        `Reference "${reference}" escapes the skill references directory.`
      );
    try {
      const content = await readFile(refPath, "utf8");
      return ok({ skill, reference, content });
    } catch {
      return err("not_found", `Reference "${reference}" not found for skill "${skill}".`);
    }
  },
};

// ── validate_artifact ─────────────────────────────────────────────────────────

const VALIDATE_ARTIFACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["artifact", "schema"],
  properties: {
    artifact: { description: "The data to validate." },
    schema: {
      type: "object",
      description: "JSON Schema to validate the artifact against.",
    },
  },
};
const validateArtifactArgs = ajv.compile(VALIDATE_ARTIFACT_SCHEMA);

export const validateArtifactTool: PlatformTool = {
  name: "validate_artifact",
  description:
    "Validate an arbitrary artifact against a JSON Schema. Returns { valid: true } on success or { valid: false, errors: [...] } with AJV error details. Use before writing structured data to resources.",
  mutating: false,
  inputSchema: VALIDATE_ARTIFACT_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateArtifactArgs(args))
      return err("validation_error", firstError(validateArtifactArgs.errors));
    const { artifact, schema } = args as { artifact: unknown; schema: Record<string, unknown> };
    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(schema);
    } catch (e) {
      return err("internal_error", `Invalid schema: ${e instanceof Error ? e.message : String(e)}`);
    }
    const valid = validate(artifact);
    if (valid) return ok({ valid: true });
    return ok({
      valid: false,
      errors: (validate.errors ?? []).map((e) => ({
        path: e.instancePath || "(root)",
        message: e.message ?? "is invalid",
      })),
    });
  },
};

// ── transfer_to_agent ─────────────────────────────────────────────────────────

const TRANSFER_TO_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: {
    agentId: { type: "string", minLength: 1, description: "Soul name of the target agent." },
    message: {
      type: "string",
      description: "Optional handoff context to give the receiving agent.",
    },
  },
};
const validateTransfer = ajv.compile(TRANSFER_TO_AGENT_SCHEMA);

export const transferToAgentTool: PlatformTool = {
  name: "transfer_to_agent",
  description:
    "Hand the conversation off to another configured agent. The conversation's active agent switches and future turns are handled by the target. Validates that the target is a known platform or Soul agent.",
  mutating: false,
  inputSchema: TRANSFER_TO_AGENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateTransfer(args))
      return err("validation_error", firstError(validateTransfer.errors));
    const { agentId, message } = args as { agentId: string; message?: string };
    if (ctx.platformAgentNames?.has(agentId)) {
      return ok({ agentId, agentName: agentId, status: "transferred", message: message ?? null });
    }
    const agent = ctx.soulLoader?.agents.get(agentId);
    if (!agent) return err("not_found", `Agent "${agentId}" not found.`);
    const agentName = typeof agent.frontmatter.name === "string" ? agent.frontmatter.name : agentId;
    return ok({ agentId, agentName, status: "transferred", message: message ?? null });
  },
};

// ── delegate_to_agent ─────────────────────────────────────────────────────────

const DELEGATE_TO_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "task"],
  properties: {
    agentId: {
      type: "string",
      minLength: 1,
      description: "Soul name of the agent to delegate to.",
    },
    task: { type: "string", minLength: 1, description: "The task description to delegate." },
    context: {
      type: "object",
      description: "Optional structured context to pass to the delegated agent.",
    },
  },
};
const validateDelegate = ajv.compile(DELEGATE_TO_AGENT_SCHEMA);

export const delegateToAgentTool: PlatformTool = {
  name: "delegate_to_agent",
  description:
    "Delegate a sub-task to another agent and record the delegation. The UI surfaces a delegation-event card. Full async execution is deferred (Agents v0.9) — V1 records intent and returns a delegation receipt.",
  mutating: false,
  inputSchema: DELEGATE_TO_AGENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelegate(args))
      return err("validation_error", firstError(validateDelegate.errors));
    const { agentId, task, context } = args as {
      agentId: string;
      task: string;
      context?: Record<string, unknown>;
    };
    const agent = ctx.soulLoader?.agents.get(agentId);
    if (!agent) return err("not_found", `Agent "${agentId}" not found in soul.`);
    return ok({ agentId, task, context: context ?? null, status: "delegated" });
  },
};

// ── trigger_routine ───────────────────────────────────────────────────────────

const TRIGGER_ROUTINE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Soul name of the routine to trigger." },
    inputs: {
      type: "object",
      description: "Optional key-value inputs matching the routine's x-inputs schema.",
    },
  },
};
const validateTriggerRoutine = ajv.compile(TRIGGER_ROUTINE_SCHEMA);

export const triggerRoutineTool: PlatformTool = {
  name: "trigger_routine",
  description:
    "Trigger a routine by name with optional inputs (validated against the routine's x-inputs schema). Returns the run id; watch progress via the routine run APIs.",
  mutating: true,
  inputSchema: TRIGGER_ROUTINE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateTriggerRoutine(args))
      return err("validation_error", firstError(validateTriggerRoutine.errors));
    const { name, inputs } = args as { name: string; inputs?: Record<string, unknown> };
    if (!ctx.triggerRoutine) {
      return err("internal_error", "Routine engine is not available.");
    }
    try {
      const { runId } = await ctx.triggerRoutine(name, inputs);
      return ok({ routineId: name, status: "triggered", runId, inputs: inputs ?? null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "RoutineTriggerError" && message.includes("not found")) {
        return err("not_found", message);
      }
      return err("validation_error", message);
    }
  },
};

// ── routine_forge ─────────────────────────────────────────────────────────────

const ROUTINE_NAME_RE = /^[a-z][a-z0-9-]*$/;

const ROUTINE_FORGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "definition"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Routine slug (directory under soul/routines/): lowercase, digits, hyphens.",
    },
    definition: {
      type: "object",
      description:
        "The routine.yaml document (CNCF Serverless Workflow 0.8 subset + x- extensions). " +
        "Validated against the V1 meta-schema; deferred constructs are rejected.",
    },
    hooks: {
      type: "string",
      description:
        "Optional hooks.ts source: an object-literal expression like " +
        "({ beforeHook(ctx){}, afterMyState(ctx){}, myStepFn(ctx, args){} }). No import/export.",
    },
  },
};
const validateRoutineForge = ajv.compile(ROUTINE_FORGE_SCHEMA);

export const routineForgeTool: PlatformTool = {
  name: "routine_forge",
  description:
    "Create or update a ROUTINE (a scheduled/triggered automation) in the soul repo — use this, " +
    "not skill_create, whenever the user asks to 'create a routine' / 'automate X' / 'every " +
    "morning do Y' / 'when X happens do Y'. `definition` is a CNCF Serverless Workflow 0.8 subset " +
    'and MUST include the top-level fields `id` (matches `name`), `version` (e.g. "1.0"), ' +
    "`start` (the first state's name), `states` (min 1), and `x-triggers` (min 1, e.g. " +
    "[{ type: 'cron', schedule: '0 9 * * *' }] or [{ type: 'manual' }]) — additional properties " +
    "are rejected at every level. Minimal example: " +
    '{ id: "daily-report", version: "1.0", start: "Report", "x-triggers": [{ type: "cron", ' +
    'schedule: "0 9 * * *" }], functions: [{ name: "send", operation: "tool:resource_search" }], ' +
    'states: [{ name: "Report", type: "operation", actions: [{ functionRef: { refName: "send" } }], ' +
    "end: true }] }. Load the routine-forge skill for the full authoring workflow before calling " +
    "this. Validates the definition against the V1 meta-schema (deferred constructs rejected), " +
    "writes soul/routines/{name}/routine.yaml (+ optional hooks.ts), and commits via withSync. " +
    "No approval step (ROUT-V1-002).",
  mutating: true,
  inputSchema: ROUTINE_FORGE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateRoutineForge(args))
      return err("validation_error", firstError(validateRoutineForge.errors));
    const { name, definition, hooks } = args as {
      name: string;
      definition: Record<string, unknown>;
      hooks?: string;
    };
    if (!ROUTINE_NAME_RE.test(name)) return err("validation_error", "invalid routine name");
    if (!ctx.gitSync) return err("internal_error", "Soul git sync is not available.");

    try {
      validateRoutineDefinition(definition);
    } catch (e) {
      if (e instanceof TulipFarmValidationError) {
        return err("validation_error", `${e.path || "/"}: ${e.message}`);
      }
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    try {
      const dir = join(ctx.gitSync.path, "routines", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "routine.yaml"), stringifyYaml(definition), "utf8");
      if (hooks) await writeFile(join(dir, "hooks.ts"), hooks, "utf8");
      await ctx.gitSync.withSync(`soul: forge routine ${name}`);
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    // withSync does not emit soul.synced — revalidate + reconcile schedules explicitly.
    try {
      await ctx.onRoutinesChanged?.();
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
    return ok({ name, committed: true, hasHooks: Boolean(hooks) });
  },
};

// ── routine_picker ────────────────────────────────────────────────────────────

const ROUTINE_PICKER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateRoutinePicker = ajv.compile(ROUTINE_PICKER_SCHEMA);

export const routinePickerTool: PlatformTool = {
  name: "routine_picker",
  description:
    "List all available routines from the soul so the user can pick one to trigger. Returns name, title, and description for each routine.",
  mutating: false,
  inputSchema: ROUTINE_PICKER_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateRoutinePicker(args))
      return err("validation_error", firstError(validateRoutinePicker.errors));
    const routines = ctx.soulLoader?.routines ?? new Map<string, SoulRoutine>();
    const items = Array.from(routines.values()).map((r) => ({
      name: r.name,
      title: typeof r.config.title === "string" ? r.config.title : r.name,
      description: typeof r.config.description === "string" ? r.config.description : null,
    }));
    return ok({ routines: items });
  },
};

// ── begin_soul_batch ──────────────────────────────────────────────────────────

const BEGIN_SOUL_BATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateBeginSoulBatch = ajv.compile(BEGIN_SOUL_BATCH_SCHEMA);

export const beginSoulBatchTool: PlatformTool = {
  name: "begin_soul_batch",
  description:
    "Open a soul-batch window. Multiple soul file writes performed after this call will be committed together by end_soul_batch. Call end_soul_batch to close the batch and commit.",
  mutating: false,
  inputSchema: BEGIN_SOUL_BATCH_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateBeginSoulBatch(args))
      return err("validation_error", firstError(validateBeginSoulBatch.errors));
    return ok({ status: "open" });
  },
};

// ── end_soul_batch ────────────────────────────────────────────────────────────

const END_SOUL_BATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: {
      type: "string",
      minLength: 1,
      description: "Commit message for the batch of soul writes.",
    },
  },
};
const validateEndSoulBatch = ajv.compile(END_SOUL_BATCH_SCHEMA);

export const endSoulBatchTool: PlatformTool = {
  name: "end_soul_batch",
  description:
    "Close the soul-batch window and commit all pending soul writes as a single commit via withSync (commit + best-effort push).",
  mutating: true,
  inputSchema: END_SOUL_BATCH_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateEndSoulBatch(args))
      return err("validation_error", firstError(validateEndSoulBatch.errors));
    if (!ctx.gitSync) return err("internal_error", "Soul git sync is not available.");
    const { message } = args as { message: string };
    try {
      const result = await ctx.gitSync.withSync(message);
      return ok({ sha: result.sha, filesChanged: result.filesChanged });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
  },
};

// ── soul_repo_commit ──────────────────────────────────────────────────────────

const SOUL_REPO_COMMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: {
      type: "string",
      minLength: 1,
      description: "Commit message attributed to tulipfarm-bot.",
    },
  },
};
const validateSoulRepoCommit = ajv.compile(SOUL_REPO_COMMIT_SCHEMA);

export const soulRepoCommitTool: PlatformTool = {
  name: "soul_repo_commit",
  description:
    "Stage and commit all current soul changes locally (attributed to tulipfarm-bot). Does not push — use soul_repo_push or end_soul_batch to reach the remote.",
  mutating: true,
  inputSchema: SOUL_REPO_COMMIT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSoulRepoCommit(args))
      return err("validation_error", firstError(validateSoulRepoCommit.errors));
    if (!ctx.gitSync) return err("internal_error", "Soul git sync is not available.");
    const { message } = args as { message: string };
    try {
      const result = await ctx.gitSync.commit(message);
      return ok({ sha: result.sha, filesChanged: result.filesChanged });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
  },
};

// ── soul_repo_push ────────────────────────────────────────────────────────────

const SOUL_REPO_PUSH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateSoulRepoPush = ajv.compile(SOUL_REPO_PUSH_SCHEMA);

export const soulRepoPushTool: PlatformTool = {
  name: "soul_repo_push",
  description:
    "Push committed soul changes to the configured git remote. Returns { pushed: false } when no remote is configured (local-only mode).",
  mutating: true,
  inputSchema: SOUL_REPO_PUSH_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSoulRepoPush(args))
      return err("validation_error", firstError(validateSoulRepoPush.errors));
    if (!ctx.gitSync) return err("internal_error", "Soul git sync is not available.");
    try {
      const pushed = await ctx.gitSync.push();
      return ok({ pushed });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
  },
};

// ── call_skill (routine-spawned only) ────────────────────────────────────────

const CALL_SKILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to invoke." },
    args: {
      type: "object",
      description: "Optional arguments to pass to the skill.",
    },
  },
};
const validateCallSkill = ajv.compile(CALL_SKILL_SCHEMA);

export const callSkillTool: PlatformTool = {
  name: "call_skill",
  description:
    "Load and invoke a skill within the current routine execution context. Only callable from a routine-spawned agent turn.",
  mutating: false,
  inputSchema: CALL_SKILL_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCallSkill(args))
      return err("validation_error", firstError(validateCallSkill.errors));
    if (!ctx.routineContext)
      return err("internal_error", "call_skill is only callable from a routine context.");
    const { name, args: skillArgs } = args as { name: string; args?: Record<string, unknown> };
    const skill = resolveSkill(
      name,
      ctx.soulLoader as SoulLoader | undefined,
      ctx.bundledSkills,
      ctx.disabledBundledSkills
    );
    if (!skill) return err("not_found", `Skill "${name}" not found.`);
    return ok({
      name: skill.name,
      frontmatter: skill.frontmatter,
      body: skill.body,
      args: skillArgs ?? null,
    });
  },
};

// ── complete_state (routine-spawned only) ─────────────────────────────────────

const COMPLETE_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    output: { description: "Output data from the completed state." },
  },
};
const validateCompleteState = ajv.compile(COMPLETE_STATE_SCHEMA);

export const completeStateTool: PlatformTool = {
  name: "complete_state",
  description:
    "Signal completion of the current routine state and emit its output. Only callable from a routine-spawned agent turn.",
  mutating: true,
  inputSchema: COMPLETE_STATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCompleteState(args))
      return err("validation_error", firstError(validateCompleteState.errors));
    if (!ctx.routineContext)
      return err("internal_error", "complete_state is only callable from a routine context.");
    const { output } = args as { output?: unknown };
    return ok({
      routineId: ctx.routineContext.routineId,
      runId: ctx.routineContext.runId,
      completed: true,
      output: output ?? null,
    });
  },
};

// ── complete_task ─────────────────────────────────────────────────────────────

const COMPLETE_TASK_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["success", "failed", "cancelled"],
      description: "Outcome of the delegated work.",
    },
    summary: { type: "string", description: "One-line summary of what was built / what happened." },
    result: {
      type: "object",
      description:
        "Optional structured result, e.g. { resources, skills, agents } counts or names.",
    },
    error: { type: "string", description: "Specific reason when status is 'failed'." },
  },
};
const validateCompleteTask = ajv.compile(COMPLETE_TASK_SCHEMA);

export const completeTaskTool: PlatformTool = {
  name: "complete_task",
  description:
    "Signal that the delegated work is finished and hand control back to the front-desk agent. Call this when a creation/onboarding session is done (success), cannot proceed (failed), or was abandoned (cancelled).",
  mutating: false,
  inputSchema: COMPLETE_TASK_SCHEMA,
  handler: async (args) => {
    if (!validateCompleteTask(args))
      return err("validation_error", firstError(validateCompleteTask.errors));
    const { status, summary, result, error } = args as {
      status: "success" | "failed" | "cancelled";
      summary?: string;
      result?: Record<string, unknown>;
      error?: string;
    };
    return ok({
      status,
      summary: summary ?? null,
      result: result ?? null,
      error: error ?? null,
      completed: true,
    });
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

export const PLATFORM_TOOLS: PlatformTool[] = [
  loadSkillTool,
  loadSkillReferenceTool,
  validateArtifactTool,
  transferToAgentTool,
  delegateToAgentTool,
  triggerRoutineTool,
  routineForgeTool,
  routinePickerTool,
  beginSoulBatchTool,
  endSoulBatchTool,
  soulRepoCommitTool,
  soulRepoPushTool,
  callSkillTool,
  completeStateTool,
  completeTaskTool,
];
