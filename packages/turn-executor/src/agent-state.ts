import type {
  AgentLoopInput,
  AgentLoopOutcome,
  ModelFailureDiagnostic,
} from "@tulipfarm/agent-runtime";
import { assertStateTransition, type StateStatus } from "@tulipfarm/run-kernel";
import { StateTransitionConflictError } from "./kernel-ports";

/** Maps Agent loop outcomes onto legal Run-kernel State transitions and durable waits. */

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
    /** Wrapped so an output of `null` stays distinguishable from "this transition sets none". */
    output?: { value: unknown };
  }): Promise<void>;
}

export interface TurnWaitPort {
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
  readonly waits: TurnWaitPort;
}

export type AgentStateResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly modelFailure?: ModelFailureDiagnostic;
    }
  | {
      readonly status: "waiting";
      readonly reason: "approval_required";
      readonly waitId: string;
      readonly approvalId: string;
      /** The Tool call being held, so a reader can show the decision against that call. */
      readonly callId: string;
    }
  | {
      readonly status: "waiting";
      readonly reason: "child_running";
      readonly waitId: string;
      readonly childRunId: string;
      /** The Tool call being held, so a reader can show the child against that call. */
      readonly callId: string;
    }
  | { readonly status: "input_required"; readonly text: string }
  | { readonly status: "cancelled" }
  | { readonly status: "needs_reconciliation" };

export class AgentStateRunner {
  constructor(private readonly options: AgentStateRunnerOptions) {}

  /** Runs one Agent State over the already-announced Context bundle. */
  async execute(request: AgentStateRequest, input: AgentLoopInput): Promise<AgentStateResult> {
    // Fail before any model or Tool work if the State cannot legally start.
    assertStateTransition(request.from, "running");
    await this.move(request, request.from, "running");

    let outcome: AgentLoopOutcome;
    try {
      outcome = await this.options.loop.run(input);
    } catch {
      // Effects may or may not have landed; reconciliation decides, not the worker.
      try {
        await this.move(request, "running", "needs_reconciliation", "agent_loop_error");
      } catch (error) {
        if (!(error instanceof StateTransitionConflictError)) throw error;
      }
      return { status: "needs_reconciliation" };
    }

    switch (outcome.status) {
      case "completed":
        await this.move(request, "running", "succeeded");
        return { status: "succeeded", output: outcome.output };

      case "failed":
        await this.move(request, "running", "failed", outcome.reason);
        return {
          status: "failed",
          reason: outcome.reason,
          ...(outcome.modelFailure === undefined ? {} : { modelFailure: outcome.modelFailure }),
        };

      case "awaiting_approval": {
        const { waitId } = await this.options.waits.register({
          businessId: request.businessId,
          runId: request.runId,
          stateKey: request.stateKey,
          approvalId: outcome.approvalId,
          callId: outcome.callId,
        });
        await this.move(request, "running", "waiting", "approval_required");
        return {
          status: "waiting",
          reason: "approval_required",
          waitId,
          approvalId: outcome.approvalId,
          callId: outcome.callId,
        };
      }

      case "awaiting_child":
        // No registration here: the wait is already durable, registered by the dispatcher at
        // spawn so the child cannot finish before its resume grant exists.
        // A child that finishes while this Run is still `running` spends its signal against a Run
        // that cannot be requeued. Claiming that resolution has to wait until the Run is durably
        // `waiting`, which happens only after this returns, so the Run dispatcher does it.
        await this.move(request, "running", "waiting", "child_running");
        return {
          status: "waiting",
          reason: "child_running",
          waitId: outcome.waitId,
          childRunId: outcome.childRunId,
          callId: outcome.callId,
        };

      case "input_required":
        await this.move(request, "running", "succeeded");
        return { status: "input_required", text: outcome.text };

      case "cancelled":
        // `RunCancellationManager` is walking this State down the same two steps from the other
        // side. Whoever loses the CAS has still observed the cancellation it was told about, so a
        // lost race is the expected outcome, not a failure to report.
        try {
          await this.move(request, "running", "cancelling", "cancelled");
          await this.move(request, "cancelling", "cancelled");
        } catch (error) {
          if (!(error instanceof StateTransitionConflictError)) throw error;
        }
        return { status: "cancelled" };
    }
  }

  /** Settles guardrail-decided States through the same `running → succeeded` path. */
  async settle(
    request: AgentStateRequest,
    output: unknown
  ): Promise<Extract<AgentStateResult, { status: "succeeded" }>> {
    assertStateTransition(request.from, "running");
    await this.move(request, request.from, "running");
    await this.move(request, "running", "succeeded");
    return { status: "succeeded", output };
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
