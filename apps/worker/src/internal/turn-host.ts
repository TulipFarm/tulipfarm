import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import type { ParticipantToolCall } from "@tulipfarm/schema";
import type { ApprovalWaitPort } from "../agent-state";
import type {
  TurnCompletionRecord,
  TurnCompletionRef,
  TurnCompletionStatus,
  TurnCompletionStore,
} from "../conversation-turn";
import type { ResolvedTurnContext, TurnContextPort, TurnRequest } from "../turn/driver";
import type { InternalApiClient } from "./client";

/** API-backed turn ports; every path names only a Run and API re-derives authority. */

/** Which Turn a Run is answering. `undefined` when the Run no longer names one. */
export interface RemoteTurnIdentity {
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
}

/** A dispatch outcome as the host reports it: the caller already holds the `callId`. */
type RemoteToolResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "invalid_arguments"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "awaiting_approval"; readonly approvalId: string };

/** Re-attaches the `callId` by hand: spreading a union would lose which variant this is. */
function withCallId(callId: string, result: RemoteToolResult): ToolDispatchResult {
  switch (result.status) {
    case "succeeded":
      return { status: "succeeded", callId, output: result.output };
    case "awaiting_approval":
      return { status: "awaiting_approval", callId, approvalId: result.approvalId };
    default:
      return { status: result.status, callId, reason: result.reason };
  }
}

function turnPath(runId: string, suffix = ""): string {
  return `/api/v1/internal/turns/${encodeURIComponent(runId)}${suffix}`;
}

export class HttpTurnHost
  implements TurnContextPort, TurnCompletionStore, ToolDispatchPort, ApprovalWaitPort
{
  constructor(private readonly client: InternalApiClient) {}

  /** `undefined` means a retry or reclaim left this Run with no Turn to answer. */
  async findTurn(runId: string): Promise<RemoteTurnIdentity | undefined> {
    // `409` is a Run no executor may write for; `404` is a Run or Turn that is gone. Both mean
    // this worker holds nothing, and neither is a fault worth reconciling.
    return this.client.find<RemoteTurnIdentity>("GET", turnPath(runId), [404, 409]);
  }

  /** The published LLM configuration, or `undefined` when the Soul publishes none. */
  async llmConfig(): Promise<unknown> {
    return this.client.find<Record<string, unknown>>("GET", "/api/v1/internal/llm/config", [204]);
  }

  /** `TurnContextPort`. */
  async resolve(request: TurnRequest): Promise<ResolvedTurnContext> {
    return this.client.require<ResolvedTurnContext>("POST", turnPath(request.runId, "/context"));
  }

  /** `ToolDispatchPort`. The far side re-derives the callId's authority from the Run. */
  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    const result = await this.client.require<RemoteToolResult>(
      "POST",
      turnPath(request.runId, "/tools"),
      { callId: request.callId, name: request.name, arguments: request.arguments }
    );
    return withCallId(request.callId, result);
  }

  /** Parks on the API-side approval wait; resume tokens never cross to the Worker. */
  async register(input: {
    runId: string;
    stateKey: string;
    approvalId: string;
  }): Promise<{ waitId: string }> {
    return this.client.require<{ waitId: string }>(
      "POST",
      `${turnPath(input.runId, "/approvals")}/${encodeURIComponent(input.approvalId)}/wait`,
      { stateKey: input.stateKey }
    );
  }

  /** Only `204` means unfinished; missing Runs still throw to prevent duplicate answers. */
  async findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined> {
    return this.client.find<TurnCompletionRecord>(
      "GET",
      `${turnPath(ref.runId, "/completion")}?attempt=${ref.attempt}`,
      [204]
    );
  }

  async appendAssistantMessage(
    input: TurnCompletionRef & {
      content: string;
      metadata?: { readonly toolCalls?: readonly ParticipantToolCall[] };
    }
  ): Promise<{ messageId: string }> {
    return this.client.require<{ messageId: string }>("POST", turnPath(input.runId, "/messages"), {
      attempt: input.attempt,
      content: input.content,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  async completeTurn(
    input: TurnCompletionRef & {
      status: TurnCompletionStatus;
      cursor: number;
      messageId: string | null;
    }
  ): Promise<void> {
    await this.client.require("POST", turnPath(input.runId, "/completion"), {
      attempt: input.attempt,
      status: input.status,
      cursor: input.cursor,
      messageId: input.messageId,
    });
  }
}
