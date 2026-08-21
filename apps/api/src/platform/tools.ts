import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DelegateToAgentInput, DelegationOutcome } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PLATFORM_RUNTIME_TOOLS } from "@tulipfarm/platform-tools";
import { ajv, definitions } from "@tulipfarm/schema";
import type { BundledSkill } from "@tulipfarm/soul";
import {
  type GitSyncService,
  type RoutineCatalog,
  resolveSkill,
  type SoulAgent,
  type SoulLoader,
  type SoulRoutine,
  type SoulSkill,
  SoulWriteError,
  type SoulWriter,
  unresolvedRoutineResourceTypes,
} from "@tulipfarm/soul";
import type { RequestContext } from "@tulipfarm/tool-host";
import { type ApiToolDefinition, defineApiTool } from "@tulipfarm/tool-host";
import { stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import { mapSoulWriteError, soulCommitError } from "../tools/soul-faults";
import { delegateToAgentTool } from "./delegate-tool";
import { guardrailForgeTool } from "./guardrail-tool";
import { firstError, SOUL_ROUTINE_TARGET, SOUL_SKILL_TARGET, soulTarget } from "./tool-args";
import { err, ok } from "./tool-result";

export interface PlatformToolContext {
  soulLoader?: {
    skills: Map<string, SoulSkill>;
    agents: Map<string, SoulAgent>;
    routines?: Map<string, SoulRoutine>;
    /** Read by `routine_forge` so a Routine cannot name a Resource type the Soul does not have. */
    resources?: ReadonlyMap<string, unknown>;
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
  /**
   * The Routines surface's own read model. `routine_forge` reports success only once the Routine
   * it wrote is listed here, so the Tool's claim is a read-back through the reader the user will
   * use rather than a restatement of what the write path was asked to do.
   */
  routineCatalog?: RoutineCatalog;
  /**
   * Re-reads `guardrails.yaml` into the live {@link GuardrailsService}. Every Turn's Context
   * carries the in-process policy, not the published bundle, so without this a committed
   * Guardrail is not enforced until the next Soul sync or restart.
   */
  onGuardrailsChanged?: () => Promise<void>;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: ReadonlySet<string>;
  platformAgentNames?: ReadonlySet<string>;
  requestContext?: RequestContext;
  events?: EventEmitter;
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
  required: ["name", "definition", "triggers"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Routine slug (directory under soul/routines/): lowercase, digits, hyphens.",
    },
    definition: {
      type: "object",
      description:
        "Canonical published Routine definition. metadata.slug must match name. spec.states must be an array of State objects [{ name, type, ... }].",
    },
    triggers: {
      type: "array",
      minItems: 1,
      items: { type: "object" },
      description:
        "Canonical published Trigger definitions referencing this Routine and its authored version.",
    },
  },
};
const validateRoutineForge = ajv.compile(ROUTINE_FORGE_SCHEMA);

export const routineForgeTool = defineApiTool<PlatformToolContext>({
  name: "routine_forge",
  requiresAmbient: ["soul"],
  description:
    "Create or update a ROUTINE (a scheduled/triggered automation) in the soul repo — use this, " +
    "not skill_create, whenever the user asks to 'create a routine' / 'automate X' / 'every " +
    "morning do Y' / 'when X happens do Y'. `definition` MUST be a canonical published Routine " +
    "document: apiVersion `tulipfarm.ai/v1`, kind `Routine`, and metadata with id, slug (matching " +
    "name), schemaVersion, authoredVersion, and lifecycle `published`. `definition.spec.states` " +
    "MUST be an array of State objects with name and type (not an object/map). `triggers` MUST contain " +
    "canonical published Trigger documents with their own metadata and a spec.routineRef naming this " +
    "Routine at its authored version. Use a `manual` Trigger when the user needs to run it from the " +
    "Routines UI; cron, interval, and datetime Triggers schedule themselves. Load the routine-forge " +
    "Skill for complete canonical examples before calling this. The Tool validates every document and " +
    "commits the Routine plus all Triggers atomically to the Soul repo.",
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
    const { name, definition, triggers } = args as {
      name: string;
      definition: Record<string, unknown>;
      triggers: Record<string, unknown>[];
    };
    if (!ROUTINE_NAME_RE.test(name)) return err("validation_error", "invalid routine name");

    let routine: definitions.routine.RoutineDefinition;
    let triggerDefinitions: definitions.trigger.TriggerDefinition[];
    try {
      routine = definitions.routine.validateRoutineDefinition(definition).document;
      triggerDefinitions = triggers.map(
        (trigger) => definitions.trigger.validateTriggerDefinition(trigger).document
      );
    } catch (error) {
      return err("validation_error", error instanceof Error ? error.message : String(error));
    }
    if (routine.metadata.slug !== name)
      return err("validation_error", "definition.metadata.slug must match name");
    if (routine.metadata.lifecycle !== "published")
      return err("validation_error", "definition.metadata.lifecycle must be published");
    const unresolved = unresolvedRoutineResourceTypes(routine.spec, ctx.soulLoader?.resources);
    if (unresolved !== undefined) return err(unresolved.code, unresolved.message);
    if (
      new Set(triggerDefinitions.map((trigger) => trigger.metadata.slug)).size !==
      triggerDefinitions.length
    ) {
      return err("validation_error", "triggers must have unique metadata.slug values");
    }
    for (const trigger of triggerDefinitions) {
      if (trigger.metadata.lifecycle !== "published")
        return err("validation_error", "trigger metadata.lifecycle must be published");
      if (
        trigger.spec.routineRef.name !== name ||
        trigger.spec.routineRef.version !== String(routine.metadata.authoredVersion)
      ) {
        return err(
          "validation_error",
          "trigger spec.routineRef must match the Routine name and authored version"
        );
      }
    }

    let write: Awaited<ReturnType<SoulWriter["apply"]>>;
    try {
      write = await ctx.soulWriter.apply({
        subject: `soul: forge routine ${name}`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: [
          {
            op: "put",
            target: { kind: "Routine", slug: name },
            content: stringifyYaml(routine),
          },
          ...triggerDefinitions.map((trigger) => ({
            op: "put" as const,
            target: { kind: "Trigger" as const, slug: trigger.metadata.slug },
            content: stringifyYaml(trigger),
          })),
        ],
      });
    } catch (e) {
      if (e instanceof SoulWriteError) return mapSoulWriteError(e);
      return soulCommitError(e, e instanceof Error ? e.message : String(e));
    }

    // Committed is not published: the Routines surface and every Run read the active bundle, so a
    // Routine whose publication failed is invisible and cannot be triggered. Reporting success here
    // is what makes the Tool claim an outcome the Runtime never reached.
    if (!write.published) {
      return err(
        "internal_error",
        `Routine ${name} was committed to the Soul but its runtime bundle publication failed, so it is not published and will not appear in Routines${
          write.publicationError === undefined ? "" : ` — ${write.publicationError}`
        }`
      );
    }

    // The gateway reloads the catalog but does not reschedule cron triggers.
    try {
      await ctx.onRoutinesChanged?.();
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    const invisible = await routineMissingFromCatalog(ctx.routineCatalog, name);
    if (invisible !== undefined) return err("internal_error", invisible);

    return ok({
      name,
      committed: true,
      triggerSlugs: triggerDefinitions.map((trigger) => trigger.metadata.slug),
    });
  },
});

/**
 * Why the forged Routine is not on the Routines surface, or `undefined` when it is listed.
 *
 * A Tool that announces a Routine the surface cannot show is the failure this guards: the write
 * path and the read model can drift apart in ways the write path cannot see, and every such drift
 * has reached users as a confident success message for something unreachable.
 */
async function routineMissingFromCatalog(
  catalog: RoutineCatalog | undefined,
  slug: string
): Promise<string | undefined> {
  if (catalog === undefined) return undefined;
  try {
    const listed = await catalog.list();
    return listed.some((routine) => routine.slug === slug)
      ? undefined
      : `Routine ${slug} was committed and published but does not appear on the Routines surface, so it is not available to run or edit`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Routine ${slug} was committed and published but the Routines surface could not be read back, so it cannot be reported as available — ${reason}`;
  }
}

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
  delegateToAgentTool,
  triggerRoutineTool,
  routineForgeTool,
  routinePickerTool,
  guardrailForgeTool,
  soulRepoPushTool,
  callSkillTool,
  // Context-free Tools the durable runtime also hosts; `PlatformRuntimeContext` is a subset of
  // `PlatformToolContext`, so the control plane registers the same definitions.
  ...(PLATFORM_RUNTIME_TOOLS as ApiToolDefinition<PlatformToolContext>[]),
];
