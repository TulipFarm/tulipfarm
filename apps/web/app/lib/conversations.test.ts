import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversation, getConversationMessages, listConversations } from "./conversations";

type Call = { url: string; init: RequestInit };

function mockFetch(responder: (url: string) => unknown): Call[] {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => responder(url) } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("conversations client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listConversations GETs the list and unwraps `conversations`", async () => {
    const calls = mockFetch(() => ({
      conversations: [
        { id: "c1", title: "Inventory", agentId: null, createdAt: "t", updatedAt: "t" },
      ],
    }));
    const out = await listConversations();
    expect(calls[0].url).toContain("/api/v1/conversations");
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Inventory");
  });

  it("getConversation GETs a single conversation by id", async () => {
    const calls = mockFetch(() => ({
      id: "c1",
      title: "Inventory",
      agentId: "GeneralAssistant",
      userId: "u1",
      model: null,
      createdAt: "t",
      updatedAt: "t",
    }));
    const out = await getConversation("c1");
    expect(calls[0].url).toContain("/api/v1/conversations/c1");
    expect(out.agentId).toBe("GeneralAssistant");
  });

  it("getConversationMessages GETs the messages and unwraps `messages`", async () => {
    const calls = mockFetch(() => ({
      messages: [{ _id: "m1", conversationId: "c1", role: "user", content: "hi", createdAt: "t" }],
      nextCursor: null,
    }));
    const out = await getConversationMessages("c1");
    expect(calls[0].url).toContain("/api/v1/conversations/c1/messages");
    expect(out[0].role).toBe("user");
  });

  it("url-encodes the conversation id", async () => {
    const calls = mockFetch(() => ({
      id: "a/b",
      title: null,
      agentId: null,
      userId: null,
      model: null,
      createdAt: "t",
      updatedAt: "t",
    }));
    await getConversation("a/b");
    expect(calls[0].url).toContain("/api/v1/conversations/a%2Fb");
  });
});
