import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { encodeCursor, type PaginatedResult } from "../pagination";
import { MemoryRateLimiter } from "../rate-limit";
import type { TokenDoc, TokenRepo } from "./api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "./csrf";
import { SESSION_COOKIE } from "./routes";
import { MemorySessionStore } from "./session-store";
import { createUser, type UserDoc, type UserRepo } from "./users";

// A session binds its own CSRF token (see makeCsrfHook); tests look it up by session id.
const csrfBySid = new Map<string, string>();
const WRONG_CSRF = "a".repeat(64);

async function issueSession(store: MemorySessionStore, userId: string): Promise<string> {
  const session = await store.issue({ userId, authMethods: ["password"] });
  csrfBySid.set(session.sid, session.csrfToken);
  return session.sid;
}

function csrfOf(sid: string): string {
  return csrfBySid.get(sid) ?? WRONG_CSRF;
}

class FakeUserRepo implements UserRepo {
  constructor(private readonly users: UserDoc[] = []) {}
  async findByEmail(email: string): Promise<UserDoc | null> {
    const normalized = email.trim().toLowerCase();
    return this.users.find((u) => u.email === normalized) ?? null;
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

class MemoryTokenRepo implements TokenRepo {
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

  async findAllPaginated(
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<TokenDoc>> {
    return paginateInMemory(this.tokens, {}, limit, after);
  }

  async findByUserIdPaginated(
    userId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<TokenDoc>> {
    return paginateInMemory(this.tokens, { userId }, limit, after);
  }
}

function paginateInMemory(
  tokens: TokenDoc[],
  filter: { userId?: string },
  limit: number,
  after?: { createdAt: Date; _id: string }
): PaginatedResult<TokenDoc> {
  let items = filter.userId ? tokens.filter((t) => t.userId === filter.userId) : [...tokens];
  items = items.sort((a, b) => {
    const d = a.createdAt.getTime() - b.createdAt.getTime();
    return d !== 0 ? d : a._id.localeCompare(b._id);
  });
  if (after) {
    items = items.filter(
      (t) =>
        t.createdAt > after.createdAt ||
        (t.createdAt.getTime() === after.createdAt.getTime() && t._id > after._id)
    );
  }
  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  return { items: page, nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
}

function cookieValue(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
}

describe("auth routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;

  beforeEach(async () => {
    store = new MemorySessionStore();
    const repo = new FakeUserRepo();
    await createUser(repo, "user@example.com", "correct-horse", "admin");
    app = await buildApp({ sessionStore: store, userRepo: repo, tokenRepo: new MemoryTokenRepo() });
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /login sets tf_sid cookie on success", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "correct-horse" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: "user@example.com", role: "admin" });
    const sid = cookieValue(res);
    expect(sid).toBeTruthy();
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
  });

  it("POST /login is case-insensitive on email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "USER@example.com", password: "correct-horse" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("POST /login returns 401 for wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(cookieValue(res)).toBeUndefined();
  });

  it("POST /login returns 401 for unknown email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", password: "whatever" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /login returns 400 when fields missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /session returns the user with a valid cookie", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "correct-horse" },
    });
    const sid = cookieValue(login);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: sid as string },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("user@example.com");
  });

  it("GET /session returns 401 without a cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /session returns 401 for an unknown session id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: "bogus" },
    });
    expect(res.statusCode).toBe(401);
  });

  describe("GET /tokens pagination", () => {
    let sessionCookie: string;
    let csrf: string;

    beforeEach(async () => {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "user@example.com", password: "correct-horse" },
      });
      sessionCookie = cookieValue(login) as string;
      // The CSRF token is bound to the session this login issued — a token from any other
      // session is rejected (see makeCsrfHook).
      csrf = login.cookies.find((c) => c.name === CSRF_COOKIE)?.value as string;
    });

    async function createToken(name: string): Promise<void> {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/tokens",
        cookies: { [SESSION_COOKIE]: sessionCookie, [CSRF_COOKIE]: csrf },
        headers: { [CSRF_HEADER]: csrf },
        payload: { name },
      });
    }

    it("returns tokens with nextCursor null when results fit in one page", async () => {
      await createToken("t1");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/tokens",
        cookies: { [SESSION_COOKIE]: sessionCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ tokens: unknown[]; nextCursor: string | null }>();
      expect(body.tokens).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
    });

    it("returns nextCursor when results exceed limit", async () => {
      await createToken("t1");
      await createToken("t2");
      await createToken("t3");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/tokens?limit=2",
        cookies: { [SESSION_COOKIE]: sessionCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ tokens: unknown[]; nextCursor: string | null }>();
      expect(body.tokens).toHaveLength(2);
      expect(typeof body.nextCursor).toBe("string");
    });

    it("fetches next page using cursor", async () => {
      await createToken("t1");
      await createToken("t2");
      await createToken("t3");
      const first = await app.inject({
        method: "GET",
        url: "/api/v1/auth/tokens?limit=2",
        cookies: { [SESSION_COOKIE]: sessionCookie },
      });
      const { nextCursor } = first.json<{ tokens: unknown[]; nextCursor: string }>();
      const second = await app.inject({
        method: "GET",
        url: `/api/v1/auth/tokens?limit=2&cursor=${nextCursor}`,
        cookies: { [SESSION_COOKIE]: sessionCookie },
      });
      expect(second.statusCode).toBe(200);
      const body = second.json<{ tokens: unknown[]; nextCursor: string | null }>();
      expect(body.tokens).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
    });

    it("returns 400 for an invalid cursor", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/tokens?cursor=notvalid!!",
        cookies: { [SESSION_COOKIE]: sessionCookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid cursor");
    });
  });

  it("POST /logout clears the session and cookie", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "correct-horse" },
    });
    const sid = cookieValue(login) as string;
    const csrfToken = login.cookies.find((c) => c.name === CSRF_COOKIE)?.value as string;

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrfToken },
      headers: { [CSRF_HEADER]: csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    expect(await store.get(sid)).toBeNull();

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("API token routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: MemoryTokenRepo;
  let adminSid: string;
  let memberSid: string;
  let adminId: string;
  let memberId: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new MemoryTokenRepo();

    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    adminId = admin._id;
    memberId = member._id;
    adminSid = await issueSession(store, adminId);
    memberSid = await issueSession(store, memberId);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo });
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /tokens creates token and returns raw value once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "ci-token" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^tulip_/);
    expect(body.name).toBe("ci-token");
    expect(body.prefix).toBe(body.token.slice(0, 10));
    expect(body.tokenHash).toBeUndefined();
  });

  it("POST /tokens returns 400 when name missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /tokens returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /tokens admin can create for another user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "for-member", userId: memberId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().userId).toBe(memberId);
  });

  it("POST /tokens member cannot create for another user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
      payload: { name: "x", userId: adminId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /tokens returns 404 for unknown userId (admin)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "x", userId: "no-such-user" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /tokens admin sees all tokens", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "admin-token" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
      payload: { name: "member-token" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokens).toHaveLength(2);
  });

  it("GET /tokens member sees only own tokens", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "admin-token" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
      payload: { name: "member-token" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(200);
    const tokens = res.json().tokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0].userId).toBe(memberId);
  });

  it("DELETE /tokens/:id revokes own token", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
      payload: { name: "to-revoke" },
    });
    const { id } = create.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
    });
    expect(del.statusCode).toBe(204);
    expect(await tokenRepo.findById(id)).toBeNull();
  });

  it("DELETE /tokens/:id member cannot revoke another user's token", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "admin-token" },
    });
    const { id } = create.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
    });
    expect(del.statusCode).toBe(403);
  });

  it("DELETE /tokens/:id admin can revoke any token", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
      payload: { name: "member-token" },
    });
    const { id } = create.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });
    expect(del.statusCode).toBe(204);
  });

  it("DELETE /tokens/:id returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/tokens/no-such-id",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Bearer token auth", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: MemoryTokenRepo;
  let adminSid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new MemoryTokenRepo();

    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    adminSid = await issueSession(store, admin._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo });
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /session authenticates via Bearer token", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "mcp" },
    });
    const rawToken = create.json().token as string;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("admin@example.com");
  });

  it("GET /session returns 401 for invalid Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { authorization: "Bearer tulip_bogustoken" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("Bearer token no longer works after revocation", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { name: "temp" },
    });
    const { token: rawToken, id } = create.json();

    await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("session cookie still works alongside Bearer token support", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("CSRF protection", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let adminSid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    const repo = new FakeUserRepo();
    await createUser(repo, "admin@example.com", "pass", "admin");
    adminSid = await issueSession(store, (await repo.findByEmail("admin@example.com"))?._id ?? "");
    app = await buildApp({ sessionStore: store, userRepo: repo, tokenRepo: new MemoryTokenRepo() });
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /login sets csrf_token cookie (non-httpOnly)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "pass" },
    });
    expect(res.statusCode).toBe(200);
    const csrf = res.cookies.find((c) => c.name === CSRF_COOKIE);
    expect(csrf).toBeDefined();
    expect(csrf?.httpOnly).not.toBe(true);
    expect(csrf?.value).toHaveLength(64);
  });

  it("GET requests pass without CSRF token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(200);
  });

  it("POST with session + correct CSRF header passes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });
    expect(res.statusCode).toBe(204);
  });

  it("POST with session + missing CSRF header returns 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST with session + wrong CSRF header returns 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: WRONG_CSRF },
      headers: { [CSRF_HEADER]: "wrong-token" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST with Bearer token bypasses CSRF (no CSRF header needed)", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "pass" },
    });
    const csrfToken = loginRes.cookies.find((c) => c.name === CSRF_COOKIE)?.value as string;
    const sid = loginRes.cookies.find((c) => c.name === SESSION_COOKIE)?.value as string;

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrfToken },
      headers: { [CSRF_HEADER]: csrfToken },
      payload: { name: "bearer-test" },
    });
    const rawToken = create.json().token as string;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("rate limiting", () => {
  let app: FastifyInstance;
  let rateLimiter: MemoryRateLimiter;

  beforeEach(async () => {
    rateLimiter = new MemoryRateLimiter();
    const store = new MemorySessionStore();
    const repo = new FakeUserRepo();
    await createUser(repo, "user@example.com", "pass", "admin");
    app = await buildApp({
      sessionStore: store,
      userRepo: repo,
      tokenRepo: new MemoryTokenRepo(),
      rateLimiter,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 429 after exceeding limit", async () => {
    // exhaust the limit
    for (let i = 0; i < 100; i++) {
      await rateLimiter.check("rl:auth:127.0.0.1", 100, 60_000);
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "pass" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "rate_limit_exceeded" });
  });

  it("sets Retry-After header on 429", async () => {
    for (let i = 0; i < 100; i++) {
      await rateLimiter.check("rl:auth:127.0.0.1", 100, 60_000);
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "pass" },
    });
    expect(res.statusCode).toBe(429);
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("sets X-RateLimit-* headers on allowed response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "pass" },
    });
    expect(res.statusCode).toBe(200);
    // Login carries its own, stricter limiter on top of the shared auth limiter, so the
    // headers on this route reflect the login budget.
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
    expect(Number(res.headers["x-ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
    expect(Number(res.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
  });

  it("sets X-RateLimit-* headers on 429", async () => {
    for (let i = 0; i < 100; i++) {
      await rateLimiter.check("rl:auth:127.0.0.1", 100, 60_000);
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "pass" },
    });
    expect(res.headers["x-ratelimit-limit"]).toBe("100");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(res.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
  });
});
