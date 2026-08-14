import { type AccessGrantDefinition, canonicalHash } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterRequest,
  type ToolIntent,
  type ToolReconciliationAdapter,
  type ToolReconciliationOutcome,
  type ToolReconciliationRequest,
} from "@tulipfarm/tool-broker";
import {
  assertIntegrationAccess,
  IntegrationAccessDeniedError,
  type IntegrationPrincipalRef,
} from "../grants";
import {
  classifyHttpFailure,
  collectPages,
  type IntegrationHttpPort,
  type IntegrationHttpResponse,
  PaginationBoundError,
} from "../http";
import { JIRA_PROJECT_TARGET, JIRA_RECONCILIATION_OPERATIONS, JIRA_TOOL_IDS } from "./contracts";
import {
  assertProjectInScope,
  JiraScopeDeniedError,
  type JiraSiteScope,
  jiraIssueUrl,
  parseIssueKey,
} from "./scope";

/**
 * Default-deny Jira adapter: site scope, AccessGrant, and credential gate provider calls; writes
 * use effect labels and reconcile ambiguous 5xx outcomes against provider state.
 */

export interface JiraEffectContext {
  readonly integrationId: string;
  readonly site: JiraSiteScope;
  readonly principals: readonly IntegrationPrincipalRef[];
  readonly grants: readonly AccessGrantDefinition[];
}

export interface JiraContextResolver {
  resolve(intent: ToolIntent): Promise<JiraEffectContext | undefined>;
}

export interface JiraAdapterDeps {
  readonly http: IntegrationHttpPort;
  readonly context: JiraContextResolver;
  readonly now: () => Date;
}

const SEARCH_PATH = "/rest/api/3/search";
const ISSUE_PATH = "/rest/api/3/issue";
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_OPEN_ISSUES = 5;

/** Hash effect keys into fixed-shape Jira labels for duplicate and reconciliation lookup. */
export function jiraEffectLabel(idempotencyKey: string): string {
  return `tulipfarm-effect-${canonicalHash(idempotencyKey).slice(0, 32)}`;
}

type Arguments = Record<string, unknown>;

function args(intent: ToolIntent): Arguments {
  const value = intent.arguments;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value as Arguments;
}

function stringArg(source: Arguments, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value;
}

function stringListArg(source: Arguments, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value as string[];
}

function numberArg(source: Arguments, key: string, fallback: number): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterDispatchError("after_dispatch", "provider_response_malformed", false);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AdapterDispatchError("after_dispatch", "provider_response_malformed", false);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const MUTATING_TOOLS = new Set<string>([JIRA_TOOL_IDS.issueCreate, JIRA_TOOL_IDS.issueTransition]);

const USER_TOOLS = new Set<string>([JIRA_TOOL_IDS.userSearch, JIRA_TOOL_IDS.userAvailability]);

/** JQL string literal — Jira quotes with double quotes and escapes with a backslash. */
function jqlString(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

export class JiraAdapter implements ToolAdapter, ToolReconciliationAdapter {
  constructor(private readonly deps: JiraAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    const { intent } = request;
    const source = args(intent);
    const projectKey = this.projectKeyFor(source);
    const context = await this.authorize(intent, projectKey);

    if (credential === undefined || credential.length === 0) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }

    switch (intent.action) {
      case JIRA_TOOL_IDS.issueRead:
        return this.readIssue(stringArg(source, "issueKey"), credential);
      case JIRA_TOOL_IDS.issueSearch:
        return this.searchIssues(projectKey, source, credential);
      case JIRA_TOOL_IDS.issueCreate:
        return this.createIssue(context, source, request.idempotencyKey, credential);
      case JIRA_TOOL_IDS.issueTransition:
        return this.transitionIssue(source, credential);
      case JIRA_TOOL_IDS.userSearch:
        return this.searchUsers(projectKey, source, credential);
      case JIRA_TOOL_IDS.userAvailability:
        return this.availability(projectKey, source, credential);
      default:
        throw new AdapterDispatchError("before_dispatch", "unsupported_action", false);
    }
  }

  /** Every Tool is scoped to exactly one project, named directly or carried by the issue key. */
  private projectKeyFor(source: Arguments): string {
    if (typeof source.projectKey === "string") return stringArg(source, "projectKey");
    try {
      return parseIssueKey(stringArg(source, "issueKey")).projectKey;
    } catch (error) {
      if (error instanceof JiraScopeDeniedError) {
        throw new AdapterDispatchError("before_dispatch", "site_scope_denied", false);
      }
      throw error;
    }
  }

  private async authorize(intent: ToolIntent, projectKey: string): Promise<JiraEffectContext> {
    const context = await this.deps.context.resolve(intent);
    if (context === undefined) {
      throw new AdapterDispatchError("before_dispatch", "integration_context_unresolved", false);
    }

    const mutating = MUTATING_TOOLS.has(intent.action);
    try {
      assertProjectInScope(context.site, projectKey, {
        permission: USER_TOOLS.has(intent.action) ? "users" : "issues",
        level: mutating ? "write" : "read",
      });
    } catch (error) {
      if (error instanceof JiraScopeDeniedError) {
        throw new AdapterDispatchError("before_dispatch", "site_scope_denied", false);
      }
      throw error;
    }

    try {
      assertIntegrationAccess(
        context.grants,
        {
          integrationId: context.integrationId,
          principals: context.principals,
          action: intent.action,
          target: { type: JIRA_PROJECT_TARGET, id: projectKey },
        },
        this.deps.now()
      );
    } catch (error) {
      if (error instanceof IntegrationAccessDeniedError) {
        throw new AdapterDispatchError("before_dispatch", "integration_access_denied", false);
      }
      throw error;
    }

    return context;
  }

  private async call(
    request: Parameters<IntegrationHttpPort["send"]>[0],
    credential: string,
    mutating: boolean
  ): Promise<IntegrationHttpResponse> {
    const response = await this.deps.http.send(request, credential);
    const failure = classifyHttpFailure(response, mutating);
    if (failure !== null) {
      throw new AdapterDispatchError(failure.phase, failure.code, failure.retryable);
    }
    return response;
  }

  private async search(
    jql: string,
    credential: string,
    options: { readonly startAt?: number; readonly maxResults: number }
  ): Promise<Record<string, unknown>> {
    const response = await this.call(
      {
        method: "GET",
        path: SEARCH_PATH,
        query: {
          jql,
          startAt: String(options.startAt ?? 0),
          maxResults: String(options.maxResults),
        },
      },
      credential,
      false
    );
    return record(response.body);
  }

  private async issue(issueKey: string, credential: string): Promise<Record<string, unknown>> {
    const response = await this.call(
      { method: "GET", path: `${ISSUE_PATH}/${issueKey}` },
      credential,
      false
    );
    return record(response.body);
  }

  private async readIssue(issueKey: string, credential: string): Promise<unknown> {
    const issue = await this.issue(issueKey, credential);
    const fields = record(issue.fields);
    const assignee = fields.assignee === null ? undefined : record(fields.assignee);
    return {
      issueKey: String(issue.key),
      projectKey: parseIssueKey(String(issue.key)).projectKey,
      summary: String(fields.summary),
      description: optionalString(fields.description) ?? "",
      status: String(record(fields.status).name),
      issueType: String(record(fields.issuetype).name),
      assignee: assignee === undefined ? null : String(assignee.accountId),
      labels: list(fields.labels ?? []).map((label) => String(label)),
    };
  }

  private async searchIssues(
    projectKey: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const limit = numberArg(source, "limit", DEFAULT_LIMIT);
    const jql = `project = ${projectKey} AND (${stringArg(source, "jql")})`;
    let total = 0;

    try {
      const items = await collectPages<{ issueKey: string; summary: string; status: string }>(
        async (cursor) => {
          const page = await this.search(jql, credential, {
            startAt: cursor === undefined ? 0 : Number(cursor),
            maxResults: Math.min(limit, PAGE_SIZE),
          });
          total = Number(page.total);
          const startAt = Number(page.startAt);
          const issues = list(page.issues).map((entry) => {
            const issue = record(entry);
            const fields = record(issue.fields);
            return {
              issueKey: String(issue.key),
              summary: String(fields.summary),
              status: String(record(fields.status).name),
            };
          });
          const seen = startAt + issues.length;
          return { items: issues, nextCursor: seen < total ? String(seen) : undefined };
        },
        { maxPages: MAX_PAGES, maxItems: limit }
      );
      return { total, items };
    } catch (error) {
      if (error instanceof PaginationBoundError) {
        // Truncating a result set an Agent will reason over is worse than failing the read.
        throw new AdapterDispatchError("before_dispatch", "pagination_bound_exceeded", false);
      }
      throw error;
    }
  }

  private async createIssue(
    context: JiraEffectContext,
    source: Arguments,
    idempotencyKey: string,
    credential: string
  ): Promise<unknown> {
    const label = jiraEffectLabel(idempotencyKey);

    // Read before write: a redelivered effect must return the issue it already created.
    const existing = await this.search(`labels = ${jqlString(label)}`, credential, {
      maxResults: 1,
    });
    const found = list(existing.issues)[0];
    if (found !== undefined) return this.createOutput(context.site, record(found));

    const projectKey = stringArg(source, "projectKey");
    const response = await this.call(
      {
        method: "POST",
        path: ISSUE_PATH,
        body: {
          fields: {
            project: { key: projectKey },
            summary: stringArg(source, "summary"),
            description: optionalString(source.description) ?? "",
            issuetype: { name: stringArg(source, "issueType") },
            labels: [
              ...(Array.isArray(source.labels) ? stringListArg(source, "labels") : []),
              label,
            ],
          },
        },
      },
      credential,
      true
    );
    return this.createOutput(context.site, record(response.body));
  }

  private createOutput(site: JiraSiteScope, issue: Record<string, unknown>): unknown {
    const issueKey = String(issue.key);
    return { issueKey, issueId: String(issue.id), url: jiraIssueUrl(site, issueKey) };
  }

  private async transitionIssue(source: Arguments, credential: string): Promise<unknown> {
    const issueKey = stringArg(source, "issueKey");
    const targetStatus = stringArg(source, "targetStatus");

    const current = await this.issue(issueKey, credential);
    if (String(record(record(current.fields).status).name) === targetStatus) {
      return { issueKey, status: targetStatus };
    }

    await this.call(
      {
        method: "POST",
        path: `${ISSUE_PATH}/${issueKey}/transitions`,
        body: { transition: { id: stringArg(source, "transitionId") } },
      },
      credential,
      true
    );

    // Report the status Jira actually holds, not the one the transition was meant to produce.
    const applied = await this.issue(issueKey, credential);
    return { issueKey, status: String(record(record(applied.fields).status).name) };
  }

  private async searchUsers(
    projectKey: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const response = await this.call(
      {
        method: "GET",
        path: "/rest/api/3/user/assignable/search",
        query: {
          project: projectKey,
          query: stringArg(source, "query"),
          maxResults: String(numberArg(source, "limit", DEFAULT_LIMIT)),
        },
      },
      credential,
      false
    );
    return {
      users: list(response.body)
        .map((entry) => record(entry))
        .filter((user) => user.active === true)
        .map((user) => ({
          accountId: String(user.accountId),
          displayName: String(user.displayName),
          active: true,
        })),
    };
  }

  private async availability(
    projectKey: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const maxOpenIssues = numberArg(source, "maxOpenIssues", DEFAULT_MAX_OPEN_ISSUES);
    const candidates = [];
    for (const accountId of stringListArg(source, "accountIds")) {
      const page = await this.search(
        `project = ${projectKey} AND assignee = ${jqlString(accountId)} AND statusCategory != Done`,
        credential,
        { maxResults: 1 }
      );
      const openIssueCount = Number(page.total);
      candidates.push({ accountId, openIssueCount, available: openIssueCount <= maxOpenIssues });
    }
    return { candidates };
  }

  /**
   * Resolve an ambiguous effect against provider state. Without a credential the honest answer is
   * `ambiguous` — never an assumed `not_applied` that would invite a duplicate write.
   */
  async reconcile(
    request: ToolReconciliationRequest,
    credential?: string
  ): Promise<ToolReconciliationOutcome> {
    if (credential === undefined || credential.length === 0) {
      return { outcome: "ambiguous", evidenceRef: "jira:lookup_skipped:credential_missing" };
    }

    const source = args(request.intent);
    try {
      switch (request.operation) {
        case JIRA_RECONCILIATION_OPERATIONS.create:
          return await this.reconcileCreate(request.idempotencyKey, credential);
        case JIRA_RECONCILIATION_OPERATIONS.status:
          return await this.reconcileStatus(source, credential);
        default:
          return { outcome: "ambiguous", evidenceRef: "jira:lookup_unsupported" };
      }
    } catch {
      // A failed lookup proves nothing about the effect; leave it for the next attempt.
      return { outcome: "ambiguous", evidenceRef: "jira:lookup_failed" };
    }
  }

  private async reconcileCreate(
    idempotencyKey: string,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const label = jiraEffectLabel(idempotencyKey);
    const page = await this.search(`labels = ${jqlString(label)}`, credential, { maxResults: 1 });
    const found = list(page.issues)[0];
    return found === undefined
      ? { outcome: "not_applied", evidenceRef: `jira:issue:absent:${label}` }
      : { outcome: "confirmed", evidenceRef: `jira:issue:${String(record(found).key)}` };
  }

  private async reconcileStatus(
    source: Arguments,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const issueKey = stringArg(source, "issueKey");
    const issue = await this.issue(issueKey, credential);
    const status = String(record(record(issue.fields).status).name);
    const evidenceRef = `jira:issue:${issueKey}:${status}`;
    return status === stringArg(source, "targetStatus")
      ? { outcome: "confirmed", evidenceRef }
      : { outcome: "not_applied", evidenceRef };
  }
}
