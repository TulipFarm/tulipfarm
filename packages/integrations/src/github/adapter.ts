import type { AccessGrantDefinition } from "@tulipfarm/schema";
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
  type IntegrationHttpPort,
  type IntegrationHttpResponse,
} from "../http";
import {
  GITHUB_RECONCILIATION_OPERATIONS,
  GITHUB_REPOSITORY_TARGET,
  GITHUB_TOOL_IDS,
} from "./contracts";
import {
  assertRepositoryInScope,
  type GitHubInstallationScope,
  GitHubScopeDeniedError,
  parseRepositoryRef,
} from "./scope";

/**
 * GitHub Integration adapter (SPEC §11.3, §15).
 *
 * Implements the Tool Broker's adapter port; the broker never imports this package. Three
 * properties matter here and each is enforced before a single byte reaches GitHub:
 *
 * 1. **Default deny, non-amplifying.** Installation scope bounds the request, the AccessGrant
 *    narrows it further, and the credential must already have been leased. Any of these failing
 *    is a `before_dispatch` denial with no provider call — an unauthorized close never happens
 *    "just to find out".
 * 2. **Stable idempotency without provider support.** GitHub has no idempotency key, so a
 *    mutation carries a hidden marker derived from the effect's key, and provider state is read
 *    back before writing. A duplicate delivery returns the original effect instead of a second one.
 * 3. **Honest ambiguity.** A 5xx on a write is reported as `after_dispatch`, which the effect
 *    ledger records as ambiguous and hands to reconciliation. Nothing here retries a mutation or
 *    guesses that it did not apply.
 *
 * The leased credential is passed straight to the HTTP port and never stored, logged, or attached
 * to a raised error.
 */

export interface GitHubEffectContext {
  readonly integrationId: string;
  readonly installation: GitHubInstallationScope;
  /** The acting principal and any roles it holds, for AccessGrant matching. */
  readonly principals: readonly IntegrationPrincipalRef[];
  readonly grants: readonly AccessGrantDefinition[];
}

export interface GitHubContextResolver {
  resolve(intent: ToolIntent): Promise<GitHubEffectContext | undefined>;
}

export interface GitHubAdapterDeps {
  readonly http: IntegrationHttpPort;
  readonly context: GitHubContextResolver;
  readonly now: () => Date;
}

/**
 * Hidden marker written into a comment body so a repeated delivery — or a reconciliation after an
 * ambiguous write — can recognize the effect that already landed. Invisible in rendered Markdown.
 */
export function githubEffectMarker(idempotencyKey: string): string {
  return `<!-- tulipfarm-effect:${idempotencyKey} -->`;
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

function numberArg(source: Arguments, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
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

function names(value: unknown): string[] {
  return list(value).map((entry) => String(record(entry).name));
}

function logins(value: unknown): string[] {
  return list(value).map((entry) => String(record(entry).login));
}

const MUTATING_TOOLS = new Set<string>([
  GITHUB_TOOL_IDS.issueComment,
  GITHUB_TOOL_IDS.issueLabel,
  GITHUB_TOOL_IDS.issueAssign,
  GITHUB_TOOL_IDS.issueClose,
]);

/** Repository slug from a search result's `repository_url`. */
function repositoryFromUrl(url: unknown): string {
  const parts = String(url).split("/");
  return parts.slice(-2).join("/");
}

export class GitHubAdapter implements ToolAdapter, ToolReconciliationAdapter {
  constructor(private readonly deps: GitHubAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    const { intent } = request;
    const source = args(intent);
    const repository = stringArg(source, "repository");
    const mutating = MUTATING_TOOLS.has(intent.action);

    await this.authorize(intent, repository, mutating);

    if (credential === undefined || credential.length === 0) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }

    switch (intent.action) {
      case GITHUB_TOOL_IDS.issueRead:
        return this.readIssue(repository, numberArg(source, "issueNumber"), credential);
      case GITHUB_TOOL_IDS.issueSearch:
        return this.searchIssues(repository, source, credential);
      case GITHUB_TOOL_IDS.issueComment:
        return this.comment(repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.issueLabel:
        return this.addLabels(repository, source, credential);
      case GITHUB_TOOL_IDS.issueAssign:
        return this.assign(repository, source, credential);
      case GITHUB_TOOL_IDS.issueClose:
        return this.close(repository, source, credential);
      default:
        throw new AdapterDispatchError("before_dispatch", "unsupported_action", false);
    }
  }

  /**
   * Installation scope first, then the AccessGrant: the installation is the hard provider-side
   * bound, and reporting it first keeps an out-of-installation repository from being described as
   * merely ungranted.
   */
  private async authorize(
    intent: ToolIntent,
    repository: string,
    mutating: boolean
  ): Promise<void> {
    const context = await this.deps.context.resolve(intent);
    if (context === undefined) {
      throw new AdapterDispatchError("before_dispatch", "integration_context_unresolved", false);
    }

    try {
      assertRepositoryInScope(context.installation, parseRepositoryRef(repository), {
        permission: "issues",
        level: mutating ? "write" : "read",
      });
    } catch (error) {
      if (error instanceof GitHubScopeDeniedError) {
        throw new AdapterDispatchError("before_dispatch", "installation_scope_denied", false);
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
          target: { type: GITHUB_REPOSITORY_TARGET, id: repository },
        },
        this.deps.now()
      );
    } catch (error) {
      if (error instanceof IntegrationAccessDeniedError) {
        throw new AdapterDispatchError("before_dispatch", "integration_access_denied", false);
      }
      throw error;
    }
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

  private async readIssue(
    repository: string,
    issueNumber: number,
    credential: string
  ): Promise<unknown> {
    const response = await this.call(
      { method: "GET", path: `/repos/${repository}/issues/${issueNumber}` },
      credential,
      false
    );
    const issue = record(response.body);
    return {
      repository,
      number: Number(issue.number),
      title: String(issue.title),
      body: typeof issue.body === "string" ? issue.body : "",
      state: String(issue.state),
      labels: names(issue.labels),
      assignees: logins(issue.assignees),
      htmlUrl: String(issue.html_url),
    };
  }

  private async searchIssues(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const state = typeof source.state === "string" ? source.state : "open";
    const qualifiers = [`repo:${repository}`, "is:issue"];
    if (state !== "all") qualifiers.push(`state:${state}`);
    const response = await this.call(
      {
        method: "GET",
        path: "/search/issues",
        query: {
          q: `${qualifiers.join(" ")} ${stringArg(source, "query")}`,
          per_page: String(typeof source.limit === "number" ? source.limit : 20),
        },
      },
      credential,
      false
    );
    const body = record(response.body);
    return {
      totalCount: Number(body.total_count),
      items: list(body.items).map((entry) => {
        const item = record(entry);
        return {
          repository: repositoryFromUrl(item.repository_url),
          number: Number(item.number),
          title: String(item.title),
          state: String(item.state),
          htmlUrl: String(item.html_url),
        };
      }),
    };
  }

  private async findMarkedComment(
    repository: string,
    issueNumber: number,
    marker: string,
    credential: string
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.call(
      { method: "GET", path: `/repos/${repository}/issues/${issueNumber}/comments` },
      credential,
      false
    );
    return list(response.body)
      .map((entry) => record(entry))
      .find((comment) => String(comment.body ?? "").includes(marker));
  }

  private commentOutput(comment: Record<string, unknown>): unknown {
    return {
      commentId: String(comment.id),
      htmlUrl: String(comment.html_url),
      createdAt: String(comment.created_at),
    };
  }

  private async comment(
    repository: string,
    source: Arguments,
    idempotencyKey: string,
    credential: string
  ): Promise<unknown> {
    const issueNumber = numberArg(source, "issueNumber");
    const marker = githubEffectMarker(idempotencyKey);

    // Read before write: a redelivered effect must return the comment it already posted.
    const existing = await this.findMarkedComment(repository, issueNumber, marker, credential);
    if (existing !== undefined) return this.commentOutput(existing);

    const response = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/issues/${issueNumber}/comments`,
        body: { body: `${stringArg(source, "body")}\n\n${marker}` },
      },
      credential,
      true
    );
    return this.commentOutput(record(response.body));
  }

  private async addLabels(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const response = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/issues/${numberArg(source, "issueNumber")}/labels`,
        body: { labels: stringListArg(source, "labels") },
      },
      credential,
      true
    );
    return { labels: names(response.body) };
  }

  private async assign(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const response = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/issues/${numberArg(source, "issueNumber")}/assignees`,
        body: { assignees: stringListArg(source, "assignees") },
      },
      credential,
      true
    );
    return { assignees: logins(record(response.body).assignees) };
  }

  private async close(repository: string, source: Arguments, credential: string): Promise<unknown> {
    const stateReason = typeof source.stateReason === "string" ? source.stateReason : "completed";
    const response = await this.call(
      {
        method: "PATCH",
        path: `/repos/${repository}/issues/${numberArg(source, "issueNumber")}`,
        body: { state: "closed", state_reason: stateReason },
      },
      credential,
      true
    );
    const issue = record(response.body);
    return {
      number: Number(issue.number),
      state: String(issue.state),
      stateReason: String(issue.state_reason),
    };
  }

  /**
   * Resolve an ambiguous effect against provider state. The credential is optional because
   * reconciliation may run long after the leasing dispatch: with no way to read GitHub, the honest
   * answer is `ambiguous`, never an assumed `not_applied`.
   */
  async reconcile(
    request: ToolReconciliationRequest,
    credential?: string
  ): Promise<ToolReconciliationOutcome> {
    if (credential === undefined || credential.length === 0) {
      return { outcome: "ambiguous", evidenceRef: "github:lookup_skipped:credential_missing" };
    }

    const source = args(request.intent);
    const repository = stringArg(source, "repository");
    const issueNumber = numberArg(source, "issueNumber");

    try {
      switch (request.operation) {
        case GITHUB_RECONCILIATION_OPERATIONS.comment:
          return await this.reconcileComment(repository, issueNumber, request, credential);
        case GITHUB_RECONCILIATION_OPERATIONS.state:
          return await this.reconcileState(repository, issueNumber, credential);
        case GITHUB_RECONCILIATION_OPERATIONS.labels:
          return await this.reconcileLabels(repository, issueNumber, source, credential);
        case GITHUB_RECONCILIATION_OPERATIONS.assignees:
          return await this.reconcileAssignees(repository, issueNumber, source, credential);
        default:
          return { outcome: "ambiguous", evidenceRef: "github:lookup_unsupported" };
      }
    } catch {
      // A failed lookup proves nothing about the effect; leave it for the next attempt.
      return { outcome: "ambiguous", evidenceRef: "github:lookup_failed" };
    }
  }

  private async reconcileComment(
    repository: string,
    issueNumber: number,
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const comment = await this.findMarkedComment(
      repository,
      issueNumber,
      githubEffectMarker(request.idempotencyKey),
      credential
    );
    return comment === undefined
      ? {
          outcome: "not_applied",
          evidenceRef: `github:comment:absent:${repository}#${issueNumber}`,
        }
      : { outcome: "confirmed", evidenceRef: `github:comment:${String(comment.id)}` };
  }

  private async issueState(
    repository: string,
    issueNumber: number,
    credential: string
  ): Promise<Record<string, unknown>> {
    const response = await this.call(
      { method: "GET", path: `/repos/${repository}/issues/${issueNumber}` },
      credential,
      false
    );
    return record(response.body);
  }

  private async reconcileState(
    repository: string,
    issueNumber: number,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const issue = await this.issueState(repository, issueNumber, credential);
    const state = String(issue.state);
    const evidenceRef = `github:issue:${repository}#${issueNumber}:${state}`;
    return state === "closed"
      ? { outcome: "confirmed", evidenceRef }
      : { outcome: "not_applied", evidenceRef };
  }

  private async reconcileLabels(
    repository: string,
    issueNumber: number,
    source: Arguments,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const issue = await this.issueState(repository, issueNumber, credential);
    const present = new Set(names(issue.labels));
    const applied = stringListArg(source, "labels").every((label) => present.has(label));
    const evidenceRef = `github:issue:${repository}#${issueNumber}:labels`;
    return applied
      ? { outcome: "confirmed", evidenceRef }
      : { outcome: "not_applied", evidenceRef };
  }

  private async reconcileAssignees(
    repository: string,
    issueNumber: number,
    source: Arguments,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const issue = await this.issueState(repository, issueNumber, credential);
    const present = new Set(logins(issue.assignees));
    const applied = stringListArg(source, "assignees").every((login) => present.has(login));
    const evidenceRef = `github:issue:${repository}#${issueNumber}:assignees`;
    return applied
      ? { outcome: "confirmed", evidenceRef }
      : { outcome: "not_applied", evidenceRef };
  }
}
