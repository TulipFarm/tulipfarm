import { describe, expect, test } from "vitest";
import { a2uiAgentToSend } from "~/lib/chat/use-chat-stream";

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

  test("ignores unknown / malformed payloads", () => {
    expect(a2uiAgentToSend(null)).toBeNull();
    expect(a2uiAgentToSend({ kind: "choice" })).toBeNull();
    expect(a2uiAgentToSend({ kind: "other", label: "x" })).toBeNull();
    expect(a2uiAgentToSend("nope")).toBeNull();
  });
});
