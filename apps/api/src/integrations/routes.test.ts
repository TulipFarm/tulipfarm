import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSyncService, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { BundledIntegration } from "../soul/integrations/bundled";
import type { SlackAuthTestResult } from "./slack-binding";

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

class FakeSecretsService {
  private store = new Map<string, string>();
  async get(key: string): Promise<string> {
    const value = this.store.get(key);
    if (value === undefined) throw new Error(`secret not found: ${key}`);
    return value;
  }
  async set(key: string, plaintext: string): Promise<void> {
    this.store.set(key, plaintext);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<Array<{ key: string }>> {
    return [...this.store.keys()].map((key) => ({ key }));
  }
}

class FakeIntegrationStore {
  calls: string[] = [];
  private appsById = new Map<string, { id: string }>();
  private integrationsById = new Map<string, { id: string }>();
  private routesById = new Map<string, { id: string }>();
  get apps() {
    return [...this.appsById.values()];
  }
  get integrations() {
    return [...this.integrationsById.values()];
  }
  get routes() {
    return [...this.routesById.values()];
  }
  async putApp(app: { id: string }) {
    this.calls.push("putApp");
    this.appsById.set(app.id, app);
  }
  async putIntegration(integration: { id: string }) {
    this.calls.push("putIntegration");
    this.integrationsById.set(integration.id, integration);
  }
  async putAccessGrant(grant: unknown) {
    this.calls.push("putAccessGrant");
    void grant;
  }
  async putRoute(route: { id: string }) {
    this.calls.push("putRoute");
    this.routesById.set(route.id, route);
  }
}

describe("integrations routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let sid: string;
  let soulPath: string;
  let withSync: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let soulIntegrations: Map<string, SoulIntegration>;
  let soulLoader: SoulLoader;
  let secretsService: FakeSecretsService;
  let bundledIntegrations: Map<string, BundledIntegration>;
  let integrationStore: FakeIntegrationStore;
  const temps: string[] = [];

  beforeEach(async () => {
    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    soulPath = await mkdtemp(join(tmpdir(), "integrations-soul-"));
    temps.push(soulPath);
    withSync = vi.fn().mockImplementation(async () => {
      soulLoader.integrations = await reloadIntegrationsFromDisk();
      return { sha: "abc1234", filesChanged: 1 };
    });
    reload = vi.fn().mockImplementation(async () => {
      soulLoader.integrations = await reloadIntegrationsFromDisk();
    });

    async function reloadIntegrationsFromDisk(): Promise<Map<string, SoulIntegration>> {
      const map = new Map<string, SoulIntegration>();
      const dir = join(soulPath, "integrations", "slack");
      try {
        const manifest = parseYaml(await readFile(join(dir, "manifest.yml"), "utf8"));
        let connection: SoulIntegration["connection"];
        try {
          connection = parseYaml(await readFile(join(dir, "connection.yaml"), "utf8"));
        } catch {
          // optional
        }
        map.set("slack", { slug: "slack", sourceIntegration: "slack", manifest, connection });
      } catch {
        // not materialized yet
      }
      return map;
    }

    soulIntegrations = new Map();
    const soulAgents = new Map([
      ["agent-1", { name: "agent-1" }],
      ["agent-2", { name: "agent-2" }],
    ]);
    soulLoader = {
      integrations: soulIntegrations,
      agents: soulAgents,
      reload,
    } as unknown as SoulLoader;

    const gitSync = {
      path: soulPath,
      withSync,
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;

    secretsService = new FakeSecretsService();
    bundledIntegrations = new Map([
      [
        "slack",
        {
          manifest: {
            name: "slack",
            egress: { type: "none" },
            required_env: [
              { name: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true },
              { name: "SLACK_TEAM_ID", label: "Team ID", secret: false },
            ],
          },
          setupGuide: "# Connect Slack",
        },
      ],
    ]);

    integrationStore = new FakeIntegrationStore();

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      gitSync,
      soulLoader,
      secretsService: secretsService as never,
      bundledIntegrations,
      slackBind: {
        integrations: integrationStore as never,
        businessId: "biz-1",
        verifyBotToken: async (): Promise<SlackAuthTestResult> => ({
          teamId: "T123",
          appId: "A456",
        }),
      },
    });
  });

  afterEach(async () => {
    await app.close();
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  describe("GET /api/v1/integrations", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/integrations" });
      expect(res.statusCode).toBe(401);
    });

    it("lists a bundled-only integration as disconnected", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { integrations } = res.json();
      expect(integrations).toEqual([
        expect.objectContaining({ name: "slack", status: "disconnected" }),
      ]);
    });
  });

  describe("POST /api/v1/integrations/:name/connect", () => {
    it("400s when required env is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: {} },
      });
      expect(res.statusCode).toBe(400);
    });

    it("materializes the soul dir, seals secret env, and connects", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "connected", toolCount: 0 });

      const written = parseYaml(
        await readFile(join(soulPath, "integrations", "slack", "connection.yaml"), "utf8")
      );
      expect(written.enabled).toBe(true);
      expect(written.env.SLACK_TEAM_ID).toBe("T123");
      expect(written.env.SLACK_BOT_TOKEN).toMatch(/^secret:\/\//);
      expect(await secretsService.get("integration.slack.SLACK_BOT_TOKEN")).toBe("xoxb-secret");

      const detail = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/slack",
        cookies: auth(),
        headers,
      });
      expect(detail.json().status).toBe("connected");
    });
  });

  describe("POST /api/v1/integrations/:name/disconnect", () => {
    it("keeps sealed env but marks disabled", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" } },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/disconnect",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "disconnected" });

      const written = parseYaml(
        await readFile(join(soulPath, "integrations", "slack", "connection.yaml"), "utf8")
      );
      expect(written.enabled).toBe(false);
      expect(written.env.SLACK_BOT_TOKEN).toMatch(/^secret:\/\//);
    });
  });

  describe("DELETE /api/v1/integrations/:name", () => {
    it("removes the soul dir and deletes secrets", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" } },
      });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/integrations/slack",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(204);
      await expect(secretsService.get("integration.slack.SLACK_BOT_TOKEN")).rejects.toThrow();

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
        cookies: auth(),
        headers,
      });
      expect(list.json().integrations).toEqual([
        expect.objectContaining({ name: "slack", status: "disconnected" }),
      ]);
    });
  });

  describe("POST /api/v1/integrations/slack/bind", () => {
    it("404s when Slack is not connected", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/bind",
        cookies: auth(),
        headers,
        payload: { agentId: "agent-1" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("400s when agentId does not name a real Agent", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" } },
      });

      integrationStore.calls.length = 0;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/bind",
        cookies: auth(),
        headers,
        payload: { agentId: "does-not-exist" },
      });
      expect(res.statusCode).toBe(400);
      expect(integrationStore.calls).toEqual([]);
    });

    it("calls putApp/putIntegration/putRoute in order with a stubbed auth.test response", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" } },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/bind",
        cookies: auth(),
        headers,
        payload: { agentId: "agent-1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "bound",
        teamId: "T123",
        appId: "A456",
        routeId: "slack:A456:T123:route:default",
        channelId: null,
      });

      expect(integrationStore.calls).toEqual([
        "putApp",
        "putIntegration",
        "putRoute",
        "putApp",
        "putIntegration",
        "putRoute",
      ]);
      expect(integrationStore.apps[0]).toMatchObject({
        provider: "slack",
        externalAppId: "A456",
        businessId: "biz-1",
      });
      expect(integrationStore.integrations[0]).toMatchObject({
        externalTenantId: "T123",
        businessId: "biz-1",
      });
      expect(integrationStore.routes[0]).toMatchObject({
        agentId: "agent-1",
        businessId: "biz-1",
      });
    });

    it("re-binding the same workspace updates rows in place instead of duplicating them", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" } },
      });

      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/bind",
        cookies: auth(),
        headers,
        payload: { agentId: "agent-1" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/bind",
        cookies: auth(),
        headers,
        payload: { agentId: "agent-2" },
      });
      expect(res.statusCode).toBe(200);

      expect(integrationStore.apps).toHaveLength(1);
      expect(integrationStore.integrations).toHaveLength(1);
      expect(integrationStore.routes).toHaveLength(1);
      expect(integrationStore.routes[0]).toMatchObject({ agentId: "agent-2" });
    });
  });
});
