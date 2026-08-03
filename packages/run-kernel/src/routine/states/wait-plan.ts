import type { PersistedWaitKind, RegisterWaitInput, WaitAggregation } from "../../waits";
import type { CompiledState } from "../compiler";
import { RoutineStepError, type StepOutcome, stateOutcome } from "./step";

/**
 * Shared plumbing for the States that hand control to someone outside the Run — an approver, an
 * assignee, a form submitter, a child Run. Each one becomes a *durable* wait: bounded by an
 * authored deadline, addressed to explicit principals, and resolved through exactly one of the
 * paths below. Nothing here performs I/O; the caller registers the returned wait and persists the
 * decision, so a crash between planning and registering replays to the same plan.
 */

export interface StateWaitContext {
  readonly businessId: string;
  readonly runId: string;
  readonly waitId: string;
  /** Durable State occurrence key; it may differ from the authored name inside a fan-out. */
  readonly stateKey: string;
  /** ISO-8601 instant the wait is opened at. */
  readonly now: string;
}

export interface StateWaitOptions {
  readonly kind: PersistedWaitKind;
  /** Canonical `kind:id` principals allowed to signal. Empty is a denial, never "anyone". */
  readonly principals: readonly string[];
  readonly aggregation?: WaitAggregation;
  readonly expectedSignals?: number;
  readonly quorum?: number | null;
}

/** A State's own output schema when it declared one, else a stable per-wait reference. */
export function waitSchemaRef(state: CompiledState, kind: PersistedWaitKind): string {
  return state.outputSchemaRef ?? `wait:${kind}:${state.name}`;
}

function deadlineMsOf(state: CompiledState): number {
  const value = state.definition.deadlineMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RoutineStepError("deadline_not_bounded", state.name);
  }
  return value;
}

export function planStateWait(
  state: CompiledState,
  ctx: StateWaitContext,
  options: StateWaitOptions
): RegisterWaitInput {
  if (options.principals.length === 0) {
    throw new RoutineStepError("principals_not_declared", state.name);
  }
  const deadlineMs = deadlineMsOf(state);
  return {
    id: ctx.waitId,
    businessId: ctx.businessId,
    runId: ctx.runId,
    stateKey: ctx.stateKey,
    kind: options.kind,
    aggregation: options.aggregation ?? "first",
    schemaRef: waitSchemaRef(state, options.kind),
    allowedPrincipals: options.principals,
    expectedSignals: options.expectedSignals ?? 1,
    quorum: options.quorum ?? null,
    deadlineAt: new Date(Date.parse(ctx.now) + deadlineMs).toISOString(),
    createdAt: ctx.now,
  };
}

/** How a State that waited on someone resolves. Every path is explicit — none is a silent skip. */
export type StateResumeDecision =
  | { readonly kind: "continue"; readonly outcome: StepOutcome }
  | { readonly kind: "handled"; readonly errorRef: string; readonly outcome: StepOutcome }
  | { readonly kind: "failed"; readonly errorRef: string }
  | { readonly kind: "attention"; readonly errorRef: string };

export function continueState(state: CompiledState): StateResumeDecision {
  return { kind: "continue", outcome: stateOutcome(state) };
}

/**
 * Route a named failure. An authored `onError` handler claims it; otherwise the State takes the
 * declared fallback — `failed` for a decided negative outcome, `attention` for one nobody
 * decided (an expiry, an unconfirmed compensation), which a human must resolve.
 */
export function resolveErrorPath(
  state: CompiledState,
  errorRef: string,
  fallback: "failed" | "attention"
): StateResumeDecision {
  const handler = state.onError.find((candidate) => candidate.errorRef === errorRef);
  if (handler !== undefined) {
    if (handler.transition !== null) {
      return {
        kind: "handled",
        errorRef,
        outcome: { kind: "transition", target: handler.transition },
      };
    }
    if (handler.end) return { kind: "handled", errorRef, outcome: { kind: "end" } };
  }
  return fallback === "failed" ? { kind: "failed", errorRef } : { kind: "attention", errorRef };
}

/** Read a required list of authored role names off a State. */
export function requireRoles(state: CompiledState, key: string): readonly string[] {
  const value = state.definition[key];
  const roles = Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];
  if (roles.length === 0) throw new RoutineStepError("principals_not_declared", state.name);
  return roles;
}
