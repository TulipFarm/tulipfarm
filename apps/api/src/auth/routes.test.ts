import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
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
    app = await buildApp({ sessionStore: store, userRepo: repo });
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
    // Session destroyed in the store.
    expect(await store.get(sid)).toBeNull();

    // The now-stale sid no longer authenticates.
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(after.statusCode).toBe(401);
  });
});
