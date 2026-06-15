import { describe, expect, test } from "vitest";
import type { ChatMessage } from "~/lib/chat/types";
import { a2uiAgentToSend, seedState } from "~/lib/chat/use-chat-stream";

describe("a2uiAgentToSend", () => {
  test("maps a choice payload to a user turn using the label", () => {
    expect(a2uiAgentToSend({ kind: "choice", value: "staging", label: "Staging" })).toEqual({
      text: "Staging",
    });
  });

  test("falls back to the choice value when no label is present", () => {
    expect(a2uiAgentToSend({ kind: "choice", value: "staging" })).toEqual({ text: "staging" });
  });

  test("maps a suggest_agent payload to a turn that switches the agent", () => {
    expect(
      a2uiAgentToSend({ kind: "suggest_agent", agentId: "billing", label: "Switch to Billing" })
    ).toEqual({ text: "Switch to Billing", opts: { agentId: "billing" } });
  });

  test("maps an a2ui-form submit to a readable markdown list (humanized keys, Yes/No booleans)", () => {
    expect(
      a2uiAgentToSend({
        kind: "a2ui-form",
        event: "answer",
        data: { city: "Pune", emailNotifications: false },
      })
    ).toEqual({ text: "- **City:** Pune\n- **Email Notifications:** No" });
  });

  test("maps an empty a2ui-form submit to a non-empty placeholder turn", () => {
    expect(a2uiAgentToSend({ kind: "a2ui-form", event: "answer" })).toEqual({
      text: "(submitted)",
    });
  });

  test("maps an a2ui-action to the event (with payload when present)", () => {
    expect(a2uiAgentToSend({ kind: "a2ui-action", event: "approve" })).toEqual({ text: "approve" });
    expect(a2uiAgentToSend({ kind: "a2ui-action", event: "approve", payload: { id: 7 } })).toEqual({
      text: 'approve {"id":7}',
    });
  });

  test("ignores unknown / malformed payloads", () => {
    expect(a2uiAgentToSend(null)).toBeNull();
    expect(a2uiAgentToSend({ kind: "choice" })).toBeNull();
    expect(a2uiAgentToSend({ kind: "other", label: "x" })).toBeNull();
    expect(a2uiAgentToSend({ kind: "a2ui-action" })).toBeNull();
    expect(a2uiAgentToSend("nope")).toBeNull();
  });
});

describe("seedState", () => {
  const seeded: ChatMessage[] = [
    { id: "m1", role: "user", parts: [{ kind: "text", text: "hi" }], sealed: true },
  ];

  test("with no options it is the empty idle timeline", () => {
    expect(seedState()).toEqual({ messages: [], pendingApprovals: {}, status: "idle" });
  });

  test("an initial conversation id seeds the id but no messages", () => {
    expect(seedState({ initialConversationId: "c1" })).toEqual({
      messages: [],
      pendingApprovals: {},
      status: "idle",
      conversationId: "c1",
    });
  });

  test("initial messages seed a sealed, idle transcript bound to the conversation id", () => {
    const state = seedState({ initialConversationId: "c1", initialMessages: seeded });
    expect(state.status).toBe("idle");
    expect(state.conversationId).toBe("c1");
    expect(state.messages).toEqual(seeded);
  });
});
