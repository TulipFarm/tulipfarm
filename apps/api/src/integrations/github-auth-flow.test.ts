import { generateKeyPairSync } from "node:crypto";
import type { IntegrationHttpRequest } from "@tulipfarm/integrations";
import type { GitSyncService, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
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
import { loadBundledIntegrations } from "../soul/integrations/bundled";
import { makeSoulWriterDouble } from "../soul/soul-writer-double";
import type { IntegrationAuthRequestDoc, IntegrationAuthRequestRepo } from "./auth-broker";
import { InMemoryPrincipalProviderTokenRepo } from "./principal-tokens";

/* Exercises the shipped GitHub manifest through the broker, including credential landing. */

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

class FakeIntegrationStore {
  apps: Array<Record<string, unknown>> = [];
  integrations: Array<Record<string, unknown>> = [];
  accessGrants: Array<Record<string, unknown>> = [];
  async putApp(app: Record<string, unknown>) {
    this.apps.push(app);
  }
  async putIntegration(integration: Record<string, unknown>) {
    this.integrations.push(integration);
  }
  async putAccessGrant(grant: Record<string, unknown>) {
    this.accessGrants.push(grant);
  }
  async loadProviderSnapshot() {
    return { apps: this.apps, integrations: this.integrations, accessGrants: this.accessGrants };
  }
}

class FakeSoulRepositoryStore {
  async get() {
    return null;
  }
  async put() {}
}

describe("github declarative auth flow", () => {
  let app: FastifyInstance;
  let sid: string;
  let soul: ReturnType<typeof makeSoulWriterDouble>;
  let soulLoader: SoulLoader;
  let secretsService: FakeSecretsService;
  let repo: MemoryAuthRequestRepo;
  let principalTokens: InMemoryPrincipalProviderTokenRepo;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let store: FakeIntegrationStore;
  let privateKeyPem: string;

  beforeEach(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

    const sessions = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    // Connecting the *deployment's* shared credential is an operator act — these flows all
    // exercise `scope: "business"`, so the fixture must be an administrator. A `member` here
    // would assert a reach the deployment does not grant.
    const user = await createUser(userRepo, "user@example.com", "pass", "admin");
    sid = await sessions.create(user._id);

    soul = makeSoulWriterDouble();

    const bundled = await loadBundledIntegrations(logger);
    const github = bundled.get("github");
    if (!github) throw new Error("github is not a bundled integration");
    const githubManifest = github.manifest;

    function reloadFromTree(): Map<string, SoulIntegration> {
      const map = new Map<string, SoulIntegration>();
      const manifestRaw = soul.writer.read("Integration", "github");
      const connectionRaw = soul.writer.readCompanion("Integration", "github", "connection.yaml");
      if (manifestRaw !== null || connectionRaw !== null) {
        const connection = connectionRaw === null ? undefined : parseYaml(connectionRaw);
        map.set("github", {
          slug: "github",
          sourceIntegration: "github",
          manifest: githubManifest,
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
      githubInstall: {
        integrations: store as never,
        secretsService: secretsService as never,
        businessId: "biz-1",
        soulRepositories: new FakeSoulRepositoryStore() as never,
        http: {
          send: async (req: IntegrationHttpRequest) => {
            if (req.path === "/app/installations/99") {
              return {
                status: 200,
                body: { account: { login: "acme-corp" }, permissions: { issues: "write" } },
              };
            }
            if (req.path === "/app/installations/99/access_tokens") {
              return { status: 201, body: { token: "ghs_x", expires_at: "2026-08-06T13:00:00Z" } };
            }
            if (req.path === "/installation/repositories") {
              return { status: 200, body: { repositories: [{ full_name: "acme-corp/widgets" }] } };
            }
            throw new Error(`unexpected request: ${req.method} ${req.path}`);
          },
        } as never,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  const startStep = (step: number) =>
    app.inject({
      method: "POST",
      url: `/api/v1/integrations/github/auth/start/${step}`,
      cookies: auth(),
      headers,
    });

  /** Step 1: GitHub creates the App from our manifest and hands the credentials back. */
  async function createApp(): Promise<void> {
    const started = await startStep(0);
    expect(started.statusCode).toBe(200);
    const state = new URL(started.json().url).searchParams.get("state");

    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 123456,
          slug: "acme-tulipfarm",
          pem: privateKeyPem,
          webhook_secret: "whsec",
          client_id: "Iv1.abc",
          client_secret: "cs_shh",
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/auth/callback?state=${state}&code=manifest-code`,
    });
    expect(res.statusCode).toBe(302);
  }

  /** Step 2: the operator picks repos; GitHub returns the installation id. */
  async function installOnRepos(): Promise<void> {
    const started = await startStep(1);
    expect(started.statusCode).toBe(200);
    const state = new URL(started.json().url).searchParams.get("state");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/auth/callback?state=${state}&installation_id=99`,
    });
    expect(res.statusCode).toBe(302);
  }

  it("posts the App definition to GitHub instead of asking the operator to fill a form", async () => {
    const started = await startStep(0);
    const body = started.json();

    expect(body.action).toBe("form_post");
    expect(String(body.url)).toContain("github.com/settings/apps/new");
    expect(body.field).toBe("manifest");
    const manifest = JSON.parse(body.value);
    // Without this GitHub has nowhere to send the one-time code, and the flow cannot self-complete.
    expect(manifest.redirect_url).toContain("/api/v1/integrations/auth/callback");
    expect(manifest.default_permissions).toMatchObject({ contents: "write" });
  });

  it("stores the App credentials where the token-minting code reads them", async () => {
    await createApp();

    // These exact keys are what `INTEGRATION_APPS` resolves each role to; a mismatch here means a
    // connected App that cannot mint a single token.
    expect(secretsService.store.get("integration.github.GITHUB_APP_ID")).toBe("123456");
    expect(secretsService.store.get("integration.github.GITHUB_APP_SLUG")).toBe("acme-tulipfarm");
    expect(secretsService.store.get("integration.github.GITHUB_APP_PRIVATE_KEY")).toBe(
      privateKeyPem
    );
    expect(secretsService.store.get("integration.github.GITHUB_WEBHOOK_SECRET")).toBe("whsec");
  });

  it("sends the operator to the App it just created, by slug", async () => {
    await createApp();
    const started = await startStep(1);

    // The slug is sealed; resolving it is the only reason this URL is reachable at all.
    expect(String(started.json().url)).toContain(
      "github.com/apps/acme-tulipfarm/installations/new"
    );
  });

  it("records the installation once the operator picks repos", async () => {
    await createApp();
    expect(store.integrations).toHaveLength(0);

    await installOnRepos();

    expect(store.integrations[0]).toMatchObject({
      externalTenantId: "99",
      externalAccountId: "acme-corp",
    });
    expect(store.accessGrants[0]).toMatchObject({
      definition: { externalTargets: { ids: ["acme-corp/widgets"] } },
    });
  });

  it("never writes an App credential to the git-tracked connection file", async () => {
    await createApp();
    await installOnRepos();

    const raw = soul.writer.readCompanion("Integration", "github", "connection.yaml") ?? "";
    for (const secret of [privateKeyPem, "whsec", "cs_shh"]) {
      expect(raw).not.toContain(secret);
    }
  });
});
