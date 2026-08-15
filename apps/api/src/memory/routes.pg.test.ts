import type { PGlite } from "@electric-sql/pglite";
import { EngineMemoryRepo, MAX_KEY_CHARS, MAX_VALUE_CHARS, MemoryService } from "@tulipfarm/memory";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { makeMigratedPglite } from "../test/pglite";

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
  async create(_t: TokenDoc): Promise<void> {}
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

const TEST_CSRF = "a".repeat(64);

type ApiEntry = {
  key: string;
  value: string;
  writtenByAgentId: string | null;
  createdAt: string;
  lastWrittenAt: string;
};

describe("memory routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let repo: EngineMemoryRepo;
  let userId: string;
  let sid: string;
  let otherUserId: string;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    repo = new EngineMemoryRepo(db);
    const service = new MemoryService(repo);

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    userId = member._id;
    sid = await store.create(member._id);
    const other = await createUser(userRepo, "other@example.com", "pass", "member");
    otherUserId = other._id;

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      memoryService: service,
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function seed(uid: string, key: string, value: string, agentId?: string): Promise<void> {
    const now = new Date();
    await repo.upsert({
      _id: `${uid}:${key}`,
      userId: uid,
      key,
      value,
      writtenByAgentId: agentId,
      createdAt: now,
      lastWrittenAt: now,
    });
  }

  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/memory" });
    expect(res.statusCode).toBe(401);
  });

  it("lists only the current user's entries with the value limit", async () => {
    await seed(userId, "preferred_name", "Dhruv", "agent-1");
    await seed(otherUserId, "secret", "not mine");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: ApiEntry[]; maxValueChars: number };
    expect(body.maxValueChars).toBe(MAX_VALUE_CHARS);
    expect(body.entries.map((e) => e.key)).toEqual(["preferred_name"]);
    expect(body.entries[0].writtenByAgentId).toBe("agent-1");
  });

  it("edits a value and preserves the agent attribution", async () => {
    await seed(userId, "preferred_name", "Dhruv", "agent-1");
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/memory/preferred_name",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { value: "DJ" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ApiEntry;
    expect(body.value).toBe("DJ");
    expect(body.writtenByAgentId).toBe("agent-1");
    const stored = await repo.listByUser(userId);
    expect(stored[0].value).toBe("DJ");
    expect(stored[0].writtenByAgentId).toBe("agent-1");
  });

  it("rejects a value over the limit with 422", async () => {
    await seed(userId, "preferred_name", "Dhruv");
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/memory/preferred_name",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { value: "x".repeat(MAX_VALUE_CHARS + 1) },
    });
    expect(res.statusCode).toBe(422);
    const stored = await repo.listByUser(userId);
    expect(stored[0].value).toBe("Dhruv");
  });

  it("upserts a new user-authored key (no agent attribution)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/memory/tone",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { value: "friendly and direct" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ApiEntry;
    expect(body.key).toBe("tone");
    expect(body.value).toBe("friendly and direct");
    expect(body.writtenByAgentId).toBeNull(); // user-authored
    const stored = await repo.listByUser(userId);
    expect(stored.map((e) => e.key)).toContain("tone");
  });

  it("rejects a key over the length limit with 422", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/memory/${encodeURIComponent("k".repeat(MAX_KEY_CHARS + 1))}`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { value: "v" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("setting a key another user owns creates the caller's own, leaving the other untouched", async () => {
    await seed(otherUserId, "secret", "not mine");
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/memory/secret",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { value: "mine now" },
    });
    expect(res.statusCode).toBe(200);
    expect((await repo.listByUser(userId)).find((e) => e.key === "secret")?.value).toBe("mine now");
    expect((await repo.listByUser(otherUserId))[0].value).toBe("not mine"); // isolation holds
  });

  it("deletes an entry and 404s when absent", async () => {
    await seed(userId, "preferred_name", "Dhruv");
    const ok = await app.inject({
      method: "DELETE",
      url: "/api/v1/memory/preferred_name",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });
    expect(ok.statusCode).toBe(204);
    expect(await repo.listByUser(userId)).toHaveLength(0);

    const gone = await app.inject({
      method: "DELETE",
      url: "/api/v1/memory/preferred_name",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("handles keys containing a slash via encodeURIComponent", async () => {
    await seed(userId, "user/preference", "dark mode");
    const enc = encodeURIComponent("user/preference"); // user%2Fpreference

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/memory/${enc}`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { value: "light mode" },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as ApiEntry).value).toBe("light mode");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/memory/${enc}`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });
    expect(del.statusCode).toBe(204);
    expect(await repo.listByUser(userId)).toHaveLength(0);
  });
});
