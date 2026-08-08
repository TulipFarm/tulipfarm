import { generateKeyPairSync } from "node:crypto";
import type { IntegrationHttpPort, IntegrationHttpRequest } from "@tulipfarm/integrations";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";

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
  apps: unknown[] = [];
  integrations: unknown[] = [];
  accessGrants: unknown[] = [];
  async putApp(app: unknown) {
    this.apps.push(app);
  }
  async putIntegration(integration: unknown) {
    this.integrations.push(integration);
  }
  async revokeIntegration(businessId: string, id: string) {
    const integration = (
      this.integrations as Array<{ id: string; businessId: string; status: string }>
    ).find((candidate) => candidate.businessId === businessId && candidate.id === id);
    if (integration) integration.status = "revoked";
  }
  async putAccessGrant(grant: unknown) {
    this.accessGrants.push(grant);
  }
  async putRoute() {
    throw new Error("not used by the GitHub install flow");
  }
  async loadProviderSnapshot(businessId: string, provider: string) {
    const apps = (this.apps as Array<{ id: string; businessId: string; provider: string }>).filter(
      (app) => app.businessId === businessId && app.provider === provider
    );
    const appIds = new Set(apps.map((app) => app.id));
    const integrations = (
      this.integrations as Array<{ id: string; businessId: string; appId: string }>
    ).filter(
      (integration) => integration.businessId === businessId && appIds.has(integration.appId)
    );
    const integrationIds = new Set(integrations.map((integration) => integration.id));
    const accessGrants = (
      this.accessGrants as Array<{ businessId: string; integrationId: string }>
    ).filter((grant) => grant.businessId === businessId && integrationIds.has(grant.integrationId));
    return { apps, integrations, accessGrants, routes: [] };
  }
}

class FakeSoulRepositoryStore {
  private row: {
    businessId: string;
    integrationId: string;
    owner: string;
    repo: string;
    createdVia: "connected_existing" | "created_via_app";
  } | null = null;
  async put(repository: {
    businessId: string;
    integrationId: string;
    owner: string;
    repo: string;
    createdVia: "connected_existing" | "created_via_app";
  }) {
    this.row = repository;
  }
  async get(businessId: string) {
    return this.row?.businessId === businessId ? this.row : undefined;
  }
}

function fakeGitHubHttp(
  handler: (request: IntegrationHttpRequest) => { status: number; body: unknown }
): IntegrationHttpPort {
  return {
    async send(request: IntegrationHttpRequest) {
      const { status, body } = handler(request);
      return { status, headers: {}, body };
    },
  };
}

describe("GitHub App install routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let sid: string;
  let secretsService: FakeSecretsService;
  let integrationStore: FakeIntegrationStore;
  let soulRepositories: FakeSoulRepositoryStore;
  let privateKeyPem: string;
  let http: IntegrationHttpPort;

  const auth = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const headers = { [CSRF_HEADER]: TEST_CSRF };

  beforeEach(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

    store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    secretsService = new FakeSecretsService();
    integrationStore = new FakeIntegrationStore();
    soulRepositories = new FakeSoulRepositoryStore();
    http = fakeGitHubHttp(() => ({ status: 500, body: {} }));

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      secretsService: secretsService as never,
      githubInstall: {
        integrations: integrationStore as never,
        secretsService: secretsService as never,
        businessId: "biz-1",
        http: { send: (...args) => http.send(...args) },
        soulRepositories: soulRepositories as never,
      },
    });
  });

  describe("GET /api/v1/integrations/github/install/start", () => {
    it("401s without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/start",
      });
      expect(res.statusCode).toBe(401);
    });

    it("400s when the App isn't configured", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/start",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it("redirects to github.com with a signed state once the App slug is set", async () => {
      await secretsService.set("github-app-slug", "tulipfarm-bot");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/start",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe(
        "https://github.com/apps/tulipfarm-bot/installations/new"
      );
      expect(location.searchParams.get("state")).toBeTruthy();
    });
  });

  describe("GET /api/v1/integrations/github/install/callback", () => {
    async function issuedState(): Promise<string> {
      await secretsService.set("github-app-slug", "tulipfarm-bot");
      const start = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/start",
        cookies: auth(),
        headers,
      });
      const location = new URL(start.headers.location as string);
      const state = location.searchParams.get("state");
      if (!state) throw new Error("no state issued");
      return state;
    }

    it("401s on a forged or expired state", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/callback?setup_action=install&installation_id=1&state=bogus",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(401);
    });

    it("200s pending_approval when an org member requested install without admin approval", async () => {
      const state = await issuedState();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/github/install/callback?setup_action=request&state=${encodeURIComponent(state)}`,
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "pending_approval" });
    });

    it("400s when the App credentials aren't configured", async () => {
      const state = await issuedState();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/github/install/callback?setup_action=install&installation_id=99&state=${encodeURIComponent(state)}`,
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it("records the installation and redirects back into the web app on success", async () => {
      const state = await issuedState();
      await secretsService.set("github-app-id", "app-123");
      await secretsService.set("github-app-private-key", privateKeyPem);

      http = fakeGitHubHttp((request) => {
        if (request.path === "/app/installations/99") {
          return {
            status: 200,
            body: {
              account: { login: "acme-corp" },
              permissions: { issues: "write", metadata: "read" },
            },
          };
        }
        if (request.path === "/app/installations/99/access_tokens") {
          return {
            status: 201,
            body: { token: "ghs_abc", expires_at: "2026-08-06T13:00:00Z" },
          };
        }
        if (request.path === "/installation/repositories") {
          return {
            status: 200,
            body: { repositories: [{ full_name: "acme-corp/widgets" }] },
          };
        }
        throw new Error(`unexpected request: ${request.method} ${request.path}`);
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/integrations/github/install/callback?setup_action=install&installation_id=99&state=${encodeURIComponent(state)}`,
        cookies: auth(),
        headers,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/integrations/github?installed=1");
      expect(integrationStore.apps).toHaveLength(1);
      expect(integrationStore.integrations).toEqual([
        expect.objectContaining({
          id: "github:99",
          appId: "github-app",
          externalTenantId: "99",
          externalAccountId: "acme-corp",
          status: "active",
        }),
      ]);
      expect(integrationStore.accessGrants).toEqual([
        expect.objectContaining({
          integrationId: "github:99",
          definition: {
            externalTargets: { type: "github.repository", ids: ["acme-corp/widgets"] },
            permissions: { issues: "write", metadata: "read" },
          },
        }),
      ]);
    });
  });

  describe("GET /api/v1/integrations/github/status", () => {
    it("401s without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/status",
      });
      expect(res.statusCode).toBe(401);
    });

    it("200s an empty list when nothing is installed", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/status",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ installations: [] });
    });

    it("200s the installation and its repos after a successful install", async () => {
      await secretsService.set("github-app-slug", "tulipfarm-bot");
      const start = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/start",
        cookies: auth(),
        headers,
      });
      const state = new URL(start.headers.location as string).searchParams.get("state");
      if (!state) throw new Error("no state issued");

      await secretsService.set("github-app-id", "app-123");
      await secretsService.set("github-app-private-key", privateKeyPem);

      http = fakeGitHubHttp((request) => {
        if (request.path === "/app/installations/99") {
          return {
            status: 200,
            body: {
              account: { login: "acme-corp" },
              permissions: { issues: "write", metadata: "read" },
            },
          };
        }
        if (request.path === "/app/installations/99/access_tokens") {
          return {
            status: 201,
            body: { token: "ghs_abc", expires_at: "2026-08-06T13:00:00Z" },
          };
        }
        if (request.path === "/installation/repositories") {
          return {
            status: 200,
            body: { repositories: [{ full_name: "acme-corp/widgets" }] },
          };
        }
        throw new Error(`unexpected request: ${request.method} ${request.path}`);
      });

      await app.inject({
        method: "GET",
        url: `/api/v1/integrations/github/install/callback?setup_action=install&installation_id=99&state=${encodeURIComponent(state)}`,
        cookies: auth(),
        headers,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/status",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        installations: [
          { installationId: "99", account: "acme-corp", repositories: ["acme-corp/widgets"] },
        ],
      });
    });
  });

  describe("POST /api/v1/integrations/github/installations/:installationId/disconnect", () => {
    async function installGitHubApp(): Promise<void> {
      await secretsService.set("github-app-slug", "tulipfarm-bot");
      const start = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/start",
        cookies: auth(),
        headers,
      });
      const state = new URL(start.headers.location as string).searchParams.get("state");
      if (!state) throw new Error("no state issued");

      await secretsService.set("github-app-id", "app-123");
      await secretsService.set("github-app-private-key", privateKeyPem);

      http = fakeGitHubHttp((request) => {
        if (request.path === "/app/installations/99") {
          return {
            status: 200,
            body: {
              account: { login: "acme-corp" },
              permissions: { issues: "write", metadata: "read" },
            },
          };
        }
        if (request.path === "/app/installations/99/access_tokens") {
          return {
            status: 201,
            body: { token: "ghs_abc", expires_at: "2026-08-06T13:00:00Z" },
          };
        }
        if (request.path === "/installation/repositories") {
          return {
            status: 200,
            body: { repositories: [{ full_name: "acme-corp/widgets" }] },
          };
        }
        throw new Error(`unexpected request: ${request.method} ${request.path}`);
      });

      await app.inject({
        method: "GET",
        url: `/api/v1/integrations/github/install/callback?setup_action=install&installation_id=99&state=${encodeURIComponent(state)}`,
        cookies: auth(),
        headers,
      });
    }

    it("401s without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/installations/99/disconnect",
      });
      expect(res.statusCode).toBe(401);
    });

    it("404s an installation id that isn't active for this business", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/installations/99/disconnect",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it("revokes the installation and drops it from status", async () => {
      await installGitHubApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/installations/99/disconnect",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "disconnected" });

      const status = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/status",
        cookies: auth(),
        headers,
      });
      expect(status.json()).toEqual({ installations: [] });
    });

    it("404s on a second disconnect of the same installation", async () => {
      await installGitHubApp();
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/installations/99/disconnect",
        cookies: auth(),
        headers,
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/installations/99/disconnect",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Soul repo pick/create", () => {
    async function installWithPermissions(permissions: Record<string, string>): Promise<void> {
      await secretsService.set("github-app-slug", "tulipfarm-bot");
      const start = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/install/start",
        cookies: auth(),
        headers,
      });
      const state = new URL(start.headers.location as string).searchParams.get("state");
      if (!state) throw new Error("no state issued");

      await secretsService.set("github-app-id", "app-123");
      await secretsService.set("github-app-private-key", privateKeyPem);

      http = fakeGitHubHttp((request) => {
        if (request.path === "/app/installations/99") {
          return { status: 200, body: { account: { login: "acme-corp" }, permissions } };
        }
        if (request.path === "/app/installations/99/access_tokens") {
          return { status: 201, body: { token: "ghs_abc", expires_at: "2026-08-06T13:00:00Z" } };
        }
        if (request.path === "/installation/repositories") {
          return {
            status: 200,
            body: {
              repositories: [
                { full_name: "acme-corp/widgets", private: true },
                { full_name: "acme-corp/gadgets", private: false },
              ],
            },
          };
        }
        if (request.path === "/orgs/acme-corp/repos" && request.method === "POST") {
          return { status: 201, body: { full_name: "acme-corp/new-soul" } };
        }
        throw new Error(`unexpected request: ${request.method} ${request.path}`);
      });

      await app.inject({
        method: "GET",
        url: `/api/v1/integrations/github/install/callback?setup_action=install&installation_id=99&state=${encodeURIComponent(state)}`,
        cookies: auth(),
        headers,
      });
    }

    it("200s null when no Soul repo is selected yet", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/soul-repo",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ soulRepo: null });
    });

    it("lists the installation's granted repos for the picker", async () => {
      await installWithPermissions({ issues: "write", metadata: "read" });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/github/installations/99/repos",
        cookies: auth(),
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        repositories: [
          { owner: "acme-corp", repo: "widgets", private: true },
          { owner: "acme-corp", repo: "gadgets", private: false },
        ],
      });
    });

    it("connects an already-granted repo as the Soul repo", async () => {
      await installWithPermissions({ issues: "write", metadata: "read" });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/soul-repo",
        cookies: auth(),
        headers,
        payload: { installationId: "99", owner: "acme-corp", repo: "widgets" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "connected" });
      expect(await soulRepositories.get("biz-1")).toEqual(
        expect.objectContaining({
          integrationId: "github:99",
          owner: "acme-corp",
          repo: "widgets",
          createdVia: "connected_existing",
        })
      );
    });

    it("400s connecting a repo the installation doesn't grant", async () => {
      await installWithPermissions({ issues: "write", metadata: "read" });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/soul-repo",
        cookies: auth(),
        headers,
        payload: { installationId: "99", owner: "acme-corp", repo: "not-granted" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("409s creating a repo via the App without administration:write", async () => {
      await installWithPermissions({ issues: "write", metadata: "read" });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/soul-repo/create",
        cookies: auth(),
        headers,
        payload: { installationId: "99", owner: "acme-corp", repo: "new-soul" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(
        expect.objectContaining({
          upgradeUrl: "https://github.com/settings/installations/99/permissions/update",
        })
      );
    });

    it("creates a repo via the App once administration:write is granted", async () => {
      await installWithPermissions({
        issues: "write",
        metadata: "read",
        administration: "write",
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/github/soul-repo/create",
        cookies: auth(),
        headers,
        payload: { installationId: "99", owner: "acme-corp", repo: "new-soul" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "created" });
      expect(await soulRepositories.get("biz-1")).toEqual(
        expect.objectContaining({
          integrationId: "github:99",
          owner: "acme-corp",
          repo: "new-soul",
          createdVia: "created_via_app",
        })
      );
    });
  });
});
