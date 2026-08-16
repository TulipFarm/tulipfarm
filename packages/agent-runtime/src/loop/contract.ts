import type { ModelRequirementsPolicy } from "../models/requirements";
import type { ModelInvocationFailureReason, ModelMessage, ModelPort } from "../ports";
import type { LoopCheckpointStore } from "./checkpoint";

/** What a caller of the bounded Tool loop supplies, implements, and receives back. */

export interface AgentLoopLimits {
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly maxRepairAttempts: number;
}

export interface ExposedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Only non-mutating Tools may dispatch concurrently; absent means sequential. */
  readonly mutating?: boolean;
}

export interface AgentLoopInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly modelProfileId: string;
  /** Governance the acting Agent requires of the model; see `ModelInvocationRequest.policy`. */
  readonly modelPolicy?: ModelRequirementsPolicy;
  /** Whom the turn acts as; see `ModelInvocationRequest.principal`. */
  readonly principal?: { readonly kind: string; readonly id: string };
  /** Which Agent the turn runs as, so its spend is attributed rather than pooled. */
  readonly agentId?: string;
  /** Digest of the Context manifest the messages were assembled from. */
  readonly contextDigest: string;
  readonly guardrailDigest: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ExposedTool[];
  readonly limits: AgentLoopLimits;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Skill narrowing affects model-visible Tools only; `exposed` remains the auth boundary. */
  readonly skillToolScopes?: ReadonlyMap<string, readonly string[]>;
}

export interface ToolDispatchRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ToolDispatchResult =
  | { readonly status: "succeeded"; readonly callId: string; readonly output: unknown }
  | { readonly status: "denied"; readonly callId: string; readonly reason: string }
  | { readonly status: "invalid_arguments"; readonly callId: string; readonly reason: string }
  | { readonly status: "failed"; readonly callId: string; readonly reason: string }
  | {
      readonly status: "awaiting_approval";
      readonly callId: string;
      readonly approvalId: string;
    };

export interface ToolDispatchPort {
  dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult>;
}

export type AgentLoopEventType =
  | "iteration_started"
  | "text_delta"
  | "tool_call_dispatched"
  | "tool_call_rejected"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

/** Loop events carry model text only; Tool args/output stay with `ToolDispatchPort`. */
export interface AgentLoopEvent {
  readonly sequence: number;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly type: AgentLoopEventType;
  readonly iteration: number;
  readonly toolName?: string;
  readonly callId?: string;
  readonly outcome?: string;
  /** Model text released this chunk. Present only on `text_delta`. */
  readonly text?: string;
  readonly textIndex?: number;
  readonly occurredAt: string;
}

export interface AgentLoopEventSink {
  append(event: AgentLoopEvent): Promise<void>;
}

/** Budget manager must charge before use and fail closed. */
export interface AgentLoopBudgetPort {
  consume(input: { key: string; amount: number }): Promise<{ outcome: string }>;
}

export type AgentLoopFailureReason =
  | "iteration_limit"
  | "tool_call_limit"
  | "repair_budget_exhausted"
  | "budget_exhausted"
  | ModelInvocationFailureReason
  | "empty_model_output";

export type AgentLoopOutcome =
  | {
      readonly status: "completed";
      readonly output: unknown;
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    }
  | {
      readonly status: "failed";
      readonly reason: AgentLoopFailureReason;
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    }
  | {
      readonly status: "awaiting_approval";
      readonly approvalId: string;
      readonly callId: string;
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    }
  | {
      readonly status: "cancelled";
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    };

export interface AgentLoopDependencies {
  readonly model: ModelPort;
  readonly tools: ToolDispatchPort;
  readonly checkpoints: LoopCheckpointStore;
  readonly events: AgentLoopEventSink;
  readonly budget: AgentLoopBudgetPort;
  isCancelled(): Promise<boolean>;
  /** Diagnostic only — a blank final completion is otherwise invisible in server logs. */
  readonly log?: { warn(obj: unknown, msg?: string): void };
  now?(): Date;
}
