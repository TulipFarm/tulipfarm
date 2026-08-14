import type { event as eventSchema } from "@tulipfarm/schema";

/**
 * Trigger matching requires exact type, version, and predicates; equally specific matches are
 * `ambiguous`, no matches are `no_match`, and neither starts a Run.
 */

export type TriggerLifecycle = "draft" | "published" | "retired";

export type TriggerKind =
  | "cron"
  | "datetime"
  | "form"
  | "integration_event"
  | "internal_api"
  | "internal_event"
  | "interval"
  | "manual"
  | "webhook";

export interface TriggerPredicate {
  readonly path: string;
  readonly equals: unknown;
}

export interface RegisteredTrigger {
  readonly triggerSlug: string;
  readonly authoredVersion: number;
  readonly lifecycle: TriggerLifecycle;
  readonly type: TriggerKind;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly provider?: string;
  readonly formRef?: string;
  readonly match?: readonly TriggerPredicate[];
  readonly routineRef: { readonly name: string; readonly version: string };
  readonly backgroundIdentity: {
    readonly principalKind: string;
    readonly principalId: string;
  };
  readonly inputMappings?: Readonly<Record<string, string>>;
  readonly requireVerified?: boolean;
  /** When set, intake runs as a constrained read-only Agent Run instead of the Routine. */
  readonly semanticIntakeAgent?: { readonly name: string; readonly version: string };
}

export type TriggerMatch =
  | { readonly kind: "matched"; readonly trigger: RegisteredTrigger }
  | { readonly kind: "no_match" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

export function dotPath(data: unknown, path: string): unknown {
  let cursor = data;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function satisfies(
  trigger: RegisteredTrigger,
  envelope: eventSchema.EventEnvelope<Record<string, unknown>>
): boolean {
  if (trigger.lifecycle !== "published") return false;
  if (trigger.eventType !== envelope.type) return false;
  if (trigger.eventVersion !== envelope.version) return false;
  if (trigger.provider !== undefined && trigger.provider !== envelope.source.provider) return false;
  if (trigger.formRef !== undefined && dotPath(envelope.data, "formRef") !== trigger.formRef) {
    return false;
  }
  return (trigger.match ?? []).every(
    (predicate) => dotPath(envelope.data, predicate.path) === predicate.equals
  );
}

function specificity(trigger: RegisteredTrigger): number {
  return (
    (trigger.match?.length ?? 0) +
    (trigger.provider === undefined ? 0 : 1) +
    (trigger.formRef === undefined ? 0 : 1)
  );
}

export function matchTrigger(
  triggers: readonly RegisteredTrigger[],
  envelope: eventSchema.EventEnvelope<Record<string, unknown>>
): TriggerMatch {
  const candidates = triggers.filter((trigger) => satisfies(trigger, envelope));
  if (candidates.length === 0) return { kind: "no_match" };

  const best = Math.max(...candidates.map(specificity));
  const winners = candidates.filter((trigger) => specificity(trigger) === best);
  const first = winners[0];
  if (winners.length === 1 && first !== undefined) return { kind: "matched", trigger: first };

  return {
    kind: "ambiguous",
    candidates: winners.map((trigger) => trigger.triggerSlug).sort(),
  };
}
