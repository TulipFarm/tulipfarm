import { PublicOriginsService } from "@tulipfarm/integrations";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";

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
  async create(_token: TokenDoc): Promise<void> {}
  async findByHash(_hash: string): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(_userId: string): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(_id: string): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(_id: string): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

describe("system status routes", () => {
  let app: FastifyInstance;
  let sid: string;
  let fetchImpl: ReturnType<typeof vi.fn>;

  async function build(latestTag: string | null) {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "admin@example.com", "pass", "admin");
    sid = await store.create(user._id);
    fetchImpl = vi.fn(async () =>
      latestTag
        ? new Response(JSON.stringify({ tag_name: latestTag }), { status: 200 })
        : new Response("nope", { status: 500 })
    );
    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      systemRoutes: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
  }

  afterEach(async () => {
    await app.close();
  });

  beforeEach(async () => {
    process.env.TULIPFARM_VERSION = "0.2.1";
  });

  it("reports an available update when a newer release exists", async () => {
    await build("v0.5.0");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/system/update-check",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: "0.2.1",
      latest: "0.5.0",
      updateAvailable: true,
    });
  });

  it("reports no update when up to date and degrades gracefully on GitHub failure", async () => {
    await build("v0.2.1");
    const same = await app.inject({
      method: "GET",
      url: "/api/v1/system/update-check",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(same.json()).toMatchObject({ version: "0.2.1", updateAvailable: false });
    await app.close();

    await build(null); // GitHub 500
    const degraded = await app.inject({
      method: "GET",
      url: "/api/v1/system/update-check",
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({ latest: null, updateAvailable: false });
  });

  it("requires auth", async () => {
    await build("v0.5.0");
    const res = await app.inject({ method: "GET", url: "/api/v1/system/update-check" });
    expect(res.statusCode).toBe(401);
  });

  it("serves real OIM conformance through the protected app route", async () => {
    await build(null);
    const url = "/api/v1/system/oim-capabilities";
    const anonymous = await app.inject({ method: "GET", url });
    expect(anonymous.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url,
      cookies: { [SESSION_COOKIE]: sid },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capabilities: {
        packageEntrypoint: "oim.yml",
        runtime: { name: "TulipFarm" },
        profiles: { core: expect.arrayContaining(["1.2"]) },
        conformance: { passedCases: expect.any(Array) },
      },
      unverifiedProfiles: expect.any(Array),
    });
    expect(response.json().capabilities.conformance.passedCases.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/system/public-origins", () => {
  it("returns the exact callback URL derived from a saved public address", async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const sid = await store.create(user._id);
    const publicOrigins = new PublicOriginsService(
      {
        get: async () => ({ webOrigin: "https://tulip.example.com", apiOrigin: null }),
        put: async () => {},
        delete: async () => {},
      },
      "default"
    );
    const app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      publicOrigins,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/public-origins",
      cookies: { [SESSION_COOKIE]: sid },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      webOrigin: "https://tulip.example.com",
      apiOrigin: "https://tulip.example.com",
      callbackUrl: "https://tulip.example.com/api/v1/integrations/auth/callback",
      source: "database",
    });
    await app.close();
  });

  it("reconciles provider webhooks after the public API origin changes", async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "admin@example.com", "pass", "admin");
    const sid = await store.create(user._id);
    const reconcile = vi.fn(async () => {});
    const publicOrigins = new PublicOriginsService(
      {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
      },
      "default"
    );
    const app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      publicOrigins,
      systemRoutes: { onPublicOriginsChanged: reconcile },
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/system/public-origins",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: "a".repeat(64) },
      headers: { [CSRF_HEADER]: "a".repeat(64) },
      payload: { webOrigin: "https://web.example.test", apiOrigin: "https://api.example.test" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(reconcile).toHaveBeenCalledWith("https://api.example.test");
  });
});
