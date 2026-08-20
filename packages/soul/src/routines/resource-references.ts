/**
 * Resource types a canonical Routine's Record States name, and whether the Soul actually has them.
 *
 * A Routine is validated document-by-document — shape, slug, lifecycle, Trigger back-references —
 * and every one of those checks is internal to the paperwork. A `record_*` State naming a Resource
 * type nobody created passes all of them and then fails, or silently no-ops, on every Run it ever
 * has. The reference is only meaningful against the Soul, so it has to be checked against the Soul.
 */

const RECORD_TOOL_PREFIX = "record_";

function literalResourceType(state: unknown): string | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const { type, toolRef, action, input } = state as Record<string, unknown>;
  if (type !== "tool") return undefined;
  const tool = (toolRef as { name?: unknown } | undefined)?.name ?? action;
  if (typeof tool !== "string" || !tool.startsWith(RECORD_TOOL_PREFIX)) return undefined;
  const referenced = (input as { type?: unknown } | undefined)?.type;
  if (typeof referenced !== "string" || referenced.length === 0) return undefined;
  // Only a literal is a claim about the Soul; an expression resolves per Run and cannot be checked.
  return referenced.includes("$") || referenced.includes("{") ? undefined : referenced;
}

/** Every distinct Resource type the Routine's Record States name literally. */
export function routineResourceTypeReferences(spec: unknown): string[] {
  const states = (spec as { states?: unknown } | undefined)?.states;
  if (!Array.isArray(states)) return [];
  const referenced = new Set<string>();
  for (const state of states) {
    const type = literalResourceType(state);
    if (type !== undefined) referenced.add(type);
  }
  return [...referenced];
}

export interface RoutineResourceRefusal {
  readonly code: "validation_error" | "unavailable";
  readonly message: string;
}

/**
 * Why the Routine must not be committed, or `undefined` when every reference resolves.
 *
 * An absent `known` map is refused rather than waved through: a Routine whose references were never
 * checked is indistinguishable from one whose references are wrong, and only one of those is safe.
 */
export function unresolvedRoutineResourceTypes(
  spec: unknown,
  known: ReadonlyMap<string, unknown> | undefined
): RoutineResourceRefusal | undefined {
  const referenced = routineResourceTypeReferences(spec);
  if (referenced.length === 0) return undefined;
  if (known === undefined)
    return {
      code: "unavailable",
      message: `Resource types are not loaded, so the references to ${referenced.join(", ")} cannot be verified and the Routine was not committed.`,
    };
  const missing = referenced.filter((type) => !known.has(type));
  if (missing.length === 0) return undefined;
  return {
    code: "validation_error",
    message: `No Resource type named ${missing.join(", ")} exists, so every Run of this Routine would fail. Create the Resource type first with create_resource_type, or point the Routine at an existing type.`,
  };
}
