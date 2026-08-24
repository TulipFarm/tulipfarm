import type { MessageContent } from "@tulipfarm/schema";
import type { ModelRequirementsPolicy } from "../models/requirements";

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: MessageContent;
}

/**
 * One File's bytes, resolved and re-authorized for this invocation.
 *
 * Bytes ride beside the transcript rather than inside it because `MessageContent` is persisted:
 * a part naming a File stays a name forever, and inlining base64 would both bloat every row and
 * freeze a copy of content the File store is supposed to own.
 *
 * Only Files the current Turn attached appear here. A part in an older message keeps its name and
 * resolves to nothing, so a File is sent once rather than re-sent on every later Turn.
 */
export interface ResolvedAttachment {
  readonly fileId: string;
  readonly mediaType: string;
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ModelInvocationRequest {
  readonly requestId: string;
  readonly modelProfileId: string;
  readonly messages: readonly ModelMessage[];
  /** Bytes for the file parts this Turn attached, keyed by `fileId`; see {@link ResolvedAttachment}. */
  readonly attachments?: readonly ResolvedAttachment[];
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[];
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  /**
   * Governance the turn requires of whatever model serves it — residency, retention, training,
   * sensitivity.
   *
   * It rides the request rather than the port because the port is constructed before the turn's
   * Context resolves, so at construction time nothing yet knows which Agent is acting.
   */
  readonly policy?: ModelRequirementsPolicy;
  /**
   * Whom the call acts as, so a provider credential can carry that principal's authority instead
   * of the deployment's. Absent means the call acts as the deployment.
   */
  readonly principal?: { readonly kind: string; readonly id: string };
  /** Which Agent this call is on behalf of, so spend can be attributed to it. */
  readonly agentId?: string;
  /**
   * Stops the call while it is still running, when the Run is cancelled.
   *
   * It rides the request rather than the port's signature so that a `ModelPort` which does not
   * honour it — a scripted test double, the eval harness — stays valid without change. An adapter
   * that does honour it must combine it with whatever bounds it already imposes, never replace
   * them: a stall timeout and a participant pressing stop are separate reasons to end the call.
   */
  readonly signal?: AbortSignal;
}

export type ModelInvocationFailureReason =
  | "model_billing_inactive"
  | "model_authentication_failed"
  | "model_not_configured"
  | "model_not_found"
  | "model_rate_limited"
  | "model_provider_unavailable"
  | "model_error";

/** A participant-safe model failure. The provider's original error remains operator-only. */
export class ModelInvocationError extends Error {
  constructor(
    readonly reason: ModelInvocationFailureReason,
    cause: unknown,
    /**
     * What the provider had already consumed when the call failed.
     *
     * A call that dies mid-stream is not a free call: the input was submitted and the partial
     * output was generated, and the provider bills for both. Without this the Run is charged
     * nothing, so a failure loop can spend without limit against a budget it never touches.
     */
    readonly usage?: ModelUsage,
    /** The provider model whose call began, when the adapter can know it. */
    readonly modelId?: string
  ) {
    super(reason, { cause });
    this.name = "ModelInvocationError";
  }
}

export type ModelOutput =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly {
        readonly callId: string;
        readonly name: string;
        readonly arguments: unknown;
      }[];
    }
  | { readonly kind: "structured"; readonly value: unknown };

/**
 * What one model call consumed.
 *
 * The detail fields are reported separately rather than folded into the totals because they are
 * priced differently by every provider that offers them: a cached input token is cheaper than a
 * fresh one and a reasoning token is billed as output the participant never sees. Dropping them
 * makes a call look identical to one that cost several times as much.
 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from the provider's prompt cache, included in `inputTokens`. */
  readonly cacheReadTokens?: number;
  /** Input tokens written to the provider's prompt cache, included in `inputTokens`. */
  readonly cacheWriteTokens?: number;
  /** Output tokens spent on hidden reasoning, included in `outputTokens`. */
  readonly reasoningTokens?: number;
  /** Provider-reported cost when the adapter can price the call; absent when unknown. */
  readonly costUsd?: number;
  /**
   * Why `costUsd` is what it is.
   *
   * `unpriced` and a zero cost are different facts, and the budget must not read them the same
   * way: an unpriceable call cannot be charged against a cost ceiling, so a Run that declared
   * one is not entitled to keep spending. Absent means the adapter does not report a basis.
   */
  readonly costBasis?: "priced" | "subscription" | "unpriced";
}

export interface ModelInvocationResult {
  readonly requestId: string;
  readonly output: ModelOutput;
  readonly usage: ModelUsage;
  readonly providerRequestId?: string;
}

/** Stream ends with one `completed` chunk; adapters without streaming omit `stream`. */
export type ModelStreamChunk =
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "completed"; readonly result: ModelInvocationResult };

/** Provider-neutral model invocation boundary selected through a governed ModelProfile. */
export interface ModelPort {
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
  /** Optional streaming; non-streaming providers still return a final result. */
  stream?(request: ModelInvocationRequest): AsyncIterable<ModelStreamChunk>;
}
