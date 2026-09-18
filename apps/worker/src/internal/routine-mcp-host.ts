import type { McpExecutionBinding } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type RoutineMcpAuthorization,
  type RoutineMcpPreparation,
  type RoutineMcpPreparationPort,
  type RoutineToolRequest,
  type ToolAdapter,
  type ToolAdapterRequest,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import type { InternalApiClient } from "./client";

type RemotePreparation =
  | { readonly kind: "failed" | "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly adapter: { readonly kind: "mcp"; readonly ref: string };
      readonly mcp: McpExecutionBinding;
      readonly destination?: string;
    };

type RemoteDispatch =
  | { readonly kind: "succeeded"; readonly output: unknown }
  | {
      readonly kind: "failed";
      readonly error: {
        readonly phase: "before_dispatch" | "after_dispatch";
        readonly code: string;
        readonly retryable: boolean;
        readonly providerRequestId?: string;
        readonly retryAfterMs?: number;
      };
    };

class HttpRoutineMcpAdapter implements ToolAdapter {
  readonly kind = "mcp";

  constructor(
    private readonly client: InternalApiClient,
    private readonly claim: RoutineToolRequest["claim"]
  ) {}

  async dispatch(request: ToolAdapterRequest): Promise<unknown> {
    const result = await this.client.require<RemoteDispatch>(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(request.intent.runId)}/routine-tools/${encodeURIComponent(request.intent.intentId)}/dispatch`,
      { attempt: request.attempt, claim: this.claim },
      { signal: request.abortSignal, timeoutMs: request.timeoutMs }
    );
    if (result.kind === "succeeded") return result.output;
    throw new AdapterDispatchError(
      result.error.phase,
      result.error.code,
      result.error.retryable,
      result.error.providerRequestId,
      result.error.retryAfterMs
    );
  }
}

/** The API derives account authority from the persisted Run; the Worker never receives Secrets. */
export class HttpRoutineMcpHost implements RoutineMcpPreparationPort {
  constructor(private readonly client: InternalApiClient) {}

  async prepare(
    request: RoutineToolRequest,
    pinnedIntent?: ToolIntent
  ): Promise<RoutineMcpPreparation> {
    const arguments_ = request.plan.arguments;
    if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
      return { kind: "failed", reason: "invalid_arguments" };
    }
    const resolved = await this.client.require<RemotePreparation>(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(request.runId)}/routine-states/${encodeURIComponent(request.stateKey)}/tool/resolve`,
      {
        arguments: arguments_,
        claim: request.claim,
        ...(pinnedIntent?.mcp === undefined ? {} : { binding: pinnedIntent.mcp }),
      },
      { signal: request.signal }
    );
    if (resolved.kind !== "ready") return resolved;
    return {
      kind: "ready",
      arguments: { ...arguments_ },
      adapterRef: resolved.adapter.ref,
      adapter: new HttpRoutineMcpAdapter(this.client, request.claim),
      hostCredentials: true,
      mcp: resolved.mcp,
      ...(resolved.destination === undefined ? {} : { destination: resolved.destination }),
    };
  }

  async revalidate(
    request: RoutineToolRequest,
    binding: McpExecutionBinding
  ): Promise<RoutineMcpAuthorization> {
    return this.client.require(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(request.runId)}/routine-states/${encodeURIComponent(request.stateKey)}/tool/reauthorize`,
      { binding, claim: request.claim },
      { signal: request.signal }
    );
  }
}
