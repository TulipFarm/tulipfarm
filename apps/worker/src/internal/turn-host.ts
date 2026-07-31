import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import type { ApprovalWaitPort } from "../agent-state";
import type {
  TurnCompletionRecord,
  TurnCompletionRef,
  TurnCompletionStatus,
  TurnCompletionStore,
} from "../conversation-turn";
import type { ResolvedTurnContext, TurnContextPort, TurnRequest } from "../turn/driver";
import type { InternalApiClient } from "./client";

/**
 * The API-backed implementation of every port a turn needs from outside the Worker.
 *
 * One class rather than three because there is one remote host: the Context, the Tool catalog, and
 * the conversation tables all live behind the same boundary and the same credential, and splitting
 * them would only invent a seam that does not exist. What matters is the direction — each port is
 * declared by the Worker (`turn/driver.ts`, `@tulipfarm/agent-runtime`), and this file satisfies
 * them. PR 4 swaps the implementation for in-process resolution and no caller changes.
 *
 * Every path names a Run and nothing else. Authority comes from the Run's recorded subject on the
 * far side, so this client cannot ask to act as anyone — the worst a leaked credential buys is
 * doing to a live Run exactly what that Run was already entitled to do.
 */

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

  /**
   * The Turn this Run answers, or `undefined` when it answers none.
   *
   * A Run superseded by a retry no longer names its Turn, and so does a Run whose lease another
   * worker has already reclaimed. Either way there is nothing for this executor to do, and asking
   * first is what stops it from spending a model call to find out.
   */
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

  /**
   * `ApprovalWaitPort`. Parks this Run on the durable wait for an approval already requested.
   *
   * The wait lives beside the approval, on the far side, because that is where the decision is
   * made and where the one-use resume token must be redeemed. What comes back is only the wait's
   * id — enough to tell a reader what the Run is stopped on, and nothing that could resume it.
   */
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

  /**
   * `TurnCompletionStore`. `204` — and only `204` — means this attempt has recorded no outcome
   * yet; a missing Run still throws, because reading that as "not finished" is how a redelivered
   * job posts a second answer.
   */
  async findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined> {
    return this.client.find<TurnCompletionRecord>(
      "GET",
      `${turnPath(ref.runId, "/completion")}?attempt=${ref.attempt}`,
      [204]
    );
  }

  async appendAssistantMessage(
    input: TurnCompletionRef & { content: string }
  ): Promise<{ messageId: string }> {
    return this.client.require<{ messageId: string }>("POST", turnPath(input.runId, "/messages"), {
      attempt: input.attempt,
      content: input.content,
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
