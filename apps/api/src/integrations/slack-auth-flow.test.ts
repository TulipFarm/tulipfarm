import type { GitSyncService, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import { loadBundledIntegrations, makeSoulWriterDouble } from "@tulipfarm/soul";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { IntegrationAuthRequestDoc, IntegrationAuthRequestRepo } from "./auth-broker";
import { InMemoryPrincipalProviderTokenRepo } from "./principal-tokens";

/* Drives the shipped Slack manifest through the generic broker and OAuth callback path. */

const TEST_CSRF = "a".repeat(64);
const logger = { info() {}, warn() {}, error() {}, debug() {} };

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
  async create(_token: TokenDoc) {}
  async findByHash() {
    return null;
  }
  async findByUserId() {
    return [];
  }
  async findAll() {
    return [];
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

class FakeSecretsService {
  store = new Map<string, string>();
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

class MemoryAuthRequestRepo implements IntegrationAuthRequestRepo {
  requests: IntegrationAuthRequestDoc[] = [];
  async create(request: IntegrationAuthRequestDoc): Promise<void> {
    this.requests.push({ ...request });
  }
  async consume(state: string): Promise<IntegrationAuthRequestDoc | null> {
    const request = this.requests.find(
      (r) => r.state === state && r.consumedAt === null && r.expiresAt > new Date()
    );
    if (!request) return null;
    request.consumedAt = new Date();
    return { ...request };
  }
}

/** Captures only what `ensureDefaultSlackRoute` writes; everything else throws if touched. */
class FakeIntegrationStore {
  apps: Array<Record<string, unknown>> = [];
  integrations: Array<Record<string, unknown>> = [];
  routes: Array<Record<string, unknown>> = [];
  async putApp(app: Record<string, unknown>) {
    this.apps.push(app);
  }
  async putIntegration(integration: Record<string, unknown>) {
    this.integrations.push(integration);
  }
  async putRoute(route: Record<string, unknown>) {
    this.routes.push(route);
  }
}

describe("slack declarative auth flow", () => {
  let app: FastifyInstance;
  let sid: string;
  let soul: ReturnType<typeof makeSoulWriterDouble>;
  let soulLoader: SoulLoader;
  let secretsService: FakeSecretsService;
  let repo: MemoryAuthRequestRepo;
  let principalTokens: InMemoryPrincipalProviderTokenRepo;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let store: FakeIntegrationStore;

  beforeEach(async () => {
    const sessions = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    // Business-scoped shared credentials require an admin fixture.
    const user = await createUser(userRepo, "user@example.com", "pass", "admin");
    sid = await sessions.create(user._id);

    soul = makeSoulWriterDouble();

    const bundled = await loadBundledIntegrations(logger);
    const slack = bundled.get("slack");
    if (!slack) throw new Error("slack is not a bundled integration");
    const slackManifest = slack.manifest;

    function reloadFromTree(): Map<string, SoulIntegration> {
      const map = new Map<string, SoulIntegration>();
      const manifestRaw = soul.writer.read("Integration", "slack");
      const connectionRaw = soul.writer.readCompanion("Integration", "slack", "connection.yaml");
      if (manifestRaw !== null || connectionRaw !== null) {
        const connection = connectionRaw === null ? undefined : parseYaml(connectionRaw);
        map.set("slack", {
          slug: "slack",
          sourceIntegration: "slack",
          manifest: slackManifest,
          connection,
        } as SoulIntegration);
      }
      return map;
    }

    soulLoader = {
      integrations: new Map<string, SoulIntegration>(),
      agents: new Map(),
      reload: vi.fn().mockImplementation(async () => {
        soulLoader.integrations = reloadFromTree();
      }),
    } as unknown as SoulLoader;

    const gitSync = {
      path: "/soul",
      withSync: vi.fn(),
      commit: vi.fn(),
      push: vi.fn(),
    } as unknown as GitSyncService;

    secretsService = new FakeSecretsService();
    repo = new MemoryAuthRequestRepo();
    principalTokens = new InMemoryPrincipalProviderTokenRepo();
    fetchImpl = vi.fn();
    store = new FakeIntegrationStore();

    app = await buildApp({
      sessionStore: sessions,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      gitSync,
      soulWriter: soul.writer,
      soulLoader,
      secretsService: secretsService as never,
      bundledIntegrations: bundled,
      integrationAuth: {
        repo,
        fetchImpl: fetchImpl as never,
        tokens: principalTokens,
      },
      slackBind: {
        integrations: store as never,
        businessId: "biz-1",
        // The real one calls Slack's auth.test; the flow under test is what produced the token.
        verifyBotToken: vi.fn().mockResolvedValue({ appId: "A123", teamId: "T999" }),
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  const detail = async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/slack",
      cookies: auth(),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  /** Step 1: hand the operator a Slack "create app" URL with our manifest pre-filled. */
  async function createApp(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/auth/start/0",
      cookies: auth(),
      headers,
    });
    expect(res.statusCode).toBe(200);
    return res.json().url as string;
  }

  /** Step 2: the three values that only exist on Slack's Basic Information page. */
  async function submitFields(): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/connect",
      cookies: auth(),
      headers,
      payload: {
        env: {
          SLACK_CLIENT_ID: "111.222",
          SLACK_CLIENT_SECRET: "client-shh",
          SLACK_APP_TOKEN: "xapp-1-abc",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending");
  }

  /** Step 3: install to the workspace, which is what actually yields the bot token. */
  async function installToWorkspace(): Promise<void> {
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/slack/auth/start/2",
      cookies: auth(),
      headers,
    });
    expect(started.statusCode).toBe(200);
    const state = new URL(started.json().url).searchParams.get("state");

    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, access_token: "xoxb-real", team: { id: "T999", name: "Acme" } }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/auth/callback?state=${state}&code=oauth-code`,
    });
    expect(res.statusCode).toBe(302);
  }

  it("pre-fills Slack's create-app form so no JSON is copied by hand", async () => {
    const url = new URL(await createApp());
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");

    const manifest = JSON.parse(url.searchParams.get("manifest_json") ?? "{}");
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    // Registering our callback here is what lets step 3 run with zero manual configuration.
    expect(manifest.oauth_config.redirect_urls).toEqual([
      expect.stringContaining("/api/v1/integrations/auth/callback"),
    ]);
  });

  it("produces every value Slack channel routing reads", async () => {
    await submitFields();
    await installToWorkspace();

    // slack-binding.ts reads exactly these three.
    expect(secretsService.store.get("integration.slack.SLACK_BOT_TOKEN")).toBe("xoxb-real");
    expect(secretsService.store.get("integration.slack.SLACK_APP_TOKEN")).toBe("xapp-1-abc");
    const connection = parseYaml(
      soul.writer.readCompanion("Integration", "slack", "connection.yaml") ?? ""
    );
    // `map: {team.id: SLACK_TEAM_ID}` is the only reason the workspace id is captured at all.
    expect(connection.env.SLACK_TEAM_ID).toBe("T999");
  });

  it("wires channel routing when the token arrives from the OAuth redirect", async () => {
    await submitFields();
    expect(store.routes).toHaveLength(0);

    await installToWorkspace();

    expect(store.routes).toHaveLength(1);
    expect(store.routes[0]).toMatchObject({ businessId: "biz-1", status: "active" });
    expect(store.integrations[0]).toMatchObject({ externalTenantId: "T999" });
  });

  it("keeps step 2's values when step 3 writes, and only then reports connected", async () => {
    await submitFields();
    expect((await detail()).connected).toBe(false);

    await installToWorkspace();

    expect((await detail()).connected).toBe(true);
    // The app-level token came from an earlier step; a replacing write would have dropped it.
    expect(secretsService.store.get("integration.slack.SLACK_APP_TOKEN")).toBe("xapp-1-abc");
  });

  it("never writes a Slack credential to the git-tracked connection file", async () => {
    await submitFields();
    await installToWorkspace();

    const raw = soul.writer.readCompanion("Integration", "slack", "connection.yaml") ?? "";
    for (const secret of ["client-shh", "xapp-1-abc", "xoxb-real"]) {
      expect(raw).not.toContain(secret);
    }
  });
});
