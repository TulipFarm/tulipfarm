import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { AdapterDispatchError, type ToolIntent } from "@tulipfarm/tool-broker";
import { beforeEach, describe, expect, it } from "vitest";
import type { IntegrationHttpRequest, IntegrationHttpResponse } from "../http";
import { JiraAdapter, type JiraEffectContext, jiraEffectLabel } from "./adapter";
import { JIRA_ISSUE_TARGET, JIRA_PROJECT_TARGET, JIRA_TOOL_IDS } from "./contracts";

const BUSINESS_ID = "biz-1";
const INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL = "jira_oauth_token";

const ALL_ACTIONS = [
  JIRA_TOOL_IDS.issueRead,
  JIRA_TOOL_IDS.issueSearch,
  JIRA_TOOL_IDS.issueCreate,
  JIRA_TOOL_IDS.issueTransition,
  JIRA_TOOL_IDS.userSearch,
  JIRA_TOOL_IDS.userAvailability,
];

function grant(actions: string[] = ALL_ACTIONS): AccessGrantDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "AccessGrant",
    metadata: {
      id: "44444444-4444-4444-8444-444444444444",
      slug: "triage-jira-grant",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
    },
    spec: {
      integrationId: INTEGRATION_ID,
      principals: [{ kind: "agent", id: AGENT_ID }],
      actions,
      externalTargets: [{ type: JIRA_PROJECT_TARGET, ids: ["FARM"] }],
      delegable: false,
    },
  };
}

function context(overrides: Partial<JiraEffectContext> = {}): JiraEffectContext {
  return {
    integrationId: INTEGRATION_ID,
    site: {
      businessId: BUSINESS_ID,
      integrationId: INTEGRATION_ID,
      cloudId: "cloud-9",
      siteUrl: "https://tulip.atlassian.net",
      projects: ["FARM"],
      permissions: { issues: "write", users: "read" },
    },
    principals: [{ kind: "agent", id: AGENT_ID }],
    grants: [grant()],
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
      { type: JIRA_PROJECT_TARGET, id: "FARM" },
      { type: JIRA_ISSUE_TARGET, id: "FARM-12" },
    ],
    arguments: args,
    destination: "jira",
    credentialRef: "secret://jira/oauth",
    idempotencyKey,
  };
}

/** Responses are queued per route; the last queued response repeats. */
class FakeJiraHttp {
  readonly calls: IntegrationHttpRequest[] = [];
  private readonly routes = new Map<string, IntegrationHttpResponse[]>();

  route(method: string, path: string, ...responses: IntegrationHttpResponse[]): void {
    this.routes.set(`${method} ${path}`, responses);
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    if (credential !== CREDENTIAL) throw new Error("adapter dispatched without the leased token");
    this.calls.push(request);
    const queued = this.routes.get(`${request.method} ${request.path}`);
    if (queued === undefined || queued.length === 0) {
      throw new Error(`unscripted Jira call: ${request.method} ${request.path}`);
    }
    return queued.length === 1
      ? (queued[0] as IntegrationHttpResponse)
      : (queued.shift() as IntegrationHttpResponse);
  }
}

const ISSUE_BODY = {
  key: "FARM-12",
  fields: {
    summary: "Crash on save",
    description: "steps",
    status: { name: "To Do" },
    issuetype: { name: "Bug" },
    assignee: { accountId: "acct-7", displayName: "Maintainer" },
    labels: ["triage"],
  },
};

function ok(body: unknown, status = 200): IntegrationHttpResponse {
  return { status, headers: {}, body };
}

let http: FakeJiraHttp;
let resolved: JiraEffectContext | undefined;
let adapter: JiraAdapter;

beforeEach(() => {
  http = new FakeJiraHttp();
  resolved = context();
  adapter = new JiraAdapter({
    http,
    context: { resolve: async () => resolved },
    now: () => new Date("2026-07-25T00:00:00.000Z"),
  });
});

function dispatch(toolIntent: ToolIntent) {
  return adapter.dispatch(
    { intent: toolIntent, idempotencyKey: toolIntent.idempotencyKey, attempt: 1 },
    CREDENTIAL
  );
}

describe("JiraAdapter reads", () => {
  it("reads an issue through the typed Tool", async () => {
    http.route("GET", "/rest/api/3/issue/FARM-12", ok(ISSUE_BODY));
    await expect(
      dispatch(intent(JIRA_TOOL_IDS.issueRead, { issueKey: "FARM-12" }))
    ).resolves.toEqual({
      issueKey: "FARM-12",
      projectKey: "FARM",
      summary: "Crash on save",
      description: "steps",
      status: "To Do",
      issueType: "Bug",
      assignee: "acct-7",
      labels: ["triage"],
    });
  });

  it("walks every search page rather than returning a silent first page", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({
        total: 3,
        startAt: 0,
        maxResults: 2,
        issues: [
          { key: "FARM-1", fields: { summary: "a", status: { name: "To Do" } } },
          { key: "FARM-2", fields: { summary: "b", status: { name: "To Do" } } },
        ],
      }),
      ok({
        total: 3,
        startAt: 2,
        maxResults: 2,
        issues: [{ key: "FARM-3", fields: { summary: "c", status: { name: "Done" } } }],
      })
    );

    const output = await dispatch(
      intent(JIRA_TOOL_IDS.issueSearch, { projectKey: "FARM", jql: "text ~ crash", limit: 10 })
    );
    expect(output).toEqual({
      total: 3,
      items: [
        { issueKey: "FARM-1", summary: "a", status: "To Do" },
        { issueKey: "FARM-2", summary: "b", status: "To Do" },
        { issueKey: "FARM-3", summary: "c", status: "Done" },
      ],
    });
    expect(http.calls[0]?.query?.jql).toContain("project = FARM");
  });

  it("fails loudly instead of truncating when a search exceeds its declared bound", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({
        total: 9,
        startAt: 0,
        maxResults: 2,
        issues: [
          { key: "FARM-1", fields: { summary: "a", status: { name: "To Do" } } },
          { key: "FARM-2", fields: { summary: "b", status: { name: "To Do" } } },
        ],
      })
    );
    await expect(
      dispatch(intent(JIRA_TOOL_IDS.issueSearch, { projectKey: "FARM", jql: "text ~ x", limit: 1 }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "pagination_bound_exceeded" });
  });

  it("answers the availability question from assigned open work, not from a guess", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({ total: 2, startAt: 0, maxResults: 1, issues: [] }),
      ok({ total: 9, startAt: 0, maxResults: 1, issues: [] })
    );
    await expect(
      dispatch(
        intent(JIRA_TOOL_IDS.userAvailability, {
          projectKey: "FARM",
          accountIds: ["acct-7", "acct-8"],
          maxOpenIssues: 5,
        })
      )
    ).resolves.toEqual({
      candidates: [
        { accountId: "acct-7", openIssueCount: 2, available: true },
        { accountId: "acct-8", openIssueCount: 9, available: false },
      ],
    });
  });

  it("searches assignable users within the project", async () => {
    http.route(
      "GET",
      "/rest/api/3/user/assignable/search",
      ok([
        { accountId: "acct-7", displayName: "Maintainer", active: true },
        { accountId: "acct-9", displayName: "Retired", active: false },
      ])
    );
    await expect(
      dispatch(intent(JIRA_TOOL_IDS.userSearch, { projectKey: "FARM", query: "main" }))
    ).resolves.toEqual({
      users: [{ accountId: "acct-7", displayName: "Maintainer", active: true }],
    });
  });
});

describe("JiraAdapter authorization", () => {
  it("denies before any provider call when no Integration context resolves", async () => {
    resolved = undefined;
    await expect(
      dispatch(intent(JIRA_TOOL_IDS.issueRead, { issueKey: "FARM-12" }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "integration_context_unresolved" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies an action no AccessGrant covers, without touching Jira", async () => {
    resolved = context({ grants: [grant([JIRA_TOOL_IDS.issueRead])] });
    await expect(
      dispatch(
        intent(JIRA_TOOL_IDS.issueCreate, { projectKey: "FARM", summary: "x", issueType: "Bug" })
      )
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "integration_access_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies a project outside the site installation, without touching Jira", async () => {
    await expect(
      dispatch(intent(JIRA_TOOL_IDS.issueRead, { issueKey: "OTHER-3" }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "site_scope_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies a project the grant never named even when the site covers it", async () => {
    resolved = context({ site: { ...context().site, projects: "all" } });
    await expect(
      dispatch(intent(JIRA_TOOL_IDS.issueRead, { issueKey: "OTHER-3" }))
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "integration_access_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("denies a write when the installation only holds read permission", async () => {
    resolved = context({ site: { ...context().site, permissions: { issues: "read" } } });
    await expect(
      dispatch(
        intent(JIRA_TOOL_IDS.issueCreate, { projectKey: "FARM", summary: "x", issueType: "Bug" })
      )
    ).rejects.toMatchObject({ code: "site_scope_denied" });
    expect(http.calls).toHaveLength(0);
  });

  it("refuses to dispatch without a leased credential", async () => {
    const uncredentialed = intent(JIRA_TOOL_IDS.issueRead, { issueKey: "FARM-12" });
    await expect(
      adapter.dispatch({
        intent: uncredentialed,
        idempotencyKey: uncredentialed.idempotencyKey,
        attempt: 1,
      })
    ).rejects.toMatchObject({ phase: "before_dispatch", code: "credential_missing" });
    expect(http.calls).toHaveLength(0);
  });
});

describe("JiraAdapter effects", () => {
  const createIntent = intent(JIRA_TOOL_IDS.issueCreate, {
    projectKey: "FARM",
    summary: "Crash on save",
    issueType: "Bug",
    description: "from GitHub issue 41",
  });
  const label = jiraEffectLabel("idem-1");

  it("stamps the effect label on a created issue so the write can be recognized later", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({ total: 0, startAt: 0, maxResults: 1, issues: [] })
    );
    http.route("POST", "/rest/api/3/issue", ok({ id: "10001", key: "FARM-13" }, 201));

    const output = await dispatch(createIntent);
    const posted = http.calls.find((call) => call.method === "POST");
    expect((posted?.body as { fields: { labels: string[] } }).fields.labels).toContain(label);
    expect(output).toEqual({
      issueKey: "FARM-13",
      issueId: "10001",
      url: "https://tulip.atlassian.net/browse/FARM-13",
    });
  });

  it("returns the existing issue on a duplicate delivery instead of creating a second one", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({
        total: 1,
        startAt: 0,
        maxResults: 1,
        issues: [{ id: "10001", key: "FARM-13", fields: { summary: "Crash on save" } }],
      })
    );
    const output = await dispatch(createIntent);
    expect(http.calls.some((call) => call.method === "POST")).toBe(false);
    expect(output).toMatchObject({ issueKey: "FARM-13" });
  });

  it("transitions an issue and reports the status it read back", async () => {
    http.route(
      "GET",
      "/rest/api/3/issue/FARM-12",
      ok(ISSUE_BODY),
      ok({ ...ISSUE_BODY, fields: { ...ISSUE_BODY.fields, status: { name: "In Progress" } } })
    );
    http.route("POST", "/rest/api/3/issue/FARM-12/transitions", ok(undefined, 204));

    await expect(
      dispatch(
        intent(JIRA_TOOL_IDS.issueTransition, {
          issueKey: "FARM-12",
          transitionId: "21",
          targetStatus: "In Progress",
        })
      )
    ).resolves.toEqual({ issueKey: "FARM-12", status: "In Progress" });
  });

  it("skips a transition that provider state shows already applied", async () => {
    http.route(
      "GET",
      "/rest/api/3/issue/FARM-12",
      ok({ ...ISSUE_BODY, fields: { ...ISSUE_BODY.fields, status: { name: "In Progress" } } })
    );
    await expect(
      dispatch(
        intent(JIRA_TOOL_IDS.issueTransition, {
          issueKey: "FARM-12",
          transitionId: "21",
          targetStatus: "In Progress",
        })
      )
    ).resolves.toEqual({ issueKey: "FARM-12", status: "In Progress" });
    expect(http.calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("JiraAdapter provider failures", () => {
  it("reports a provider 5xx on a create as after_dispatch so the ledger marks it ambiguous", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({ total: 0, startAt: 0, maxResults: 1, issues: [] })
    );
    http.route("POST", "/rest/api/3/issue", { status: 503, headers: {}, body: {} });

    const error = await dispatch(
      intent(JIRA_TOOL_IDS.issueCreate, { projectKey: "FARM", summary: "x", issueType: "Bug" })
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AdapterDispatchError);
    expect(error).toMatchObject({ phase: "after_dispatch", retryable: true });
  });

  it("reports a rate limit as a retryable pre-dispatch failure", async () => {
    http.route("GET", "/rest/api/3/issue/FARM-12", {
      status: 429,
      headers: { "retry-after": "5" },
      body: {},
    });
    await expect(
      dispatch(intent(JIRA_TOOL_IDS.issueRead, { issueKey: "FARM-12" }))
    ).rejects.toMatchObject({
      phase: "before_dispatch",
      code: "provider_rate_limited",
      retryable: true,
    });
  });

  it("never puts the credential into a failure it raises", async () => {
    http.route("GET", "/rest/api/3/issue/FARM-12", { status: 403, headers: {}, body: {} });
    const error = await dispatch(intent(JIRA_TOOL_IDS.issueRead, { issueKey: "FARM-12" })).catch(
      (thrown: unknown) => thrown
    );
    expect(
      JSON.stringify({ message: (error as Error).message, ...(error as object) })
    ).not.toContain(CREDENTIAL);
  });
});

describe("JiraAdapter reconciliation", () => {
  const createIntent = intent(JIRA_TOOL_IDS.issueCreate, {
    projectKey: "FARM",
    summary: "Crash on save",
    issueType: "Bug",
  });

  function reconcileCreate(credential?: string) {
    return adapter.reconcile(
      {
        intent: createIntent,
        idempotencyKey: createIntent.idempotencyKey,
        operation: "jira.issue.create.lookup",
      },
      credential
    );
  }

  it("confirms an ambiguous create when the effect label is present at the provider", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({
        total: 1,
        startAt: 0,
        maxResults: 1,
        issues: [{ id: "10001", key: "FARM-13", fields: {} }],
      })
    );
    await expect(reconcileCreate(CREDENTIAL)).resolves.toEqual({
      outcome: "confirmed",
      evidenceRef: "jira:issue:FARM-13",
    });
  });

  it("reports not_applied when no issue carries the effect label", async () => {
    http.route(
      "GET",
      "/rest/api/3/search",
      ok({ total: 0, startAt: 0, maxResults: 1, issues: [] })
    );
    await expect(reconcileCreate(CREDENTIAL)).resolves.toMatchObject({ outcome: "not_applied" });
  });

  it("stays ambiguous rather than guessing when the lookup itself fails", async () => {
    http.route("GET", "/rest/api/3/search", { status: 503, headers: {}, body: {} });
    await expect(reconcileCreate(CREDENTIAL)).resolves.toMatchObject({ outcome: "ambiguous" });
  });

  it("stays ambiguous when reconciliation runs without a credential", async () => {
    await expect(reconcileCreate()).resolves.toMatchObject({ outcome: "ambiguous" });
  });

  it("confirms an ambiguous transition by reading the status back", async () => {
    http.route(
      "GET",
      "/rest/api/3/issue/FARM-12",
      ok({ ...ISSUE_BODY, fields: { ...ISSUE_BODY.fields, status: { name: "Done" } } })
    );
    const transitionIntent = intent(JIRA_TOOL_IDS.issueTransition, {
      issueKey: "FARM-12",
      transitionId: "31",
      targetStatus: "Done",
    });
    await expect(
      adapter.reconcile(
        {
          intent: transitionIntent,
          idempotencyKey: transitionIntent.idempotencyKey,
          operation: "jira.issue.status.lookup",
        },
        CREDENTIAL
      )
    ).resolves.toEqual({ outcome: "confirmed", evidenceRef: "jira:issue:FARM-12:Done" });
  });
});
