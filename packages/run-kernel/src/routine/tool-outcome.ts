import type { CompiledState } from "./compiler";
import { type StepOutcome, stateOutcome } from "./states/step";
import { resolveErrorPath } from "./states/wait-plan";

export type RoutineToolExecutionOutcome =
  | { readonly kind: "succeeded"; readonly output: unknown }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "awaiting_approval"; readonly reason: string; readonly approvalId: string }
  | {
      readonly kind: "waiting";
      readonly reason: string;
      readonly effectId?: string;
      readonly attempt?: number;
      readonly notBefore?: string;
      readonly delayMs?: number;
      readonly waitId?: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RoutineToolOutcomeActions<T> {
  complete(output: unknown): void;
  awaitApproval(approvalId: string): Promise<T>;
  wait(reason: string): Promise<T>;
  reconcile(evidenceRef: string): Promise<T>;
  fail(code: string): T;
}

/**
 * Applies one Tool result to the Routine state machine.
 *
 * The Broker owns whether an effect is safe to replay. The kernel owns how that verdict changes
 * the State, so Worker and Eval cannot drift on approvals, retries, failures, or reconciliation.
 */
export async function applyRoutineToolStateOutcome<T>(
  state: CompiledState,
  result: RoutineToolExecutionOutcome,
  actions: RoutineToolOutcomeActions<T>,
  options: { readonly settledReplay?: boolean } = {}
): Promise<StepOutcome | T> {
  if (result.kind === "succeeded") {
    actions.complete(result.output);
    return stateOutcome(state);
  }
  if (options.settledReplay === true) {
    return actions.reconcile("routine:settled_tool_evidence_invalid");
  }
  if (result.kind === "awaiting_approval") {
    return actions.awaitApproval(result.approvalId);
  }
  if (result.kind === "waiting") {
    return actions.wait(result.reason);
  }
  if (result.kind !== "failed") {
    return actions.reconcile(`routine:${result.reason}`);
  }

  const code = `tool_${result.reason}`;
  const decision = resolveErrorPath(state, code, "failed");
  if (decision.kind === "handled") return decision.outcome;
  if (decision.kind === "failed") return actions.fail(code);
  return actions.reconcile(`routine:${code}`);
}
