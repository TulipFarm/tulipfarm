import type { CompiledState } from "../compiler";
import { resolveRoutineStateInput } from "../input";
import { routineEffectId } from "../scheduling";
import { RoutineStepError } from "./step";
import { routineIdempotencyKey } from "./tool";

/**
 * Plans an `action` State: one runtime Tool called directly, with no model deciding to call it.
 *
 * A `tool` State dispatches a *ToolContract* pinned in the Soul; an `action` State dispatches a
 * Tool the runtime already hosts (`record_create`, `api_request`, `send_slack_message`, ...),
 * which has no Soul artifact to reference. Both settle through the same effect ledger, so the
 * idempotency key and effect id are derived identically — a retried or replayed Run converges on
 * the one effect rather than sending a second Slack message.
 *
 * Unlike a `tool` State, what the Tool returned becomes the State's output, because an `action` is
 * how a Routine fetches data as well as how it causes something.
 */

export interface ActionDispatchContext {
  readonly runId: string;
  readonly stateKey: string;
}

export interface ActionDispatchPlan {
  readonly action: string;
  readonly arguments: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly effectId: string;
  readonly logicalEffectOrdinal: number;
  /**
   * The authored ceiling this State compiled to, carried so the gate can refuse a Tool above it.
   * The compiler already refused any ceiling that escalates, so this can only narrow.
   */
  readonly permissionCeiling: { readonly maxRiskClass: string };
}

export function planActionDispatch(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>,
  ctx: ActionDispatchContext
): ActionDispatchPlan {
  if (state.type !== "action") throw new RoutineStepError("state_cannot_progress", state.name);
  const action = (state.definition as unknown as Record<string, unknown>).action;
  if (typeof action !== "string" || action === "") {
    throw new RoutineStepError("missing_action_name", state.name);
  }
  return {
    action,
    arguments: resolveRoutineStateInput(state, scope),
    idempotencyKey: routineIdempotencyKey(ctx.runId, ctx.stateKey),
    effectId: routineEffectId(ctx.runId, ctx.stateKey),
    logicalEffectOrdinal: state.index,
    permissionCeiling: { maxRiskClass: state.permissions.maxRiskClass },
  };
}
