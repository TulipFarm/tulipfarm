import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type {
  DelegateToAgentInput,
  DelegationOutcome,
  SpawnSubagentInput,
  SpawnSubagentOutcome,
} from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { PLATFORM_RUNTIME_TOOLS } from "@tulipfarm/platform-tools";
import { ajv, type definitions } from "@tulipfarm/schema";
import {
  type CommandRefusalReason,
  SkillBashRunError,
  type SkillBashRunner,
  SkillCommandRunError,
  type SkillCommandRunner,
} from "@tulipfarm/skill-sandbox";
import type { BundledSkill } from "@tulipfarm/soul";
import {
  createSkillFileReader,
  type GitSyncService,
  isSkillDefinitionFile,
  lockProvenance,
  type RoutineCatalog,
  type RoutineCatalogDetail,
  readSkillsLock,
  resolveSkill,
  SKILL_TOOL_DECLARATION,
  SKILL_TOOL_INPUT_SCHEMA,
  SKILL_TOOL_NAME,
  SkillFileError,
  type SoulAgent,
  type SoulLoader,
  type SoulRoutine,
  type SoulSkill,
  SoulWriteError,
  type SoulWriter,
  unresolvedRoutineDefinitions,
  unresolvedRoutineResourceTypes,
} from "@tulipfarm/soul";
import type { RequestContext } from "@tulipfarm/tool-host";
import {
  type ApiToolDefinition,
  defineApiTool,
  type ParkableApiToolDefinition,
  type ToolCallResult,
} from "@tulipfarm/tool-host";
import { stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import { declaredStringList } from "../tools/network/compose";
import { mapSoulWriteError, soulCommitError } from "../tools/soul-faults";
import { delegateToAgentTool } from "./delegate-tool";
import { guardrailForgeTool } from "./guardrail-tool";
import { validateRoutineForgeDefinitions } from "./routine-forge-validation";
import { spawnSubagentTool } from "./spawn-tool";
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
  /**
   * Names of the Tools this instance hosts for Agents. Read by `routine_forge` to tell a Routine
   * `tool` State that names a hosted Tool — which it can never reach — apart from one that names a
   * ToolContract the Soul is simply missing. The two need opposite corrections.
   */
  runtimeToolNames?: () => ReadonlySet<string>;
  /**
   * Executes a Skill's declared command in the sandbox. Absent — no runtime image is configured —
   * leaves `skill` in `run` mode reporting that execution is unavailable rather than missing.
   */
  skillCommands?: SkillCommandRunner;
  /**
   * Executes a command a Skill documented in a fenced block. Absent — no runtime image — leaves
   * `skill` in `shell` mode reporting that execution is unavailable rather than missing.
   */
  skillBash?: SkillBashRunner;
  soulPath?: string;
  gitSync?: GitSyncService;
  /** The single write gateway for the authored Soul tree (ADR-007). */
  readonly soulWriter: SoulWriter;
  routineContext?: { routineId: string; runId: string };
  /**
   * Starts a Routine Run as `caller`. The caller is a parameter rather than a fixed identity
   * because a Routine Run authorizes its Agent States against its own effective subject: minted
   * under a principal that holds no grants, every Tool call the Routine makes is denied.
   */
  triggerRoutine?: (
    slug: string,
    inputs: Record<string, unknown> | undefined,
    caller: { readonly kind: string; readonly id: string }
  ) => Promise<{ runId: string }>;
  /** The one guarded path that starts a delegated child Run; see `./delegation.ts`. */
  delegateToAgent?: (input: DelegateToAgentInput) => Promise<DelegationOutcome>;
  /** Spawns an ad-hoc helper the caller defines inline; absent leaves `spawn_subagent` unavailable. */
  spawnSubagent?: (input: SpawnSubagentInput) => Promise<SpawnSubagentOutcome>;
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
  /**
   * Skills hidden for this Turn only, on top of the persisted tombstones in
   * {@link PlatformToolContext.disabledBundledSkills}. A Skill documenting an integration that is
   * not installed belongs here and not there: the tombstone set is written back to
   * `skills/.bundled-disabled.json`, so a live check added to it would persist as a permanent
   * delete the moment anything else saved.
   */
  hiddenSkillNames?: () => Promise<ReadonlySet<string>>;
  platformAgentNames?: ReadonlySet<string>;
  requestContext?: RequestContext;
  events?: EventEmitter;
}

/**
 * The Skills this Turn cannot see: persisted tombstones plus any live gate.
 *
 * Every Skill read path must resolve through this. A Skill that `skill_list` hides but
 * the `skill` Tool still serves is worse than one that was never hidden, because the Agent reaches it
 * by name and then calls Tools the same gate excluded.
 */
async function hiddenSkills(ctx: PlatformToolContext): Promise<ReadonlySet<string>> {
  const persisted = ctx.disabledBundledSkills ?? new Set<string>();
  const live = await ctx.hiddenSkillNames?.();
  if (live === undefined || live.size === 0) return persisted;
  return new Set([...persisted, ...live]);
}

const SOUL_REPO_TARGET = "soul.repo";
const SOUL_REPO_ALL_TARGET_ID = "entire-repository";

function wholeSoulRepoTarget() {
  return [{ type: SOUL_REPO_TARGET, id: SOUL_REPO_ALL_TARGET_ID }];
}

function skillFileReader(
  ctx: PlatformToolContext,
  skillName: string,
  soulSkill: SoulSkill | undefined,
  bundledSkill: BundledSkill | undefined
): ReturnType<typeof createSkillFileReader> | undefined {
  if (!soulSkill && bundledSkill) {
    return createSkillFileReader({
      directory: bundledSkill.directory,
      advertisedPaths: bundledSkill.files,
    });
  }
  return ctx.soulPath
    ? createSkillFileReader({ directory: `${ctx.soulPath}/skills/${skillName}` })
    : undefined;
}

function missingFileMessage(skill: string, file: string, available: readonly string[]) {
  const availability =
    available.length === 0
      ? "No supporting files are available."
      : `Available files: ${available.join(", ")}.`;
  return `File "${file}" not found for Skill "${skill}". ${availability}`;
}

interface SkillToolArgs {
  name: string;
  file?: string;
  mode?: string;
  command?: string;
  arguments?: Record<string, unknown>;
  destination?: string;
}

/** Executing modes, which `classify` charges against `platform.skill.run` rather than `.load`. */
function isRunMode(mode: string | undefined): mode is "run" | "shell" {
  return mode === "run" || mode === "shell";
}

const validateSkillTool = ajv.compile(SKILL_TOOL_INPUT_SCHEMA);

const SKILL_COMMAND_RUN_FAILURES: Record<
  string,
  { code: "not_found" | "write_denied"; text: string }
> = {
  skill_not_found: {
    code: "not_found",
    text: "No Skill declares runnable commands under that name.",
  },
  command_not_found: { code: "not_found", text: "That Skill declares no command with that name." },
  destination_denied: {
    code: "write_denied",
    text: "The command's ToolContract does not allow that destination.",
  },
};

const SKILL_BASH_FAILURES: Record<CommandRefusalReason, string> = {
  no_allowlist: "That Skill declares no `allowedCommands`, so it can run nothing.",
  not_allowed: "That Skill's `allowedCommands` do not cover this command.",
  command_chaining:
    "A command may not chain or pipe into another one; run the single command the Skill documents.",
  unterminated_heredoc: "The heredoc opened on the first line is never closed by its delimiter.",
};

/**
 * Runs a command the Skill packaged as a script and declared with a ToolContract.
 *
 * A Skill is an instruction package, so its scripts are inert text until something runs them. A
 * model asked what `probe.ts` prints can only compute the answer itself, which silently diverges
 * from the real one as soon as the code reads a clock, a random value, a file or the network.
 */
async function runDeclaredCommand(
  ctx: PlatformToolContext,
  input: {
    skill: string;
    command: string;
    runId: string;
    arguments?: Record<string, unknown>;
    destination?: string;
  }
): Promise<ToolCallResult> {
  if (!ctx.skillCommands)
    return err("internal_error", "Skill command execution is not configured.");
  try {
    const result = await ctx.skillCommands.run({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId: input.runId,
      // The per-call id keeps each occurrence distinct. Input Artifacts are keyed by
      // run + state + argument digest and are append-only, so a stateKey fixed per command
      // makes a second identical call in the same Run collide with the first.
      stateKey: `skill-command:${input.skill}:${input.command}:${ctx.requestContext?.toolCallId ?? randomUUID()}`,
      skill: input.skill,
      command: input.command,
      ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
      ...(input.destination === undefined ? {} : { destination: input.destination }),
    });
    return ok(result);
  } catch (e) {
    if (e instanceof SkillCommandRunError) {
      if (e.code === "sandbox_unavailable")
        return err(
          "internal_error",
          "No sandbox runtime image is configured, so Skill commands cannot run."
        );
      const failure = SKILL_COMMAND_RUN_FAILURES[e.code];
      // Every `SkillCommandRunError` code is mapped; the fallback keeps the union exhaustive
      // without asserting on a value the compiler already narrowed.
      if (failure !== undefined) {
        const options = e.available.length === 0 ? "" : ` Available: ${e.available.join(", ")}.`;
        return err(failure.code, `${failure.text}${options}`);
      }
    }
    return err("internal_error", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Runs a command the Skill wrote into its instructions rather than packaged as a file.
 *
 * `mode: "run"` covers code a Skill shipped as a script with a ToolContract. Most Skills teach by
 * example instead, putting the command in a fenced block in `SKILL.md` — which the model can read
 * but, without this, only ever narrate. The Skill's `allowedCommands` frontmatter says which of
 * those commands may actually run, and the sandbox bounds what running one can do.
 */
async function runShellCommand(
  ctx: PlatformToolContext,
  skill: SoulSkill | BundledSkill,
  input: { skill: string; command: string; runId: string; destination?: string }
): Promise<ToolCallResult> {
  if (!ctx.skillBash) return err("internal_error", "Skill command execution is not configured.");
  const allowedCommands = declaredStringList(skill.frontmatter.allowedCommands);
  // A command may only reach a destination the same Skill already declared on a command of its
  // own, so inline code never widens the Skill's egress beyond what its ToolContracts allow.
  const allowedDestinations = [
    ...new Set(
      (await ctx.skillCommands?.list())
        ?.filter((candidate) => candidate.skill === input.skill)
        .flatMap((candidate) => candidate.allowedDestinations) ?? []
    ),
  ];
  try {
    const result = await ctx.skillBash.run({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId: input.runId,
      stateKey: `skill-bash:${input.skill}:${ctx.requestContext?.toolCallId ?? randomUUID()}`,
      skill: input.skill,
      command: input.command,
      allowedCommands,
      allowedDestinations,
      ...(input.destination === undefined ? {} : { destination: input.destination }),
    });
    return ok(result);
  } catch (e) {
    if (e instanceof SkillBashRunError) {
      if (e.code === "sandbox_unavailable")
        return err(
          "internal_error",
          "No sandbox runtime image is configured, so commands cannot run."
        );
      const options = e.available.length === 0 ? "" : ` Declared: ${e.available.join(", ")}.`;
      if (e.code === "destination_denied")
        return err("write_denied", `That Skill does not allow that destination.${options}`);
      const reason = e.reason === undefined ? "" : SKILL_BASH_FAILURES[e.reason];
      return err("write_denied", `${reason}${options}`);
    }
    return err("internal_error", e instanceof Error ? e.message : String(e));
  }
}

/**
 * The one door to a Skill. `{ name }` loads it, `{ name, file }` reads one of the files it
 * advertised — reference, schema, asset or script alike, and `mode: "inspect"` returns the same
 * content as data, with provenance and without making the Skill active. Every mode resolves the
 * Skill first, so a Skill hidden from `skill_list` cannot be reached by naming one of its files,
 * and reads are confined to paths the artifact layout can address inside that Skill's own
 * directory.
 *
 * Inspect exists because reading a Skill and adopting one are different acts. An authoring or
 * auditing Turn has to read the exact bytes of a Skill it is about to patch, verify or judge —
 * frequently one it does not trust yet — and loading to do that would both hand those bytes to
 * the model as instructions and re-narrow the offer away from the Skill the Turn is working in.
 *
 * `run` and `shell` execute rather than read, so `classify` raises the authorized action to
 * `platform.skill.run`: a grant that lets a principal read a Skill must not also let it run the
 * Skill's code.
 */
export const skillTool = defineApiTool<PlatformToolContext>({
  name: SKILL_TOOL_NAME,
  requiresAmbient: ["soul"],
  description: SKILL_TOOL_DECLARATION.description,
  mutating: false,
  tier: "platform",
  inputSchema: SKILL_TOOL_INPUT_SCHEMA,
  authorization: {
    action: "platform.skill.load",
    resources: ["soul.skill"],
    targets: (args) => soulTarget(SOUL_SKILL_TARGET, args, "name"),
    dataClasses: ["soul_definition"],
  },
  classify: (args) => ({
    mutating: false,
    action: isRunMode((args as { mode?: string }).mode)
      ? "platform.skill.run"
      : "platform.skill.load",
  }),
  handler: async (args, ctx) => {
    if (!validateSkillTool(args))
      return err("validation_error", firstError(validateSkillTool.errors));
    const {
      name,
      file,
      mode,
      command,
      arguments: commandArgs,
      destination,
    } = args as SkillToolArgs;

    const hidden = await hiddenSkills(ctx);
    const skill = resolveSkill(
      name,
      ctx.soulLoader as SoulLoader | undefined,
      ctx.bundledSkills,
      hidden
    );
    if (!skill) return err("not_found", `Skill "${name}" not found.`);

    if (isRunMode(mode)) {
      if (command === undefined)
        return err("validation_error", `\`mode: "${mode}"\` requires \`command\`.`);
      if (file !== undefined)
        return err(
          "validation_error",
          "`file` reads a Skill's files and cannot be combined with a run mode."
        );
      const runId = ctx.routineContext?.runId ?? ctx.requestContext?.runId;
      if (runId === undefined)
        return err("internal_error", "Cannot run a Skill command outside a Run.");
      const shared = {
        skill: name,
        command,
        runId,
        ...(destination === undefined ? {} : { destination }),
      };
      return mode === "run"
        ? runDeclaredCommand(ctx, {
            ...shared,
            ...(commandArgs === undefined ? {} : { arguments: commandArgs }),
          })
        : runShellCommand(ctx, skill, shared);
    }

    const soulSkill = ctx.soulLoader?.skills.get(name);
    // `resolveSkill` already applied `hidden`, so a bundled hit here is one this Turn may see.
    const bundledSkill = soulSkill ? undefined : ctx.bundledSkills?.get(name);
    const reader = skillFileReader(ctx, name, soulSkill, bundledSkill);

    let files: readonly string[];
    try {
      files = (await reader?.list()) ?? [];
    } catch {
      return err("internal_error", `Skill "${name}" files are temporarily unavailable.`);
    }

    if (file === undefined) {
      const loaded = { name: skill.name, frontmatter: skill.frontmatter, body: skill.body, files };
      if (mode !== "inspect") return ok(loaded);
      const soulPath = ctx.gitSync?.path ?? ctx.soulPath;
      const lock = soulPath === undefined ? undefined : await readSkillsLock(soulPath);
      return ok({
        ...loaded,
        inspected: true,
        provenance:
          lock === undefined ? "bundled" : lockProvenance(lock, name, soulSkill !== undefined),
      });
    }

    if (!reader) return err("not_found", missingFileMessage(name, file, files));
    // The load already returned this text as `body`, and `files` deliberately omits it. Reading it
    // back costs a whole model invocation to receive bytes the caller is holding, so say so
    // instead of serving it — the alternative is a Turn that spends its budget re-reading itself.
    if (isSkillDefinitionFile(file)) {
      return err(
        "validation_error",
        `"${file}" is Skill "${name}"'s own definition — loading the Skill already returned it as ` +
          "`body`. Use what you have; `file` is for the supporting paths in `files`."
      );
    }
    try {
      const content = await reader.read(file);
      return ok({ name, file, content, ...(mode === "inspect" ? { inspected: true } : {}) });
    } catch (error) {
      if (error instanceof SkillFileError) {
        if (error.code === "INVALID_PATH") {
          return err(
            "validation_error",
            `File "${file}" is not a readable path inside Skill "${name}".`
          );
        }
        if (error.code === "NOT_FOUND") {
          return err("not_found", missingFileMessage(name, file, files));
        }
      }
      return err("internal_error", `Skill "${name}" files are temporarily unavailable.`);
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
    const caller = ctx.requestContext?.subject;
    if (!caller) {
      return err("internal_error", "Cannot trigger a routine without a calling principal.");
    }
    try {
      const { runId } = await ctx.triggerRoutine(name, inputs, caller);
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
        "Canonical published Routine definition. metadata.slug must match name. spec.states must be an array of State objects [{ name, type, ... }]. Triggers live in spec.triggers on this same document.",
    },
  },
};
const validateRoutineForge = ajv.compile(ROUTINE_FORGE_SCHEMA);

/**
 * Stamps the authoring principal onto a Trigger's `backgroundIdentity`, replacing whatever the
 * model wrote there.
 *
 * A Trigger's background identity is the effective subject of every Run it starts, and a Routine's
 * Agent States authorize their Tool calls against that subject. A model-invented name such as
 * `service:routine-runner` matches no row in `principals`, so it holds no grants and every Tool
 * call the Routine makes is denied. The author is the one principal we know exists and whose
 * authority the Routine is meant to act within.
 */
function authoredBy(
  routine: definitions.routine.RoutineDefinition,
  author: { readonly kind: string; readonly id: string } | undefined
): definitions.routine.RoutineDefinition {
  if (author === undefined || routine.spec.triggers === undefined) return routine;
  return {
    ...routine,
    spec: {
      ...routine.spec,
      triggers: routine.spec.triggers.map((trigger) => ({
        ...trigger,
        backgroundIdentity: { principalKind: author.kind, principalId: author.id },
      })),
    },
  };
}

export const routineForgeTool = defineApiTool<PlatformToolContext>({
  name: "routine_forge",
  requiresAmbient: ["soul"],
  description:
    "Create or update a ROUTINE (a scheduled/triggered automation) in the soul repo. Use this, " +
    "not skill_create, whenever the user asks to 'create a routine' / 'automate X' / 'every " +
    "morning do Y' / 'when X happens do Y'. Updating an existing Routine replaces its whole " +
    "document, so call `routine_get` first and forge the full definition back, or every State and " +
    "Trigger you did not restate is deleted. `definition` MUST be a canonical published Routine " +
    "document: apiVersion `tulipfarm.ai/v1`, kind `Routine`, and metadata with id, slug (matching " +
    "name), schemaVersion, authoredVersion, and lifecycle `published`. `definition.spec.states` " +
    "MUST be an array of State objects with name and type (not an object/map). Triggers belong to " +
    "`definition.spec.triggers`, each an object with a slug-shaped `name` and a `type`; there is no " +
    "separate Trigger document and no `triggers` argument. cron, interval, and datetime Triggers " +
    "schedule themselves once published, and the Routines UI can already start a Run without any " +
    "Trigger, so omit `spec.triggers` entirely for a Routine that only runs on demand. Load the " +
    "routine-forge Skill for complete canonical examples before calling this. The Tool validates the " +
    "document and commits it to the Soul repo.",
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
    const { name, definition } = args as {
      name: string;
      definition: Record<string, unknown>;
    };
    if (!ROUTINE_NAME_RE.test(name)) return err("validation_error", "invalid routine name");

    const validation = validateRoutineForgeDefinitions({ name, definition });
    if (!validation.ok) return err("validation_error", validation.message);
    const { routine, triggers: triggerDefinitions } = validation;
    const unresolved = unresolvedRoutineResourceTypes(routine.spec, ctx.soulLoader?.resources);
    if (unresolved !== undefined) return err(unresolved.code, unresolved.message);
    const unreachable = unresolvedRoutineDefinitions(routine.spec, {
      ...(ctx.soulLoader?.agents === undefined ? {} : { agents: ctx.soulLoader.agents }),
      // The Routine being forged lands in the same commit, so a self-referencing child_routine
      // State resolves even though the loader has not seen it yet.
      ...(ctx.soulLoader?.routines === undefined
        ? {}
        : { routines: new Map([...ctx.soulLoader.routines, [name, undefined]]) }),
      ...(ctx.runtimeToolNames === undefined ? {} : { runtimeToolNames: ctx.runtimeToolNames() }),
    });
    if (unreachable !== undefined) return err(unreachable.code, unreachable.message);

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
            content: stringifyYaml(authoredBy(routine, ctx.requestContext?.subject)),
          },
        ],
      });
    } catch (e) {
      if (e instanceof SoulWriteError) return mapSoulWriteError(e);
      return soulCommitError(e, "Routine could not be written to the Soul.");
    }

    // Committed is not published: the Routines surface and every Run read the active bundle, so a
    // Routine whose publication failed is invisible and cannot be triggered. Reporting success here
    // is what makes the Tool claim an outcome the Runtime never reached.
    if (!write.published) {
      return err(
        "internal_error",
        `Routine ${name} was committed to the Soul but its runtime bundle publication failed, so it is not published and will not appear in Routines.`
      );
    }

    // The gateway reloads the catalog but does not reschedule cron triggers.
    try {
      await ctx.onRoutinesChanged?.();
    } catch {
      return err("internal_error", `Routine ${name} could not be activated after publication.`);
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
  } catch {
    return `Routine ${slug} was committed and published but the Routines surface could not be read back, so it cannot be reported as available`;
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

const ROUTINE_GET_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Routine slug, as `routine_picker` lists it.",
    },
  },
};
const validateRoutineGet = ajv.compile(ROUTINE_GET_SCHEMA);

export const routineGetTool = defineApiTool<PlatformToolContext>({
  name: "routine_get",
  requiresAmbient: ["soul"],
  description:
    "Read one Routine's full configuration: the canonical Routine document (metadata, spec.states " +
    "and spec.triggers) plus the Triggers currently scheduling it. `routine_picker` returns only " +
    "names, so this is the only way to see what a Routine actually does. Call it before every " +
    "`routine_forge` edit: forge replaces the whole document, so an update written without reading " +
    "first silently deletes every State and Trigger it did not restate. Reads the verified active " +
    "Soul bundle, so it returns the Routine a Run would actually execute rather than an authored draft.",
  mutating: false,
  tier: "platform",
  inputSchema: ROUTINE_GET_SCHEMA,
  authorization: {
    action: "platform.routine.read",
    resources: ["soul.routine"],
    targets: (args) => soulTarget(SOUL_ROUTINE_TARGET, args, "name"),
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateRoutineGet(args))
      return err("validation_error", firstError(validateRoutineGet.errors));
    const { name } = args as { name: string };
    if (ctx.routineCatalog === undefined)
      return err(
        "internal_error",
        "The Routines surface is unavailable, so no Routine can be read."
      );

    let detail: RoutineCatalogDetail | undefined;
    try {
      detail = await ctx.routineCatalog.get(name);
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    if (detail === undefined) {
      // A Routine that is in the Soul but absent from the active bundle failed publication, and
      // reporting that as a plain miss makes an Agent forge a duplicate instead of repairing it.
      return ctx.soulLoader?.routines?.has(name)
        ? err(
            "not_found",
            `Routine ${name} exists in the Soul but is not in the active bundle, so it is not published and cannot run.`
          )
        : err("not_found", `routine not found: ${name}`);
    }

    return ok({
      name: detail.slug,
      id: detail.id,
      displayName: detail.displayName,
      authoredVersion: detail.authoredVersion,
      triggers: detail.triggers,
      definition: detail.definition,
      bundleDigest: detail.bundleDigest,
    });
  },
});

const ROUTINE_DELETE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Routine name to delete." },
  },
};
const validateRoutineDelete = ajv.compile(ROUTINE_DELETE_SCHEMA);

export const routineDeleteTool = defineApiTool<PlatformToolContext>({
  name: "routine_delete",
  requiresAmbient: ["soul"],
  description:
    "Delete a routine from the soul repo. Its Triggers live inside the Routine document, so they " +
    "go with it, and the response names them, because their webhook URLs stop resolving. " +
    "Commits atomically to the soul repo.",
  mutating: true,
  tier: "platform",
  inputSchema: ROUTINE_DELETE_SCHEMA,
  authorization: {
    action: "platform.routine.delete",
    resources: ["soul.routine"],
    targets: (args) => soulTarget(SOUL_ROUTINE_TARGET, args, "name"),
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateRoutineDelete(args))
      return err("validation_error", firstError(validateRoutineDelete.errors));
    const { name } = args as { name: string };

    if (!ctx.soulLoader?.routines?.has(name)) return err("not_found", `routine not found: ${name}`);

    let triggerSlugs: string[] = [];
    if (ctx.routineCatalog) {
      try {
        const listed = await ctx.routineCatalog.list();
        triggerSlugs = listed.find((r) => r.slug === name)?.triggers.map((t) => t.slug) ?? [];
      } catch (e) {
        return err("internal_error", e instanceof Error ? e.message : String(e));
      }
    }

    try {
      await ctx.soulWriter.apply({
        subject: `soul: remove routine ${name}`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        // Triggers live inside the Routine document, so removing it removes them with it. The
        // names are still reported, because a caller has to know which webhook URLs just died.
        changes: [{ op: "deleteArtifact", kind: "Routine", slug: name }],
      });
    } catch (e) {
      if (e instanceof SoulWriteError) return mapSoulWriteError(e);
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    try {
      await ctx.onRoutinesChanged?.();
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    return ok({ name, deleted: true, triggersDeleted: triggerSlugs });
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

/** Fresh stateless clock Tool shares the turn-context format to avoid conflicting time facts. */

export const PLATFORM_TOOLS: ParkableApiToolDefinition<PlatformToolContext>[] = [
  skillTool,
  delegateToAgentTool,
  spawnSubagentTool,
  triggerRoutineTool,
  routineForgeTool,
  routinePickerTool,
  routineGetTool,
  routineDeleteTool,
  guardrailForgeTool,
  soulRepoPushTool,
  // Context-free Tools the durable runtime also hosts; `PlatformRuntimeContext` is a subset of
  // `PlatformToolContext`, so the control plane registers the same definitions.
  ...(PLATFORM_RUNTIME_TOOLS as ApiToolDefinition<PlatformToolContext>[]),
];
