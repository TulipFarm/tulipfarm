import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import type { ActionDispatchPlan } from "@tulipfarm/run-kernel";

/**
 * Runs one runtime Tool for an `action` State, with no model in the loop.
 *
 * This is the deliberate counterpart to {@link ./tool-port.ts}. A `tool` State brokers a
 * ToolContract pinned in the Soul; an `action` State calls a Tool the runtime already
 * hosts — `record_create`, `record_search`, `api_request`, `send_slack_message` — which has no
 * Soul artifact to pin and so can never be reached that way.
 *
 * Authority is not invented here. The dispatch carries no `agentName`, so the control plane
 * derives it from the Run row's own recorded subject: the Routine acts as itself, gated by the
 * caller layers alone. A Routine can therefore do no more than whoever owns it may do.
 */

export type RoutineActionOutcome =
  | { readonly kind: "succeeded"; readonly output: unknown }
  /** A definitive negative an authored `onError` handler may claim by reason code. */
  | { readonly kind: "failed"; readonly reason: string }
  /** Nothing decided the call. The State parks for reconciliation rather than guessing. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RoutineActionRequest {
  readonly businessId: string;
  readonly runId: string;
  /** Durable State occurrence key, so a parked Tool registers its wait against this State. */
  readonly stateKey: string;
  readonly plan: ActionDispatchPlan;
}

export interface RoutineActionPort {
  execute(request: RoutineActionRequest): Promise<RoutineActionOutcome>;
}

/**
 * Dispatches through the same port an Agent turn uses, so an `action` State reaches exactly the
 * Tools an Agent could have reached and is gated by exactly the same authority.
 */
export class DispatchRoutineActionPort implements RoutineActionPort {
  constructor(private readonly tools: ToolDispatchPort) {}

  async execute(request: RoutineActionRequest): Promise<RoutineActionOutcome> {
    const { plan } = request;
    const result = await this.tools.dispatch({
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateKey,
      // Derived from the Run and State occurrence, so a replayed State proposes the same call.
      callId: plan.effectId,
      name: plan.action,
      arguments: plan.arguments,
      permissionCeiling: plan.permissionCeiling,
    });

    switch (result.status) {
      case "succeeded":
        // A confirmed-effect replay reports success but hands back a marker, because the ledger
        // records that the call happened and not what it answered. An `action` State publishes its
        // output to later States, so accepting that marker would quietly feed them the wrong data.
        // Parking is the honest answer: the effect stands, and reconciliation decides the rest.
        if (result.replayed === true) {
          return { kind: "unavailable", reason: "replayed_without_output" };
        }
        return { kind: "succeeded", output: result.output };
      case "denied":
        return { kind: "failed", reason: `denied_${result.reason}` };
      case "invalid_arguments":
        return { kind: "failed", reason: `invalid_arguments_${result.reason}` };
      case "failed":
        return { kind: "failed", reason: result.reason };
      default:
        // `awaiting_approval` and `awaiting_child` mean the call is live but unfinished, and a
        // Routine `action` composes neither yet. Parking is the only honest answer: guessing
        // either way would strand or double-run an effect that already reached the provider.
        return { kind: "unavailable", reason: result.status };
    }
  }
}
