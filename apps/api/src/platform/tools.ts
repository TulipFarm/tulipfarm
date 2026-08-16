import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DelegateToAgentInput, DelegationOutcome } from "@tulipfarm/agent-runtime";
import { DelegationError } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PLATFORM_RUNTIME_TOOLS } from "@tulipfarm/platform-tools";
import { ChildRunError } from "@tulipfarm/run-kernel";
import { ajv, TulipFarmValidationError, validateRoutineDefinition } from "@tulipfarm/schema";
import type { BundledSkill } from "@tulipfarm/soul";
import {
  type GitSyncService,
  resolveSkill,
  type SoulAgent,
  type SoulLoader,
  type SoulRoutine,
  type SoulSkill,
  SoulWriteError,
  type SoulWriter,
} from "@tulipfarm/soul";
import type { RequestContext } from "@tulipfarm/tool-host";
import { type ApiToolDefinition, defineApiTool } from "@tulipfarm/tool-host";
import { stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import { soulCommitError } from "../tools/soul-faults";
import { delegateToAgentTool } from "./delegate-tool";
import {
  firstError,
  SOUL_AGENT_TARGET,
  SOUL_ROUTINE_TARGET,
  SOUL_SKILL_TARGET,
  soulTarget,
} from "./tool-args";
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
  /** The one guarded path that starts a delegated child Run; see `./delegation.ts`. */
  delegateToAgent?: (input: DelegateToAgentInput) => Promise<DelegationOutcome>;
  onRoutinesChanged?: () => Promise<void>;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: ReadonlySet<string>;
  platformAgentNames?: ReadonlySet<string>;
  requestContext?: RequestContext;
  events?: EventEmitter;
}

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

const SOUL_REPO_TARGET = "soul.repo";
const SOUL_REPO_ALL_TARGET_ID = "entire-repository";

function wholeSoulRepoTarget() {
  return [{ type: SOUL_REPO_TARGET, id: SOUL_REPO_ALL_TARGET_ID }];
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
  requiresAmbient: ["soul"],
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
  requiresAmbient: ["soul"],
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
  requiresAmbient: ["soul"],
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
  requiresAmbient: ["soul"],
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
  requiresAmbient: ["soul"],
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
  requiresAmbient: ["soul"],
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
  requiresAmbient: ["soul"],
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
  requiresAmbient: ["soul"],
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

/** Fresh stateless clock Tool shares the turn-context format to avoid conflicting time facts. */

export const PLATFORM_TOOLS: ApiToolDefinition<PlatformToolContext>[] = [
  loadSkillTool,
  loadSkillReferenceTool,
  transferToAgentTool,
  delegateToAgentTool,
  triggerRoutineTool,
  routineForgeTool,
  routinePickerTool,
  soulRepoPushTool,
  callSkillTool,
  // Context-free Tools the durable runtime also hosts; `PlatformRuntimeContext` is a subset of
  // `PlatformToolContext`, so the control plane registers the same definitions.
  ...(PLATFORM_RUNTIME_TOOLS as ApiToolDefinition<PlatformToolContext>[]),
];
