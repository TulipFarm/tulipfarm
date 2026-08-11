import type { CompiledState } from "../compiler";
import { RoutineStepError } from "./step";
import { continueState, resolveErrorPath, type StateResumeDecision } from "./wait-plan";

/**
 * Compensation crosses a package boundary: the Tool broker owns effects, and the Run kernel may
 * not import it (`docs/architecture/dependency-rules.md`). A `compensate` State therefore names
 * *what* to undo and the caller injects a port that knows *how*.
 */
export interface CompensationRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  /** The reversing operation the State declared. */
  readonly targetRef: string;
  /** The State whose effect is being undone, when the graph named one. */
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
 * Run the compensation. Only a *confirmed* compensation lets the Run continue: a failure, an
 * ambiguous result, and a port that threw all park the Run for attention, because an effect that
 * may still exist must never be recorded as undone. The port's error is never surfaced in the
 * decision — it may carry Secret or protected values.
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
