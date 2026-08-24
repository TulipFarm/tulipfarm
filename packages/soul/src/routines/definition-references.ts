import { ROUTINE_STATE_REF_EDGES } from "../refs";

/**
 * Definitions a canonical Routine's States name, and whether the Soul actually has them.
 *
 * A Routine State reference (`agentRef`, `toolRef`, `routineRef`, `formRef`) is only meaningful
 * against the Soul, and nothing in document validation can see that far. Left unchecked it reaches
 * the Soul writer's semantic pass, which answers with a payload-safe `UNRESOLVED_REF` pointer and
 * no way to tell "you named an Agent that was never created" apart from "you named something that
 * can never be named here" — so an authoring Agent retries variations until its repair budget dies.
 *
 * Checking here turns both cases into one instruction the caller can act on: create the
 * prerequisite first, or stop referencing something a Routine cannot reference.
 */

interface RoutineStateReference {
  /** Target definition kind, e.g. `Agent`. */
  readonly kind: string;
  /** The referenced definition's authored name. */
  readonly name: string;
  /** The State that carries the reference. */
  readonly state: string;
}

function referenceOf(state: unknown): RoutineStateReference | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const { type, name } = state as Record<string, unknown>;
  if (typeof type !== "string") return undefined;
  const edge = ROUTINE_STATE_REF_EDGES[type];
  if (edge === undefined) return undefined;
  const [field, kind] = edge;
  const ref = (state as Record<string, unknown>)[field];
  if (ref === null || typeof ref !== "object") return undefined;
  const referenced = (ref as { name?: unknown }).name;
  if (typeof referenced !== "string" || referenced.length === 0) return undefined;
  return { kind, name: referenced, state: typeof name === "string" ? name : type };
}

/** Every definition reference the Routine's States name, in State order. */
export function routineDefinitionReferences(spec: unknown): RoutineStateReference[] {
  const states = (spec as { states?: unknown } | undefined)?.states;
  if (!Array.isArray(states)) return [];
  const references: RoutineStateReference[] = [];
  for (const state of states) {
    const reference = referenceOf(state);
    if (reference !== undefined) references.push(reference);
  }
  return references;
}

export interface RoutineDefinitionRefusal {
  readonly code: "validation_error";
  readonly message: string;
}

/** What the Soul already has, for the reference kinds a Routine can name. */
export interface KnownSoulDefinitions {
  readonly agents?: ReadonlyMap<string, unknown>;
  readonly routines?: ReadonlyMap<string, unknown>;
  /**
   * Names of Tools the running instance hosts. These are *not* Soul `ToolContract` definitions and
   * a Routine `tool` State cannot reach them, so naming one is always a mistake worth catching by
   * name rather than as an unresolved reference.
   */
  readonly runtimeToolNames?: ReadonlySet<string>;
}

function inventory(known: ReadonlyMap<string, unknown> | undefined, label: string): string {
  const names = known === undefined ? [] : [...known.keys()].sort();
  return names.length === 0
    ? `The Soul has no ${label} yet.`
    : `Existing ${label}: ${names.join(", ")}.`;
}

function agentIssues(
  references: readonly RoutineStateReference[],
  agents: ReadonlyMap<string, unknown> | undefined
): string[] {
  const missing = [
    ...new Set(
      references.filter((r) => r.kind === "Agent" && !agents?.has(r.name)).map((r) => r.name)
    ),
  ];
  if (missing.length === 0) return [];
  return [
    `No Agent named ${missing.join(", ")} exists in the Soul, so this Routine cannot be committed. ` +
      `Create the Agent first with agent_create, then forge the Routine. ${inventory(agents, "Agents")}`,
  ];
}

function routineIssues(
  references: readonly RoutineStateReference[],
  routines: ReadonlyMap<string, unknown> | undefined
): string[] {
  const missing = [
    ...new Set(
      references.filter((r) => r.kind === "Routine" && !routines?.has(r.name)).map((r) => r.name)
    ),
  ];
  if (missing.length === 0) return [];
  return [
    `No Routine named ${missing.join(", ")} exists in the Soul, so this child_routine State cannot ` +
      `be committed. Forge the child Routine first. ${inventory(routines, "Routines")}`,
  ];
}

function toolIssues(
  references: readonly RoutineStateReference[],
  runtimeToolNames: ReadonlySet<string> | undefined
): string[] {
  if (runtimeToolNames === undefined) return [];
  const hosted = [
    ...new Set(
      references
        .filter((r) => r.kind === "ToolContract" && runtimeToolNames.has(r.name))
        .map((r) => r.name)
    ),
  ];
  if (hosted.length === 0) return [];
  return [
    `${hosted.join(", ")} is a Tool this instance hosts for Agents, not a Soul ToolContract, and a ` +
      `Routine "tool" State can only name a ToolContract. Use an "agent" State whose agentRef ` +
      `points at an Agent allowed to call it, and put the work in that Agent's instructions.`,
  ];
}

/**
 * Why the Routine must not be committed, or `undefined` when every State reference is reachable.
 *
 * Unknown kinds and unverifiable references pass: this rejects what it can prove wrong, and leaves
 * everything else to the Soul writer's semantic pass, which sees the whole tree.
 */
export function unresolvedRoutineDefinitions(
  spec: unknown,
  known: KnownSoulDefinitions
): RoutineDefinitionRefusal | undefined {
  const references = routineDefinitionReferences(spec);
  if (references.length === 0) return undefined;
  const issues = [
    ...toolIssues(references, known.runtimeToolNames),
    ...agentIssues(references, known.agents),
    ...routineIssues(references, known.routines),
  ];
  if (issues.length === 0) return undefined;
  return { code: "validation_error", message: issues.join("\n") };
}
