import { createHash } from "node:crypto";
import type { RoutineDefinition } from "./routine";
import type { TriggerDefinition } from "./trigger";

/**
 * Projecting `Routine.spec.triggers` back into the standalone Trigger shape the runtime consumes.
 *
 * Triggers are authored inside their Routine, because a Trigger names exactly one Routine and
 * cannot outlive it — a separate `triggers/` tree only made it possible for one to be orphaned.
 * The scheduler, the webhook resolver and the invoke route still speak the flat shape, so this is
 * the single seam that translates, rather than teaching each of them about containment.
 */

/**
 * A stable synthetic id for an embedded Trigger.
 *
 * An embedded Trigger authors no `id` of its own — containment plus `name` already identify it.
 * The id must still be stable across publications, because it reaches audit and lineage records
 * that outlive the Routine version that produced them, so derive it from the pair rather than
 * minting a fresh one on every load.
 */
export function embeddedTriggerId(routineId: string, name: string): string {
  const hex = createHash("sha256").update(`trigger:${routineId}:${name}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Every Trigger this Routine owns, in the flat shape the runtime resolvers expect. */
export function routineTriggerDocuments(
  routine: RoutineDefinition
): readonly Readonly<TriggerDefinition>[] {
  const { metadata } = routine;
  return (routine.spec.triggers ?? []).map((trigger) => {
    const { name, ...spec } = trigger;
    return {
      apiVersion: routine.apiVersion,
      kind: "Trigger",
      metadata: {
        id: embeddedTriggerId(metadata.id, name),
        slug: name,
        schemaVersion: metadata.schemaVersion,
        authoredVersion: metadata.authoredVersion,
        lifecycle: metadata.lifecycle,
      },
      spec: {
        ...spec,
        // Containment is the authority for the target, so a synthesized ref can never dangle.
        routineRef: { name: metadata.slug, version: String(metadata.authoredVersion) },
      },
    } as TriggerDefinition;
  });
}
