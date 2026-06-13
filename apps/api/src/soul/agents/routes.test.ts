import type { GitSyncService, SoulAgent, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
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
  },
  body: "# Role\nYou plan sprints.",
};

describe("agents routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let sid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);
    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync: makeFakeGitSync(),
      soulLoader: makeSoulLoader([PLANNER]),
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

    it("lists the platform agents first, then soul agents (frontmatter only, no body)", async () => {
      const res = await app.inject(authed("/api/v1/agents"));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        agents: [
          {
            name: "GeneralAssistant",
            label: "General Assistant",
            description:
              "Front desk for TulipFarm — answers questions, reads resources and knowledge, and routes creation work to the Information Architect.",
            model: "standard",
          },
          {
            name: "InformationArchitect",
            label: "Information Architect",
            description:
              "Creation specialist — builds and edits resource types, skills, and agents and runs onboarding, using the inbuilt forge skills.",
            model: "complex",
          },
          {
            name: "sprint-planner",
            label: "Sprint Planner",
            domain: "engineering",
            description: "Breaks PRDs into sprints.",
            model: "auto",
            autonomy: "supervised",
          },
        ],
      });
    });
  });

  describe("GET /api/v1/agents/:name", () => {
    it("serves the built-in GeneralAssistant detail by name", async () => {
      const res = await app.inject(authed("/api/v1/agents/GeneralAssistant"));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe("GeneralAssistant");
      expect(body.body.length).toBeGreaterThan(0);
    });

    it("returns the full agent including its markdown body", async () => {
      const res = await app.inject(authed("/api/v1/agents/sprint-planner"));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.body).toContain("You plan sprints");
      expect(body.placeholder).toEqual(["Plan next sprint..."]);
      expect(body.suggestions).toEqual(["Plan next sprint"]);
    });

    it("returns 404 for an unknown agent", async () => {
      const res = await app.inject(authed("/api/v1/agents/ghost"));
      expect(res.statusCode).toBe(404);
    });
  });
});
