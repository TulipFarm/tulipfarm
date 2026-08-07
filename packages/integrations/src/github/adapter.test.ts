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
  GITHUB_TOOL_IDS.pullRequestRead,
  GITHUB_TOOL_IDS.pullRequestSearch,
  GITHUB_TOOL_IDS.pullRequestCreate,
  GITHUB_TOOL_IDS.pullRequestComment,
  GITHUB_TOOL_IDS.pullRequestReview,
  GITHUB_TOOL_IDS.pullRequestMerge,
  GITHUB_TOOL_IDS.checkRunRead,
  GITHUB_TOOL_IDS.repoPush,
  GITHUB_TOOL_IDS.contentRead,
  GITHUB_TOOL_IDS.contentList,
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
      permissions: { issues: "write", pull_requests: "write", checks: "read", contents: "write" },
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

type RouteHandler =
  | IntegrationHttpResponse
  | ((request: IntegrationHttpRequest) => IntegrationHttpResponse);

class FakeGitHubHttp {
  readonly calls: IntegrationHttpRequest[] = [];
  private readonly routes = new Map<string, RouteHandler>();

  route(method: string, path: string, response: RouteHandler): void {
    this.routes.set(`${method} ${path}`, response);
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    if (credential !== CREDENTIAL) throw new Error("adapter dispatched without the leased token");
    this.calls.push(request);
    const handler = this.routes.get(`${request.method} ${request.path}`);
    if (handler === undefined) {
      throw new Error(`unscripted GitHub call: ${request.method} ${request.path}`);
    }
    return typeof handler === "function" ? handler(request) : handler;
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

  it("lists every issue when query is omitted, instead of filtering by text", async () => {
    http.route("GET", "/search/issues", {
      status: 200,
      headers: {},
      body: { total_count: 0, items: [] },
    });
    await dispatch(intent(GITHUB_TOOL_IDS.issueSearch, { repository: "tulip/farm" }));
    expect(http.calls[0]?.query?.q).toBe("repo:tulip/farm is:issue state:open");
  });

  it("ORs an explicit repositories list into one search call", async () => {
    resolved = context({
      installation: {
        ...context().installation,
        repositories: ["tulip/farm", "tulip/canary"],
      },
      grants: [
        {
          ...grant(ALL_ACTIONS),
          spec: {
            ...grant(ALL_ACTIONS).spec,
            externalTargets: [
              { type: GITHUB_REPOSITORY_TARGET, ids: ["tulip/farm", "tulip/canary"] },
            ],
          },
        },
      ],
    });
    http.route("GET", "/search/issues", {
      status: 200,
      headers: {},
      body: { total_count: 0, items: [] },
    });

    await dispatch(
      intent(GITHUB_TOOL_IDS.issueSearch, { repositories: ["tulip/farm", "tulip/canary"] })
    );

    expect(http.calls[0]?.query?.q).toBe("repo:tulip/farm repo:tulip/canary is:issue state:open");
  });

  it("denies a multi-repository search before any provider call when one repo isn't granted", async () => {
    resolved = context({
      installation: {
        ...context().installation,
        repositories: ["tulip/farm", "tulip/canary"],
      },
      // Grant only covers tulip/farm — tulip/canary must still deny, fail-closed.
    });

    await expect(
      dispatch(
        intent(GITHUB_TOOL_IDS.issueSearch, { repositories: ["tulip/farm", "tulip/canary"] })
      )
    ).rejects.toThrow(AdapterDispatchError);
    expect(http.calls).toHaveLength(0);
  });

  it("searches every installed repository when neither repository nor repositories is given", async () => {
    resolved = context({
      installation: {
        ...context().installation,
        repositories: ["tulip/farm"],
      },
    });
    http.route("GET", "/search/issues", {
      status: 200,
      headers: {},
      body: { total_count: 0, items: [] },
    });

    await dispatch(intent(GITHUB_TOOL_IDS.issueSearch, {}));

    expect(http.calls[0]?.query?.q).toBe("repo:tulip/farm is:issue state:open");
  });

  it("requires an explicit repositories list for an account-wide installation, rather than widening", async () => {
    resolved = context({
      installation: { ...context().installation, repositories: "all" },
    });

    await expect(dispatch(intent(GITHUB_TOOL_IDS.issueSearch, {}))).rejects.toThrow(
      AdapterDispatchError
    );
    expect(http.calls).toHaveLength(0);
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

const PULL_REQUEST_BODY = {
  number: 12,
  title: "Fix crash",
  body: "closes #41",
  state: "open",
  merged: false,
  html_url: "https://github.com/tulip/farm/pull/12",
  head: { ref: "fix-crash" },
  base: { ref: "main" },
};

describe("GitHubAdapter pull requests", () => {
  it("reads a pull request through the typed Tool", async () => {
    http.route("GET", "/repos/tulip/farm/pulls/12", {
      status: 200,
      headers: {},
      body: PULL_REQUEST_BODY,
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.pullRequestRead, { repository: "tulip/farm", pullNumber: 12 })
    );
    expect(output).toEqual({
      repository: "tulip/farm",
      number: 12,
      title: "Fix crash",
      body: "closes #41",
      state: "open",
      merged: false,
      htmlUrl: "https://github.com/tulip/farm/pull/12",
      headRef: "fix-crash",
      baseRef: "main",
    });
  });

  it("denies a pull request read when the installation only holds issues permission", async () => {
    resolved = context({
      installation: { ...context().installation, permissions: { issues: "write" } },
    });
    await expect(
      dispatch(
        intent(GITHUB_TOOL_IDS.pullRequestRead, { repository: "tulip/farm", pullNumber: 12 })
      )
    ).rejects.toMatchObject({ code: "installation_scope_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("creates a pull request, stamping the effect marker in the body", async () => {
    http.route("GET", "/repos/tulip/farm/pulls", { status: 200, headers: {}, body: [] });
    http.route("POST", "/repos/tulip/farm/pulls", {
      status: 201,
      headers: {},
      body: PULL_REQUEST_BODY,
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.pullRequestCreate, {
        repository: "tulip/farm",
        title: "Fix crash",
        head: "fix-crash",
        base: "main",
      })
    );
    const posted = http.calls.find((call) => call.method === "POST");
    expect(String((posted?.body as { body: string }).body)).toContain(githubEffectMarker("idem-1"));
    expect(output).toMatchObject({ number: 12, headRef: "fix-crash", baseRef: "main" });
  });

  it("returns the existing pull request on a duplicate delivery instead of opening a second one", async () => {
    http.route("GET", "/repos/tulip/farm/pulls", {
      status: 200,
      headers: {},
      body: [PULL_REQUEST_BODY],
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.pullRequestCreate, {
        repository: "tulip/farm",
        title: "Fix crash",
        head: "fix-crash",
        base: "main",
      })
    );
    expect(http.calls.some((call) => call.method === "POST")).toBe(false);
    expect(output).toMatchObject({ number: 12 });
  });

  it("comments on a pull request via the shared issue-comments endpoint", async () => {
    http.route("GET", "/repos/tulip/farm/issues/12/comments", {
      status: 200,
      headers: {},
      body: [],
    });
    http.route("POST", "/repos/tulip/farm/issues/12/comments", {
      status: 201,
      headers: {},
      body: {
        id: 901,
        html_url: "https://github.com/tulip/farm/pull/12#issuecomment-901",
        created_at: "2026-07-25T00:00:00Z",
      },
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.pullRequestComment, {
        repository: "tulip/farm",
        pullNumber: 12,
        body: "LGTM",
      })
    );
    expect(output).toEqual({
      commentId: "901",
      htmlUrl: "https://github.com/tulip/farm/pull/12#issuecomment-901",
      createdAt: "2026-07-25T00:00:00Z",
    });
  });

  it("submits a review, stamping the effect marker in the review body", async () => {
    http.route("GET", "/repos/tulip/farm/pulls/12/reviews", { status: 200, headers: {}, body: [] });
    http.route("POST", "/repos/tulip/farm/pulls/12/reviews", {
      status: 200,
      headers: {},
      body: {
        id: 55,
        state: "APPROVED",
        html_url: "https://github.com/tulip/farm/pull/12#pullrequestreview-55",
      },
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.pullRequestReview, {
        repository: "tulip/farm",
        pullNumber: 12,
        event: "APPROVE",
      })
    );
    const posted = http.calls.find((call) => call.method === "POST");
    expect(String((posted?.body as { body: string }).body)).toContain(githubEffectMarker("idem-1"));
    expect(output).toEqual({
      reviewId: "55",
      state: "APPROVED",
      htmlUrl: "https://github.com/tulip/farm/pull/12#pullrequestreview-55",
    });
  });

  it("merges a pull request", async () => {
    http.route("GET", "/repos/tulip/farm/pulls/12", {
      status: 200,
      headers: {},
      body: { ...PULL_REQUEST_BODY, merged: false },
    });
    http.route("PUT", "/repos/tulip/farm/pulls/12/merge", {
      status: 200,
      headers: {},
      body: { merged: true, sha: "abc123" },
    });
    await expect(
      dispatch(
        intent(GITHUB_TOOL_IDS.pullRequestMerge, {
          repository: "tulip/farm",
          pullNumber: 12,
          mergeMethod: "squash",
        })
      )
    ).resolves.toEqual({ merged: true, sha: "abc123" });
    expect(http.calls.at(-1)?.body).toMatchObject({ merge_method: "squash" });
  });

  it("treats an already-merged pull request as done without merging twice", async () => {
    http.route("GET", "/repos/tulip/farm/pulls/12", {
      status: 200,
      headers: {},
      body: { ...PULL_REQUEST_BODY, merged: true, merge_commit_sha: "already-merged" },
    });
    const output = await dispatch(
      intent(GITHUB_TOOL_IDS.pullRequestMerge, { repository: "tulip/farm", pullNumber: 12 })
    );
    expect(output).toEqual({ merged: true, sha: "already-merged" });
    expect(http.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("reads a check run through the typed Tool", async () => {
    http.route("GET", "/repos/tulip/farm/check-runs/555", {
      status: 200,
      headers: {},
      body: {
        id: 555,
        name: "build",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/tulip/farm/runs/555",
      },
    });
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.checkRunRead, { repository: "tulip/farm", checkRunId: 555 }))
    ).resolves.toEqual({
      id: 555,
      name: "build",
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://github.com/tulip/farm/runs/555",
    });
  });
});

describe("GitHubAdapter repo content", () => {
  it("reads a file's content through the typed Tool", async () => {
    http.route("GET", "/repos/tulip/farm/contents/README.md", {
      status: 200,
      headers: {},
      body: {
        path: "README.md",
        sha: "abc123",
        content: "SGVsbG8=",
        encoding: "base64",
        html_url: "https://github.com/tulip/farm/blob/main/README.md",
      },
    });
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.contentRead, { repository: "tulip/farm", path: "README.md" }))
    ).resolves.toEqual({
      repository: "tulip/farm",
      path: "README.md",
      sha: "abc123",
      content: "SGVsbG8=",
      encoding: "base64",
      htmlUrl: "https://github.com/tulip/farm/blob/main/README.md",
    });
  });

  it("passes ref through as a query parameter", async () => {
    http.route("GET", "/repos/tulip/farm/contents/README.md", (request) => ({
      status: 200,
      headers: {},
      body: {
        path: "README.md",
        sha: "def456",
        content: "SGk=",
        encoding: "base64",
        html_url: "https://github.com/tulip/farm/blob/dev/README.md",
        _ref: request.query?.ref,
      },
    }));
    await dispatch(
      intent(GITHUB_TOOL_IDS.contentRead, {
        repository: "tulip/farm",
        path: "README.md",
        ref: "dev",
      })
    );
    expect(http.calls[0]?.query).toEqual({ ref: "dev" });
  });

  it("lists a directory through the typed Tool", async () => {
    http.route("GET", "/repos/tulip/farm/contents/src", {
      status: 200,
      headers: {},
      body: [
        {
          name: "a.ts",
          path: "src/a.ts",
          type: "file",
          sha: "sha-a",
          html_url: "https://github.com/tulip/farm/blob/main/src/a.ts",
        },
        {
          name: "lib",
          path: "src/lib",
          type: "dir",
          sha: "sha-lib",
          html_url: "https://github.com/tulip/farm/tree/main/src/lib",
        },
      ],
    });
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.contentList, { repository: "tulip/farm", path: "src" }))
    ).resolves.toEqual({
      repository: "tulip/farm",
      path: "src",
      entries: [
        {
          name: "a.ts",
          path: "src/a.ts",
          type: "file",
          sha: "sha-a",
          htmlUrl: "https://github.com/tulip/farm/blob/main/src/a.ts",
        },
        {
          name: "lib",
          path: "src/lib",
          type: "dir",
          sha: "sha-lib",
          htmlUrl: "https://github.com/tulip/farm/tree/main/src/lib",
        },
      ],
    });
  });

  it("lists the repository root when no path is given", async () => {
    http.route("GET", "/repos/tulip/farm/contents/", {
      status: 200,
      headers: {},
      body: [],
    });
    await expect(
      dispatch(intent(GITHUB_TOOL_IDS.contentList, { repository: "tulip/farm" }))
    ).resolves.toEqual({ repository: "tulip/farm", path: "", entries: [] });
  });
});

describe("GitHubAdapter repo push", () => {
  const pushIntent = intent(GITHUB_TOOL_IDS.repoPush, {
    repository: "tulip/farm",
    branch: "main",
    message: "fix crash",
    files: [{ path: "src/a.ts", content: "export {}" }],
  });
  const marker = githubEffectMarker("idem-1");

  it("pushes a commit through the Git Data API, stamping the marker in the message", async () => {
    http.route("GET", "/repos/tulip/farm/commits", { status: 200, headers: {}, body: [] });
    http.route("GET", "/repos/tulip/farm/git/ref/heads/main", {
      status: 200,
      headers: {},
      body: { object: { sha: "head-sha" } },
    });
    http.route("GET", "/repos/tulip/farm/git/commits/head-sha", {
      status: 200,
      headers: {},
      body: { tree: { sha: "tree-sha" } },
    });
    http.route("POST", "/repos/tulip/farm/git/blobs", {
      status: 201,
      headers: {},
      body: { sha: "blob-sha" },
    });
    http.route("POST", "/repos/tulip/farm/git/trees", {
      status: 201,
      headers: {},
      body: { sha: "new-tree-sha" },
    });
    http.route("POST", "/repos/tulip/farm/git/commits", {
      status: 201,
      headers: {},
      body: { sha: "new-commit-sha" },
    });
    http.route("PATCH", "/repos/tulip/farm/git/refs/heads/main", {
      status: 200,
      headers: {},
      body: { object: { sha: "new-commit-sha" } },
    });

    const output = await dispatch(pushIntent);

    const commitCall = http.calls.find(
      (call) => call.method === "POST" && call.path === "/repos/tulip/farm/git/commits"
    );
    expect(String((commitCall?.body as { message: string }).message)).toContain(marker);
    const refCall = http.calls.find((call) => call.method === "PATCH");
    expect(refCall?.body).toEqual({ sha: "new-commit-sha", force: false });
    expect(output).toEqual({
      repository: "tulip/farm",
      branch: "main",
      sha: "new-commit-sha",
      htmlUrl: "https://github.com/tulip/farm/commit/new-commit-sha",
    });
  });

  it("returns the existing commit on a duplicate delivery instead of pushing twice", async () => {
    http.route("GET", "/repos/tulip/farm/commits", {
      status: 200,
      headers: {},
      body: [{ sha: "already-pushed", commit: { message: `fix crash\n\n${marker}` } }],
    });
    const output = await dispatch(pushIntent);
    expect(http.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(
      false
    );
    expect(output).toEqual({
      repository: "tulip/farm",
      branch: "main",
      sha: "already-pushed",
      htmlUrl: "https://github.com/tulip/farm/commit/already-pushed",
    });
  });

  it("pages past a full first page to find a marker further back in history", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      sha: `recent-${i}`,
      commit: { message: `noise ${i}` },
    }));
    http.route("GET", "/repos/tulip/farm/commits", (request) => {
      const page = request.query?.page ?? "1";
      if (page === "1") return { status: 200, headers: {}, body: fullPage };
      if (page === "2") {
        return {
          status: 200,
          headers: {},
          body: [{ sha: "confirmed-sha", commit: { message: `fix crash\n\n${marker}` } }],
        };
      }
      throw new Error(`unexpected page ${page}`);
    });

    const output = await dispatch(pushIntent);

    expect(http.calls.filter((call) => call.path === "/repos/tulip/farm/commits")).toHaveLength(2);
    expect(output).toEqual({
      repository: "tulip/farm",
      branch: "main",
      sha: "confirmed-sha",
      htmlUrl: "https://github.com/tulip/farm/commit/confirmed-sha",
    });
  });

  it("denies a push when the installation only holds issues permission", async () => {
    resolved = context({
      installation: { ...context().installation, permissions: { issues: "write" } },
    });
    await expect(dispatch(pushIntent)).rejects.toMatchObject({ code: "installation_scope_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("confirms a push reconciliation by finding the marked commit", async () => {
    http.route("GET", "/repos/tulip/farm/commits", {
      status: 200,
      headers: {},
      body: [{ sha: "confirmed-sha", commit: { message: `fix crash\n\n${marker}` } }],
    });
    await expect(
      adapter.reconcile(
        {
          intent: pushIntent,
          idempotencyKey: pushIntent.idempotencyKey,
          operation: "github.repo.push.lookup",
        },
        CREDENTIAL
      )
    ).resolves.toEqual({
      outcome: "confirmed",
      evidenceRef: "github:repo:push:confirmed-sha",
    });
  });

  it("reports not_applied when no commit carries the marker", async () => {
    http.route("GET", "/repos/tulip/farm/commits", { status: 200, headers: {}, body: [] });
    await expect(
      adapter.reconcile(
        {
          intent: pushIntent,
          idempotencyKey: pushIntent.idempotencyKey,
          operation: "github.repo.push.lookup",
        },
        CREDENTIAL
      )
    ).resolves.toEqual({
      outcome: "not_applied",
      evidenceRef: "github:repo:push:tulip/farm:main",
    });
  });
});

describe("GitHubAdapter pull request reconciliation", () => {
  it("confirms a pull request create by finding the open PR from head", async () => {
    http.route("GET", "/repos/tulip/farm/pulls", {
      status: 200,
      headers: {},
      body: [PULL_REQUEST_BODY],
    });
    const createIntent = intent(GITHUB_TOOL_IDS.pullRequestCreate, {
      repository: "tulip/farm",
      title: "Fix crash",
      head: "fix-crash",
      base: "main",
    });
    await expect(
      adapter.reconcile(
        {
          intent: createIntent,
          idempotencyKey: createIntent.idempotencyKey,
          operation: "github.pull_request.create.lookup",
        },
        CREDENTIAL
      )
    ).resolves.toEqual({ outcome: "confirmed", evidenceRef: "github:pull_request:12" });
  });

  it("confirms a pull request review by finding the marked review", async () => {
    http.route("GET", "/repos/tulip/farm/pulls/12/reviews", {
      status: 200,
      headers: {},
      body: [{ id: 55, body: githubEffectMarker("idem-1") }],
    });
    const reviewIntent = intent(GITHUB_TOOL_IDS.pullRequestReview, {
      repository: "tulip/farm",
      pullNumber: 12,
      event: "APPROVE",
    });
    await expect(
      adapter.reconcile(
        {
          intent: reviewIntent,
          idempotencyKey: reviewIntent.idempotencyKey,
          operation: "github.pull_request.review.lookup",
        },
        CREDENTIAL
      )
    ).resolves.toEqual({ outcome: "confirmed", evidenceRef: "github:pull_request:review:55" });
  });

  it("confirms a pull request merge by reading merged state back", async () => {
    http.route("GET", "/repos/tulip/farm/pulls/12", {
      status: 200,
      headers: {},
      body: { ...PULL_REQUEST_BODY, merged: true },
    });
    const mergeIntent = intent(GITHUB_TOOL_IDS.pullRequestMerge, {
      repository: "tulip/farm",
      pullNumber: 12,
    });
    await expect(
      adapter.reconcile(
        {
          intent: mergeIntent,
          idempotencyKey: mergeIntent.idempotencyKey,
          operation: "github.pull_request.merge.lookup",
        },
        CREDENTIAL
      )
    ).resolves.toEqual({
      outcome: "confirmed",
      evidenceRef: "github:pull_request:tulip/farm#12:merged",
    });
  });
});
