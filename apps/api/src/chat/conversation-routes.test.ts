import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserDoc } from "../auth/users";
import { registerConversationRoutes } from "./conversation-routes";
import type { ConversationDeleteOutcome, ConversationRepo } from "./conversations";
import type { MessageRepo } from "./messages";

describe("conversation deletion route", () => {
  let app: FastifyInstance;
  let outcome: ConversationDeleteOutcome;
  const deleteOwned = vi.fn<ConversationRepo["deleteOwned"]>(async () => outcome);

  beforeEach(async () => {
    outcome = "deleted";
    app = Fastify();
    const repo = { deleteOwned } as unknown as ConversationRepo;
    registerConversationRoutes(app, { repo, messageRepo: {} as MessageRepo }, async (request) => {
      request.user = { _id: "user-1" } as UserDoc;
    });
    await app.ready();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it("returns 204 after an owner-scoped delete", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/v1/chats/chat-1" });

    expect(response.statusCode).toBe(204);
    expect(deleteOwned).toHaveBeenCalledWith("chat-1", "user-1");
  });

  it("returns the same 404 for a missing or foreign chat", async () => {
    outcome = "not_found";

    const response = await app.inject({ method: "DELETE", url: "/api/v1/chats/chat-1" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "conversation not found" });
  });

  it("returns 409 while a Turn is active", async () => {
    outcome = "active_turn";

    const response = await app.inject({ method: "DELETE", url: "/api/v1/chats/chat-1" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Turn in progress");
  });
});

/**
 * The response schema is the reader's contract. A part shape it does not enumerate is not merely
 * dropped — fast-json-stringify fails the whole response, so one attachment would make an entire
 * conversation unloadable.
 */
describe("listing messages that carry an attachment", () => {
  let app: FastifyInstance;
  let present: Set<string>;

  async function build(withFiles: boolean): Promise<FastifyInstance> {
    const instance = Fastify();
    const repo = {
      findById: async () => ({ _id: "chat-1", userId: "user-1" }),
    } as unknown as ConversationRepo;
    const messageRepo = {
      listByConversation: async () => ({
        items: [
          {
            _id: "message-1",
            conversationId: "chat-1",
            role: "user" as const,
            content: [
              { type: "text", text: "what is this?" },
              { type: "file", fileId: "f1", mediaType: "image/png", name: "shot.png" },
            ],
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
        nextCursor: null,
      }),
    } as unknown as MessageRepo;
    registerConversationRoutes(
      instance,
      {
        repo,
        messageRepo,
        ...(withFiles ? { files: { presentFor: async () => present as ReadonlySet<string> } } : {}),
      },
      async (request) => {
        request.user = { _id: "user-1" } as UserDoc;
      }
    );
    await instance.ready();
    return instance;
  }

  beforeEach(async () => {
    present = new Set(["f1"]);
    app = await build(true);
  });

  afterEach(async () => {
    await app.close();
  });

  it("serializes the file part instead of failing the whole page", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/chats/chat-1/messages" });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "file", fileId: "f1", mediaType: "image/png", name: "shot.png" },
    ]);
  });

  // A destroyed File cannot be edited out of the Message that named it, so the reference has to
  // survive the page in a shape the schema enumerates — otherwise deleting one attachment would
  // make the whole conversation unloadable, which is the failure this describe block exists for.
  it("substitutes an attachment the reader can no longer open", async () => {
    present = new Set();

    const response = await app.inject({ method: "GET", url: "/api/v1/chats/chat-1/messages" });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "file-unavailable", fileId: "f1", name: "shot.png" },
    ]);
  });

  it("treats every attachment as removed where no Files service is wired at all", async () => {
    const bare = await build(false);
    try {
      const response = await bare.inject({ method: "GET", url: "/api/v1/chats/chat-1/messages" });

      expect(response.json().messages[0].content[1]).toMatchObject({ type: "file-unavailable" });
    } finally {
      await bare.close();
    }
  });
});
