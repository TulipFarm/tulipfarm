import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import type { ParticipantToolCall } from "@tulipfarm/schema";
import type { TurnAuthority } from "@tulipfarm/tool-host";
import type {
  ApprovalWaitPort,
  ResolvedTurnContext,
  TurnAttachmentPort,
  TurnCompletionRecord,
  TurnCompletionRef,
  TurnCompletionStatus,
  TurnCompletionStore,
  TurnContextPort,
  TurnRequest,
} from "@tulipfarm/turn-executor";
import type { InternalApiClient } from "./client";

/** API-backed turn ports; every path names only a Run and API re-derives authority. */

/** Which Turn a Run is answering. `undefined` when the Run no longer names one. */
export interface RemoteTurnIdentity {
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
}

/** Mirrors `TaskReconcileSignals` in `apps/api/src/internal/routes.ts` across the HTTP boundary. */
export interface TaskReconcileSignals {
  readonly businessName?: string;
  readonly businessDescription?: string;
  readonly setupComplete?: boolean;
  readonly memberCount?: number;
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
  implements
    TurnContextPort,
    TurnAttachmentPort,
    TurnCompletionStore,
    ToolDispatchPort,
    ApprovalWaitPort
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

  /** Operator price corrections, so this process charges at the price the operator set. */
  async pricingOverrides(): Promise<Record<string, { in: number; out: number }>> {
    const body = await this.client.require<{
      overrides: Record<string, { in: number; out: number }>;
    }>("GET", "/api/v1/internal/observability/pricing");
    return body.overrides;
  }

  /** Business profile and knowledge/memory signals for the task reconciler; see the API route. */
  async taskReconcileSignals(): Promise<TaskReconcileSignals | undefined> {
    return this.client.find<TaskReconcileSignals>(
      "GET",
      "/api/v1/internal/task-reconcile-signals",
      [204]
    );
  }

  /** `TurnContextPort`. */
  async resolve(request: TurnRequest): Promise<ResolvedTurnContext> {
    return this.client.require<ResolvedTurnContext>("POST", turnPath(request.runId, "/context"));
  }

  /**
   * `TurnAttachmentPort`. The far side re-authorizes the File against the Run's own subject.
   *
   * A `404` means this Run may not have these bytes — either its Turn never attached the File or
   * the subject may no longer read it. The two are deliberately indistinguishable, so that a
   * Worker cannot use this route to learn which File ids exist.
   */
  async read(runId: string, fileId: string): Promise<Uint8Array | undefined> {
    return this.client.bytes(
      turnPath(runId, `/attachments/${encodeURIComponent(fileId)}`),
      [404, 409]
    );
  }

  /** `ToolDispatchPort`. The far side re-derives the callId's authority from the Run. */
  /**
   * The Run-derived authority for this Run's Turn, so Tools hosted in this process execute under
   * what the Run recorded rather than under anything this process decided for itself.
   */
  async authority(runId: string): Promise<TurnAuthority | undefined> {
    return this.client.find<TurnAuthority>("GET", turnPath(runId, "/authority"), [404, 409]);
  }

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
