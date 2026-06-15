import { describe, expect, test } from "vitest";
import { appendUserMessage, chatReducer, initialChatState } from "~/lib/chat/reducer";
import type { ChatEvent, ChatState, TimelinePart } from "~/lib/chat/types";

// Fold a sequence of events onto a fresh state, as the stream would.
function fold(events: ChatEvent[], from: ChatState = initialChatState): ChatState {
  return events.reduce(chatReducer, from);
}

// The single assistant message the reducer builds while streaming.
function assistantParts(state: ChatState): TimelinePart[] {
  const msg = state.messages.find((m) => m.role === "assistant");
  if (!msg) throw new Error("no assistant message");
  return msg.parts;
}

test("appendUserMessage pushes a user message and marks status submitted", () => {
  const next = appendUserMessage(initialChatState, "hello");
  expect(next.status).toBe("submitted");
  expect(next.messages).toHaveLength(1);
  expect(next.messages[0].role).toBe("user");
  expect(next.messages[0].parts).toEqual([{ kind: "text", text: "hello" }]);
  // pure: original untouched
  expect(initialChatState.messages).toHaveLength(0);
});

test("text deltas concat into a single trailing text part and flip status to streaming", () => {
  const state = fold([
    { type: "text", data: { delta: "Hel" } },
    { type: "text", data: { delta: "lo " } },
    { type: "text", data: { delta: "world" } },
  ]);
  expect(state.status).toBe("streaming");
  expect(assistantParts(state)).toEqual([{ kind: "text", text: "Hello world" }]);
});

test("reasoning deltas concat into their own trailing part, kept separate from text", () => {
  const state = fold([
    { type: "reasoning", data: { delta: "think " } },
    { type: "reasoning", data: { delta: "more" } },
    { type: "text", data: { delta: "answer" } },
  ]);
  expect(assistantParts(state)).toEqual([
    { kind: "reasoning", text: "think more" },
    { kind: "text", text: "answer" },
  ]);
});

test("a tool-call then tool-result pair by toolCallId: result attached, status done", () => {
  const state = fold([
    { type: "tool-call", data: { toolCallId: "t1", toolName: "search", args: { q: "x" } } },
    { type: "tool-result", data: { toolCallId: "t1", toolName: "search", result: { hits: 2 } } },
  ]);
  expect(assistantParts(state)).toEqual([
    {
      kind: "tool",
      toolCallId: "t1",
      toolName: "search",
      args: { q: "x" },
      result: { hits: 2 },
      status: "done",
    },
  ]);
});

test("two concurrent tool-calls keep first-seen order and each gets its own result", () => {
  const state = fold([
    { type: "tool-call", data: { toolCallId: "a", toolName: "one", args: {} } },
    { type: "tool-call", data: { toolCallId: "b", toolName: "two", args: {} } },
    { type: "tool-result", data: { toolCallId: "b", toolName: "two", result: "B" } },
    { type: "tool-result", data: { toolCallId: "a", toolName: "one", result: "A" } },
  ]);
  const parts = assistantParts(state);
  expect(parts.map((p) => (p.kind === "tool" ? p.toolCallId : null))).toEqual(["a", "b"]);
  expect(parts[0]).toMatchObject({ toolCallId: "a", result: "A", status: "done" });
  expect(parts[1]).toMatchObject({ toolCallId: "b", result: "B", status: "done" });
});

describe("approvals", () => {
  test("approval-request sets the tool part pending and registers pendingApprovals", () => {
    const state = fold([
      { type: "tool-call", data: { toolCallId: "t1", toolName: "deploy", args: {} } },
      {
        type: "approval-request",
        data: {
          approvalId: "ap1",
          toolCallId: "t1",
          toolName: "deploy",
          args: {},
          expiresAt: "2026-06-10T00:00:00Z",
        },
      },
    ]);
    const tool = assistantParts(state)[0];
    expect(tool).toMatchObject({
      kind: "tool",
      approval: { approvalId: "ap1", status: "pending", expiresAt: "2026-06-10T00:00:00Z" },
    });
    const msgId = state.messages.find((m) => m.role === "assistant")?.id;
    expect(state.pendingApprovals.ap1).toEqual({ toolCallId: "t1", messageId: msgId });
  });

  test("approval-resolved(denied) sets approval.status denied and clears pendingApprovals", () => {
    const state = fold([
      { type: "tool-call", data: { toolCallId: "t1", toolName: "deploy", args: {} } },
      {
        type: "approval-request",
        data: {
          approvalId: "ap1",
          toolCallId: "t1",
          toolName: "deploy",
          args: {},
          expiresAt: "2026-06-10T00:00:00Z",
        },
      },
      {
        type: "approval-resolved",
        data: { approvalId: "ap1", toolCallId: "t1", outcome: "denied" },
      },
    ]);
    const tool = assistantParts(state)[0];
    expect(tool).toMatchObject({ kind: "tool", approval: { approvalId: "ap1", status: "denied" } });
    expect(state.pendingApprovals.ap1).toBeUndefined();
    // A denial is NOT a tool crash: the part has no result and stays running until a real result.
    expect(tool.kind === "tool" && tool.result).toBeUndefined();
  });
});

test("plan, task, sources, agent-handoff, a2ui each push a matching part", () => {
  const state = fold([
    {
      type: "plan",
      data: { planId: "p1", title: "Ship", steps: [{ id: "s1", label: "a", status: "pending" }] },
    },
    { type: "task", data: { taskId: "k1", label: "do", status: "running" } },
    { type: "sources", data: { sources: [{ id: "1", title: "Doc", url: "http://x" }] } },
    { type: "agent-handoff", data: { from: "alpha", to: "beta", reason: "expertise" } },
    { type: "a2ui", data: { html: "<b>hi</b>" } },
  ]);
  expect(assistantParts(state).map((p) => p.kind)).toEqual([
    "plan",
    "task",
    "sources",
    "agent-handoff",
    "a2ui",
  ]);
});

test("a2ui createSurface pushes a surface part; updateDataModel attaches fragments to it", () => {
  const state = fold([
    {
      type: "a2ui",
      data: {
        op: "createSurface",
        surfaceId: "dash",
        html: "<tf-card></tf-card>",
        nodeIds: ["a2-0"],
      },
    },
    {
      type: "a2ui",
      data: {
        op: "updateDataModel",
        surfaceId: "dash",
        fragments: [{ nodeId: "a2-0", html: "<tf-card>updated</tf-card>" }],
      },
    },
  ]);
  const parts = assistantParts(state);
  expect(parts).toHaveLength(1); // update mutates the existing part, not a new one
  const part = parts[0];
  if (part.kind !== "a2ui") throw new Error("expected a2ui part");
  expect(part.surfaceId).toBe("dash");
  expect(part.fragments).toEqual([{ nodeId: "a2-0", html: "<tf-card>updated</tf-card>" }]);
});

test("client-action is a no-op on the timeline (executed imperatively by the hook)", () => {
  const state = fold([{ type: "client-action", data: { action: "navigate", to: "/x" } }]);
  expect(state.messages.flatMap((m) => m.parts)).toHaveLength(0);
});

test("a2ui createSurface for an existing surfaceId replaces it in place (live structure update)", () => {
  const state = fold([
    {
      type: "a2ui",
      data: { op: "createSurface", surfaceId: "dash", html: "<tf-card>v1</tf-card>" },
    },
    {
      type: "a2ui",
      data: { op: "createSurface", surfaceId: "dash", html: "<tf-card>v2</tf-card>" },
    },
  ]);
  const surfaces = assistantParts(state).filter((p) => p.kind === "a2ui");
  expect(surfaces).toHaveLength(1); // replaced, not duplicated
  const part = surfaces[0];
  if (part.kind !== "a2ui") throw new Error("expected a2ui part");
  expect(part.html).toBe("<tf-card>v2</tf-card>");
});

test("a2ui updateDataModel for an unknown surface is a no-op (no part, no empty message)", () => {
  const state = fold([
    {
      type: "a2ui",
      data: {
        op: "updateDataModel",
        surfaceId: "ghost",
        fragments: [{ nodeId: "x", html: "<i></i>" }],
      },
    },
  ]);
  expect(state.messages.flatMap((m) => m.parts).filter((p) => p.kind === "a2ui")).toHaveLength(0);
});

test("plan with the same planId updates in place rather than pushing a duplicate", () => {
  const state = fold([
    {
      type: "plan",
      data: { planId: "p1", steps: [{ id: "s1", label: "a", status: "pending" }] },
    },
    {
      type: "plan",
      data: { planId: "p1", steps: [{ id: "s1", label: "a", status: "done" }] },
    },
  ]);
  const parts = assistantParts(state);
  expect(parts).toHaveLength(1);
  expect(parts[0]).toMatchObject({ kind: "plan", steps: [{ id: "s1", status: "done" }] });
});

test("finish seals the assistant message and returns status to idle", () => {
  const state = fold([
    { type: "text", data: { delta: "done" } },
    { type: "finish", data: { reason: "stop" } },
  ]);
  expect(state.status).toBe("idle");
  expect(state.messages.find((m) => m.role === "assistant")?.sealed).toBe(true);
});

test("guardrail_block appends a guardrail part, then finish seals it and returns to idle", () => {
  const state = fold([
    {
      type: "guardrail_block",
      data: {
        stage: "input",
        guard: "prompt-injection",
        reason: "injection detected",
        message: "Request blocked by a safety guard.",
      },
    },
    { type: "finish", data: { reason: "guardrail_block" } },
  ]);
  expect(state.status).toBe("idle");
  const assistant = state.messages.find((m) => m.role === "assistant");
  expect(assistant?.sealed).toBe(true);
  expect(assistant?.parts).toContainEqual({
    kind: "guardrail",
    stage: "input",
    guard: "prompt-injection",
    reason: "injection detected",
    message: "Request blocked by a safety guard.",
  });
});

test("error sets status error and records the message", () => {
  const state = fold([{ type: "error", data: { message: "boom" } }]);
  expect(state.status).toBe("error");
  expect(state.error).toBe("boom");
});

test("a user message then a stream produces user + assistant messages in order", () => {
  const afterUser = appendUserMessage(initialChatState, "hi");
  const state = fold([{ type: "text", data: { delta: "yo" } }], afterUser);
  expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("finish stamps the assistant message serverId from pendingServerId, leaving id unchanged", () => {
  const from: ChatState = { ...initialChatState, pendingServerId: "srv-1" };
  const state = fold(
    [
      { type: "text", data: { delta: "hi" } },
      { type: "finish", data: { reason: "stop" } },
    ],
    from
  );
  const msg = state.messages.find((m) => m.role === "assistant");
  expect(msg?.sealed).toBe(true);
  expect(msg?.serverId).toBe("srv-1");
  // The React-key id stays the client uuid — swapping it would remount the message.
  expect(msg?.id).not.toBe("srv-1");
  // ...and the pending id is consumed so it can't leak onto a later turn's reply.
  expect(state.pendingServerId).toBeUndefined();
});
