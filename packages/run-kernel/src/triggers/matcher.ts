import type { event as eventSchema } from "@tulipfarm/schema";
import {
  type CompiledExpression,
  compileExpression,
  evaluateCondition,
} from "../routine/expressions";

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
  /**
   * Authored narrowing expression, evaluated against `{ trigger: { payload, type, provider } }`.
   * A Trigger whose expression does not compile never reaches here — the resolver drops it.
   */
  readonly filter?: string;
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

/**
 * The only scope an authored Trigger filter can read. Deliberately narrower than a Routine's:
 * a Trigger is matched before any Run exists, so there is no `input` or `states` to reference.
 */
export const TRIGGER_FILTER_ROOTS = ["trigger"] as const;

const filterCache = new Map<string, CompiledExpression>();

/** Compile an authored Trigger filter. Throws `ExpressionError` so a resolver can fail closed. */
export function compileTriggerFilter(source: string): CompiledExpression {
  const cached = filterCache.get(source);
  if (cached !== undefined) return cached;
  const compiled = compileExpression(source, { roots: TRIGGER_FILTER_ROOTS });
  filterCache.set(source, compiled);
  return compiled;
}

function triggerFilterScope(
  envelope: eventSchema.EventEnvelope<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return {
    trigger: {
      payload: envelope.data,
      type: envelope.type,
      version: envelope.version,
      provider: envelope.source.provider,
    },
  };
}

function passesFilter(
  trigger: RegisteredTrigger,
  envelope: eventSchema.EventEnvelope<Record<string, unknown>>
): boolean {
  if (trigger.filter === undefined) return true;
  try {
    return evaluateCondition(compileTriggerFilter(trigger.filter), triggerFilterScope(envelope));
  } catch {
    // A filter that cannot be evaluated must never widen the match. Compilation faults are caught
    // at resolve time; this guards only evaluation faults, which depend on the event's own shape.
    return false;
  }
}

/**
 * Whether an event clears a Trigger's authored content gate — its `filter` and `match`.
 *
 * Identity is deliberately not re-checked. A webhook Trigger is selected by its own URL rather
 * than by matching, so the route has already established *which* Trigger this is; what it has not
 * established is whether the author wanted *this* event. Without this the authored `filter` on a
 * webhook Trigger is accepted at authoring time and then never consulted, which reads to the
 * author as a filter that silently passes everything.
 */
export function passesTriggerContentGate(
  trigger: RegisteredTrigger,
  envelope: eventSchema.EventEnvelope<Record<string, unknown>>
): boolean {
  if (!passesFilter(trigger, envelope)) return false;
  return (trigger.match ?? []).every(
    (predicate) => dotPath(envelope.data, predicate.path) === predicate.equals
  );
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
  return passesTriggerContentGate(trigger, envelope);
}

function specificity(trigger: RegisteredTrigger): number {
  return (
    (trigger.match?.length ?? 0) +
    (trigger.provider === undefined ? 0 : 1) +
    (trigger.formRef === undefined ? 0 : 1) +
    (trigger.filter === undefined ? 0 : 1)
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
