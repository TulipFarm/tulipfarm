/*
 * Hand-written types for the chat SSE wire and the timeline model the reducer folds events
 * into. These mirror the live backend contract (see the chat route): the wire `ChatEvent` union
 * is what the SSE parser yields, and the timeline (`ChatMessage` / `TimelinePart` /
 * `ChatState`) is the immutable shape components render.
 */

import type { EffortPreset, EffortRung, RunEventToolPreview } from "@tulipfarm/schema";

export type ChatEventType =
  | "text"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "approval-request"
  | "approval-resolved"
  | "plan"
  | "task"
  | "sources"
  | "agent-handoff"
  | "surface"
  | "client-action"
  | "guardrail_block"
  | "finish"
  | "error";

export type ApprovalOutcome = "approved" | "denied" | "timeout";
export type StepStatus = "pending" | "running" | "done" | "error";

/** Which layer a Tool belongs to. Mirrors the registry's tiering, not a rendering hint. */
export type ToolTier = "system" | "platform" | "integration";

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
  startedAt?: string;
  durationMs?: number;
  errorCode?: string;
  summary?: string;
};

export type PlanStep = { id: string; label: string; status: StepStatus };
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
  | { type: "plan"; data: { planId: string; title?: string; steps: PlanStep[] } }
  | { type: "task"; data: { taskId: string; label: string; status: StepStatus } }
  | { type: "sources"; data: { sources: SourceRef[] } }
  | { type: "agent-handoff"; data: { from?: string; to: string; reason?: string } }
  | {
      type: "surface";
      data: {
        artifactId: string;
        artifact?: SurfaceArtifact;
        actionHandles?: Readonly<Record<string, string>>;
        resolvedView?: ResolvedSurfaceViewNode;
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
  | { type: "error"; data: { message: string } };

export type ParsedFrame = { seq: number; type: string; data: unknown };

export type Autonomy = "full" | "supervised" | "approval-required" | "manual";
export type ChatModelSelector = EffortPreset;

export type ChatTurnOptions = {
  model?: ChatModelSelector;
  autonomy?: Autonomy;
  agentId?: string;
  skills?: string[];
  resources?: string[];
  knowledgePages?: string[];
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
  | { kind: "plan"; planId: string; title?: string; steps: PlanStep[] }
  | { kind: "task"; taskId: string; label: string; status: StepStatus }
  | { kind: "sources"; sources: SourceRef[] }
  | { kind: "agent-handoff"; to: string; from?: string; reason?: string }
  | {
      kind: "surface";
      artifactId: string;
      revision?: number;
      artifact?: SurfaceArtifact;
      actionHandles?: Readonly<Record<string, string>>;
      resolvedView?: ResolvedSurfaceViewNode;
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
};

import type { ResolvedSurfaceViewNode, SurfaceArtifact } from "@tulipfarm/surface";
