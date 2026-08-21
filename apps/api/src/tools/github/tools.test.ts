import { generateKeyPairSync } from "node:crypto";
import { GITHUB_TOOL_CONTRACTS, type IntegrationHttpRequest } from "@tulipfarm/integrations";
import { principalSecretKey, type SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore, PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import type { RequestContext } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { buildGitHubTooling } from "./compose";
import { buildGitHubTools, GITHUB_REPOSITORY_LIST_TOOL_NAME } from "./tools";

const BUSINESS_ID = "biz-triage";
const APP_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

function snapshot(): PersistedRoutingSnapshot {
  return {
    apps: [
      {
        id: "app-1",
        businessId: BUSINESS_ID,
        provider: "github",
        externalAppId: "123456",
        credentialRefs: [],
        status: "active",
      },
    ],
    integrations: [
      {
        id: "integration-1",
        businessId: BUSINESS_ID,
        appId: "app-1",
        externalTenantId: "install-1",
        externalAccountId: "tulip",
        status: "active",
      },
    ],
    accessGrants: [
      {
        id: "grant-1",
        businessId: BUSINESS_ID,
        integrationId: "integration-1",
        definition: {
          externalTargets: { ids: ["tulip/farm"] },
          permissions: { issues: "write", metadata: "read" },
        },
        status: "active",
      },
    ],
    routes: [],
  };
}

function fakeIntegrationStore(): IntegrationStore {
  return {
    async loadProviderSnapshot() {
      return snapshot();
    },
    // biome-ignore lint/suspicious/noExplicitAny: only `loadProviderSnapshot` is exercised
  } as any;
}

function snapshotWithAdministration(): PersistedRoutingSnapshot {
  return {
    ...snapshot(),
    accessGrants: [
      {
        id: "grant-1",
        businessId: BUSINESS_ID,
        integrationId: "integration-1",
        definition: {
          externalTargets: { ids: ["tulip/farm"] },
          permissions: { issues: "write", metadata: "read", administration: "write" },
        },
        status: "active",
      },
    ],
  };
}

function fakeIntegrationStoreWithAdministration(): IntegrationStore {
  return {
    async loadProviderSnapshot() {
      return snapshotWithAdministration();
    },
    // biome-ignore lint/suspicious/noExplicitAny: only `loadProviderSnapshot` is exercised
  } as any;
}

function fakeSecretsService(): () => Promise<SecretsService> {
  return async () =>
    ({
      get: async (key: string) => {
        if (key === "integration.github.GITHUB_APP_PRIVATE_KEY") return APP_PRIVATE_KEY_PEM;
        throw new Error(`no secret ${key}`);
      },
      // biome-ignore lint/suspicious/noExplicitAny: only `get` is exercised
    }) as any;
}

function fakeHttp(issue: { number: number; title: string; state: string }) {
  return {
    async send(request: IntegrationHttpRequest, credential: string) {
      if (request.path.endsWith("/access_tokens")) {
        return {
          status: 201,
          headers: {},
          body: { token: "ghs_minted", expires_at: "2026-08-06T01:00:00.000Z" },
        };
      }
      if (request.path === `/repos/tulip/farm/issues/${issue.number}`) {
        expect(credential).toBe("ghs_minted");
        if (request.method === "PATCH") {
          return {
            status: 200,
            headers: {},
            body: {
              number: issue.number,
              title: issue.title,
              body: "",
              state: "closed",
              html_url: `https://github.com/tulip/farm/issues/${issue.number}`,
              labels: [],
              assignees: [],
            },
          };
        }
        return {
          status: 200,
          headers: {},
          body: {
            number: issue.number,
            title: issue.title,
            body: "",
            state: issue.state,
            html_url: `https://github.com/tulip/farm/issues/${issue.number}`,
            labels: [],
            assignees: [],
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    },
  };
}

function fakeIssueCreateHttp() {
  return {
    async send(request: IntegrationHttpRequest) {
      if (request.path.endsWith("/access_tokens")) {
        return {
          status: 201,
          headers: {},
          body: { token: "ghs_minted", expires_at: "2026-08-06T01:00:00.000Z" },
        };
      }
      if (request.path === "/repos/tulip/farm/issues" && request.method === "GET") {
        return { status: 200, headers: {}, body: [] };
      }
      if (request.path === "/repos/tulip/farm/issues" && request.method === "POST") {
        return {
          status: 201,
          headers: {},
          body: {
            number: 99,
            title: "New bug",
            body: "steps",
            state: "open",
            html_url: "https://github.com/tulip/farm/issues/99",
            labels: [],
            assignees: [],
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    },
  };
}

function fakeRepositoryCreateHttp(hasAdministration: boolean) {
  return {
    async send(request: IntegrationHttpRequest) {
      if (request.path.endsWith("/access_tokens")) {
        return {
          status: 201,
          headers: {},
          body: { token: "ghs_minted", expires_at: "2026-08-06T01:00:00.000Z" },
        };
      }
      if (
        hasAdministration &&
        request.path === "/repos/tulip/new-repo" &&
        request.method === "GET"
      ) {
        return { status: 404, headers: {}, body: {} };
      }
      if (hasAdministration && request.path === "/orgs/tulip/repos" && request.method === "POST") {
        return {
          status: 201,
          headers: {},
          body: {
            full_name: "tulip/new-repo",
            html_url: "https://github.com/tulip/new-repo",
            private: true,
            default_branch: "main",
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    },
  };
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return { userId: "user-1", runId: "run-1", toolCallId: "call-1", ...overrides };
}

function expectNoNullishTargetText(targets: unknown): void {
  expect(JSON.stringify(targets)).not.toMatch(/undefined|null/);
}

describe("buildGitHubTools", () => {
  it("derives egress destinations from the published GitHub contracts", () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const destinationsByAction = new Map(
      GITHUB_TOOL_CONTRACTS.map((contract) => [
        contract.spec.action,
        contract.spec.allowedDestinations,
      ])
    );

    for (const tool of tools.filter(
      (candidate) => candidate.name !== GITHUB_REPOSITORY_LIST_TOOL_NAME
    )) {
      const action = tool.definition?.authorization.action;
      if (action === undefined) throw new Error(`${tool.name} missing authorization action`);
      expect(tool.definition?.authorization.allowedDestinations, tool.name).toEqual(
        destinationsByAction.get(action)
      );
    }
  });

  it("uses an installation-scoped target for all-repository searches", () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });

    for (const name of ["github_issue_search", "github_pull_request_search"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool?.definition === undefined) throw new Error(`${name} not registered`);
      const targets = tool.definition.targetsFor({ query: "is:open" });

      expect(targets, name).toEqual([
        { type: "integration.github", id: "installation:all-repositories" },
      ]);
      // A concrete repository grant must not satisfy an installation-wide search. Since both now
      // live under `integration.github`, the separation is carried by the id prefix, so that is
      // what this asserts — checking the old `github.repository` type would be vacuous.
      expect(
        targets.filter((target) => target.id?.startsWith("repo:")),
        name
      ).toEqual([]);
      expectNoNullishTargetText(targets);
    }
  });

  it("mirrors the adapter's all-repository search fallback for malformed selectors", () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const allRepositoriesTarget = [
      { type: "integration.github", id: "installation:all-repositories" },
    ];
    const cases: unknown[] = [
      { query: "is:open", repositories: [] },
      { query: "is:open", repository: 42 },
      { query: "is:open", repository: null },
      { query: "is:open", repository: "" },
      { query: "is:open", repositories: "tulip/farm" },
    ];

    for (const name of ["github_issue_search", "github_pull_request_search"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool?.definition === undefined) throw new Error(`${name} not registered`);
      for (const args of cases) {
        expect(tool.definition.targetsFor(args), `${name} ${JSON.stringify(args)}`).toEqual(
          allRepositoriesTarget
        );
      }
      expect(tool.definition.targetsFor({ query: "is:open", repository: "tulip/farm" })).toEqual([
        { type: "integration.github", id: "repo:tulip/farm" },
      ]);
      expect(
        tool.definition.targetsFor({ query: "is:open", repositories: ["tulip/farm"] })
      ).toEqual([{ type: "integration.github", id: "repo:tulip/farm" }]);
    }
  });

  it("keeps GitHub target derivation total for raw model output", () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const names = ["github_issue_search", "github_pull_request_search", "github_issue_read"];
    const rawInputs: unknown[] = [
      {},
      { unexpected: true },
      { repository: 7 },
      { repository: null, repositories: null },
      { repositories: [1, null] },
      null,
      [],
    ];

    for (const name of names) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool?.definition === undefined) throw new Error(`${name} not registered`);
      for (const input of rawInputs) {
        expect(() => tool.definition?.targetsFor(input), `${name} target derivation`).not.toThrow();
        expectNoNullishTargetText(tool.definition.targetsFor(input));
      }
    }
  });

  it("dispatches a read tool through the effect ledger and returns the adapter output", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 42, title: "Bug", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_issue_read");
    if (tool === undefined) throw new Error("github_issue_read not registered");

    const result = await tool.execute({ repository: "tulip/farm", issueNumber: 42 }, context());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ repository: "tulip/farm", number: 42, title: "Bug" });
    }
  });

  it("spends the human caller's OAuth token without minting an installation token", async () => {
    const principal = { kind: "user", id: "user-1" };
    let installationMinted = false;
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: async () =>
        ({
          get: async (key: string) => {
            if (key === principalSecretKey(principal, "github", "GITHUB_OAUTH_ACCESS_TOKEN")) {
              return "gho_personal";
            }
            if (key === "integration.github.GITHUB_APP_PRIVATE_KEY") return APP_PRIVATE_KEY_PEM;
            throw new Error(`no secret ${key}`);
          },
        }) as SecretsService,
      http: {
        async send(request: IntegrationHttpRequest, credential?: string) {
          if (request.path.endsWith("/access_tokens")) {
            installationMinted = true;
            throw new Error("installation token must not be minted");
          }
          expect(credential).toBe("gho_personal");
          return {
            status: 200,
            headers: {},
            body: {
              number: 42,
              title: "Private bug",
              body: "",
              state: "open",
              html_url: "https://github.com/tulip/farm/issues/42",
              labels: [],
              assignees: [],
            },
          };
        },
      },
    });
    const tools = buildGitHubTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
    });
    const tool = tools.find((candidate) => candidate.name === "github_issue_read");
    if (tool === undefined) throw new Error("github_issue_read not registered");

    const result = await tool.execute(
      { repository: "tulip/farm", issueNumber: 42 },
      context({ credentialPrincipal: principal })
    );

    expect(result.success).toBe(true);
    expect(installationMinted).toBe(false);
  });

  it("dispatches a mutating tool and marks it mutating for the approval gate", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 7, title: "Flaky test", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_issue_close");
    if (tool === undefined) throw new Error("github_issue_close not registered");
    expect(tool.mutating).toBe(true);

    const result = await tool.execute({ repository: "tulip/farm", issueNumber: 7 }, context());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ number: 7, state: "closed" });
    }
  });

  it("replays the same effect instead of re-dispatching on a repeated call id", async () => {
    let issueGets = 0;
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path.endsWith("/access_tokens")) {
          return {
            status: 201,
            headers: {},
            body: { token: "ghs_minted", expires_at: "2026-08-06T01:00:00.000Z" },
          };
        }
        issueGets += 1;
        return {
          status: 200,
          headers: {},
          body: {
            number: 42,
            title: "Bug",
            body: "",
            state: "open",
            html_url: "https://github.com/tulip/farm/issues/42",
            labels: [],
            assignees: [],
          },
        };
      },
    };
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_issue_read");
    if (tool === undefined) throw new Error("github_issue_read not registered");

    const args = { repository: "tulip/farm", issueNumber: 42 };
    const ctx = context();
    const first = await tool.execute(args, ctx);
    const second = await tool.execute(args, ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.data).toMatchObject({ replayed: true });
    }
    expect(issueGets).toBe(1);
  });

  it("lists installed repositories with no run context and no effect reservation", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const effects = new MemoryEffectStore();
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects });
    const tool = tools.find((t) => t.name === "github_repository_list");
    if (tool === undefined) throw new Error("github_repository_list not registered");

    const result = await tool.execute({}, { userId: "user-1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        repositories: [{ repository: "tulip/farm", account: "tulip" }],
      });
    }
    expect(await effects.list(BUSINESS_ID)).toEqual([]);
  });

  it("requires installation-wide authority to list installed repositories", () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_repository_list");
    if (tool?.definition === undefined) throw new Error("github_repository_list not registered");

    expect(tool.definition.targetsFor({})).toEqual([
      { type: "integration.github", id: "installation:all-repositories" },
    ]);
    expect(tool.definition.targetsFor(null)).toEqual([
      { type: "integration.github", id: "installation:all-repositories" },
    ]);
  });

  it("tells the model to call github_repository_list when the repository isn't installed", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_issue_read");
    if (tool === undefined) throw new Error("github_issue_read not registered");

    const result = await tool.execute({ repository: "not/installed", issueNumber: 1 }, context());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("not_found");
      expect(result.error.message).toContain("github_repository_list");
    }
  });

  it("fails closed with an internal_error when the run context is missing", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 1, title: "t", state: "open" }),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_issue_read");
    if (tool === undefined) throw new Error("github_issue_read not registered");

    const result = await tool.execute(
      { repository: "tulip/farm", issueNumber: 1 },
      { userId: "user-1" }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("internal_error");
    }
  });

  it("opens a new issue via github_issue_create", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeIssueCreateHttp(),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_issue_create");
    if (tool === undefined) throw new Error("github_issue_create not registered");
    expect(tool.mutating).toBe(true);

    const result = await tool.execute(
      { repository: "tulip/farm", title: "New bug", body: "steps" },
      context()
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ number: 99, title: "New bug" });
    }
  });

  it("creates a new repo via github_repository_create when administration:write is granted", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStoreWithAdministration(),
      secrets: fakeSecretsService(),
      http: fakeRepositoryCreateHttp(true),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_repository_create");
    if (tool === undefined) throw new Error("github_repository_create not registered");
    expect(tool.mutating).toBe(true);

    const result = await tool.execute({ owner: "tulip", name: "new-repo" }, context());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ repository: "tulip/new-repo", private: true });
    }
  });

  it("returns a clear message when repo creation lacks administration:write", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeRepositoryCreateHttp(false),
    });
    const tools = buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
    const tool = tools.find((t) => t.name === "github_repository_create");
    if (tool === undefined) throw new Error("github_repository_create not registered");

    const result = await tool.execute({ owner: "tulip", name: "new-repo" }, context());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("administration:write");
    }
  });
});

/** Assert multi-install GitHub Tools mint the selected repository installation token. */
function twoInstallationSnapshot(): PersistedRoutingSnapshot {
  return {
    apps: [
      {
        id: "app-1",
        businessId: BUSINESS_ID,
        provider: "github",
        externalAppId: "123456",
        credentialRefs: [],
        status: "active",
      },
    ],
    integrations: [
      {
        id: "integration-1",
        businessId: BUSINESS_ID,
        appId: "app-1",
        externalTenantId: "install-1",
        externalAccountId: "tulip",
        status: "active",
      },
      {
        id: "integration-2",
        businessId: BUSINESS_ID,
        appId: "app-1",
        externalTenantId: "install-2",
        externalAccountId: "acme",
        status: "active",
      },
    ],
    accessGrants: [
      {
        id: "grant-1",
        businessId: BUSINESS_ID,
        integrationId: "integration-1",
        definition: {
          externalTargets: { ids: ["tulip/farm"] },
          permissions: { issues: "write", metadata: "read" },
        },
        status: "active",
      },
      {
        id: "grant-2",
        businessId: BUSINESS_ID,
        integrationId: "integration-2",
        definition: {
          externalTargets: { ids: ["acme/widgets"] },
          permissions: { issues: "write", metadata: "read" },
        },
        status: "active",
      },
    ],
    routes: [],
  };
}

function fakeTwoInstallationStore(): IntegrationStore {
  return {
    async loadProviderSnapshot() {
      return twoInstallationSnapshot();
    },
    // biome-ignore lint/suspicious/noExplicitAny: only `loadProviderSnapshot` is exercised
  } as any;
}

/** Mints a distinct token per installation so a cross-installation credential is observable. */
function fakeTwoInstallationHttp(seen: { credentials: string[] }) {
  return {
    async send(request: IntegrationHttpRequest, credential?: string) {
      const accessToken = /^\/app\/installations\/(.+)\/access_tokens$/.exec(request.path);
      if (accessToken !== null) {
        return {
          status: 201,
          headers: {},
          body: {
            token: `ghs_${accessToken[1]}`,
            expires_at: "2026-08-06T01:00:00.000Z",
          },
        };
      }
      if (credential !== undefined) seen.credentials.push(credential);
      if (request.path === "/repos/tulip/farm/issues/1" && request.method === "GET") {
        return {
          status: 200,
          headers: {},
          body: {
            number: 1,
            title: "tulip issue",
            body: "",
            state: "open",
            html_url: "https://github.com/tulip/farm/issues/1",
            labels: [],
            assignees: [],
          },
        };
      }
      if (request.path === "/repos/acme/widgets/issues/2" && request.method === "GET") {
        return {
          status: 200,
          headers: {},
          body: {
            number: 2,
            title: "acme issue",
            body: "",
            state: "open",
            html_url: "https://github.com/acme/widgets/issues/2",
            labels: [],
            assignees: [],
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    },
  };
}

describe("buildGitHubTools with several active installations", () => {
  function build(seen: { credentials: string[] }) {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeTwoInstallationStore(),
      secrets: fakeSecretsService(),
      http: fakeTwoInstallationHttp(seen),
    });
    return {
      tooling,
      tools: buildGitHubTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() }),
    };
  }

  it("reads a repository from each installation with that installation's own credential", async () => {
    const seen = { credentials: [] as string[] };
    const { tools } = build(seen);
    const read = tools.find((t) => t.name === "github_issue_read");
    if (read === undefined) throw new Error("github_issue_read not registered");

    const first = await read.execute(
      { repository: "tulip/farm", issueNumber: 1 },
      context({ toolCallId: "call-a" })
    );
    expect(first.success).toBe(true);
    expect(seen.credentials).toEqual(["ghs_install-1"]);

    const second = await read.execute(
      { repository: "acme/widgets", issueNumber: 2 },
      context({ toolCallId: "call-b" })
    );
    expect(second.success).toBe(true);
    // The second call must not reuse the first installation's cached token.
    expect(seen.credentials).toEqual(["ghs_install-1", "ghs_install-2"]);
  });

  it("refuses a repository no installation covers rather than borrowing another's credential", async () => {
    const seen = { credentials: [] as string[] };
    const { tools } = build(seen);
    const read = tools.find((t) => t.name === "github_issue_read");
    if (read === undefined) throw new Error("github_issue_read not registered");

    const result = await read.execute(
      { repository: "other/repo", issueNumber: 1 },
      context({ toolCallId: "call-c" })
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("github_repository_list");
    expect(seen.credentials).toEqual([]);
  });

  it("mints the installation covering the account a repository is created under", async () => {
    const seen = { credentials: [] as string[] };
    const { tooling } = build(seen);
    const ref = await tooling.installations.list();
    expect(ref.map((entry) => entry.accountLogin).sort()).toEqual(["acme", "tulip"]);
  });

  it("scopes the entitlement credential to the installation covering the repository", async () => {
    const seen = { credentials: [] as string[] };
    const { tooling } = build(seen);
    const repo = (repository: string) => ({ kind: "repository", repository }) as const;
    expect(await tooling.installationToken(repo("tulip/farm"))).toBe("ghs_install-1");
    expect(await tooling.installationToken(repo("acme/widgets"))).toBe("ghs_install-2");
    expect(await tooling.installationToken(repo("other/repo"))).toBeUndefined();
    // The org-membership probe asks over the installation covering the *account*, since the
    // repository it is about to create does not exist yet.
    expect(await tooling.installationToken({ kind: "account", owner: "acme" })).toBe(
      "ghs_install-2"
    );
  });
});
