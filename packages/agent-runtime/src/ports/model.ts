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

/**
 * One increment of a streamed model response.
 *
 * A stream always ends with exactly one `completed` chunk carrying the same
 * `ModelInvocationResult` a non-streaming `invoke` would have returned, so a consumer that only
 * wants the outcome reads the last chunk and a consumer that wants live text reads the deltas.
 * Adapters that cannot stream simply do not implement `stream`.
 */
export type ModelStreamChunk =
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "completed"; readonly result: ModelInvocationResult };

/** Provider-neutral model invocation boundary selected through a governed ModelProfile. */
export interface ModelPort {
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
  /**
   * Stream the same call `invoke` would make.
   *
   * Optional: the loop falls back to `invoke` when an adapter omits it, so a non-streaming
   * provider stays usable and only loses the live text — never a result.
   */
  stream?(request: ModelInvocationRequest): AsyncIterable<ModelStreamChunk>;
}
