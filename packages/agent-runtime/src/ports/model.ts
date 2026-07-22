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
  };
  readonly providerRequestId?: string;
}

/** Provider-neutral model invocation boundary selected through a governed ModelProfile. */
export interface ModelPort {
  invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult>;
}
