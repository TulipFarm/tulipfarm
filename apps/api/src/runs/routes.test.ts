import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { RunEventRecord, RunStreamGrant } from "./events";

const TEST_CSRF = "a".repeat(64);
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const BUSINESS_ID = "business-1";

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((user) => user.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((user) => user._id === id) ?? null;
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

function event(sequence: number): RunEventRecord {
  return {
    sequence,
    eventType: "state.transitioned",
    audience: "participant",
    payload: { stateKey: "apply", status: "succeeded" },
    occurredAt: "2026-07-25T10:00:00.000Z",
  };
}

describe("GET /api/v1/runs/:id/events", () => {
  let app: FastifyInstance;
  let sid: string;
  let grant: RunStreamGrant | null;
  let runStatus: string | null;

  beforeEach(async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);
    grant = { businessId: BUSINESS_ID, audiences: ["participant"] };
    runStatus = "succeeded";

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      runEvents: {
        events: {
          async list(_businessId, _runId, options) {
            return [event(1), event(2)].filter((entry) => entry.sequence > options.after);
          },
        },
        runs: {
          async find() {
            return runStatus === null ? null : { status: runStatus };
          },
        },
        authorize: async () => grant,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const authed = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });

  it("streams the persisted events with resume cursors", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events`,
      cookies: authed(),
    });

    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.payload).toContain("id: 1\nevent: state.transitioned\n");
    expect(res.payload).toContain("id: 2\nevent: state.transitioned\n");
    expect(res.payload).toContain("event: stream.closed");
  });

  it("resumes strictly after the requested cursor", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events?after=1`,
      cookies: authed(),
    });

    expect(res.payload).not.toContain("id: 1\nevent: state.transitioned");
    expect(res.payload).toContain("id: 2\nevent: state.transitioned");
  });

  it("resumes from the Last-Event-ID header when no cursor is given", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events`,
      cookies: authed(),
      headers: { "last-event-id": "1" },
    });

    expect(res.payload).not.toContain("id: 1\nevent: state.transitioned");
    expect(res.payload).toContain("id: 2\nevent: state.transitioned");
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/runs/${RUN_ID}/events` });

    expect(res.statusCode).toBe(401);
  });

  it("denies a caller with no grant for the Run", async () => {
    grant = null;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events`,
      cookies: authed(),
    });

    expect(res.statusCode).toBe(403);
  });

  it("rate-limits how fast one client may open streams", async () => {
    const seen: Array<{ key: string; limit: number; windowMs: number }> = [];
    const limited = await buildApp({
      sessionStore: new MemorySessionStore(),
      userRepo: new FakeUserRepo(),
      tokenRepo: new FakeTokenRepo(),
      rateLimiter: {
        async check(key, limit, windowMs) {
          seen.push({ key, limit, windowMs });
          return { allowed: false, limit, remaining: 0, resetAt: Date.now() + windowMs };
        },
      },
      runEvents: {
        events: {
          async list() {
            return [];
          },
        },
        runs: {
          async find() {
            return { status: "succeeded" };
          },
        },
        authorize: async () => grant,
      },
    });

    const res = await limited.inject({ method: "GET", url: `/api/v1/runs/${RUN_ID}/events` });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "rate_limit_exceeded" });
    expect(seen).toEqual([{ key: "rl:run-events:127.0.0.1", limit: 30, windowMs: 60_000 }]);
    await limited.close();
  });

  it("reports an unknown Run before opening a stream", async () => {
    runStatus = null;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events`,
      cookies: authed(),
    });

    expect(res.statusCode).toBe(404);
  });
});
