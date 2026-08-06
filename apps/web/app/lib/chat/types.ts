/*
 * Hand-written types for the chat SSE wire and the timeline model the reducer folds events into.
 * These mirror the live backend contract (see the chat route): the wire `ChatEvent` union is what
 * the SSE parser yields, and the timeline (`ChatMessage` / `TimelinePart` / `ChatState`) is the
 * immutable shape components render. Several event kinds are CONTRACT-ONLY (reasoning/plan/task/
 * sources/agent-handoff/surface) — typed and reduced now so renderers can light up when the backend
 * starts emitting them. No Zod: validate by hand at the parse boundary.
 */

// ----- Wire: SSE events ------------------------------------------------------------------------

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

export type PlanStep = { id: string; label: string; status: StepStatus };
// `ref` is the inline citation number the agent wrote (`[ref]`); it ties a source to its `[n]` marker.
export type SourceRef = { id?: string; title?: string; url?: string; ref?: number; path?: string };

// Discriminated union over every event the wire can carry; `data` is typed per `type`.
export type ChatEvent =
  | { type: "text"; data: { delta: string } }
  | { type: "reasoning"; data: { delta: string } }
  | { type: "tool-call"; data: { toolCallId: string; toolName: string; args: unknown } }
  | { type: "tool-result"; data: { toolCallId: string; toolName: string; result: unknown } }
  | {
      type: "approval-request";
      data: {
        approvalId: string;
        toolCallId: string;
        toolName?: string;
        args?: unknown;
        // Absent when the Run event stream carries no deadline for the wait; the card then shows no
        // countdown rather than a fabricated one.
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
        artifact: SurfaceArtifact;
        actionHandles?: Readonly<Record<string, string>>;
        resolvedView?: ResolvedSurfaceViewNode;
      };
    }
  // Imperative agent→client action (navigate, …). Executed by the chat hook, not rendered as a part.
  | { type: "client-action"; data: { action: string; to?: string; reason?: string | null } }
  // `guard` is withheld from a participant on purpose — naming the guard that refused teaches a
  // reader what to write around — so it is optional here and absent on the live wire.
  | {
      type: "guardrail_block";
      data: { stage: "input" | "output"; guard?: string; reason: string; message?: string };
    }
  // `messageId` is the persisted reply the turn produced; the turn's own finish event names it, so a
  // reply can be given feedback without a separate header.
  | { type: "finish"; data: { reason: string; messageId?: string | null } }
  | { type: "error"; data: { message: string } };

// Raw output of the frame parser, before mapping to a typed `ChatEvent`.
export type ParsedFrame = { seq: number; type: string; data: unknown };

// ----- Request shape knobs ---------------------------------------------------------------------

export type Autonomy = "full" | "supervised" | "approval-required" | "manual";
export type ModelTier = "auto" | "quick" | "standard" | "complex";

// ----- Timeline model --------------------------------------------------------------------------

export type Role = "user" | "assistant";
export type ToolStatus = "running" | "done";

export type ApprovalState = {
  approvalId: string;
  status: "pending" | ApprovalOutcome;
  expiresAt?: string;
};

// A renderable segment of one message. The reducer appends/merges these as events arrive; order is
// first-seen and stable. Tool parts carry an optional `approval` so the UI can distinguish a denied
// approval from a genuine tool crash via `approval.status`, not the result payload.
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
    }
  | { kind: "reasoning"; text: string }
  | { kind: "plan"; planId: string; title?: string; steps: PlanStep[] }
  | { kind: "task"; taskId: string; label: string; status: StepStatus }
  | { kind: "sources"; sources: SourceRef[] }
  | { kind: "agent-handoff"; to: string; from?: string; reason?: string }
  | {
      kind: "surface";
      artifactId: string;
      revision: number;
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
    }
  | {
      kind: "code-context";
      filePath: string;
      language?: string;
      lines: { lineNumber: number; content: string; isRelevant?: boolean; annotation?: string }[];
    }
  | {
      kind: "search-progress";
      query: string;
      isSearching?: boolean;
      items: {
        id: string;
        title: string;
        domain?: string;
        url?: string;
        status: "done" | "searching" | "pending";
      }[];
    }
  | {
      kind: "source-carousel";
      sources: {
        id: string;
        title: string;
        snippet?: string;
        domain: string;
        domainIcon?: string;
        url?: string;
        imageUrl?: string;
      }[];
    }
  | {
      kind: "followup-pills";
      items: {
        id: string;
        label: string;
        prompt: string;
        iconName?: string;
      }[];
    };

export type ChatMessage = {
  id: string;
  role: Role;
  parts: TimelinePart[];
  // True once a terminal `finish` has been folded in; a sealed message takes no more deltas.
  sealed: boolean;
  // The persisted message id (assistant turns): from the X-Message-Id header live, or `_id` on
  // restore. Distinct from the React-key `id` (kept stable to avoid a remount). Feedback targets it.
  serverId?: string;
  // The caller's current thumbs vote on this reply, if any (persisted, see message_feedback).
  feedback?: "up" | "down";
};

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";

export type ChatState = {
  messages: ChatMessage[];
  // approvalId -> the tool part it targets, so `approval-resolved` can find it in O(1).
  pendingApprovals: Record<string, { toolCallId: string; messageId: string }>;
  status: ChatStatus;
  conversationId?: string;
  // The Run answering the in-flight turn (X-Run-Id). Stopping the turn cancels this Run, and a
  // reconnect resumes its event stream by cursor.
  runId?: string;
  // The agent currently handling the conversation, updated live by `agent-handoff` events so the
  // header indicator follows transfers. Undefined until the first handoff — callers fall back to the
  // restored conversation's persisted agent.
  currentAgent?: string;
  error?: string;
};

import type { ResolvedSurfaceViewNode, SurfaceArtifact } from "@tulipfarm/surface";
