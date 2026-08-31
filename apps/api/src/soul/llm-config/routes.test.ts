import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { makeSoulWriterDouble, type SoulWriterDouble } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
import { __resetLlmCatalogCache } from "./routes";

const TEST_CSRF = "a".repeat(64);

/** A stubbed `fetch` returning a LiteLLM catalog (or empty). Resets the module cache so each test's
 *  stub is used deterministically (no real network, no cross-test catalog leakage). */
function stubCatalog(catalog: Record<string, unknown>): void {
  __resetLlmCatalogCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => catalog }) as unknown as Response)
  );
}

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
  let soulWriterDouble: SoulWriterDouble;
  let reload: ReturnType<typeof vi.fn>;
  let init: ReturnType<typeof vi.fn>;
  let secretsGet: ReturnType<typeof vi.fn>;
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
    soulWriterDouble = makeSoulWriterDouble();

    // reload re-reads the config the gateway just wrote (mirrors SoulLoader), so the PUT response
    // reflects what was saved. The route writes the whole soul.yaml under the `Settings` artifact.
    let current: unknown = validConfig;
    reload = vi.fn(async () => {
      const raw = soulWriterDouble.writer.read("Settings");
      const manifest = (raw === null ? {} : parseYaml(raw)) as { llm?: unknown };
      current = manifest.llm;
    });
    const soulLoader = {
      get llmConfig() {
        return current;
      },
      reload,
    } as unknown as SoulLoader;

    const gitSync = {
      path: soulPath,
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;
    init = vi.fn().mockResolvedValue(undefined);
    const llmService = { init, select: vi.fn() } as never;
    // resource-name (config) is set; everything else (incl. api keys, base URLs) is unavailable by
    // default — tests that exercise the openai-compatible live-fetch path override this.
    secretsGet = vi.fn(async (key: string) => {
      if (key === "azure-openai-resource-name") return "my-res";
      throw new Error("unset");
    });
    const secretsService = {
      list: vi.fn().mockResolvedValue([]),
      get: secretsGet,
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
      soulWriter: soulWriterDouble.writer,
    });
    // Default: empty catalog, so PUT's auto-enrich is a no-op (no specs pinned) and no real network
    // call happens. Tests that exercise enrichment/resolve override with their own catalog.
    stubCatalog({});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    __resetLlmCatalogCache();
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

    it("refuses a member: provider and model ids describe where prompts are sent", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-providers",
        cookies: cookies(memberSid),
        headers,
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns the provider registry to an admin", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-providers",
        cookies: cookies(adminSid),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { providers } = res.json();
      expect(providers.map((p: { id: string }) => p.id)).toEqual([
        "anthropic",
        "openai",
        "azure",
        "openai-compatible",
        "claude-code",
        "codex",
      ]);
      const anthropic = providers.find((p: { id: string }) => p.id === "anthropic");
      expect(anthropic.fields).toContainEqual(
        expect.objectContaining({ key: "anthropic-api-key", role: "api_key", kind: "secret" })
      );
      const azure = providers.find((p: { id: string }) => p.id === "azure");
      expect(azure.label).toBe("Azure Foundry");
      expect(azure.fields.map((f: { role: string }) => f.role)).toEqual([
        "api_key",
        "resource_name",
        "base_url",
      ]);
    });
  });

  describe("GET /api/v1/provider-config", () => {
    it("refuses a member", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/provider-config",
        cookies: cookies(memberSid),
        headers,
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns stored config-field values but never secret (api key) values", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/provider-config",
        cookies: cookies(adminSid),
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

    it("refuses a member: the config names every provider, model and api_key_ref", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config",
        cookies: cookies(memberSid),
        headers,
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns the current config to an admin", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
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
      expect(soulWriterDouble.applied).toEqual([]);
    });

    it("validates, writes, commits, reloads, and re-inits the LlmService", async () => {
      const next = {
        presets: { default: "balanced" },
        tiers: {
          quick: {
            providers: [
              {
                provider: "openai",
                model: "gpt-4o-mini",
                api_key_ref: "openai-key",
                spec: { max_input_tokens: 128000 },
              },
            ],
          },
          standard: {
            providers: [
              {
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                spec: { max_input_tokens: 200000 },
              },
            ],
          },
          complex: {
            providers: [
              {
                provider: "anthropic",
                model: "claude-opus-4-8",
                spec: { max_input_tokens: 200000 },
              },
            ],
          },
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

      const manifest = parseYaml(soulWriterDouble.writer.read("Settings") ?? "") as {
        llm: unknown;
      };
      expect(manifest.llm).toEqual(next);
      expect(soulWriterDouble.applied).toHaveLength(1);
      expect(soulWriterDouble.applied[0]).toMatchObject({
        subject: "soul: update llm config",
        changes: [{ op: "put", target: { kind: "Settings" } }],
      });
      expect(reload).toHaveBeenCalledOnce();
      expect(init).toHaveBeenCalledOnce();
    });

    it("accepts and round-trips preset mappings while preserving provider chains", async () => {
      const next = {
        presets: {
          default: "balanced",
          fast: "fast",
          balanced: "balanced",
          thorough: "thorough",
        },
        tiers: {
          quick: {
            providers: [
              {
                provider: "anthropic",
                model: "claude-haiku-4-5",
                spec: { max_input_tokens: 200000 },
              },
            ],
          },
          standard: {
            providers: [
              {
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                spec: { max_input_tokens: 200000 },
              },
              {
                provider: "openai",
                model: "gpt-4o",
                api_key_ref: "openai-key",
                spec: { max_input_tokens: 128000 },
              },
            ],
          },
          complex: {
            providers: [
              {
                provider: "anthropic",
                model: "claude-opus-4-8",
                spec: { max_input_tokens: 200000 },
              },
            ],
          },
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

      const manifest = parseYaml(soulWriterDouble.writer.read("Settings") ?? "") as {
        llm: unknown;
      };
      expect(manifest.llm).toEqual(next);
    });

    it("rejects preset targets that are not available derived ModelProfiles", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        payload: {
          presets: { default: "missing-profile" },
          tiers: {
            quick: { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] },
            standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
            complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
          },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("missing-profile");
      expect(soulWriterDouble.applied).toEqual([]);
      expect(init).not.toHaveBeenCalled();
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
      expect(soulWriterDouble.applied).toEqual([]);
      expect(init).not.toHaveBeenCalled();
    });

    it.each([
      ["an empty", ""],
      ["a whitespace-only", "   "],
    ])("rejects %s fallback Model ID and names the field", async (_label, model) => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        payload: {
          tiers: {
            quick: {
              providers: [
                { provider: "anthropic", model: "claude-haiku-4-5" },
                { provider: "anthropic", model },
              ],
            },
            standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
            complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
          },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe(
        "/tiers/quick/providers/1/model: Model ID is required and must not be blank"
      );
      expect(soulWriterDouble.applied).toEqual([]);
      expect(init).not.toHaveBeenCalled();
    });

    it("rejects a fallback entry that names no provider", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        payload: {
          tiers: {
            quick: {
              providers: [
                { provider: "anthropic", model: "claude-haiku-4-5" },
                { provider: "", model: "gpt-4o-mini" },
              ],
            },
            standard: { providers: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] },
            complex: { providers: [{ provider: "anthropic", model: "claude-opus-4-8" }] },
          },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe(
        "/tiers/quick/providers/1/provider: Provider is required and must not be blank"
      );
      expect(soulWriterDouble.applied).toEqual([]);
      expect(init).not.toHaveBeenCalled();
    });
  });

  const CATALOG = {
    "azure_ai/kimi-k2.5": {
      input_cost_per_token: 0.00000057,
      output_cost_per_token: 0.0000023,
      max_input_tokens: 256000,
      mode: "chat",
      supports_function_calling: true,
    },
  };

  describe("GET /api/v1/llm-config/resolve-spec", () => {
    it("is admin-only (403 for a member)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config/resolve-spec?provider=azure&model=kimi-k2.5",
        cookies: cookies(memberSid),
      });
      expect(res.statusCode).toBe(403);
    });

    it("resolves a model spec from the LiteLLM catalog for an admin", async () => {
      stubCatalog(CATALOG);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config/resolve-spec?provider=azure&model=kimi-k2.5",
        cookies: cookies(adminSid),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        spec: { input_cost_per_token: number; litellm_key: string } | null;
        matchedKey: string | null;
        candidates: string[];
      };
      expect(body.matchedKey).toBe("azure_ai/kimi-k2.5");
      expect(body.spec?.input_cost_per_token).toBe(0.00000057);
      expect(body.spec?.litellm_key).toBe("azure_ai/kimi-k2.5");
    });

    it("resolves an administrator-selected ambiguous candidate", async () => {
      stubCatalog(CATALOG);
      const res = await app.inject({
        method: "GET",
        url:
          "/api/v1/llm-config/resolve-spec?provider=openai-compatible&model=kimi-k2.5" +
          "&candidate=azure_ai%2Fkimi-k2.5",
        cookies: cookies(adminSid),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        matchedKey: "azure_ai/kimi-k2.5",
        spec: { max_input_tokens: 256000 },
      });
    });
  });

  describe("POST /api/v1/llm-config/test-connection", () => {
    it("is admin-only (403 for a member)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/llm-config/test-connection",
        cookies: cookies(memberSid),
        headers,
        payload: { provider: "openai", model: "gpt-4o" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("refuses an entry with no model rather than probing nothing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/llm-config/test-connection",
        cookies: cookies(adminSid),
        headers,
        payload: { provider: "openai", model: "   " },
      });
      expect(res.statusCode).toBe(422);
    });

    it("reports an entry it cannot even build as a verdict, not a 500", async () => {
      // An unknown provider or a missing secret is the configuration answer the operator pressed
      // the button to get. Failing the request instead would show them "something went wrong".
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/llm-config/test-connection",
        cookies: cookies(adminSid),
        headers,
        payload: { provider: "not-a-real-provider", model: "whatever" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ verdict: "unreachable" });
    });
  });

  describe("GET /api/v1/llm-config/model-options", () => {
    it("is admin-only (403 for a member)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config/model-options?provider=openai",
        cookies: cookies(memberSid),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns LiteLLM catalog ids (chat only) for a non-azure provider", async () => {
      stubCatalog({
        "gpt-4o": { input_cost_per_token: 1, mode: "chat" },
        "openai/gpt-4o-mini": { input_cost_per_token: 1, mode: "chat" },
        "text-embedding-3-small": { input_cost_per_token: 1, mode: "embedding" },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config/model-options?provider=openai",
        cookies: cookies(adminSid),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: string[]; source: string };
      expect(body.source).toBe("catalog");
      expect(body.models).toContain("gpt-4o");
      expect(body.models).toContain("gpt-4o-mini");
      expect(body.models).not.toContain("text-embedding-3-small"); // embeddings excluded
    });

    it("returns live proxy models for openai-compatible when base_url is configured", async () => {
      secretsGet.mockImplementation(async (key: string) => {
        if (key === "openai-compatible-base-url") return "http://localhost:11434/v1";
        if (key === "openai-compatible-api-key") return "sk-test";
        throw new Error("unset");
      });
      const catalogFetch = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "http://localhost:11434/v1/models") {
            expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer sk-test");
            return {
              ok: true,
              json: async () => ({ data: [{ id: "llama3" }, { id: "mixtral" }] }),
            };
          }
          return catalogFetch();
        })
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config/model-options?provider=openai-compatible",
        cookies: cookies(adminSid),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: string[]; source: string };
      expect(body.source).toBe("live");
      expect(body.models).toEqual(["llama3", "mixtral"]);
      expect(catalogFetch).not.toHaveBeenCalled();
    });

    it("falls back to the catalog when the live proxy fetch fails", async () => {
      secretsGet.mockImplementation(async (key: string) => {
        if (key === "openai-compatible-base-url") return "http://localhost:11434/v1";
        throw new Error("unset");
      });
      __resetLlmCatalogCache();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url === "http://localhost:11434/v1/models") {
            return { ok: false, json: async () => ({}) };
          }
          return {
            ok: true,
            json: async () => ({ "custom-model": { input_cost_per_token: 1, mode: "chat" } }),
          };
        })
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/llm-config/model-options?provider=openai-compatible",
        cookies: cookies(adminSid),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { models: string[]; source: string };
      expect(body.source).toBe("catalog");
      expect(body.models).toContain("custom-model");
    });
  });

  describe("PUT auto-resolves + pins model specs", () => {
    it("pins a LiteLLM spec onto a spec-less model on save", async () => {
      stubCatalog(CATALOG);
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        payload: {
          tiers: {
            quick: { providers: [{ provider: "azure", model: "kimi-k2.5" }] },
            standard: { providers: [{ provider: "azure", model: "kimi-k2.5" }] },
            complex: { providers: [{ provider: "azure", model: "kimi-k2.5" }] },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      // The written soul file should now carry the pinned spec (auto-resolved from LiteLLM).
      const manifest = parseYaml(soulWriterDouble.writer.read("Settings") ?? "") as {
        llm: {
          tiers: { quick: { providers: Array<{ spec?: { input_cost_per_token: number } }> } };
        };
      };
      expect(manifest.llm.tiers.quick.providers[0].spec?.input_cost_per_token).toBe(0.00000057);
    });

    it("rejects an unresolved model without writing or reloading", async () => {
      stubCatalog(CATALOG); // catalog has only kimi-k2.5
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        payload: {
          tiers: {
            quick: { providers: [{ provider: "azure", model: "some-unknown-model-xyz" }] },
            standard: { providers: [{ provider: "azure", model: "some-unknown-model-xyz" }] },
            complex: { providers: [{ provider: "azure", model: "some-unknown-model-xyz" }] },
          },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("needs a verified context window");
      expect(soulWriterDouble.applied).toEqual([]);
      expect(reload).not.toHaveBeenCalled();
      expect(init).not.toHaveBeenCalled();
    });

    it("accepts an explicit context capacity when pricing stays unresolved", async () => {
      stubCatalog(CATALOG);
      const entry = {
        provider: "azure",
        model: "some-unknown-model-xyz",
        spec: { max_input_tokens: 131072 },
      };
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/llm-config",
        cookies: cookies(adminSid),
        headers,
        payload: {
          tiers: {
            quick: { providers: [entry] },
            standard: { providers: [entry] },
            complex: { providers: [entry] },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().tiers.quick.providers[0].spec).toEqual({ max_input_tokens: 131072 });
    });
  });
});
