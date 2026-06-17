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
import { PgKvRepo } from "./repo";
import { KvService } from "./service";

const TEST_CSRF = "a".repeat(64);
const write = (sid: string) => ({
  cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
  headers: { [CSRF_HEADER]: TEST_CSRF },
});

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

describe("kv routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let kvService: KvService;
  let store: MemorySessionStore;
  let adminSid: string;
  let memberSid: string;
  let otherSid: string;
  let memberId: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    kvService = new KvService(new PgKvRepo(db));

    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    const other = await createUser(userRepo, "other@example.com", "pass", "member");
    memberId = member._id;
    adminSid = await store.create(admin._id);
    memberSid = await store.create(member._id);
    otherSid = await store.create(other._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, kvService });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  // ── User scope ──────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/kv/prefs/theme" });
    expect(res.statusCode).toBe(401);
  });

  it("round-trips a user entry through PUT then GET", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/kv/prefs/theme",
      ...write(memberSid),
      payload: { value: { mode: "dark" } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ namespace: "prefs", key: "theme" });

    const get = await app.inject({
      method: "GET",
      url: "/api/v1/kv/prefs/theme",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ namespace: "prefs", key: "theme", value: { mode: "dark" } });
  });

  it("isolates users: another user cannot read the same path", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/kv/prefs/theme",
      ...write(memberSid),
      payload: { value: "mine" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/kv/prefs/theme",
      cookies: { [SESSION_COOKIE]: otherSid },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for an oversize value", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/kv/prefs/big",
      ...write(memberSid),
      payload: { value: "x".repeat(256 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("honors expiry on the read path (lazy)", async () => {
    // Seed an already-expired entry directly through the service, then read via the route.
    await kvService.set("user", memberId, "prefs", "ghost", "v", new Date(Date.now() - 1000));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/kv/prefs/ghost",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE is idempotent (204 twice)", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/kv/prefs/temp",
      ...write(memberSid),
      payload: { value: 1 },
    });
    const d1 = await app.inject({
      method: "DELETE",
      url: "/api/v1/kv/prefs/temp",
      ...write(memberSid),
    });
    const d2 = await app.inject({
      method: "DELETE",
      url: "/api/v1/kv/prefs/temp",
      ...write(memberSid),
    });
    expect(d1.statusCode).toBe(204);
    expect(d2.statusCode).toBe(204);
  });

  it("lists entries in a namespace", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/kv/n/a",
      ...write(memberSid),
      payload: { value: 1 },
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/kv/n/b",
      ...write(memberSid),
      payload: { value: 2 },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/kv/n",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.map((e: { key: string }) => e.key)).toEqual(["a", "b"]);
  });

  // ── Admin / system scope ──────────────────────────────────────────────────────

  it("forbids non-admins from the system keyspace (403)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/kv/cfg/flag",
      ...write(memberSid),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets an admin write and read the system keyspace; repeated PUT updates in place", async () => {
    const put1 = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/kv/cfg/flag",
      ...write(adminSid),
      payload: { value: { enabled: false } },
    });
    expect(put1.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/kv/cfg/flag",
      ...write(adminSid),
      payload: { value: { enabled: true } },
    });

    const get = await app.inject({
      method: "GET",
      url: "/api/v1/admin/kv/cfg/flag",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ value: { enabled: true } });

    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM kv_store WHERE scope = 'system'"
    );
    expect(Number((rows[0] as { n: number }).n)).toBe(1);
  });

  it("keeps user and system keyspaces separate (same namespace/key)", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/kv/cfg/flag",
      ...write(memberSid),
      payload: { value: "user-value" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/kv/cfg/flag",
      ...write(adminSid),
      payload: { value: "system-value" },
    });
    const userGet = await app.inject({
      method: "GET",
      url: "/api/v1/kv/cfg/flag",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(userGet.json().value).toBe("user-value");
  });
});
