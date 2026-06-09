import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { type UserDoc, type UserRepo, createUser } from "../../auth/users";
import type { PaginatedResult } from "../../pagination";

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
  async create() {}
  async findByHash() {
    return null;
  }
  async findByUserId() {
    return [] as TokenDoc[];
  }
  async findAll() {
    return [] as TokenDoc[];
  }
  async findById() {
    return null;
  }
  async deleteById() {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const validConfig = {
  tiers: {
    quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
    standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
    complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
  },
};

describe("llm-config routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let memberSid: string;
  let adminSid: string;
  let soulPath: string;
  let withSync: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let init: ReturnType<typeof vi.fn>;
  const temps: string[] = [];

  beforeEach(async () => {
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    memberSid = await store.create(member._id);
    adminSid = await store.create(admin._id);

    soulPath = await mkdtemp(join(tmpdir(), "llm-soul-"));
    temps.push(soulPath);
    withSync = vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 1 });

    // reload re-reads the written file (mirrors SoulLoader), so the PUT response reflects what was saved.
    let current: unknown = validConfig;
    reload = vi.fn(async () => {
      current = parseYaml(await readFile(join(soulPath, "llm.config.yaml"), "utf8"));
    });
    const soulLoader = {
      get llmConfig() {
        return current;
      },
      reload,
    } as unknown as SoulLoader;

    const gitSync = {
      path: soulPath,
      withSync,
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;
    init = vi.fn().mockResolvedValue(undefined);
    const llmService = { init, select: vi.fn() } as never;
    const secretsService = {
      list: vi.fn().mockResolvedValue([]),
      // resource-name (config) is set; everything else (incl. api keys) is unavailable.
      get: vi.fn(async (key: string) => {
        if (key === "azure-openai-resource-name") return "my-res";
        throw new Error("unset");
      }),
      set: vi.fn(),
      delete: vi.fn(),
    } as never;

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      gitSync,
      soulLoader,
      llmService,
      secretsService,
    });
  });

  afterEach(async () => {
    await app.close();
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const cookies = (sid: string) => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  describe("GET /api/v1/llm-providers", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/llm-providers" });
      expect(res.statusCode).toBe(401);
    });

    it("returns the provider registry to any authed user", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-providers",
        cookies: cookies(memberSid),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { providers } = res.json();
      expect(providers.map((p: { id: string }) => p.id)).toEqual([
        "anthropic",
        "openai",
        "azure",
        "openai-compatible",
      ]);
      const anthropic = providers.find((p: { id: string }) => p.id === "anthropic");
      expect(anthropic.fields).toContainEqual(
        expect.objectContaining({ key: "anthropic-api-key", role: "api_key", kind: "secret" })
      );
      const azure = providers.find((p: { id: string }) => p.id === "azure");
      expect(azure.fields.map((f: { role: string }) => f.role)).toEqual([
        "api_key",
        "resource_name",
      ]);
    });
  });

  describe("GET /api/v1/provider-config", () => {
    it("returns stored config-field values but never secret (api key) values", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/provider-config",
        cookies: cookies(memberSid),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { values } = res.json();
      expect(values["azure-openai-resource-name"]).toBe("my-res");
      expect(Object.keys(values).some((k: string) => k.endsWith("-api-key"))).toBe(false);
    });
  });

  describe("GET /api/v1/llm-config", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/llm-config" });
      expect(res.statusCode).toBe(401);
    });

    it("returns the current config to any authed user", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config",
        cookies: cookies(memberSid),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(validConfig);
    });
  });

  describe("PUT /api/v1/llm-config", () => {
    it("rejects a non-admin with 403 and writes nothing", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(memberSid),
        headers,
        payload: validConfig,
      });
      expect(res.statusCode).toBe(403);
      expect(withSync).not.toHaveBeenCalled();
      await expect(access(join(soulPath, "llm.config.yaml"))).rejects.toThrow();
    });

    it("validates, writes, commits, reloads, and re-inits the LlmService", async () => {
      const next = {
        tiers: {
          quick: {
            providers: [{ provider: "openai", model: "gpt-4o-mini", api_key_ref: "openai-key" }],
          },
          standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
          complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
        },
      };
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        payload: next,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(next);

      const written = parseYaml(await readFile(join(soulPath, "llm.config.yaml"), "utf8"));
      expect(written).toEqual(next);
      expect(withSync).toHaveBeenCalledWith("soul: update llm config");
      expect(reload).toHaveBeenCalledOnce();
      expect(init).toHaveBeenCalledOnce();
    });

    it("rejects a structurally invalid config with 422, leaving the running config intact", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        // quick tier has an empty providers list (minItems 1) and other tiers are missing.
        payload: { tiers: { quick: { providers: [] } } },
      });
      expect(res.statusCode).toBe(422);
      expect(withSync).not.toHaveBeenCalled();
      expect(init).not.toHaveBeenCalled();
      await expect(access(join(soulPath, "llm.config.yaml"))).rejects.toThrow();
    });
  });
});
