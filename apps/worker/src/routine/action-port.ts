import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import {
  type ActionDispatchPlan,
  assertRunActive,
  type ChildLinkAncestry,
  type DurableWaitManager,
} from "@tulipfarm/run-kernel";
import type { RunStore } from "@tulipfarm/storage";

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
  | { readonly kind: "awaiting_approval"; readonly approvalId: string }
  | {
      readonly kind: "awaiting_child";
      readonly childRunId: string;
      readonly waitId: string;
    }
  | { readonly kind: "awaiting_retry"; readonly waitId: string }
  /** A definitive negative an authored `onError` handler may claim by reason code. */
  | { readonly kind: "failed"; readonly reason: string }
  /** Nothing decided the call. The State parks for reconciliation rather than guessing. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RoutineActionRequest {
  readonly businessId: string;
  readonly runId: string;
  /** Durable State occurrence key, so a parked Tool registers its wait against this State. */
  readonly stateKey: string;
  readonly signal?: AbortSignal;
  readonly plan: ActionDispatchPlan;
}

export interface RoutineActionPort {
  execute(request: RoutineActionRequest): Promise<RoutineActionOutcome>;
}

export interface RoutineActionChildren {
  readonly links: Required<Pick<ChildLinkAncestry, "callLink">>;
  readonly runs: Pick<RunStore, "find">;
  readonly waits: Pick<DurableWaitManager, "find">;
}

/**
 * Dispatches through the same port an Agent turn uses, so an `action` State reaches exactly the
 * Tools an Agent could have reached and is gated by exactly the same authority.
 */
export class DispatchRoutineActionPort implements RoutineActionPort {
  constructor(
    private readonly tools: ToolDispatchPort,
    private readonly children: RoutineActionChildren
  ) {}

  async execute(request: RoutineActionRequest): Promise<RoutineActionOutcome> {
    assertRunActive(request.signal);
    const pending = await this.childOutcome(request);
    assertRunActive(request.signal);
    // A terminal child's bound Tool lookup still settles its effect. Its failure must survive
    // that lookup even when the Tool reports success while returning the failed child's summary.
    if (pending !== undefined && pending.kind !== "failed") return pending;
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
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    assertRunActive(request.signal);
    if (pending?.kind === "failed") return pending;

    switch (result.status) {
      case "succeeded": {
        // A fast child may finish before the Tool ever parks. Its Tool-level success is not
        // evidence that the child succeeded: helper Tools also return failed-child summaries.
        const child = await this.childOutcome(request);
        assertRunActive(request.signal);
        return child ?? { kind: "succeeded", output: result.output };
      }
      case "awaiting_approval":
        return { kind: "awaiting_approval", approvalId: result.approvalId };
      case "awaiting_child": {
        const child = await this.childOutcome(request, result);
        assertRunActive(request.signal);
        return (
          child ?? {
            kind: "awaiting_child",
            childRunId: result.childRunId,
            waitId: result.waitId,
          }
        );
      }
      case "awaiting_retry":
        return { kind: "awaiting_retry", waitId: result.waitId };
      case "denied":
        return { kind: "failed", reason: `denied_${result.reason}` };
      case "invalid_arguments":
        return { kind: "failed", reason: `invalid_arguments_${result.reason}` };
      case "failed":
        return { kind: "failed", reason: result.reason };
    }
  }

  private async childOutcome(
    request: RoutineActionRequest,
    expected?: { readonly childRunId: string; readonly waitId: string }
  ): Promise<RoutineActionOutcome | undefined> {
    const link = await this.children.links.callLink(
      request.businessId,
      request.runId,
      request.plan.effectId
    );
    assertRunActive(request.signal);
    if (link === null) {
      return expected === undefined
        ? undefined
        : { kind: "unavailable", reason: "child_link_missing" };
    }
    if (
      link.parentRunId !== request.runId ||
      link.callId !== request.plan.effectId ||
      link.resume === null ||
      link.detachedAt !== null ||
      (expected !== undefined &&
        (link.childRunId !== expected.childRunId || link.resume.waitId !== expected.waitId))
    ) {
      return { kind: "unavailable", reason: "child_link_invalid" };
    }
    const [child, wait] = await Promise.all([
      this.children.runs.find(request.businessId, link.childRunId),
      this.children.waits.find(request.businessId, link.resume.waitId),
    ]);
    assertRunActive(request.signal);
    if (
      child === null ||
      wait === null ||
      wait.runId !== request.runId ||
      wait.stateKey !== request.stateKey ||
      wait.kind !== "child_run"
    ) {
      return { kind: "unavailable", reason: "child_wait_invalid" };
    }
    if (child.status === "failed" || child.status === "cancelled") {
      return { kind: "failed", reason: `child_${child.status}` };
    }
    if (wait.status === "timed_out") return { kind: "failed", reason: "child_expired" };
    if (child.status === "succeeded") return undefined;
    if (child.status === "needs_reconciliation" || child.status === "attention_required") {
      return { kind: "unavailable", reason: `child_${child.status}` };
    }
    return {
      kind: "awaiting_child",
      childRunId: link.childRunId,
      waitId: link.resume.waitId,
    };
  }
}
