import type { event as eventSchema } from "@tulipfarm/schema";
import { matchTrigger, type RegisteredTrigger } from "./matcher";
import { buildInvocation, type RunInvocation, TriggerBindError } from "./transform";

/**
 * The one path from a canonical event to a Routine Run.
 *
 * Every event-borne Trigger family — `webhook`, `integration_event`, `internal_event`, `form` —
 * arrives here, so matching, binding and identity are decided once rather than per call site.
 * Schedule and `manual` Triggers do not: they name their Routine directly and never match.
 */

export interface EventTriggerDispatchDeps {
  /** Published Triggers that can consume an event, read from the verified active bundle. */
  listTriggers(businessId: string): Promise<readonly RegisteredTrigger[]>;
  startRun(invocation: RunInvocation): Promise<{ runId: string; outcome: "started" | "duplicate" }>;
}

export type EventTriggerDispatch =
  | { readonly kind: "no_match" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | {
      readonly kind: "rejected";
      readonly triggerSlug: string;
      readonly code: string;
    }
  | {
      readonly kind: "started";
      readonly triggerSlug: string;
      readonly runId: string;
      readonly outcome: "started" | "duplicate";
    };

/**
 * Bind one event to at most one Trigger and start its Run.
 *
 * Authoring faults (no match, an ambiguous pair, an unresolvable input mapping) are returned, not
 * thrown: the event was accepted and redelivering it would never bind any better. Infrastructure
 * faults from `listTriggers` or `startRun` propagate, so an at-least-once caller retries them.
 */
export async function dispatchEventTrigger(
  envelope: eventSchema.EventEnvelope<Record<string, unknown>>,
  deps: EventTriggerDispatchDeps
): Promise<EventTriggerDispatch> {
  const triggers = await deps.listTriggers(envelope.businessId);
  const match = matchTrigger(triggers, envelope);
  if (match.kind === "no_match") return { kind: "no_match" };
  if (match.kind === "ambiguous") return { kind: "ambiguous", candidates: match.candidates };

  let invocation: RunInvocation;
  try {
    invocation = buildInvocation(match.trigger, envelope);
  } catch (error) {
    if (error instanceof TriggerBindError) {
      return { kind: "rejected", triggerSlug: match.trigger.triggerSlug, code: error.code };
    }
    throw error;
  }

  const { runId, outcome } = await deps.startRun(invocation);
  return { kind: "started", triggerSlug: match.trigger.triggerSlug, runId, outcome };
}
