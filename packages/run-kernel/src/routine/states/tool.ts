import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { routineEffectId } from "../scheduling";
import { RoutineStepError } from "./step";

/**
 * Tool planning is side-effect-free and derives arguments, `idempotencyKey`, and `effectId` from
 * the Run and durable occurrence so retries, resumes, and replay converge on the same effect.
 */

export interface ToolStateRef {
  readonly name: string;
  readonly version: string;
  readonly id?: string;
}

export interface ToolDispatchContext {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
}

export interface ToolDispatchPlan {
  readonly toolRef: ToolStateRef;
  readonly action: string;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly arguments: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly effectId: string;
  /** Position of the effect within its Run, so the ledger can reject a second one for the State. */
  readonly logicalEffectOrdinal: number;
}

function authored(state: CompiledState): Record<string, unknown> {
  return state.definition as unknown as Record<string, unknown>;
}

/** Missing authored Tool reference or action is refused by State name, never invented. */
function toolRefOf(state: CompiledState): { ref: ToolStateRef; action: string } {
  const value = authored(state).toolRef;
  const action = authored(state).action;
  if (typeof value !== "object" || value === null || typeof action !== "string") {
    throw new RoutineStepError("missing_tool_ref", state.name);
  }
  const { name, version, id } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new RoutineStepError("missing_tool_ref", state.name);
  }
  return {
    ref: { name, version, ...(typeof id === "string" ? { id } : {}) },
    action,
  };
}

function optionalString(state: CompiledState, key: string): string | undefined {
  const value = authored(state)[key];
  return typeof value === "string" ? value : undefined;
}

export function routineIdempotencyKey(runId: string, stateKey: string): string {
  return `routine:${runId}:${stateKey}`;
}

export function planToolDispatch(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>,
  ctx: ToolDispatchContext
): ToolDispatchPlan {
  if (state.type !== "tool") throw new RoutineStepError("state_cannot_progress", state.name);
  const { ref, action } = toolRefOf(state);
  const destination = optionalString(state, "destination");
  const credentialRef = optionalString(state, "credentialRef");

  return {
    toolRef: ref,
    action,
    ...(destination === undefined ? {} : { destination }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    arguments: resolveRoutineStateInput(state, scope),
    idempotencyKey: routineIdempotencyKey(ctx.runId, ctx.stateKey),
    effectId: routineEffectId(ctx.runId, ctx.stateKey),
    logicalEffectOrdinal: state.index,
  };
}
