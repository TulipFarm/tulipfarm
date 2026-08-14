export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ModelInvocationRequest {
  readonly requestId: string;
  readonly modelProfileId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[];
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
}

export type ModelInvocationFailureReason =
  | "model_billing_inactive"
  | "model_authentication_failed"
  | "model_not_found"
  | "model_rate_limited"
  | "model_provider_unavailable"
  | "model_error";

/** A participant-safe model failure. The provider's original error remains operator-only. */
export class ModelInvocationError extends Error {
  constructor(
    readonly reason: ModelInvocationFailureReason,
    cause: unknown
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

export interface ModelInvocationResult {
  readonly requestId: string;
  readonly output: ModelOutput;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Provider-reported cost when the adapter can price the call; absent when unknown. */
    readonly costUsd?: number;
  };
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
