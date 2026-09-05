/*
 * Hand-written types for the chat SSE wire and the timeline model the reducer folds events
 * into. These mirror the live backend contract (see the chat route): the wire `ChatEvent` union
 * is what the SSE parser yields, and the timeline (`ChatMessage` / `TimelinePart` /
 * `ChatState`) is the immutable shape components render.
 */

import type { EffortPreset, EffortRung, RunEventToolPreview } from "@tulipfarm/schema";
import type { SurfaceCodeViewPayload } from "@tulipfarm/surface/client";

export type ChatEventType =
  | "text"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "approval-request"
  | "approval-resolved"
  | "sources"
  | "agent-handoff"
  | "plan"
  | "surface"
  | "client-action"
  | "guardrail_block"
  | "finish"
  | "error";

export type ApprovalOutcome = "approved" | "denied" | "timeout";

/** Which layer a Tool belongs to. Mirrors the registry's tiering, not a rendering hint. */
export type ToolTier = "system" | "platform" | "integration";

/** One Round of a declared plan: calls the Agent expects to be able to run at the same time. */
export type PlanRound = { calls: { tool: string; label?: string }[] };

export type ChatFailureDetails = {
  reason?: string;
  requestId?: string;
  modelId?: string;
};

/**
 * The bounded, redaction-aware view of a Tool's arguments or output that the wire carries.
 * `json` is already redacted and already truncated when it arrives; the client never un-redacts
 * it.
 */
export type ToolPreview = RunEventToolPreview;

/** Identity and timing for one Tool call. Says which kind of Tool ran, not what it operated on. */
export type ToolMeta = {
  /** Hash of the verbatim arguments. Stays the authority after a preview redacts or truncates. */
  argsDigest?: string;
  tier?: ToolTier;
  mutating?: boolean;
  agentId?: string;
  /** The State the call belonged to — real grouping data, not adjacency guessed by the client. */
  stepId?: string;
  /**
   * The concurrent dispatch the call belonged to. Present only when the runtime really did run it
   * alongside others, so the trace can say "at the same time" without ever guessing it from
   * adjacency or from two timestamps that merely look close.
   */
  batchId?: string;
  startedAt?: string;
  durationMs?: number;
  errorCode?: string;
  summary?: string;
  /** UI-only deep link to a connect page; never sent to the model. */
  connectUrl?: string;
};

export type SourceRef = { id?: string; title?: string; url?: string; ref?: number; path?: string };

export type ChatEvent =
  | { type: "text"; data: { delta: string } }
  | { type: "reasoning"; data: { delta: string } }
  | {
      type: "tool-call";
      data: {
        toolCallId: string;
        toolName: string;
        args: unknown;
        preview?: ToolPreview;
        meta?: ToolMeta;
      };
    }
  | {
      type: "tool-result";
      data: {
        toolCallId: string;
        toolName: string;
        result: unknown;
        preview?: ToolPreview;
        meta?: ToolMeta;
      };
    }
  | {
      type: "approval-request";
      data: {
        approvalId: string;
        toolCallId: string;
        toolName?: string;
        args?: unknown;
        expiresAt?: string;
      };
    }
  | {
      type: "approval-resolved";
      data: { approvalId: string; toolCallId: string; outcome: ApprovalOutcome };
    }
  | { type: "sources"; data: { sources: SourceRef[] } }
  | { type: "agent-handoff"; data: { from?: string; to: string; reason?: string } }
  | { type: "plan"; data: { revision: number; rounds: PlanRound[] } }
  | {
      type: "surface";
      data: {
        artifactId: string;
        artifact?: SurfaceArtifact;
        actionHandles?: Readonly<Record<string, string>>;
        resolvedView?: ResolvedSurfaceViewNode;
        codeView?: SurfaceCodeViewPayload;
      };
    }
  | { type: "client-action"; data: { action: string; to?: string; reason?: string | null } }
  | {
      type: "guardrail_block";
      data: { stage: "input" | "output"; guard?: string; reason: string; message?: string };
    }
  | {
      type: "finish";
      data: {
        reason: string;
        messageId?: string | null;
        receipt?: ModelReceipt;
      };
    }
  | { type: "error"; data: { message: string; details?: ChatFailureDetails } };

export type ParsedFrame = { seq: number; type: string; data: unknown };

export type Autonomy = "full" | "supervised" | "approval-required" | "manual";
export type ChatModelSelector = EffortPreset;

/** A File already uploaded and ready to attach; `fileId` is what the request actually sends. */
export type AttachedFile = { fileId: string; mediaType: string; name: string };

export type ChatTurnOptions = {
  model?: ChatModelSelector;
  autonomy?: Autonomy;
  agentId?: string;
  skills?: string[];
  resources?: string[];
  knowledgePages?: string[];
  files?: AttachedFile[];
};

export type ChatTurnSource = {
  text: string;
  options?: ChatTurnOptions;
};

export type Role = "user" | "assistant";
export type ToolStatus = "running" | "done";

export type ApprovalState = {
  approvalId: string;
  status: "pending" | ApprovalOutcome;
  expiresAt?: string;
};

export type ModelReceipt = {
  modelId: string;
  effortPreset?: EffortPreset;
  effortApplied?: EffortRung;
  modelCallLatencyMs: number;
};

export type TimelinePart =
  | { kind: "text"; text: string }
  | { kind: "file"; fileId: string; mediaType: string; name: string }
  /** An attachment this reader can no longer open. Named, because the Message still says what
   *  it was even though the File it pointed at is gone. */
  | { kind: "file-unavailable"; fileId: string; name: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      status: ToolStatus;
      approval?: ApprovalState;
      /** Redacted, bounded views of the call's input and output; absent on a legacy stream. */
      argsPreview?: ToolPreview;
      resultPreview?: ToolPreview;
      meta?: ToolMeta;
      /** `error` is distinct from `done`: a call that ran and failed is not a call that worked. */
      outcome?: "ok" | "error";
    }
  | { kind: "reasoning"; text: string }
  | { kind: "sources"; sources: SourceRef[] }
  | { kind: "agent-handoff"; to: string; from?: string; reason?: string }
  /**
   * The Agent's own forecast of the Rounds ahead.
   *
   * The shape is declared by the Agent; the progress is not. Nothing here records what ran — the
   * renderer ticks these entries off against the real `tool` parts beside them, so a plan can
   * never claim work the Turn did not do.
   *
   * At most one per Message: a revision replaces its predecessor rather than stacking beneath it,
   * because a plan is a statement of the current intent, not a history of intents.
   */
  | { kind: "plan"; revision: number; rounds: PlanRound[] }
  | {
      kind: "surface";
      artifactId: string;
      revision?: number;
      artifact?: SurfaceArtifact;
      actionHandles?: Readonly<Record<string, string>>;
      resolvedView?: ResolvedSurfaceViewNode;
      codeView?: SurfaceCodeViewPayload;
    }
  | { kind: "surface-unavailable"; message: "Legacy presentation unavailable" }
  | {
      kind: "guardrail";
      stage: "input" | "output";
      guard?: string;
      reason: string;
      message?: string;
    };

export type ChatMessage = {
  id: string;
  role: Role;
  parts: TimelinePart[];
  sealed: boolean;
  serverId?: string;
  feedback?: "up" | "down";
  receipt?: ModelReceipt;
  sourceTurn?: ChatTurnSource;
};

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";

export type ChatState = {
  messages: ChatMessage[];
  pendingApprovals: Record<string, { toolCallId: string; messageId: string }>;
  status: ChatStatus;
  conversationId?: string;
  runId?: string;
  currentAgent?: string;
  error?: string;
  errorDetails?: ChatFailureDetails;
};

import type { ResolvedSurfaceViewNode, SurfaceArtifact } from "@tulipfarm/surface/client";
