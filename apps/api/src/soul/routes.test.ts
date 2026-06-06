import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { type UserDoc, type UserRepo, createUser } from "../auth/users";
import type { PaginatedResult } from "../pagination";

const TEST_CSRF = "a".repeat(64);

// ── Fake dependencies ─────────────────────────────────────────────────────────

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
  private tokens: TokenDoc[] = [];
  async create(token: TokenDoc): Promise<void> {
    this.tokens.push(token);
  }
  async findByHash(hash: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async findByUserId(userId: string): Promise<TokenDoc[]> {
    return this.tokens.filter((t) => t.userId === userId);
  }
  async findAll(): Promise<TokenDoc[]> {
    return [...this.tokens];
  }
  async findById(id: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(id: string): Promise<void> {
    this.tokens = this.tokens.filter((t) => t._id !== id);
  }
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

function makeFakeGitSync(overrides: Partial<{ commit: unknown; push: unknown }> = {}) {
  return {
    commit: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 2 }),
    push: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as GitSyncService;
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("soul routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let gitSync: GitSyncService;
  let sid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    gitSync = makeFakeGitSync();

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── POST /api/v1/soul/commit ──────────────────────────────────────────────

  describe("POST /api/v1/soul/commit", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        payload: { message: "chore: update soul" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with sha and filesChanged on successful commit", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { message: "chore: update soul" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sha: "abc1234", filesChanged: 2 });
    });

    it("returns 204 when nothing to commit (empty sha)", async () => {
      gitSync = makeFakeGitSync({
        commit: vi.fn().mockResolvedValue({ sha: "", filesChanged: 0 }),
      });
      await app.close();
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { message: "chore: update soul" },
      });
      expect(res.statusCode).toBe(204);
    });

    it("returns 400 when message is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/commit",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /api/v1/soul/push ────────────────────────────────────────────────

  describe("POST /api/v1/soul/push", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/soul/push" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with pushed: true when remote is configured", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/push",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pushed: true });
    });

    it("returns 200 with pushed: false when no remote configured", async () => {
      gitSync = makeFakeGitSync({ push: vi.fn().mockResolvedValue(false) });
      await app.close();
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/soul/push",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pushed: false });
    });
  });
});
