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
