import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { AdapterDispatchError, type ToolIntent } from "@tulipfarm/tool-broker";
import { beforeEach, describe, expect, it } from "vitest";
import type { IntegrationHttpRequest, IntegrationHttpResponse } from "../http";
import { GitHubAdapter, type GitHubEffectContext, githubEffectMarker } from "./adapter";
import { GITHUB_ISSUE_TARGET, GITHUB_REPOSITORY_TARGET, GITHUB_TOOL_IDS } from "./contracts";

const BUSINESS_ID = "biz-1";
const INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL = "ghs_installation_token";

function grant(actions: string[]): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "44444444-4444-4444-8444-444444444444",
      slug: "triage-grant",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId: INTEGRATION_ID,
      principals: [{ kind: "agent", id: AGENT_ID }],
      actions,
      externalTargets: [{ type: GITHUB_REPOSITORY_TARGET, ids: ["tulip/farm"] }],
      delegable: false,
    },
  };
}

const ALL_ACTIONS = [
  GITHUB_TOOL_IDS.issueRead,
  GITHUB_TOOL_IDS.issueSearch,
  GITHUB_TOOL_IDS.issueComment,
  GITHUB_TOOL_IDS.issueLabel,
  GITHUB_TOOL_IDS.issueAssign,
  GITHUB_TOOL_IDS.issueClose,
];

function context(overrides: Partial<GitHubEffectContext> = {}): GitHubEffectContext {
  return {
    integrationId: INTEGRATION_ID,
    installation: {
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      installationId: "inst-9",
      accountLogin: "tulip",
      repositories: ["tulip/farm"],
      permissions: { issues: "write" },
    },
    principals: [{ kind: "agent", id: AGENT_ID }],
    grants: [grant(ALL_ACTIONS)],
    ...overrides,
  };
}

function intent(action: string, args: unknown, idempotencyKey = "idem-1"): ToolIntent {
  return {
    intentId: "intent-1",
    businessId: BUSINESS_ID,
    runId: "11111111-2222-4333-8444-555555555555",
    stateId: "triage",
    toolId: action,
    toolVersion: "1.0.0",
    action,
    targetRefs: [
      { type: GITHUB_REPOSITORY_TARGET, id: "tulip/farm" },
      { type: GITHUB_ISSUE_TARGET, id: "tulip/farm#41" },
    ],
    arguments: args,
    destination: "github",
    credentialRef: "secret://github/installation",
    idempotencyKey,
  };
}

class FakeGitHubHttp {
  readonly calls: IntegrationHttpRequest[] = [];
  private readonly routes = new Map<string, IntegrationHttpResponse>();

  route(method: string, path: string, response: IntegrationHttpResponse): void {
    this.routes.set(`${method} ${path}`, response);
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    if (credential !== CREDENTIAL) throw new Error("adapter dispatched without the leased token");
    this.calls.push(request);
    const response = this.routes.get(`${request.method} ${request.path}`);
    if (response === undefined) {
      throw new Error(`unscripted GitHub call: ${request.method} ${request.path}`);
    }
    return response;
  }
}

const ISSUE_BODY = {
  number: 41,
  title: "Crash on save",
  body: "steps",
  state: "open",
  html_url: "https://github.com/tulip/farm/issues/41",
  labels: [{ name: "bug" }],
  assignees: [{ login: "maintainer" }],
};

let http: FakeGitHubHttp;
let resolved: GitHubEffectContext | undefined;
let adapter: GitHubAdapter;

beforeEach(() => {
  http = new FakeGitHubHttp();
  resolved = context();
  adapter = new GitHubAdapter({
    http,
    context: { resolve: async () => resolved },
    now: () => new Date("2026-07-25T00:00:00.000Z"),
  });
});

function dispatch(toolIntent: ToolIntent, credential: string | undefined = CREDENTIAL) {
  return adapter.dispatch(
    { intent: toolIntent, idempotencyKey: toolIntent.idempotencyKey, attempt: 1 },
    credential
  );
}

describe("GitHubAdapter reads", () => {
  it("reads an issue through the typed Tool", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41", {
      status: 200,
      headers: {},
      body: ISSUE_BODY,
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.issueRead, { repository: "tulip/farm", issueNumber: 41 })
    );
    expect(output).toEqual({
      repository: "tulip/farm",
      number: 41,
      title: "Crash on save",
      body: "steps",
      state: "open",
      labels: ["bug"],
      assignees: ["maintainer"],
      htmlUrl: "https://github.com/tulip/farm/issues/41",
    });
  });

  it("searches issues within the granted repository", async () => {
    http.route("GET", "/search/issues", {
      status: 200,
      headers: {},
      body: {
        total_count: 1,
        items: [
          {
            number: 12,
            title: "Crash when saving",
            state: "open",
            html_url: "https://github.com/tulip/farm/issues/12",
            repository_url: "https://api.github.com/repos/tulip/farm",
          },
        ],
      },
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.issueSearch, { repository: "tulip/farm", query: "crash" })
    );
    expect(output).toEqual({
      totalCount: 1,
      items: [
        {
          repository: "tulip/farm",
          number: 12,
          title: "Crash when saving",
          state: "open",
          htmlUrl: "https://github.com/tulip/farm/issues/12",
        },
      ],
    });
    expect(http.calls[0]?.query?.q).toContain("repo:tulip/farm");
  });
});

describe("GitHubAdapter authorization", () => {
  it("denies before any provider call when no Integration context resolves", async () => {
    resolved = undefined;
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.issueRead, { repository: "tulip/farm", issueNumber: 41 }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "integration_context_unresolved" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies an action no AccessGrant covers, without touching GitHub", async () => {
    resolved = context({ grants: [grant([GITHUB_TOOL_IDS.issueRead])] });
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.issueClose, { repository: "tulip/farm", issueNumber: 41 }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "integration_access_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies a repository outside the App installation, without touching GitHub", async () => {
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.issueRead, { repository: "other/repo", issueNumber: 41 }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "installation_scope_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies when the arguments name a repository the target refs never authorized", async () => {
    resolved = context({
      grants: [grant(ALL_ACTIONS)],
      installation: { ...context().installation, repositories: "all" },
    });
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.issueRead, { repository: "tulip/other", issueNumber: 41 }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "integration_access_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("refuses to dispatch without a leased credential", async () => {
    const uncredentialed = intent(GITHUB_TOOL_IDS.issueRead, {
      repository: "tulip/farm",
      issueNumber: 41,
    });
    await expect(
      adapter.dispatch({
        intent: uncredentialed,
        idempotencyKey: uncredentialed.idempotencyKey,
        attempt: 1,
      })
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "credential_missing" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies a write when the installation only holds read permission", async () => {
    resolved = context({
      installation: { ...context().installation, permissions: { issues: "read" } },
    });
    await expect(
      dispatch(
        intent(GITHUB_TOOL_IDS.issueComment, {
          repository: "tulip/farm",
          issueNumber: 41,
          body: "hi",
        })
      )
    ).rejects.toMatchObject({ code: "installation_scope_denied" });
    expect(http.calls).toHaveLength(0);
  });
});

describe("GitHubAdapter effects", () => {
  const commentIntent = intent(GITHUB_TOOL_IDS.issueComment, {
    repository: "tulip/farm",
    issueNumber: 41,
    body: "Looks like a duplicate of #12.",
  });
  const marker = githubEffectMarker("idem-1");

  it("stamps the effect marker on a comment so the write can be recognized later", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41/comments", {
      status: 200,
      headers: {},
      body: [],
    });
    http.route("POST", "/repos/tulip/farm/issues/41/comments", {
      status: 201,
      headers: {},
      body: {
        id: 900,
        html_url: "https://github.com/tulip/farm/issues/41#issuecomment-900",
        created_at: "2026-07-25T00:00:00Z",
      },
    });
    const output = await dispatch(commentIntent);
    const posted = http.calls.find((call) => call.method === "POST");
    expect(String((posted?.body as { body: string }).body)).toContain(marker);
    expect(String((posted?.body as { body: string }).body)).toContain("duplicate of #12");
    expect(output).toEqual({
      commentId: "900",
      htmlUrl: "https://github.com/tulip/farm/issues/41#issuecomment-900",
      createdAt: "2026-07-25T00:00:00Z",
    });
  });

  it("returns the existing comment on a duplicate delivery instead of posting twice", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41/comments", {
      status: 200,
      headers: {},
      body: [
        {
          id: 900,
          body: `already said it\n\n${marker}`,
          html_url: "https://github.com/tulip/farm/issues/41#issuecomment-900",
          created_at: "2026-07-25T00:00:00Z",
        },
      ],
    });
    const output = await dispatch(commentIntent);
    expect(http.calls.some((call) => call.method === "POST")).toBe(false);
    expect(output).toMatchObject({ commentId: "900" });
  });

  it("adds labels", async () => {
    http.route("POST", "/repos/tulip/farm/issues/41/labels", {
      status: 200,
      headers: {},
      body: [{ name: "bug" }, { name: "duplicate" }],
    });
    await expect(
      dispatch(
        intent(GITHUB_TOOL_IDS.issueLabel, {
          repository: "tulip/farm",
          issueNumber: 41,
          labels: ["duplicate"],
        })
      )
    ).resolves.toEqual({ labels: ["bug", "duplicate"] });
  });

  it("assigns a user", async () => {
    http.route("POST", "/repos/tulip/farm/issues/41/assignees", {
      status: 200,
      headers: {},
      body: { assignees: [{ login: "maintainer" }] },
    });
    await expect(
      dispatch(
        intent(GITHUB_TOOL_IDS.issueAssign, {
          repository: "tulip/farm",
          issueNumber: 41,
          assignees: ["maintainer"],
        })
      )
    ).resolves.toEqual({ assignees: ["maintainer"] });
  });

  it("closes an issue with an explicit state reason", async () => {
    http.route("PATCH", "/repos/tulip/farm/issues/41", {
      status: 200,
      headers: {},
      body: { number: 41, state: "closed", state_reason: "not_planned" },
    });
    await expect(
      dispatch(
        intent(GITHUB_TOOL_IDS.issueClose, {
          repository: "tulip/farm",
          issueNumber: 41,
          stateReason: "not_planned",
        })
      )
    ).resolves.toEqual({ number: 41, state: "closed", stateReason: "not_planned" });
    expect(http.calls.at(-1)?.body).toEqual({ state: "closed", state_reason: "not_planned" });
  });
});

describe("GitHubAdapter provider failures", () => {
  it("reports a provider 5xx on a write as after_dispatch so the ledger marks it ambiguous", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41/comments", {
      status: 200,
      headers: {},
      body: [],
    });
    http.route("POST", "/repos/tulip/farm/issues/41/comments", {
      status: 502,
      headers: {},
      body: {},
    });
    const error = await dispatch(
      intent(GITHUB_TOOL_IDS.issueComment, {
        repository: "tulip/farm",
        issueNumber: 41,
        body: "hi",
      })
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AdapterDispatchError);
    expect(error).toMatchObject({ phase: "after_dispatch", retryable: true });
  });

  it("reports a rate limit as a retryable pre-dispatch failure", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41", {
      status: 429,
      headers: { "retry-after": "5" },
      body: {},
    });
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.issueRead, { repository: "tulip/farm", issueNumber: 41 }))
    ).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "provider_rate_limited",
      retryable: true,
    });
  });

  it("never puts the credential into a failure it raises", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41", { status: 403, headers: {}, body: {} });
    const error = await dispatch(
      intent(GITHUB_TOOL_IDS.issueRead, { repository: "tulip/farm", issueNumber: 41 })
    ).catch((thrown: unknown) => thrown);
    expect(
      JSON.stringify({ message: (error as Error).message, ...(error as object) })
    ).not.toContain(CREDENTIAL);
  });
});

describe("GitHubAdapter reconciliation", () => {
  const commentIntent = intent(GITHUB_TOOL_IDS.issueComment, {
    repository: "tulip/farm",
    issueNumber: 41,
    body: "hi",
  });

  function reconcileWith(credential: string | undefined = CREDENTIAL) {
    return adapter.reconcile(
      {
        intent: commentIntent,
        idempotencyKey: commentIntent.idempotencyKey,
        operation: "github.issue.comment.lookup",
      },
      credential
    );
  }

  it("confirms an ambiguous comment when the marker is present at the provider", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41/comments", {
      status: 200,
      headers: {},
      body: [
        {
          id: 900,
          body: githubEffectMarker("idem-1"),
          html_url: "https://github.com/tulip/farm/issues/41#issuecomment-900",
          created_at: "2026-07-25T00:00:00Z",
        },
      ],
    });
    await expect(reconcileWith()).resolves.toEqual({
      outcome: "confirmed",
      evidenceRef: "github:comment:900",
    });
  });

  it("reports not_applied when the marker is absent", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41/comments", {
      status: 200,
      headers: {},
      body: [{ id: 900, body: "someone else", html_url: "x", created_at: "y" }],
    });
    await expect(reconcileWith()).resolves.toMatchObject({ outcome: "not_applied" });
  });

  it("stays ambiguous rather than guessing when the lookup itself fails", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41/comments", {
      status: 503,
      headers: {},
      body: {},
    });
    await expect(reconcileWith()).resolves.toMatchObject({ outcome: "ambiguous" });
  });

  it("confirms a close by reading the issue state back", async () => {
    http.route("GET", "/repos/tulip/farm/issues/41", {
      status: 200,
      headers: {},
      body: { ...ISSUE_BODY, state: "closed" },
    });
    const closeIntent = intent(GITHUB_TOOL_IDS.issueClose, {
      repository: "tulip/farm",
      issueNumber: 41,
      stateReason: "completed",
    });
    await expect(
      adapter.reconcile(
        {
          intent: closeIntent,
          idempotencyKey: closeIntent.idempotencyKey,
          operation: "github.issue.state.lookup",
        },
        CREDENTIAL
      )
    ).resolves.toEqual({ outcome: "confirmed", evidenceRef: "github:issue:tulip/farm#41:closed" });
  });

  it("stays ambiguous when reconciliation is attempted without a credential", async () => {
    await expect(
      adapter.reconcile({
        intent: commentIntent,
        idempotencyKey: commentIntent.idempotencyKey,
        operation: "github.issue.comment.lookup",
      })
    ).resolves.toMatchObject({ outcome: "ambiguous" });
  });
});
