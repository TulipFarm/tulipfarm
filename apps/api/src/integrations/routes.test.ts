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
  async loadProviderSnapshot(businessId: string, provider: string) {
    void businessId;
    void provider;
    return { apps: [], integrations: this.githubIntegrations, accessGrants: [], routes: [] };
  }
  githubIntegrations: Array<{ id: string; status: string }> = [];
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
            // No `grants`: this fixture proves they are derived from the oauth2 step's scopes,
            // which is what spares an OAuth author from writing the same list twice.
            auth: [
              {
                kind: "oauth2",
                token_url: "https://slack.example/token",
                client_id_env: "SLACK_CLIENT_ID",
                client_secret_env: "SLACK_CLIENT_SECRET",
                token_env: "SLACK_BOT_TOKEN",
                scopes: ["chat:write", "channels:read", "chat:write"],
              },
              {
                kind: "fields",
                fields: [{ name: "SLACK_TEAM_ID", label: "Team ID", secret: false }],
              },
            ],
          },
          setupGuide: "# Connect Slack",
        },
      ],
      [
        "github",
        {
          manifest: {
            name: "github",
            egress: { type: "none" },
            capabilities: ["Review and merge pull requests"],
            grants: [
              { label: "contents", access: "write", description: "Push commits." },
              { label: "metadata", access: "read", description: "Read repository names." },
            ],
          },
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
      githubInstall: {
        integrations: integrationStore as never,
        secretsService: secretsService as never,
        businessId: "biz-1",
        soulRepositories: { get: async () => undefined, put: async () => {} } as never,
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
      // Asserted by subject rather than as an exact list: the catalog also carries curated
      // listings from registry.yml, and every integration added there would otherwise break a
      // test that is about bundled discovery.
      expect(integrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "github", status: "disconnected", installed: true }),
          expect.objectContaining({ name: "slack", status: "disconnected", installed: true }),
        ])
      );
      // Sorted by name: the catalog is one list an operator scans, so its base order has to be
      // stable and predictable rather than however discovery happened to merge.
      const names = integrations.map((entry: { name: string }) => entry.name);
      expect(names).toEqual([...names].sort());
    });

    it("carries the brand mark of an integration whose manifest names one", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
        cookies: auth(),
        headers,
      });
      const byName = new Map(
        res.json().integrations.map((entry: { name: string }) => [entry.name, entry])
      );
      expect(byName.get("github")).toMatchObject({ iconPath: expect.stringMatching(/^M/) });
      // Slack asked to be removed from Simple Icons, so it has no mark and the catalog must still
      // list it — the absence is projected as absence, not as an error or a placeholder path.
      expect(byName.get("slack")).not.toHaveProperty("iconPath");
    });

    it("reflects GitHub App install status from IntegrationStore, not soul connection.yaml", async () => {
      integrationStore.githubIntegrations = [{ id: "github:99", status: "active" }];

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { integrations } = res.json();
      expect(integrations).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "github", status: "connected" })])
      );
    });
  });

  describe("GET /api/v1/integrations/:name", () => {
    async function detail(name: string) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/${name}`,
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      return res.json();
    }

    it("carries the same brand identity the catalog row showed", async () => {
      // Landing on a detail page that drops back to a bare slug reads as a different product
      // than the one that was clicked.
      expect(await detail("github")).toMatchObject({
        title: "GitHub",
        iconPath: expect.stringMatching(/^M/),
      });
    });

    it("reports the authority a manifest declares by hand", async () => {
      const { grants } = await detail("github");
      expect(grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "contents", access: "write" }),
          expect.objectContaining({ label: "metadata", access: "read" }),
        ])
      );
    });

    it("derives authority from declared OAuth scopes when the manifest states none", async () => {
      // Slack authors no `grants`; its bot scopes are real declared data on the oauth2 step, so
      // deriving them costs the author nothing and cannot drift from what is requested.
      const { grants } = await detail("slack");
      const labels = grants.map((grant: { label: string }) => grant.label);
      expect(labels).toContain("chat:write");
      expect(new Set(labels).size).toBe(labels.length);
    });

    it("reports what agents can do once connected", async () => {
      const { capabilities } = await detail("github");
      expect(capabilities.join(" ")).toMatch(/pull request/i);
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

    // The secrets API deliberately never returns values. Connect must not become the way around
    // that: env values are resolved and templated into the URLs the auth broker hands back, so a
    // reference to someone else's key would come straight back to the caller in a redirect.
    it("refuses a value referencing a secret this integration does not own", async () => {
      await secretsService.set("soul-git-credential", "ghp_the_operators_git_token");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: {
          env: {
            SLACK_BOT_TOKEN: "xoxb-secret",
            SLACK_TEAM_ID: "secret://soul-git-credential",
          },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("may not reference another secret");
      await expect(
        readFile(join(soulPath, "integrations", "slack", "connection.yaml"), "utf8")
      ).rejects.toThrow();
    });

    // Reconnect resubmits the stored form, so an integration's own reference must still pass.
    it("accepts a resubmitted reference to its own sealed value", async () => {
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: { env: { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_TEAM_ID: "T123" } },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/slack/connect",
        cookies: auth(),
        headers,
        payload: {
          env: {
            SLACK_BOT_TOKEN: "secret://integration.slack.SLACK_BOT_TOKEN",
            SLACK_TEAM_ID: "T999",
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(await secretsService.get("integration.slack.SLACK_BOT_TOKEN")).toBe("xoxb-secret");
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
      expect(list.json().integrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "github", status: "disconnected" }),
          expect.objectContaining({ name: "slack", status: "disconnected" }),
        ])
      );
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
