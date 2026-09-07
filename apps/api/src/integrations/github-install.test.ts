import { generateKeyPairSync } from "node:crypto";
import type { IntegrationHttpPort, IntegrationHttpRequest } from "@tulipfarm/integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureGitHubInstallation, listInstalledRepositories } from "./github-install";

/** Recording starts after generic auth produces App credentials and an installation id. */

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
}

class FakeIntegrationStore {
  apps: Array<Record<string, unknown>> = [];
  integrations: Array<Record<string, unknown>> = [];
  accessGrants: Array<Record<string, unknown>> = [];
  async putApp(app: Record<string, unknown>) {
    this.apps = [...this.apps.filter((a) => a.id !== app.id), app];
  }
  async putIntegration(integration: Record<string, unknown>) {
    this.integrations = [...this.integrations.filter((i) => i.id !== integration.id), integration];
  }
  async putAccessGrant(grant: Record<string, unknown>) {
    this.accessGrants = [...this.accessGrants.filter((g) => g.id !== grant.id), grant];
  }
}

function fakeHttp(
  handler: (req: IntegrationHttpRequest) => { status: number; body: unknown }
): IntegrationHttpPort {
  return {
    send: async (req: IntegrationHttpRequest) => handler(req),
  } as unknown as IntegrationHttpPort;
}

const OK_HTTP = (repos: string[]) =>
  fakeHttp((req) => {
    if (req.path === "/app/installations/99") {
      return {
        status: 200,
        body: { account: { login: "acme-corp" }, permissions: { issues: "write" } },
      };
    }
    if (req.path === "/app/installations/99/access_tokens") {
      return { status: 201, body: { token: "ghs_abc", expires_at: "2026-08-06T13:00:00Z" } };
    }
    if (req.path === "/installation/repositories") {
      return { status: 200, body: { repositories: repos.map((full_name) => ({ full_name })) } };
    }
    throw new Error(`unexpected request: ${req.method} ${req.path}`);
  });

describe("listInstalledRepositories", () => {
  it("collects every provider-authorized repository across pages", async () => {
    const names = Array.from({ length: 205 }, (_, index) => `acme-corp/repo-${index + 1}`);
    const requests: IntegrationHttpRequest[] = [];
    const http = fakeHttp((request) => {
      requests.push(request);
      const page = Number(request.query?.page ?? "1");
      const start = (page - 1) * 100;
      return {
        status: 200,
        body: {
          total_count: names.length,
          repositories: names.slice(start, start + 100).map((full_name) => ({ full_name })),
        },
      };
    });

    const repositories = await listInstalledRepositories(http, "ghs_token");

    expect(repositories).toHaveLength(205);
    expect(repositories.at(-1)).toEqual({
      owner: "acme-corp",
      repo: "repo-205",
      private: false,
    });
    expect(requests.map((request) => request.query)).toEqual([
      { per_page: "100", page: "1" },
      { per_page: "100", page: "2" },
      { per_page: "100", page: "3" },
    ]);
  });

  it("returns an empty grant only when GitHub reports no authorized repositories", async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: { total_count: 0, repositories: [] },
    }));

    await expect(listInstalledRepositories(http, "ghs_token")).resolves.toEqual([]);
  });

  it("fails the whole read when a later page fails", async () => {
    const http = fakeHttp((request) =>
      request.query?.page === "2"
        ? { status: 503, body: {} }
        : {
            status: 200,
            body: {
              total_count: 101,
              repositories: Array.from({ length: 100 }, (_, index) => ({
                full_name: `acme-corp/repo-${index + 1}`,
              })),
            },
          }
    );

    await expect(listInstalledRepositories(http, "ghs_token")).rejects.toThrow(
      "failed to list installation repositories: status 503"
    );
  });
});

describe("ensureGitHubInstallation", () => {
  let secretsService: FakeSecretsService;
  let integrations: FakeIntegrationStore;
  let privateKeyPem: string;

  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    secretsService = new FakeSecretsService();
    integrations = new FakeIntegrationStore();
  });

  const deps = (http: IntegrationHttpPort, log?: { warn: (obj: unknown) => void }) => ({
    integrations: integrations as never,
    secretsService: secretsService as never,
    businessId: "biz-1",
    http,
    log,
  });

  async function configureApp(): Promise<void> {
    await secretsService.set("integration.github.GITHUB_APP_ID", "app-123");
    await secretsService.set("integration.github.GITHUB_APP_PRIVATE_KEY", privateKeyPem);
  }

  it("records the app, installation, and the repos it grants", async () => {
    await configureApp();
    await ensureGitHubInstallation(deps(OK_HTTP(["acme-corp/widgets"])), "99");

    expect(integrations.apps[0]).toMatchObject({
      provider: "github",
      externalAppId: "app-123",
      // The rest of the platform resolves the key through this ref, so it must be the new one.
      credentialRefs: ["integration.github.GITHUB_APP_PRIVATE_KEY"],
    });
    expect(integrations.integrations[0]).toMatchObject({
      externalTenantId: "99",
      externalAccountId: "acme-corp",
      status: "active",
    });
    expect(integrations.accessGrants[0]).toMatchObject({
      definition: {
        externalTargets: { type: "github.repository", ids: ["acme-corp/widgets"] },
        permissions: { issues: "write" },
      },
    });
  });

  it("refreshes rather than duplicates when the repo selection changes", async () => {
    await configureApp();
    await ensureGitHubInstallation(deps(OK_HTTP(["acme-corp/widgets"])), "99");
    await ensureGitHubInstallation(deps(OK_HTTP(["acme-corp/widgets", "acme-corp/gadgets"])), "99");

    expect(integrations.accessGrants).toHaveLength(1);
    expect(integrations.accessGrants[0]).toMatchObject({
      definition: {
        externalTargets: { ids: ["acme-corp/widgets", "acme-corp/gadgets"] },
      },
    });
  });

  it("does nothing when the App is not configured", async () => {
    const log = { warn: vi.fn() };
    await ensureGitHubInstallation(
      deps(
        fakeHttp(() => {
          throw new Error("GitHub must not be called without credentials");
        }),
        log
      ),
      "99"
    );

    expect(integrations.integrations).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "app_not_configured" })
    );
  });

  it("swallows a GitHub failure so a connected App is not reported as an error", async () => {
    // This runs after the credentials are already committed; throwing here would show the operator
    // a failure page for an App that is, in fact, connected.
    await configureApp();
    const log = { warn: vi.fn() };
    await ensureGitHubInstallation(
      deps(
        fakeHttp(() => ({ status: 503, body: {} })),
        log
      ),
      "99"
    );

    expect(integrations.integrations).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "integrations.github.record.failed" })
    );
  });
});
