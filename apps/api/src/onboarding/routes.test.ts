import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { CATALOG } from "./catalog";

const TEST_CSRF = "a".repeat(64);

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string) {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string) {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count() {
    return this.users.length;
  }
  async insert(user: UserDoc) {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  private tokens: TokenDoc[] = [];
  async create(token: TokenDoc) {
    this.tokens.push(token);
  }
  async findByHash(hash: string) {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async findByUserId(userId: string) {
    return this.tokens.filter((t) => t.userId === userId);
  }
  async findAll() {
    return [...this.tokens];
  }
  async findById(id: string) {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(id: string) {
    this.tokens = this.tokens.filter((t) => t._id !== id);
  }
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

function makeFakeGitSync() {
  return {
    commit: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 0 }),
    push: vi.fn().mockResolvedValue(true),
    path: "/tmp/soul",
  } as unknown as GitSyncService;
}

function makeSoulLoader(resourceNames: string[]) {
  return {
    resources: new Map(resourceNames.map((n) => [n, {}])),
    agents: new Map(),
    skills: new Map(),
  } as unknown as SoulLoader;
}

async function appWithSoul(resourceNames: string[]) {
  const store = new MemorySessionStore();
  const userRepo = new FakeUserRepo();
  const tokenRepo = new FakeTokenRepo();
  const user = await createUser(userRepo, "user@example.com", "pass", "member");
  const sid = await store.create(user._id);
  const app = await buildApp({
    sessionStore: store,
    userRepo,
    tokenRepo,
    gitSync: makeFakeGitSync(),
    soulLoader: makeSoulLoader(resourceNames),
  });
  const authed = (url: string) => ({
    method: "GET" as const,
    url,
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
    headers: { [CSRF_HEADER]: TEST_CSRF },
  });
  return { app, authed };
}

describe("GET /api/v1/onboarding/suggestions", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("returns 401 without auth", async () => {
    ({ app } = await appWithSoul([]));
    const res = await app.inject({ method: "GET", url: "/api/v1/onboarding/suggestions" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the full catalog when the soul has no resources", async () => {
    let authed: Awaited<ReturnType<typeof appWithSoul>>["authed"];
    ({ app, authed } = await appWithSoul([]));
    const res = await app.inject(authed("/api/v1/onboarding/suggestions"));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { suggestions: { id: string; label: string; prompt: string }[] };
    expect(body.suggestions).toHaveLength(CATALOG.length);
    expect(Object.keys(body.suggestions[0]).sort()).toEqual(["id", "label", "prompt"]);
  });

  it("omits a suggestion whose resource already exists (AC-V1-002)", async () => {
    let authed: Awaited<ReturnType<typeof appWithSoul>>["authed"];
    ({ app, authed } = await appWithSoul(["tickets"]));
    const res = await app.inject(authed("/api/v1/onboarding/suggestions"));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { suggestions: { id: string }[] };
    expect(body.suggestions.map((s) => s.id)).not.toContain("tickets");
    expect(body.suggestions).toHaveLength(CATALOG.length - 1);
  });
});
