import { generateKeyPairSync } from "node:crypto";
import type { IntegrationHttpRequest } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore, PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { RequestContext } from "../types";
import { buildGitHubTooling } from "./compose";
import { buildGitHubTools } from "./tools";

/**
 * Exercises `buildGitHubTools()`'s `ToolDef.execute()` against a real `buildGitHubTooling()`
 * object graph (installation projection, context resolution, token minting, `GitHubAdapter`
 * dispatch), faking only the two edges outside this app's control — same shape as
 * `apps/worker/src/routine/adapters.test.ts`.
 */

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

describe("buildGitHubTools", () => {
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
