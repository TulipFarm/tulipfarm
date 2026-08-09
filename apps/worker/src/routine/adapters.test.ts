import { generateKeyPairSync } from "node:crypto";
import {
  GITHUB_ADAPTER_REF,
  GITHUB_TOOL_IDS,
  type IntegrationHttpRequest,
} from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore, PersistedRoutingSnapshot } from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  type EffectRecord,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { buildGitHubTooling } from "./adapters";
import { GITHUB_INSTALLATION_SECRET_REF } from "./github-credentials";
import type { GitHubRestHttp } from "./github-http";

/**
 * Composition test for `buildGitHubTooling()`: fakes only the two edges outside this app's
 * control — the storage snapshot and the GitHub REST transport — and exercises everything this
 * phase built in between (installation projection, context resolution, credential minting +
 * caching, `CredentialDispatcher`'s lease, and `GitHubAdapter`'s own scope + grant checks) as one
 * real object graph, the same shape `main.ts` wires.
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

function fakeHttp(issue: { number: number; title: string; state: string }): GitHubRestHttp {
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
    // biome-ignore lint/suspicious/noExplicitAny: matches the real `GitHubRestHttp` shape only
  } as any;
}

function readIssueEffect(): EffectRecord {
  return {
    effectId: "effect-1",
    businessId: BUSINESS_ID,
    runId: "run-1",
    stateId: "state-1",
    logicalEffectOrdinal: 0,
    idempotencyKey: "idem-1",
    intentDigest: "digest-1",
    guardrailRevision: "guardrail-rev-1",
    state: "authorized",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    intent: {
      intentId: "intent-1",
      businessId: BUSINESS_ID,
      runId: "run-1",
      stateId: "state-1",
      toolId: "github.issue.read",
      toolVersion: "1",
      action: GITHUB_TOOL_IDS.issueRead,
      targetRefs: [{ type: "github.issue", id: "tulip/farm#42" }],
      arguments: { repository: "tulip/farm", issueNumber: 42 },
      credentialRef: GITHUB_INSTALLATION_SECRET_REF,
      idempotencyKey: "idem-1",
    },
  };
}

describe("buildGitHubTooling", () => {
  it("resolves installation context, mints a token, and dispatches through the real GitHubAdapter", async () => {
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http: fakeHttp({ number: 42, title: "Bug", state: "open" }),
    });

    const adapter = tooling.adapters.get(GITHUB_ADAPTER_REF);
    expect(adapter).toBeDefined();

    const effect = readIssueEffect();
    const request: ToolAdapterRequest = {
      intent: effect.intent,
      idempotencyKey: effect.idempotencyKey,
      attempt: 1,
    };
    const output = await tooling.credentials.dispatch(
      effect,
      adapter as NonNullable<typeof adapter>,
      request
    );
    expect(output).toMatchObject({
      repository: "tulip/farm",
      number: 42,
      title: "Bug",
      state: "open",
    });
  });

  it("caches the minted token across two dispatches instead of re-exchanging it", async () => {
    let mints = 0;
    const http: GitHubRestHttp = {
      async send(request: IntegrationHttpRequest) {
        if (request.path.endsWith("/access_tokens")) {
          mints += 1;
          return {
            status: 201,
            headers: {},
            body: { token: "ghs_minted", expires_at: "2026-08-06T01:00:00.000Z" },
          };
        }
        return {
          status: 200,
          headers: {},
          body: {
            number: 1,
            title: "t",
            body: "",
            state: "open",
            html_url: "https://github.com/tulip/farm/issues/1",
            labels: [],
            assignees: [],
          },
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: matches the real `GitHubRestHttp` shape only
    } as any;

    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    const adapter = tooling.adapters.get(GITHUB_ADAPTER_REF);
    if (adapter === undefined) throw new Error("adapter not registered");

    const dispatchOnce = () => {
      const effect = readIssueEffect();
      const request: ToolAdapterRequest = {
        intent: effect.intent,
        idempotencyKey: effect.idempotencyKey,
        attempt: 1,
      };
      return tooling.credentials.dispatch(effect, adapter, request);
    };

    await dispatchOnce();
    await dispatchOnce();
    expect(mints).toBe(1);
  });

  it("denies a repository outside the installation's scope before reading the issue", async () => {
    const http = fakeHttp({ number: 42, title: "Bug", state: "open" });
    const tooling = buildGitHubTooling({
      businessId: BUSINESS_ID,
      integrations: fakeIntegrationStore(),
      secrets: fakeSecretsService(),
      http,
    });
    const adapter = tooling.adapters.get(GITHUB_ADAPTER_REF);
    if (adapter === undefined) throw new Error("adapter not registered");

    const effect = readIssueEffect();
    const outOfScope: EffectRecord = {
      ...effect,
      intent: {
        ...effect.intent,
        arguments: { repository: "other/repo", issueNumber: 42 },
      },
    };
    const request: ToolAdapterRequest = {
      intent: outOfScope.intent,
      idempotencyKey: outOfScope.idempotencyKey,
      attempt: 1,
    };

    await expect(tooling.credentials.dispatch(outOfScope, adapter, request)).rejects.toThrow(
      AdapterDispatchError
    );
  });
});
