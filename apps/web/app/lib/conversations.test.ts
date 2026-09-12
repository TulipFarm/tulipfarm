import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteConversation,
  getConversation,
  getConversationMessages,
  listConversations,
  renameConversation,
  setConversationStarred,
} from "./conversations";

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
        {
          id: "c1",
          title: "Inventory",
          agentId: null,
          starred: false,
          createdAt: "t",
          updatedAt: "t",
        },
      ],
    }));
    const out = await listConversations();
    expect(calls[0].url).toMatch(/\/api\/v1\/chats$/);
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Inventory");
  });

  it("listConversations encodes `q` and `limit` into the query string", async () => {
    const calls = mockFetch(() => ({ conversations: [] }));
    await listConversations({ q: "budget review", limit: 200 });
    expect(calls[0].url).toContain("q=budget+review");
    expect(calls[0].url).toContain("limit=200");
  });

  it("renameConversation PUTs the new title to the conversation", async () => {
    const calls = mockFetch(() => ({
      id: "c1",
      title: "Renamed",
      agentId: null,
      starred: false,
      createdAt: "t",
      updatedAt: "t",
    }));
    const out = await renameConversation("c1", "Renamed");
    expect(calls[0].url).toContain("/api/v1/chats/c1");
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ title: "Renamed" });
    expect(out.title).toBe("Renamed");
  });

  it("setConversationStarred PUTs the starred flag to the conversation", async () => {
    const calls = mockFetch(() => ({
      id: "c1",
      title: "Inventory",
      agentId: null,
      starred: true,
      createdAt: "t",
      updatedAt: "t",
    }));
    const out = await setConversationStarred("c1", true);
    expect(calls[0].url).toContain("/api/v1/chats/c1");
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ starred: true });
    expect(out.starred).toBe(true);
  });

  it("deleteConversation DELETEs the encoded conversation id", async () => {
    const calls = mockFetch(() => null);

    await deleteConversation("a/b");

    expect(calls[0].url).toContain("/api/v1/chats/a%2Fb");
    expect(calls[0].init.method).toBe("DELETE");
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
    expect(calls[0].url).toContain("/api/v1/chats/c1");
    expect(out.agentId).toBe("GeneralAssistant");
  });

  it("getConversationMessages GETs the messages and unwraps `messages`", async () => {
    const calls = mockFetch(() => ({
      messages: [{ _id: "m1", conversationId: "c1", role: "user", content: "hi", createdAt: "t" }],
      nextCursor: null,
    }));
    const out = await getConversationMessages("c1");
    expect(calls[0].url).toContain("/api/v1/chats/c1/messages");
    expect(out[0].role).toBe("user");
  });

  it("loads every Message page in chronological order", async () => {
    const calls = mockFetch((url) =>
      url.includes("cursor=page-2")
        ? {
            messages: [
              {
                _id: "m2",
                conversationId: "c1",
                role: "assistant",
                content: "done",
                createdAt: "t2",
              },
              {
                _id: "m3",
                conversationId: "c1",
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "record_list",
                    result: { status: "ok" },
                  },
                ],
                createdAt: "t3",
              },
            ],
            nextCursor: null,
          }
        : {
            messages: [
              {
                _id: "m1",
                conversationId: "c1",
                role: "user",
                content: "check",
                createdAt: "t1",
              },
            ],
            nextCursor: "page-2",
          }
    );

    const out = await getConversationMessages("c1");

    expect(out.map((message) => message._id)).toEqual(["m1", "m2", "m3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("limit=100");
    expect(calls[1].url).toContain("cursor=page-2");
  });

  it("surfaces a later Message page failure instead of returning partial history", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              {
                _id: "m1",
                conversationId: "c1",
                role: "user",
                content: "check",
                createdAt: "t1",
              },
            ],
            nextCursor: "page-2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "message page unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConversationMessages("c1")).rejects.toThrow("message page unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails when the Message API repeats a cursor", async () => {
    mockFetch(() => ({ messages: [], nextCursor: "same-page" }));

    await expect(getConversationMessages("c1")).rejects.toThrow(
      "The Message API repeated its pagination cursor."
    );
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
    expect(calls[0].url).toContain("/api/v1/chats/a%2Fb");
  });
});
