import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "./api-tokens";
import { SESSION_COOKIE } from "./routes";
import { MemorySessionStore } from "./session-store";
import { type UserDoc, type UserRepo, createUser } from "./users";

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

  it("POST /logout clears the session and cookie", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "correct-horse" },
    });
    const sid = cookieValue(login) as string;

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [SESSION_COOKIE]: sid },
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
    adminSid = await store.create(adminId);
    memberSid = await store.create(memberId);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo });
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /tokens creates token and returns raw value once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid },
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
      cookies: { [SESSION_COOKIE]: adminSid },
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
      cookies: { [SESSION_COOKIE]: adminSid },
      payload: { name: "for-member", userId: memberId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().userId).toBe(memberId);
  });

  it("POST /tokens member cannot create for another user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid },
      payload: { name: "x", userId: adminId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /tokens returns 404 for unknown userId (admin)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid },
      payload: { name: "x", userId: "no-such-user" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /tokens admin sees all tokens", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid },
      payload: { name: "admin-token" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid },
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
      cookies: { [SESSION_COOKIE]: adminSid },
      payload: { name: "admin-token" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid },
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
      cookies: { [SESSION_COOKIE]: memberSid },
      payload: { name: "to-revoke" },
    });
    const { id } = create.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(del.statusCode).toBe(204);
    expect(await tokenRepo.findById(id)).toBeNull();
  });

  it("DELETE /tokens/:id member cannot revoke another user's token", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid },
      payload: { name: "admin-token" },
    });
    const { id } = create.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(del.statusCode).toBe(403);
  });

  it("DELETE /tokens/:id admin can revoke any token", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: memberSid },
      payload: { name: "member-token" },
    });
    const { id } = create.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(del.statusCode).toBe(204);
  });

  it("DELETE /tokens/:id returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/tokens/no-such-id",
      cookies: { [SESSION_COOKIE]: adminSid },
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
    adminSid = await store.create(admin._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo });
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /session authenticates via Bearer token", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      cookies: { [SESSION_COOKIE]: adminSid },
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
      cookies: { [SESSION_COOKIE]: adminSid },
      payload: { name: "temp" },
    });
    const { token: rawToken, id } = create.json();

    await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      cookies: { [SESSION_COOKIE]: adminSid },
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
