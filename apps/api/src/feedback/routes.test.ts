import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { FeedbackRepo } from "./repo";

const TEST_CSRF = "a".repeat(64);
const mutate = { [CSRF_COOKIE]: TEST_CSRF };
const csrfHeader = { [CSRF_HEADER]: TEST_CSRF };

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  async create(): Promise<void> {}
  async findByHash(): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

describe("feedback routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let sid: string;
  let conversationId: string;
  let messageId: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    conversationId = randomUUID();
    messageId = randomUUID();
    await db.query(
      "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
      [conversationId, user._id]
    );
    await db.query(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, 'assistant', $3::jsonb, now())",
      [messageId, conversationId, JSON.stringify("hi there")]
    );

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      feedbackRepo: new FeedbackRepo(db),
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const authed = (extra: Record<string, string> = {}) => ({ [SESSION_COOKIE]: sid, ...extra });

  it("401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${messageId}/feedback`,
      payload: { rating: "up" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400 for an invalid rating", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${messageId}/feedback`,
      cookies: authed(mutate),
      headers: csrfHeader,
      payload: { rating: "meh" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404 for a message that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${randomUUID()}/feedback`,
      cookies: authed(mutate),
      headers: csrfHeader,
      payload: { rating: "up" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("records a vote (with note) and the GET reflects it; DELETE clears it", async () => {
    const post = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${messageId}/feedback`,
      cookies: authed(mutate),
      headers: csrfHeader,
      payload: { rating: "down", note: "too long" },
    });
    expect(post.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/feedback`,
      cookies: authed(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({
      feedback: [{ messageId, rating: "down", note: "too long" }],
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${messageId}/feedback`,
      cookies: authed(mutate),
      headers: csrfHeader,
    });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/feedback`,
      cookies: authed(),
    });
    expect(after.json()).toEqual({ feedback: [] });
  });
});
