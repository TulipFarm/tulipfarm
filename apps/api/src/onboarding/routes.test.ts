import type { LlmService } from "@tulipfarm/llm";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { makeSoulWriterDouble } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK so onboarding personalization never invokes a real model.
const generateObject = vi.fn();
vi.mock("ai", async (orig) => {
  const actual = await orig<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObject(...args) };
});

import type { KnowledgeService } from "@tulipfarm/knowledge";
import type { KvEntry, KvRepo, KvScope } from "@tulipfarm/kv";
import { KvService } from "@tulipfarm/kv";
import type { PaginatedResult } from "@tulipfarm/storage";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
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

interface SoulNames {
  resources?: string[];
  agents?: string[];
  skills?: string[];
  businessName?: string;
  businessDescription?: string;
}

function makeSoulLoader(resourceNames: string[], extra: SoulNames = {}) {
  const toMap = (names: string[] = []) => new Map(names.map((n) => [n, {}]));
  const manifest =
    extra.businessName || extra.businessDescription
      ? { businessName: extra.businessName, businessDescription: extra.businessDescription }
      : null;
  return {
    resources: toMap(resourceNames),
    agents: toMap(extra.agents),
    skills: toMap(extra.skills),
    integrations: new Map(),
    manifest,
  } as unknown as SoulLoader;
}

/** Fake LlmService — the model is a stand-in; `generateObject` is mocked at the SDK boundary. */
function makeFakeLlm() {
  // biome-ignore lint/suspicious/noExplicitAny: dummy model stand-in for the mocked SDK.
  return { effortModel: () => ({}) as any } as unknown as LlmService;
}

/** In-memory KvRepo so the real KvService (and the real KV route) work end-to-end in tests. */
class FakeKvRepo implements KvRepo {
  private rows = new Map<string, KvEntry>();
  private id(scope: KvScope, ownerId: string | undefined, ns: string, key: string) {
    return `${scope}\u0000${ownerId ?? ""}\u0000${ns}\u0000${key}`;
  }
  async upsert(doc: KvEntry) {
    this.rows.set(this.id(doc.scope, doc.ownerId, doc.namespace, doc.key), doc);
  }
  async get(scope: KvScope, ownerId: string | undefined, ns: string, key: string) {
    return this.rows.get(this.id(scope, ownerId, ns, key)) ?? null;
  }
  async delete(scope: KvScope, ownerId: string | undefined, ns: string, key: string) {
    return this.rows.delete(this.id(scope, ownerId, ns, key));
  }
  async listByNamespace(scope: KvScope, ownerId: string | undefined, ns: string) {
    return [...this.rows.values()].filter(
      (e) => e.scope === scope && e.ownerId === ownerId && e.namespace === ns
    );
  }
}

interface AppOpts extends SoulNames {
  withKv?: boolean;
  hasKnowledge?: boolean;
  withLlm?: boolean;
}

async function appWith(opts: AppOpts = {}) {
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
    soulWriter: makeSoulWriterDouble().writer,
    soulLoader: makeSoulLoader(opts.resources ?? [], opts),
    llmService: opts.withLlm ? makeFakeLlm() : undefined,
    kvService: opts.withKv ? new KvService(new FakeKvRepo()) : undefined,
    knowledgeService: opts.withKv
      ? ({
          hasAnyKnowledgePage: async () => opts.hasKnowledge ?? false,
        } as unknown as KnowledgeService)
      : undefined,
  });
  const req = (method: "GET" | "PUT", url: string, payload?: object) => ({
    method,
    url,
    payload,
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
    headers: { [CSRF_HEADER]: TEST_CSRF },
  });
  const authed = (url: string) => req("GET", url);
  return { app, authed, req };
}

/** Back-compat shim for the existing /suggestions tests. */
async function appWithSoul(resourceNames: string[]) {
  return appWith({ resources: resourceNames });
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

describe("onboarding personalization (LLM)", () => {
  let app: FastifyInstance;

  beforeEach(() => generateObject.mockReset());
  afterEach(async () => {
    await app?.close();
  });

  const PERSONALIZED = {
    suggestions: [
      { id: "matters", label: "Track legal matters?", prompt: "Help me track matters." },
    ],
    recommendations: [
      {
        id: "agent-for-matters",
        label: "Create an agent for matters",
        prompt: "Help me create an agent.",
      },
    ],
  };

  it("serves the static catalog first, then LLM suggestions once the background refresh lands", async () => {
    generateObject.mockResolvedValue({ object: PERSONALIZED });
    let authed: Awaited<ReturnType<typeof appWith>>["authed"];
    ({ app, authed } = await appWith({
      withKv: true,
      withLlm: true,
      businessDescription: "a law firm managing legal matters",
    }));

    // The first hit must not wait on the model — it answers from the static catalog and only
    // kicks the refresh off. This route blocks the web app's first paint.
    const first = (await app.inject(authed("/api/v1/onboarding/suggestions"))).json() as {
      suggestions: { id: string }[];
    };
    expect(first.suggestions).toHaveLength(CATALOG.length);
    expect(generateObject).toHaveBeenCalledOnce();

    await vi.waitFor(async () => {
      const body = (await app.inject(authed("/api/v1/onboarding/suggestions"))).json() as {
        suggestions: { id: string }[];
      };
      expect(body.suggestions.map((s) => s.id)).toEqual(["matters"]);
    });
  });

  it("serves LLM suggestions and reuses the cache across repeated hits", async () => {
    generateObject.mockResolvedValue({ object: PERSONALIZED });
    let authed: Awaited<ReturnType<typeof appWith>>["authed"];
    ({ app, authed } = await appWith({
      withKv: true,
      withLlm: true,
      businessDescription: "a law firm managing legal matters",
    }));
    await app.inject(authed("/api/v1/onboarding/suggestions"));

    await vi.waitFor(async () => {
      const body = (await app.inject(authed("/api/v1/onboarding/suggestions"))).json() as {
        suggestions: { id: string }[];
      };
      expect(body.suggestions.map((s) => s.id)).toEqual(["matters"]);
    });
    expect(generateObject).toHaveBeenCalledOnce(); // every later route hit reads the KV cache
  });

  it("falls back to the static catalog when the LLM output is malformed", async () => {
    generateObject.mockResolvedValue({ object: { suggestions: "nope" } });
    let authed: Awaited<ReturnType<typeof appWith>>["authed"];
    ({ app, authed } = await appWith({
      withKv: true,
      withLlm: true,
      businessDescription: "a law firm",
    }));
    const body = (await app.inject(authed("/api/v1/onboarding/suggestions"))).json() as {
      suggestions: { id: string }[];
    };
    expect(body.suggestions).toHaveLength(CATALOG.length);
  });
});
