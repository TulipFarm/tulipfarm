import { encodeCursor, type PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { MemoryRateLimiter } from "../rate-limit";
import type { TokenDoc, TokenRepo } from "./api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "./csrf";
import { hashInviteToken, type UserInviteDoc, type UserInviteRepo } from "./invites";
import { SESSION_COOKIE } from "./routes";
import { MemorySessionStore } from "./session-store";
import {
  createUser,
  EmailAlreadyExistsError,
  inviteUser,
  type PasswordWriteRepo,
  type UserAdminRepo,
  type UserDoc,
  type UserRepo,
} from "./users";

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

class FakeUserRepo implements UserRepo, UserAdminRepo, PasswordWriteRepo {
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
    if (this.users.some((u) => u.email === user.email)) {
      throw new EmailAlreadyExistsError();
    }
    this.users.push(user);
  }
  async listAll(): Promise<UserDoc[]> {
    return [...this.users];
  }
  async setStatus(id: string, status: UserDoc["status"]): Promise<void> {
    const user = this.users.find((u) => u._id === id);
    if (user) user.status = status;
  }
  async setPassword(id: string, passwordHash: string): Promise<void> {
    const user = this.users.find((u) => u._id === id);
    if (user) {
      user.passwordHash = passwordHash;
      user.status = "active";
    }
  }
  async setName(id: string, name: string | null): Promise<void> {
    const user = this.users.find((u) => u._id === id);
    if (user) user.name = name;
  }
}

class FakeInviteRepo implements UserInviteRepo {
  readonly invites: UserInviteDoc[] = [];

  async create(invite: UserInviteDoc): Promise<void> {
    this.invites.push(invite);
  }
  async deleteUnconsumedForUser(userId: string): Promise<void> {
    for (let i = this.invites.length - 1; i >= 0; i--) {
      const invite = this.invites[i];
      if (invite.userId === userId && invite.consumedAt === null) this.invites.splice(i, 1);
    }
  }
  private live(tokenHash: string): UserInviteDoc | undefined {
    return this.invites.find(
      (i) => i.tokenHash === tokenHash && i.consumedAt === null && i.expiresAt > new Date()
    );
  }
  async find(tokenHash: string): Promise<UserInviteDoc | null> {
    return this.live(tokenHash) ?? null;
  }
  async consume(tokenHash: string): Promise<UserInviteDoc | null> {
    const invite = this.live(tokenHash);
    if (!invite) return null;
    invite.consumedAt = new Date();
    return invite;
  }
  /** Backdates a live invite so expiry can be exercised without waiting a week. */
  expire(token: string): void {
    const invite = this.invites.find((i) => i.tokenHash === hashInviteToken(token));
    if (invite) invite.expiresAt = new Date(Date.now() - 1000);
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

describe("admin user management routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let inviteRepo: FakeInviteRepo;
  let adminSid: string;
  let memberSid: string;
  let memberId: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    inviteRepo = new FakeInviteRepo();

    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    memberId = member._id;
    adminSid = await issueSession(store, admin._id);
    memberSid = await issueSession(store, memberId);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      userAdminRepo: userRepo,
      passwordWriteRepo: userRepo,
      userInviteRepo: inviteRepo,
      tokenRepo: new MemoryTokenRepo(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /users creates an invited member with no password and returns an invite link", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { email: "new@example.com" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({
      email: "new@example.com",
      role: "member",
      status: "invited",
    });
    expect(typeof body.invite.token).toBe("string");
    expect(new Date(body.invite.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const created = await userRepo.findByEmail("new@example.com");
    expect(created?.passwordHash).toBeNull();
    // Only the hash is stored — the raw token is returned once and never recoverable.
    expect(inviteRepo.invites.map((i) => i.tokenHash)).toContain(
      hashInviteToken(body.invite.token)
    );
  });

  it("POST /users/:id/invite re-issues a link and revokes the outstanding one", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { email: "new@example.com" },
    });
    const invitedId = first.json().user.id;
    const firstToken = first.json().invite.token;

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/users/${invitedId}/invite`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().invite.token).not.toBe(firstToken);
    expect(await inviteRepo.find(hashInviteToken(firstToken))).toBeNull();
    expect(await inviteRepo.find(hashInviteToken(second.json().invite.token))).not.toBeNull();
  });

  it("POST /users/:id/invite issues a recovery link for an active user without changing it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/users/${memberId}/invite`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });
    expect(res.statusCode).toBe(200);
    const member = await userRepo.findById(memberId);
    expect(member?.status).toBe("active");
    expect(member?.passwordHash).not.toBeNull();
  });

  it("POST /users/:id/invite returns 400 for a disabled user", async () => {
    await userRepo.setStatus(memberId, "disabled");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/users/${memberId}/invite`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /users/:id/invite returns 403 for a non-admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/users/${memberId}/invite`,
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /users/:id/status re-enables a never-accepted account as invited, not active", async () => {
    const invited = await inviteUser(userRepo, "pending@example.com");
    await userRepo.setStatus(invited._id, "disabled");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${invited._id}/status`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { status: "active" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.status).toBe("invited");
    expect((await userRepo.findById(invited._id))?.status).toBe("invited");
  });

  it("POST /users returns 409 on duplicate email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { email: "member@example.com" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /users returns 403 for a non-admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      cookies: { [SESSION_COOKIE]: memberSid, [CSRF_COOKIE]: csrfOf(memberSid) },
      headers: { [CSRF_HEADER]: csrfOf(memberSid) },
      payload: { email: "new@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /users lists all users for an admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("GET /users returns 403 for a non-admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /users/:id/status disables a member", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${memberId}/status`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { status: "disabled" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.status).toBe("disabled");
    expect((await userRepo.findById(memberId))?.status).toBe("disabled");
  });

  it("PATCH /users/:id/status returns 400 for self", async () => {
    const admin = await userRepo.findByEmail("admin@example.com");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${admin?._id}/status`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { status: "disabled" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /users/:id/status returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/no-such-id/status",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { status: "disabled" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("invite acceptance", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let inviteRepo: FakeInviteRepo;
  let adminSid: string;

  async function invite(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
      payload: { email },
    });
    return { id: res.json().user.id, token: res.json().invite.token };
  }

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    inviteRepo = new FakeInviteRepo();
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    adminSid = await issueSession(store, admin._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      userAdminRepo: userRepo,
      passwordWriteRepo: userRepo,
      userInviteRepo: inviteRepo,
      tokenRepo: new MemoryTokenRepo(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("previews an invite without spending it", async () => {
    const { token } = await invite("new@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/preview",
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe("new@example.com");
    expect(await inviteRepo.find(hashInviteToken(token))).not.toBeNull();
  });

  it("redeems in a browser that still holds a live session", async () => {
    // The recovery case the link exists for: an active user forgot their password and opens the
    // re-issued link where their old session is still alive. A session cookie without a CSRF header
    // is exactly the shape a redemption arrives in, so both routes must be CSRF-exempt.
    const { token } = await invite("new@example.com");

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/preview",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      payload: { token },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().email).toBe("new@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      payload: { token, password: "a-strong-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: "new@example.com", status: "active" });

    // Rotation is what contains the fixation risk of exempting the route: the session the browser
    // arrived with must not be the one it leaves with.
    expect(cookieValue(res)).not.toBe(adminSid);
    expect(await store.get(adminSid)).toBeNull();
  });

  it("accepting sets the password, activates the account, and signs in", async () => {
    const { id, token } = await invite("new@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "a-strong-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: "new@example.com", status: "active" });

    const sid = cookieValue(res);
    expect(sid).toBeTruthy();
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: sid as string },
    });
    expect(session.statusCode).toBe(200);
    expect((await userRepo.findById(id))?.passwordHash).not.toBeNull();
  });

  it("the chosen password works at the login form", async () => {
    const { token } = await invite("new@example.com");
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "a-strong-password" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "new@example.com", password: "a-strong-password" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("an invited account cannot log in before accepting", async () => {
    await invite("new@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "new@example.com", password: "anything-at-all" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid credentials");
  });

  it("a replayed invite sets nothing the second time", async () => {
    const { token } = await invite("new@example.com");
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "a-strong-password" },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "an-attacker-password" },
    });
    expect(replay.statusCode).toBe(404);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "new@example.com", password: "an-attacker-password" },
    });
    expect(login.statusCode).toBe(401);
  });

  it("an expired invite is refused", async () => {
    const { token } = await invite("new@example.com");
    inviteRepo.expire(token);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/preview",
      payload: { token },
    });
    expect(preview.statusCode).toBe(404);

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "a-strong-password" },
    });
    expect(accept.statusCode).toBe(404);
  });

  it("an unknown token is refused with the same response as an expired one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/preview",
      payload: { token: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a disabled account's invite is dead", async () => {
    const { id, token } = await invite("new@example.com");
    await userRepo.setStatus(id, "disabled");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "a-strong-password" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a password below the minimum length", async () => {
    const { token } = await invite("new@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "short" },
    });
    expect(res.statusCode).toBe(400);
    // The token survives a rejected password — a typo must not burn the link.
    expect(await inviteRepo.find(hashInviteToken(token))).not.toBeNull();
  });

  it("a re-issued link is the recovery path for a forgotten password", async () => {
    const { id, token } = await invite("new@example.com");
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token, password: "the-forgotten-one" },
    });

    const reissued = await app.inject({
      method: "POST",
      url: `/api/v1/users/${id}/invite`,
      cookies: { [SESSION_COOKIE]: adminSid, [CSRF_COOKIE]: csrfOf(adminSid) },
      headers: { [CSRF_HEADER]: csrfOf(adminSid) },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites/accept",
      payload: { token: reissued.json().invite.token, password: "the-replacement-one" },
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "new@example.com", password: "the-replacement-one" },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe("change password", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let memberSid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    const member = await createUser(userRepo, "member@example.com", "current-password", "member");
    memberSid = await issueSession(store, member._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      userAdminRepo: userRepo,
      passwordWriteRepo: userRepo,
      userInviteRepo: new FakeInviteRepo(),
      tokenRepo: new MemoryTokenRepo(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function change(sid: string, payload: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrfOf(sid) },
      headers: { [CSRF_HEADER]: csrfOf(sid) },
      payload,
    });
  }

  it("sets a new password and rotates the session", async () => {
    const res = await change(memberSid, {
      currentPassword: "current-password",
      newPassword: "new-strong-password",
    });
    expect(res.statusCode).toBe(200);

    const newSid = cookieValue(res);
    expect(newSid).toBeTruthy();
    expect(newSid).not.toBe(memberSid);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "member@example.com", password: "new-strong-password" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("refuses a wrong current password and leaves the old one working", async () => {
    const res = await change(memberSid, {
      currentPassword: "not-the-current-one",
      newPassword: "new-strong-password",
    });
    expect(res.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "member@example.com", password: "current-password" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("returns 400 for a short new password", async () => {
    const res = await change(memberSid, {
      currentPassword: "current-password",
      newPassword: "short",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 without a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      payload: { currentPassword: "current-password", newPassword: "new-strong-password" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/v1/auth/profile", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let memberSid: string;
  let memberId: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    const member = await createUser(userRepo, "member@example.com", "current-password", "member");
    memberId = member._id;
    memberSid = await issueSession(store, member._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      userAdminRepo: userRepo,
      passwordWriteRepo: userRepo,
      profileWriteRepo: userRepo,
      userInviteRepo: new FakeInviteRepo(),
      tokenRepo: new MemoryTokenRepo(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function patchProfile(sid: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: "/api/v1/auth/profile",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: csrfOf(sid) },
      headers: { [CSRF_HEADER]: csrfOf(sid) },
      payload,
    });
  }

  it("requires a session", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/profile",
      payload: { name: "Devika Raghunathan" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("sets a display name and returns the updated user", async () => {
    const res = await patchProfile(memberSid, { name: "Devika Raghunathan" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.name).toBe("Devika Raghunathan");
    expect((await userRepo.findById(memberId))?.name).toBe("Devika Raghunathan");
  });

  it("collapses padded whitespace so a name cannot be laid out as two columns", async () => {
    const res = await patchProfile(memberSid, { name: "  Devika     Raghunathan \n" });
    expect(res.json().user.name).toBe("Devika Raghunathan");
  });

  it("clears the name when given blank text", async () => {
    await patchProfile(memberSid, { name: "Devika Raghunathan" });
    const res = await patchProfile(memberSid, { name: "   " });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.name).toBeNull();
  });

  it("never returns the password hash", async () => {
    const res = await patchProfile(memberSid, { name: "Devika Raghunathan" });
    expect(res.json().user).not.toHaveProperty("passwordHash");
  });

  it("rejects a name past the cap", async () => {
    const res = await patchProfile(memberSid, { name: "x".repeat(81) });
    expect(res.statusCode).toBe(400);
  });
});
