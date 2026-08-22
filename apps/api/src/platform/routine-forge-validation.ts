import { definitions, SchemaValidationError } from "@tulipfarm/schema";

export interface RoutineForgeValidationInput {
  readonly name: string;
  readonly definition: Record<string, unknown>;
  readonly triggers: readonly Record<string, unknown>[];
}

export type RoutineForgeValidationResult =
  | {
      readonly ok: true;
      readonly routine: definitions.routine.RoutineDefinition;
      readonly triggers: readonly definitions.trigger.TriggerDefinition[];
    }
  | { readonly ok: false; readonly message: string };

interface IndexedTrigger {
  readonly index: number;
  readonly document: definitions.trigger.TriggerDefinition;
}

function schemaIssues(label: string, error: unknown): string[] {
  if (error instanceof SchemaValidationError) {
    return error.issues.map((issue) => `${label} ${issue.path || "/"}: ${issue.message}`);
  }
  return [`${label}: could not be validated`];
}

function consistencyIssues(
  name: string,
  routine: definitions.routine.RoutineDefinition | undefined,
  triggers: readonly IndexedTrigger[]
): string[] {
  const issues: string[] = [];
  if (routine?.metadata.slug !== undefined && routine.metadata.slug !== name) {
    issues.push("Routine definition /metadata/slug: must match the Tool name");
  }
  if (routine?.metadata.lifecycle !== undefined && routine.metadata.lifecycle !== "published") {
    issues.push("Routine definition /metadata/lifecycle: must be published");
  }

  const slugs = new Set<string>();
  for (const trigger of triggers) {
    const { document, index } = trigger;
    if (slugs.has(document.metadata.slug)) {
      issues.push(`Trigger triggers[${index}] /metadata/slug: must be unique`);
    }
    slugs.add(document.metadata.slug);
    if (document.metadata.lifecycle !== "published") {
      issues.push(`Trigger triggers[${index}] /metadata/lifecycle: must be published`);
    }
    if (document.spec.routineRef.name !== name) {
      issues.push(`Trigger triggers[${index}] /spec/routineRef/name: must match the Tool name`);
    }
    if (
      routine !== undefined &&
      document.spec.routineRef.version !== String(routine.metadata.authoredVersion)
    ) {
      issues.push(
        `Trigger triggers[${index}] /spec/routineRef/version: must match the Routine authored version`
      );
    }
  }
  return issues;
}

export function validateRoutineForgeDefinitions(
  input: RoutineForgeValidationInput
): RoutineForgeValidationResult {
  let routine: definitions.routine.RoutineDefinition | undefined;
  const triggers: IndexedTrigger[] = [];
  const issues: string[] = [];

  try {
    routine = definitions.routine.validateRoutineDefinition(input.definition).document;
  } catch (error) {
    issues.push(...schemaIssues("Routine definition", error));
  }
  for (const [index, trigger] of input.triggers.entries()) {
    try {
      triggers.push({
        index,
        document: definitions.trigger.validateTriggerDefinition(trigger).document,
      });
    } catch (error) {
      issues.push(...schemaIssues(`Trigger triggers[${index}]`, error));
    }
  }
  issues.push(...consistencyIssues(input.name, routine, triggers));

  if (issues.length > 0) {
    return {
      ok: false,
      message: `Canonical definition validation failed:\n- ${issues.join("\n- ")}`,
    };
  }
  if (routine === undefined || triggers.length !== input.triggers.length) {
    return { ok: false, message: "Canonical definition validation failed." };
  }
  return { ok: true, routine, triggers: triggers.map((trigger) => trigger.document) };
}
