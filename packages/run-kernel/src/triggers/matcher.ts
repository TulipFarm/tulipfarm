import type { event as eventSchema } from "@tulipfarm/schema";

/**
 * Deterministic Trigger matching.
 *
 * Every intake class — integration event, form submission, manual invocation, internal API call,
 * internal domain event — arrives as one canonical `EventEnvelope` and is matched here against
 * the published Triggers. Matching never guesses: a Trigger matches only on exact type, exact
 * event version, and every predicate it declared. When two Triggers are equally specific the
 * result is `ambiguous` and no Run is created, and when nothing matches the result is `no_match`.
 * Both are safe outcomes the caller records; neither starts work.
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

/** One equality predicate against a dot-path in the event's `data`. */
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
  /** `form` Triggers only: the Form this Trigger owns submissions for. */
  readonly formRef?: string;
  readonly match?: readonly TriggerPredicate[];
  readonly routineRef: { readonly name: string; readonly version: string };
  readonly backgroundIdentity: {
    readonly principalKind: string;
    readonly principalId: string;
  };
  /** Authored event-path → Routine-input mappings. Nothing else reaches the Run. */
  readonly inputMappings?: Readonly<Record<string, string>>;
  /** Reject an event that did not pass provider verification. */
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

/** Specificity is the count of authored constraints; the strictly highest one wins. */
function specificity(trigger: RegisteredTrigger): number {
  return (
    (trigger.match?.length ?? 0) +
    (trigger.provider === undefined ? 0 : 1) +
    (trigger.formRef === undefined ? 0 : 1)
  );
}

/** Resolve the single Trigger that owns this event, or say plainly that none does. */
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
