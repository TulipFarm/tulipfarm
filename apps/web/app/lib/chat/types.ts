/*
 * Hand-written types for the chat SSE wire and the timeline model the reducer folds events into.
 * These mirror the live backend contract (see the chat route): the wire `ChatEvent` union is what
 * the SSE parser yields, and the timeline (`ChatMessage` / `TimelinePart` / `ChatState`) is the
 * immutable shape components render. Several event kinds are CONTRACT-ONLY (reasoning/plan/task/
 * sources/agent-handoff/a2ui) — typed and reduced now so renderers can light up when the backend
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
  | "a2ui"
  | "guardrail_block"
  | "finish"
  | "error";

export type ApprovalOutcome = "approved" | "denied" | "timeout";
export type StepStatus = "pending" | "running" | "done" | "error";

export type PlanStep = { id: string; label: string; status: StepStatus };
export type SourceRef = { id?: string; title?: string; url?: string };

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
        toolName: string;
        args: unknown;
        expiresAt: string;
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
  | { type: "a2ui"; data: { html: string } }
  | {
      type: "guardrail_block";
      data: { stage: "input" | "output"; guard: string; reason: string; message?: string };
    }
  | { type: "finish"; data: { reason: string } }
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
  | { kind: "a2ui"; html: string }
  | {
      kind: "guardrail";
      stage: "input" | "output";
      guard: string;
      reason: string;
      message?: string;
    };

export type ChatMessage = {
  id: string;
  role: Role;
  parts: TimelinePart[];
  // True once a terminal `finish` has been folded in; a sealed message takes no more deltas.
  sealed: boolean;
};

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";

export type ChatState = {
  messages: ChatMessage[];
  // approvalId -> the tool part it targets, so `approval-resolved` can find it in O(1).
  pendingApprovals: Record<string, { toolCallId: string; messageId: string }>;
  status: ChatStatus;
  conversationId?: string;
  streamId?: string;
  error?: string;
};
