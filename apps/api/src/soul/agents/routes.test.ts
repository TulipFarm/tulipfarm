import type { GitSyncService, SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { makeSoulWriterDouble } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";

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

function makeSoulLoader(agents: SoulAgent[]) {
  return {
    agents: new Map(agents.map((a) => [a.name, a])),
    skills: new Map(),
  } as unknown as SoulLoader;
}

const PLANNER: SoulAgent = {
  name: "sprint-planner",
  frontmatter: {
    label: "Sprint Planner",
    domain: "engineering",
    description: "Breaks PRDs into sprints.",
    model: "auto",
    autonomy: "supervised",
    placeholder: ["Plan next sprint..."],
    suggestions: ["Plan next sprint"],
    capabilityRestrictions: {
      tools: { allow: ["record_search"], allowMutating: false },
      records: {
        actions: { allow: ["read", "search", "nonsense"], deny: ["delete"] },
        resourceTypes: ["sprint"],
      },
    },
  },
  body: "# Role\nYou plan sprints.",
};

describe("agents routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let sid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);
    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync: makeFakeGitSync(),
      soulLoader: makeSoulLoader([PLANNER]),
      soulWriter: makeSoulWriterDouble().writer,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const authed = (url: string) => ({
    method: "GET" as const,
    url,
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
    headers: { [CSRF_HEADER]: TEST_CSRF },
  });

  describe("GET /api/v1/agents", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/agents" });
      expect(res.statusCode).toBe(401);
    });

    it("lists only Soul agents (frontmatter only, no body)", async () => {
      const res = await app.inject(authed("/api/v1/agents"));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        agents: [
          {
            name: "sprint-planner",
            label: "Sprint Planner",
            domain: "engineering",
            description: "Breaks PRDs into sprints.",
            model: "auto",
            autonomy: "supervised",
            capabilityRestrictions: {
              tools: { allow: ["record_search"], allowMutating: false },
              records: {
                actions: { allow: ["read", "search"], deny: ["delete"] },
                resourceTypes: ["sprint"],
              },
            },
          },
        ],
      });
    });

    it("drops a record action the schema does not define rather than passing it through", async () => {
      const res = await app.inject(authed("/api/v1/agents"));
      expect(res.json().agents[0].capabilityRestrictions.records.actions.allow).not.toContain(
        "nonsense"
      );
    });

    it("omits capabilityRestrictions entirely for an agent that declares none", async () => {
      const bare: SoulAgent = { name: "bare", frontmatter: {}, body: "x" };
      const solo = await buildApp({
        sessionStore: store,
        userRepo,
        tokenRepo,
        gitSync: makeFakeGitSync(),
        soulLoader: makeSoulLoader([bare]),
        soulWriter: makeSoulWriterDouble().writer,
      });
      const res = await solo.inject(authed("/api/v1/agents"));
      expect(res.json().agents[0]).not.toHaveProperty("capabilityRestrictions");
      await solo.close();
    });
  });

  describe("GET /api/v1/agents/:name", () => {
    it("does not expose the normal chat harness as an agent", async () => {
      const res = await app.inject(authed("/api/v1/agents/GeneralAssistant"));
      expect(res.statusCode).toBe(404);
    });

    it("returns the full agent including its markdown body", async () => {
      const res = await app.inject(authed("/api/v1/agents/sprint-planner"));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.body).toContain("You plan sprints");
      expect(body.placeholder).toEqual(["Plan next sprint..."]);
      expect(body.suggestions).toEqual(["Plan next sprint"]);
      expect(body.capabilityRestrictions.tools.allowMutating).toBe(false);
      expect(body.capabilityRestrictions.records.resourceTypes).toEqual(["sprint"]);
    });

    it("returns 404 for an unknown agent", async () => {
      const res = await app.inject(authed("/api/v1/agents/ghost"));
      expect(res.statusCode).toBe(404);
    });
  });
});
