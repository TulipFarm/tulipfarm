import type { CompiledState } from "../compiler";
import { RoutineStepError } from "./step";
import { continueState, resolveErrorPath, type StateResumeDecision } from "./wait-plan";

/** Run kernel names what to compensate; the caller injects the Tool-broker port. */
export interface CompensationRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly targetRef: string;
  readonly forState: string | null;
  readonly effectId: string;
  /** Stable across retries so a replayed compensation never undoes twice. */
  readonly idempotencyKey: string;
}

export type CompensationStatus = "compensated" | "failed" | "ambiguous";

export interface CompensationPort {
  compensate(request: CompensationRequest): Promise<{ readonly status: CompensationStatus }>;
}

export interface CompensationContext {
  readonly businessId: string;
  readonly runId: string;
  readonly effectId: string;
}

export function planCompensation(
  state: CompiledState,
  ctx: CompensationContext
): CompensationRequest {
  if (state.definition.type !== "compensate") {
    throw new RoutineStepError("missing_target_ref", state.name);
  }
  const targetRef = state.definition.targetRef;
  if (typeof targetRef !== "string" || targetRef.length === 0) {
    throw new RoutineStepError("missing_target_ref", state.name);
  }
  const forState = state.definition.forState;
  return {
    businessId: ctx.businessId,
    runId: ctx.runId,
    stateKey: state.name,
    targetRef,
    forState: typeof forState === "string" ? forState : null,
    effectId: ctx.effectId,
    idempotencyKey: `${ctx.runId}:${state.name}:${ctx.effectId}`,
  };
}

/**
 * Only confirmed compensation continues; failure, ambiguity, or port errors park attention, and
 * port errors are not surfaced because they may contain protected data.
 */
export async function runCompensation(
  state: CompiledState,
  port: CompensationPort,
  request: CompensationRequest
): Promise<StateResumeDecision> {
  let status: CompensationStatus;
  try {
    status = (await port.compensate(request)).status;
  } catch {
    status = "failed";
  }

  if (status === "compensated") return continueState(state);
  if (status === "ambiguous") return resolveErrorPath(state, "compensation_ambiguous", "attention");
  return resolveErrorPath(state, "compensation_failed", "attention");
}
