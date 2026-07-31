import type { AgentLoopInput, AgentLoopOutcome } from "@tulipfarm/agent-runtime";
import { assertStateTransition, type StateStatus } from "@tulipfarm/run-kernel";

/**
 * Agent State execution (SPEC §10). Composition only: the bounded loop lives in
 * `@tulipfarm/agent-runtime` and the state machine in `@tulipfarm/run-kernel`; this file maps one
 * to the other so an Agent State can only end in a status the kernel allows, and an Approval parks
 * the State on a durable wait instead of blocking a worker.
 */

export interface AgentStateRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly from: StateStatus;
}

export interface StateTransitionPort {
  transition(input: {
    businessId: string;
    runId: string;
    stateKey: string;
    from: StateStatus;
    to: StateStatus;
    reason?: string;
  }): Promise<void>;
}

export interface ApprovalWaitPort {
  register(input: {
    businessId: string;
    runId: string;
    stateKey: string;
    approvalId: string;
    callId: string;
  }): Promise<{ waitId: string }>;
}

export interface AgentLoopRunner {
  run(input: AgentLoopInput): Promise<AgentLoopOutcome>;
}

export interface AgentStateRunnerOptions {
  readonly loop: AgentLoopRunner;
  readonly transitions: StateTransitionPort;
  readonly waits: ApprovalWaitPort;
}

export type AgentStateResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "waiting"; readonly waitId: string; readonly approvalId: string }
  | { readonly status: "cancelled" }
  | { readonly status: "needs_reconciliation" };

export class AgentStateRunner {
  constructor(private readonly options: AgentStateRunnerOptions) {}

  /**
   * Runs one Agent State over an already-resolved loop input.
   *
   * The input arrives built rather than being fetched here: the caller resolved the Context to
   * announce what the model was given, and resolving it a second time would risk running the loop
   * over a bundle nobody published evidence for.
   */
  async execute(request: AgentStateRequest, input: AgentLoopInput): Promise<AgentStateResult> {
    // Fail before any model or Tool work if the State cannot legally start.
    assertStateTransition(request.from, "running");
    await this.move(request, request.from, "running");

    let outcome: AgentLoopOutcome;
    try {
      outcome = await this.options.loop.run(input);
    } catch {
      // Effects may or may not have landed; reconciliation decides, not the worker.
      await this.move(request, "running", "needs_reconciliation", "agent_loop_error");
      return { status: "needs_reconciliation" };
    }

    switch (outcome.status) {
      case "completed":
        await this.move(request, "running", "succeeded");
        return { status: "succeeded", output: outcome.output };

      case "failed":
        await this.move(request, "running", "failed", outcome.reason);
        return { status: "failed", reason: outcome.reason };

      case "awaiting_approval": {
        const { waitId } = await this.options.waits.register({
          businessId: request.businessId,
          runId: request.runId,
          stateKey: request.stateKey,
          approvalId: outcome.approvalId,
          callId: outcome.callId,
        });
        await this.move(request, "running", "waiting", "approval_required");
        return { status: "waiting", waitId, approvalId: outcome.approvalId };
      }

      case "cancelled":
        await this.move(request, "running", "cancelling", "cancelled");
        await this.move(request, "cancelling", "cancelled");
        return { status: "cancelled" };
    }
  }

  private async move(
    request: AgentStateRequest,
    from: StateStatus,
    to: StateStatus,
    reason?: string
  ): Promise<void> {
    assertStateTransition(from, to);
    await this.options.transitions.transition({
      businessId: request.businessId,
      runId: request.runId,
      stateKey: request.stateKey,
      from,
      to,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}
