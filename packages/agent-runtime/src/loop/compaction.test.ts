import { contentText, textContent } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { type ContextCompactorPort, compactModelContext } from "./compaction";

describe("compactModelContext", () => {
  it("keeps trusted instructions and the latest request while replacing older history with a real summary", async () => {
    const compact: ContextCompactorPort["compact"] = vi
      .fn()
      .mockResolvedValue("The earlier attempt failed after reading ticket T-42.");
    const messages = [
      { role: "system" as const, content: textContent("trusted instructions") },
      { role: "user" as const, content: textContent(`old request ${"x".repeat(12_000)}`) },
      { role: "assistant" as const, content: textContent("old answer") },
      { role: "user" as const, content: textContent("finish ticket T-42") },
    ];

    const result = await compactModelContext({
      requestId: "run:state:compact:1",
      modelProfileId: "primary",
      messages,
      sourceMessageIds: [null, "message-old-request", "message-old-answer", "message-current"],
      pinnedMessageCount: 1,
      budgetTokens: 2_000,
      compactor: { compact },
      signal: new AbortController().signal,
    });

    expect(compact).toHaveBeenCalled();
    const requests = vi.mocked(compact).mock.calls.map(([request]) => request);
    expect(requests.at(-1)).toMatchObject({
      modelProfileId: "primary",
      throughMessageId: "message-old-answer",
    });
    expect(requests.every((request) => !("focus" in request))).toBe(true);
    expect(requests.every((request) => request.maxOutputTokens <= 1_200)).toBe(true);
    expect(result?.[0]).toEqual(messages[0]);
    expect(result?.some((message) => contentText(message.content) === "finish ticket T-42")).toBe(
      true
    );
    expect(result?.map((message) => contentText(message.content)).join("\n")).toContain(
      "The earlier attempt failed after reading ticket T-42."
    );
  });

  it("never leaves a Tool result without its assistant Tool call when keeping the recent tail", async () => {
    const messages = [
      { role: "system" as const, content: textContent("trusted") },
      { role: "user" as const, content: textContent("investigate") },
      {
        role: "assistant" as const,
        content: textContent(
          JSON.stringify({ toolCalls: [{ callId: "old", name: "search", arguments: {} }] })
        ),
      },
      { role: "tool" as const, content: textContent("x".repeat(6_000)) },
      {
        role: "assistant" as const,
        content: textContent(
          JSON.stringify({ toolCalls: [{ callId: "recent", name: "read", arguments: {} }] })
        ),
      },
      { role: "tool" as const, content: textContent("recent result") },
    ];

    const result = await compactModelContext({
      requestId: "run:state:compact:2",
      modelProfileId: "primary",
      messages,
      pinnedMessageCount: 1,
      budgetTokens: 1_300,
      compactor: { compact: async () => "Earlier Tool activity was compacted." },
      signal: new AbortController().signal,
    });

    const roles = result?.map((message) => message.role);
    expect(roles?.slice(-2)).toEqual(["assistant", "tool"]);
    expect(contentText(result?.at(-1)?.content ?? [])).toBe("recent result");
  });

  it("summarizes an oversized legacy Message in bounded chronological requests", async () => {
    const compact: ContextCompactorPort["compact"] = vi
      .fn()
      .mockResolvedValue("The launch code remains ORCHID-71.");
    const messages = [
      { role: "system" as const, content: textContent("trusted") },
      {
        role: "user" as const,
        content: textContent(`Keep ORCHID-71 for later. ${"x".repeat(30_000)}`),
      },
      { role: "assistant" as const, content: textContent("I will retain that fact.") },
      { role: "user" as const, content: textContent("Now answer an unrelated question.") },
    ];

    await compactModelContext({
      requestId: "run:state:compact:legacy",
      modelProfileId: "primary",
      messages,
      sourceMessageIds: [null, "message-fact", "message-answer", "message-current"],
      pinnedMessageCount: 1,
      budgetTokens: 2_000,
      compactor: { compact },
      signal: new AbortController().signal,
    });

    const requests = vi.mocked(compact).mock.calls.map(([request]) => request);
    expect(requests.length).toBeGreaterThan(2);
    expect(
      requests.every(
        (request) =>
          request.messages.reduce(
            (characters, message) => characters + contentText(message.content).length,
            0
          ) /
            4 +
            request.maxOutputTokens <
          2_000
      )
    ).toBe(true);
    expect(requests.slice(0, -1).every((request) => request.throughMessageId === undefined)).toBe(
      true
    );
    expect(requests.at(-1)?.throughMessageId).toBe("message-answer");
  });
});
