import { definitions, SchemaValidationError } from "@tulipfarm/schema";
import { lintRoutine } from "@tulipfarm/soul-doctor";

export interface RoutineForgeValidationInput {
  readonly name: string;
  readonly definition: Record<string, unknown>;
}

export type RoutineForgeValidationResult =
  | {
      readonly ok: true;
      readonly routine: definitions.routine.RoutineDefinition;
      readonly triggers: readonly definitions.trigger.TriggerDefinition[];
    }
  | { readonly ok: false; readonly message: string };

function schemaIssues(label: string, error: unknown): string[] {
  if (error instanceof SchemaValidationError) {
    return error.issues.map((issue) => `${label} ${issue.path || "/"}: ${issue.message}`);
  }
  return [`${label}: could not be validated`];
}

function consistencyIssues(
  name: string,
  routine: definitions.routine.RoutineDefinition | undefined
): string[] {
  const issues: string[] = [];
  if (routine === undefined) return issues;
  if (routine.metadata.slug !== name) {
    issues.push("Routine definition /metadata/slug: must match the Tool name");
  }
  if (routine.metadata.lifecycle !== "published") {
    issues.push("Routine definition /metadata/lifecycle: must be published");
  }

  // A Trigger name is a public address, so two Triggers sharing one inside a single Routine would
  // make delivery depend on array order. Collisions *across* Routines are caught by the caller,
  // which is the only layer that can see the rest of the Soul.
  const seen = new Set<string>();
  (routine.spec.triggers ?? []).forEach((trigger, index) => {
    if (seen.has(trigger.name)) {
      issues.push(`Routine definition /spec/triggers/${index}/name: must be unique`);
    }
    seen.add(trigger.name);
  });
  return issues;
}

/**
 * The Soul Doctor's own lint, run before the write instead of after it.
 *
 * The schema proves the document is well-formed; it does not prove the Routine can run. A dangling
 * transition, an `action` State naming no Tool, or a mapping reading a field an earlier State never
 * publishes all validate cleanly and then park every Run they ever start. Rejecting them here is
 * what keeps the product path from authoring the exact class of defect the Doctor exists to repair.
 */
function lintIssues(routine: definitions.routine.RoutineDefinition | undefined): string[] {
  if (routine === undefined) return [];
  return lintRoutine({ slug: routine.metadata.slug, digest: "authored", definition: routine })
    .filter((found) => found.severity === "broken")
    .map((found) => `Routine definition ${found.at}: ${found.detail}`);
}

export function validateRoutineForgeDefinitions(
  input: RoutineForgeValidationInput
): RoutineForgeValidationResult {
  let routine: definitions.routine.RoutineDefinition | undefined;
  const issues: string[] = [];

  try {
    routine = definitions.routine.validateRoutineDefinition(input.definition).document;
  } catch (error) {
    issues.push(...schemaIssues("Routine definition", error));
  }
  issues.push(...consistencyIssues(input.name, routine));
  issues.push(...lintIssues(routine));

  if (issues.length > 0) {
    return {
      ok: false,
      message: `Canonical definition validation failed:\n- ${issues.join("\n- ")}`,
    };
  }
  if (routine === undefined) {
    return { ok: false, message: "Canonical definition validation failed." };
  }
  return {
    ok: true,
    routine,
    triggers: definitions.routineTriggers.routineTriggerDocuments(routine),
  };
}
