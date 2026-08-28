import type {
  ExposedTool,
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { extractText } from "@tulipfarm/files";
import type { ParticipantToolCall } from "@tulipfarm/schema";
import type { TurnAuthority } from "@tulipfarm/tool-host";
import type {
  ResolvedTurnContext,
  TurnAttachmentPort,
  TurnCompletionRecord,
  TurnCompletionRef,
  TurnCompletionStatus,
  TurnCompletionStore,
  TurnContextPort,
  TurnRequest,
  TurnWaitPort,
} from "@tulipfarm/turn-executor";
import type { InternalApiClient } from "./client";

/** API-backed turn ports; every path names only a Run and API re-derives authority. */

/** Which Turn a Run is answering. `undefined` when the Run no longer names one. */
export interface RemoteTurnIdentity {
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
  /** The Run this attempt supersedes, so a retry can reread what the failed attempt already did. */
  readonly previousRunId?: string;
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
  | { readonly status: "succeeded"; readonly output: unknown; readonly replayed?: true }
  | { readonly status: "denied"; readonly reason: string; readonly connectUrl?: string }
  | { readonly status: "invalid_arguments"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "awaiting_approval"; readonly approvalId: string }
  | {
      readonly status: "awaiting_child";
      readonly childRunId: string;
      readonly waitId: string;
    };

/** Re-attaches the `callId` by hand: spreading a union would lose which variant this is. */
function withCallId(callId: string, result: RemoteToolResult): ToolDispatchResult {
  switch (result.status) {
    case "succeeded":
      return {
        status: "succeeded",
        callId,
        output: result.output,
        ...(result.replayed === true ? { replayed: true as const } : {}),
      };
    case "awaiting_approval":
      return { status: "awaiting_approval", callId, approvalId: result.approvalId };
    case "awaiting_child":
      return {
        status: "awaiting_child",
        callId,
        childRunId: result.childRunId,
        waitId: result.waitId,
      };
    case "denied":
      return { status: "denied", callId, reason: result.reason, connectUrl: result.connectUrl };
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
    TurnWaitPort
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
   *
   */
  async read(runId: string, fileId: string): Promise<Uint8Array | undefined> {
    return this.client.bytes(
      turnPath(runId, `/attachments/${encodeURIComponent(fileId)}`),
      [404, 409]
    );
  }

  /**
   * `TurnAttachmentPort`. What an attached File says, so the guards can screen it.
   *
   * Runs here rather than in the API because parsing a hostile document is the riskiest thing this
   * product does with an upload, and the Worker is the process that is allowed to be crashed by
   * one. It also keeps a PDF engine out of the control plane.
   *
   * A File with no readable text is screened as nothing rather than refused: an image is
   * unreadable to a text guard by nature, and refusing it would ban vision rather than screen it.
   */
  async extract(mediaType: string, bytes: Uint8Array): Promise<string | undefined> {
    const extracted = await extractText(mediaType, bytes);
    return extracted.kind === "text" ? extracted.text : undefined;
  }

  /** `ToolDispatchPort`. The far side re-derives the callId's authority from the Run. */
  /**
   * The Run-derived authority for this Run's Turn, so Tools hosted in this process execute under
   * what the Run recorded rather than under anything this process decided for itself.
   */
  async authority(runId: string, agentName?: string): Promise<TurnAuthority | undefined> {
    const suffix = agentName === undefined ? "" : `?agent=${encodeURIComponent(agentName)}`;
    return this.client.find<TurnAuthority>(
      "GET",
      `${turnPath(runId, "/authority")}${suffix}`,
      [404, 409]
    );
  }

  /** The Tools the Run's acting Agent may be offered, resolved by the control plane's registry. */
  async agentTools(runId: string, agentName?: string): Promise<readonly ExposedTool[]> {
    const suffix = agentName === undefined ? "" : `?agent=${encodeURIComponent(agentName)}`;
    const body = await this.client.require<{ tools: readonly ExposedTool[] }>(
      "GET",
      `/api/v1/internal/runs/${encodeURIComponent(runId)}/agent-tools${suffix}`
    );
    return body.tools;
  }

  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    const result = await this.client.require<RemoteToolResult>(
      "POST",
      turnPath(request.runId, "/tools"),
      {
        callId: request.callId,
        name: request.name,
        arguments: request.arguments,
        stateId: request.stateId,
        ...(request.activeSkillName === undefined
          ? {}
          : { activeSkillName: request.activeSkillName }),
        ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
        ...(request.permissionCeiling === undefined
          ? {}
          : { permissionCeiling: request.permissionCeiling }),
      }
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
      surfaces?: readonly { artifactId: string; revision: number }[];
    }
  ): Promise<void> {
    await this.client.require("POST", turnPath(input.runId, "/completion"), {
      attempt: input.attempt,
      status: input.status,
      cursor: input.cursor,
      messageId: input.messageId,
      ...(input.surfaces?.length ? { surfaces: input.surfaces } : {}),
    });
  }
}
