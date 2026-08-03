import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { routineEffectId } from "../scheduling";
import { RoutineStepError } from "./step";

/**
 * Planning for a `tool` State. This decides *what* would be dispatched and never dispatches it:
 * the Tool Broker owns authorization, the effect ledger owns the reservation, and an adapter owns
 * the call. Keeping the plan here — rather than in whichever process happens to hold a broker —
 * is what lets a replay reach byte-identical arguments, the same idempotency key, and the same
 * effect id as the attempt it is replaying.
 *
 * The two derived identities carry the replay guarantee:
 *
 * - `idempotencyKey` is derived from the Run and the durable State occurrence, so a retried
 *   attempt, a resumed Run, and a re-executed fan-out unit all converge on the effect already
 *   reserved instead of writing a second one.
 * - `effectId` is derived from the same pair, so a worker that died between reserving an effect
 *   and recording that it did finds its own reservation rather than opening another.
 */

export interface ToolStateRef {
  readonly name: string;
  readonly version: string;
  readonly id?: string;
}

export interface ToolDispatchContext {
  readonly businessId: string;
  readonly runId: string;
  /** Durable State occurrence key — the authored name outside a fan-out, the occurrence inside. */
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

/**
 * The authored Tool reference and action. Both are required by the Routine schema; reading them
 * defensively means a State that reached here without them is refused by name rather than
 * dispatched against a reference this code invented.
 */
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

/** Deterministic idempotency key for one Tool State occurrence in one Run. */
export function routineIdempotencyKey(runId: string, stateKey: string): string {
  return `routine:${runId}:${stateKey}`;
}

/** Plan the dispatch a `tool` State describes, with its arguments resolved from the Context. */
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
