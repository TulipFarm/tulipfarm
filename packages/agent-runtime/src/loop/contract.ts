import type { ModelRequirementsPolicy } from "../models/requirements";
import type {
  ModelInvocationFailureReason,
  ModelMessage,
  ModelPort,
  ResolvedAttachment,
} from "../ports";
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
  /**
   * Bytes for the Files this Turn attached; see {@link ResolvedAttachment}.
   *
   * Resolved once by the caller and reused across iterations, because the caller is where the
   * authorization to read them lives and the loop must not be able to fetch a File on its own.
   */
  readonly attachments?: readonly ResolvedAttachment[];
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
  /** Skill currently narrowing the loop; absent means the call came directly from Chat. */
  readonly activeSkillName?: string;
}

export type ToolDispatchResult =
  | { readonly status: "succeeded"; readonly callId: string; readonly output: unknown }
  | {
      readonly status: "denied";
      readonly callId: string;
      readonly reason: string;
      /** UI-only deep link to the provider's connect page; never surfaced to the model. */
      readonly connectUrl?: string;
    }
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
  | "input_request_failed"
  | "handoff_unavailable"
  | "effect_after_report"
  | ModelInvocationFailureReason
  | "empty_model_output";

/** Participant-safe evidence for a failed model call; provider error bodies never cross this seam. */
export interface ModelFailureDiagnostic {
  readonly requestId: string;
  readonly modelId?: string;
}

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
      readonly modelFailure?: ModelFailureDiagnostic;
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
      /** A `request_input` Surface is durable; a later Chat Turn receives the answer. */
      readonly status: "input_required";
      readonly callId: string;
      /** Model prose already streamed to the participant, so the Turn can persist what was read. */
      readonly text: string;
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

/**
 * Fetches the bytes of one File an Agent asked to see again, re-authorizing as it goes.
 *
 * A separate port rather than a bigger `AgentLoopInput` because the set is not known when the Turn
 * starts: it grows mid-loop, one `file_read` at a time. Answering `undefined` is how the far side
 * refuses — a File deleted or unshared since it was read comes back as nothing and simply stops
 * being sent, which is why a revocation lands on the very next step rather than at the next Turn.
 */
export interface LoopAttachmentPort {
  read(runId: string, fileId: string): Promise<Uint8Array | undefined>;
}

export interface AgentLoopDependencies {
  readonly model: ModelPort;
  readonly tools: ToolDispatchPort;
  /** Bytes for Files re-read mid-Turn; absent leaves `file_read` able to return text only. */
  readonly attachments?: LoopAttachmentPort;
  readonly checkpoints: LoopCheckpointStore;
  readonly events: AgentLoopEventSink;
  readonly budget: AgentLoopBudgetPort;
  isCancelled(): Promise<boolean>;
  /** Diagnostic only — a blank final completion is otherwise invisible in server logs. */
  readonly log?: { warn(obj: unknown, msg?: string): void };
  now?(): Date;
}
