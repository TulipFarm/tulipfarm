import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { formatTemporalContext } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { ajv, TulipFarmValidationError, validateRoutineDefinition } from "@tulipfarm/schema";
import {
  type GitSyncService,
  type SoulAgent,
  type SoulLoader,
  type SoulRoutine,
  type SoulSkill,
  SoulWriteError,
  type SoulWriter,
} from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import type { BundledSkill } from "../soul/skills/bundled";
import { resolveSkill } from "../soul/skills/registry";
import { type ApiToolDefinition, defineApiTool } from "../tools/define";
import { soulCommitError } from "../tools/soul-faults";
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
  /** The single write gateway for the authored Soul tree (ADR-007). */
  readonly soulWriter: SoulWriter;
  routineContext?: { routineId: string; runId: string };
  triggerRoutine?: (slug: string, inputs?: Record<string, unknown>) => Promise<{ runId: string }>;
  onRoutinesChanged?: () => Promise<void>;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: ReadonlySet<string>;
  platformAgentNames?: ReadonlySet<string>;
  requestContext?: RequestContext;
  events?: EventEmitter;
}

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

/** Map a Soul write-gateway rejection onto `routine_forge`'s error vocabulary. */
function mapRoutineWriteError(e: SoulWriteError): ToolCallResult {
  switch (e.code) {
    case "VALIDATION_FAILED":
    case "INVALID_TARGET":
    case "PRECONDITION_FAILED":
      return err("validation_error", e.message);
    case "CONFLICT":
      return err("unavailable", e.message);
    default:
      return soulCommitError(e, e.message);
  }
}

/** Delegation authorizes `platform.agent`, not Soul edits to `soul.agent`. */
const SOUL_AGENT_TARGET = "platform.agent";
const SOUL_ROUTINE_TARGET = "soul.routine";
const SOUL_SKILL_TARGET = "soul.skill";
const SOUL_REPO_TARGET = "soul.repo";
const SOUL_REPO_ALL_TARGET_ID = "entire-repository";

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function soulTarget(
  type: typeof SOUL_AGENT_TARGET | typeof SOUL_ROUTINE_TARGET | typeof SOUL_SKILL_TARGET,
  args: unknown,
  key: string
) {
  const id = stringArg(args, key);
  return id === undefined ? [] : [{ type, id }];
}

function wholeSoulRepoTarget() {
  return [{ type: SOUL_REPO_TARGET, id: SOUL_REPO_ALL_TARGET_ID }];
}

// Prefer deepest non-oneOf AJV errors so users see the real schema defect.
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

const LOAD_SKILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name as registered in the soul." },
  },
};
const validateLoadSkill = ajv.compile(LOAD_SKILL_SCHEMA);

export const loadSkillTool = defineApiTool<PlatformToolContext>({
  name: "load_skill",
  description:
    "Load a Skill's frontmatter and body by name so the agent can apply its instructions. Resolves Soul Skills before the read-only bundled overlay. Graceful not_found when the Skill is absent.",
  mutating: false,
  tier: "platform",
  inputSchema: LOAD_SKILL_SCHEMA,
  authorization: {
    action: "platform.skill.load",
    resources: ["soul.skill"],
    targets: (args) => soulTarget(SOUL_SKILL_TARGET, args, "name"),
    dataClasses: ["soul_definition"],
  },
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
});

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

export const loadSkillReferenceTool = defineApiTool<PlatformToolContext>({
  name: "load_skill_reference",
  description:
    "Load a reference file from a skill's references/ directory. Use this to pull in supporting material (playbooks, templates) that are too large to include in the skill body.",
  mutating: false,
  tier: "platform",
  inputSchema: LOAD_SKILL_REFERENCE_SCHEMA,
  authorization: {
    action: "platform.skill_reference.load",
    resources: ["soul.skill"],
    targets: (args) => soulTarget(SOUL_SKILL_TARGET, args, "skill"),
    dataClasses: ["soul_definition"],
  },
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
    // `reference` is model-controlled; contain reads to the selected Skill references directory.
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
});

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

export const validateArtifactTool = defineApiTool<PlatformToolContext>({
  name: "validate_artifact",
  description:
    "Validate an arbitrary artifact against a JSON Schema. Returns { valid: true } on success or { valid: false, errors: [...] } with AJV error details. Use before writing structured data to resources.",
  mutating: false,
  tier: "platform",
  inputSchema: VALIDATE_ARTIFACT_SCHEMA,
  authorization: {
    action: "platform.artifact.validate",
    resources: ["platform.artifact"],
    dataClasses: ["soul_definition"],
  },
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
});

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

export const transferToAgentTool = defineApiTool<PlatformToolContext>({
  name: "transfer_to_agent",
  description:
    "Hand the conversation off to another configured agent. The conversation's active agent switches and future turns are handled by the target. Validates that the target is a known platform or Soul agent.",
  mutating: false,
  tier: "platform",
  inputSchema: TRANSFER_TO_AGENT_SCHEMA,
  authorization: {
    action: "platform.agent.transfer",
    resources: ["platform.agent"],
    targets: (args) => soulTarget(SOUL_AGENT_TARGET, args, "agentId"),
    dataClasses: ["operational"],
  },
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
});

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

export const delegateToAgentTool = defineApiTool<PlatformToolContext>({
  name: "delegate_to_agent",
  description:
    "Delegate a sub-task to another agent and record the delegation. The UI surfaces a delegation-event card. Full async execution is deferred (Agents v0.9) — V1 records intent and returns a delegation receipt.",
  mutating: false,
  tier: "platform",
  inputSchema: DELEGATE_TO_AGENT_SCHEMA,
  authorization: {
    action: "platform.agent.delegate",
    resources: ["platform.agent"],
    targets: (args) => soulTarget(SOUL_AGENT_TARGET, args, "agentId"),
    dataClasses: ["operational"],
  },
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
});

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

export const triggerRoutineTool = defineApiTool<PlatformToolContext>({
  name: "trigger_routine",
  description:
    "Trigger a routine by name with optional inputs (validated against the routine's x-inputs schema). Returns the run id; watch progress via the routine run APIs.",
  mutating: true,
  tier: "platform",
  inputSchema: TRIGGER_ROUTINE_SCHEMA,
  authorization: {
    action: "platform.routine.trigger",
    resources: ["soul.routine"],
    targets: (args) => soulTarget(SOUL_ROUTINE_TARGET, args, "name"),
    dataClasses: ["operational"],
  },
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
});

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

/** Validate Routine-forged Agent names now; the V1 meta-schema cannot prove they exist. */
function findUnknownAgentRef(
  definition: Record<string, unknown>,
  ctx: PlatformToolContext
): string | undefined {
  // No Soul means cannot verify, not unknown; never block bare schema tests.
  if (!ctx.soulLoader) return undefined;
  const functions = definition.functions;
  if (!Array.isArray(functions)) return undefined;
  for (const fn of functions) {
    if (typeof fn !== "object" || fn === null) continue;
    const operation = (fn as { operation?: unknown }).operation;
    if (typeof operation !== "string") continue;
    const match = /^agent:(\S+)$/.exec(operation);
    if (!match) continue;
    const agentName = match[1];
    const known = ctx.soulLoader?.agents.has(agentName) || ctx.platformAgentNames?.has(agentName);
    if (!known) return agentName;
  }
  return undefined;
}

export const routineForgeTool = defineApiTool<PlatformToolContext>({
  name: "routine_forge",
  description:
    "Create or update a ROUTINE (a scheduled/triggered automation) in the soul repo — use this, " +
    "not skill_create, whenever the user asks to 'create a routine' / 'automate X' / 'every " +
    "morning do Y' / 'when X happens do Y'. `definition` is a CNCF Serverless Workflow 0.8 subset " +
    'and MUST include the top-level fields `id` (matches `name`), `version` (e.g. "1.0"), ' +
    "`start` (the first state's name), `states` (min 1), and `x-triggers` (min 1) — additional " +
    "properties are rejected at every level. `x-triggers` entries: `{ type: 'cron', schedule: " +
    "'0 9 * * *', timezone?: 'America/New_York' }` for a recurring cron schedule (5-field cron, " +
    "UTC unless `timezone` given — 'every hour' is `0 * * * *`, 'Monday 8am' is `0 8 * * 1`); " +
    "`{ type: 'datetime', at: '2026-09-01T08:00:00Z' }` for a single one-off fire at an ISO instant; " +
    "`{ type: 'interval', everyMs: 3600000, startAt: '2026-08-08T00:00:00Z' }` for a fixed period " +
    "anchored to `startAt`; or `{ type: 'manual' }`. `cron`/`interval`/`datetime` triggers are " +
    "dispatched automatically (see the schedule dispatcher) — no separate activation step. " +
    "Minimal example: " +
    '{ id: "daily-report", version: "1.0", start: "Report", "x-triggers": [{ type: "cron", ' +
    'schedule: "0 9 * * *" }], functions: [{ name: "send", operation: "tool:resource_search" }], ' +
    'states: [{ name: "Report", type: "operation", actions: [{ functionRef: { refName: "send" } }], ' +
    "end: true }] }. Load the routine-forge skill for the full authoring workflow before calling " +
    "this. Validates the definition against the V1 meta-schema (deferred constructs rejected), " +
    "writes soul/routines/{name}/routine.yaml (+ optional hooks.ts), and commits it atomically to " +
    "the soul repo. No approval step (ROUT-V1-002).",
  mutating: true,
  tier: "platform",
  inputSchema: ROUTINE_FORGE_SCHEMA,
  authorization: {
    action: "platform.routine.forge",
    resources: ["soul.routine"],
    targets: (args) => soulTarget(SOUL_ROUTINE_TARGET, args, "name"),
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateRoutineForge(args))
      return err("validation_error", firstError(validateRoutineForge.errors));
    const { name, definition, hooks } = args as {
      name: string;
      definition: Record<string, unknown>;
      hooks?: string;
    };
    if (!ROUTINE_NAME_RE.test(name)) return err("validation_error", "invalid routine name");

    try {
      validateRoutineDefinition(definition);
    } catch (e) {
      if (e instanceof TulipFarmValidationError) {
        return err("validation_error", `${e.path || "/"}: ${e.message}`);
      }
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    const unknownAgentRef = findUnknownAgentRef(definition, ctx);
    if (unknownAgentRef) {
      return err("validation_error", `functions: agent "${unknownAgentRef}" not found`);
    }

    try {
      await ctx.soulWriter.apply({
        subject: `soul: forge routine ${name}`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: [
          {
            op: "put",
            target: { kind: "Routine", slug: name },
            content: stringifyYaml(definition),
          },
          ...(hooks
            ? [
                {
                  op: "put" as const,
                  target: { kind: "Routine" as const, slug: name, companion: "hooks.ts" },
                  content: hooks,
                },
              ]
            : []),
        ],
      });
    } catch (e) {
      if (e instanceof SoulWriteError) return mapRoutineWriteError(e);
      return soulCommitError(e, e instanceof Error ? e.message : String(e));
    }

    // The gateway reloads the catalog but does not reschedule cron triggers.
    try {
      await ctx.onRoutinesChanged?.();
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
    return ok({ name, committed: true, hasHooks: Boolean(hooks) });
  },
});

const ROUTINE_PICKER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateRoutinePicker = ajv.compile(ROUTINE_PICKER_SCHEMA);

export const routinePickerTool = defineApiTool<PlatformToolContext>({
  name: "routine_picker",
  description:
    "List all available routines from the soul so the user can pick one to trigger. Returns name, title, and description for each routine.",
  mutating: false,
  tier: "platform",
  inputSchema: ROUTINE_PICKER_SCHEMA,
  authorization: {
    action: "platform.routine.list",
    resources: ["soul.routine"],
    targets: () => [],
    dataClasses: ["operational"],
  },
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
});

const SOUL_REPO_PUSH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateSoulRepoPush = ajv.compile(SOUL_REPO_PUSH_SCHEMA);

export const soulRepoPushTool = defineApiTool<PlatformToolContext>({
  name: "soul_repo_push",
  description:
    "Push committed soul changes to the configured git remote. Returns { pushed: false } when no remote is configured (local-only mode).",
  mutating: true,
  tier: "platform",
  inputSchema: SOUL_REPO_PUSH_SCHEMA,
  authorization: {
    action: "platform.soul_repo.push",
    resources: ["soul.repo"],
    // Push publishes the whole repo state, so narrow artifact grants cannot apply.
    targets: wholeSoulRepoTarget,
    dataClasses: ["soul_definition"],
  },
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
});

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

export const callSkillTool = defineApiTool<PlatformToolContext>({
  name: "call_skill",
  description:
    "Load and invoke a skill within the current routine execution context. Only callable from a routine-spawned agent turn.",
  mutating: false,
  tier: "platform",
  inputSchema: CALL_SKILL_SCHEMA,
  authorization: {
    action: "platform.skill.call",
    resources: ["soul.skill"],
    targets: (args) => soulTarget(SOUL_SKILL_TARGET, args, "name"),
    dataClasses: ["operational"],
  },
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
});

const COMPLETE_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    output: { description: "Output data from the completed state." },
  },
};
const validateCompleteState = ajv.compile(COMPLETE_STATE_SCHEMA);

export const completeStateTool = defineApiTool<PlatformToolContext>({
  name: "complete_state",
  description:
    "Signal completion of the current routine state and emit its output. Only callable from a routine-spawned agent turn.",
  mutating: true,
  tier: "platform",
  inputSchema: COMPLETE_STATE_SCHEMA,
  authorization: {
    action: "platform.state.complete",
    resources: ["platform.state"],
    dataClasses: ["operational"],
  },
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
});

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

export const completeTaskTool = defineApiTool<PlatformToolContext>({
  name: "complete_task",
  description:
    "Signal that the delegated work is finished and hand control back to the front-desk agent. Call this when a creation/onboarding session is done (success), cannot proceed (failed), or was abandoned (cancelled).",
  mutating: false,
  tier: "platform",
  inputSchema: COMPLETE_TASK_SCHEMA,
  authorization: {
    action: "platform.task.complete",
    resources: ["platform.task"],
    dataClasses: ["operational"],
  },
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
});

const GET_CURRENT_TIME_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    timezone: {
      type: "string",
      minLength: 1,
      description:
        "IANA zone to read the time in (e.g. 'Asia/Kolkata'). Defaults to UTC. Pass the zone shown " +
        "in <current-context> to stay consistent with the rest of the turn.",
    },
  },
};
const validateGetCurrentTime = ajv.compile(GET_CURRENT_TIME_SCHEMA);

/** Fresh stateless clock Tool shares the turn-context format to avoid conflicting time facts. */
export const getCurrentTimeTool = defineApiTool<PlatformToolContext>({
  name: "get_current_time",
  description:
    "Get the current date, day of week and time. The <current-context> block is read once at the " +
    "start of the turn, so call this when a long-running turn may have outlived it, or to read the " +
    "time in a different timezone.",
  mutating: false,
  tier: "platform",
  inputSchema: GET_CURRENT_TIME_SCHEMA,
  authorization: {
    action: "platform.time.read",
    resources: ["platform.time"],
    dataClasses: ["operational"],
  },
  handler: async (args) => {
    if (!validateGetCurrentTime(args))
      return err("validation_error", firstError(validateGetCurrentTime.errors));
    const { timezone } = args as { timezone?: string };
    return ok({ current: formatTemporalContext({ now: new Date(), timezone }) });
  },
});

export const PLATFORM_TOOLS: ApiToolDefinition<PlatformToolContext>[] = [
  loadSkillTool,
  loadSkillReferenceTool,
  validateArtifactTool,
  transferToAgentTool,
  delegateToAgentTool,
  triggerRoutineTool,
  routineForgeTool,
  routinePickerTool,
  soulRepoPushTool,
  callSkillTool,
  completeStateTool,
  completeTaskTool,
  getCurrentTimeTool,
];
