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
  GITHUB_ORGANIZATION_TARGET,
  GITHUB_RECONCILIATION_OPERATIONS,
  GITHUB_REPOSITORY_TARGET,
  GITHUB_TOOL_IDS,
} from "./contracts";
import {
  assertAccountInScope,
  assertRepositoryInScope,
  type GitHubInstallationScope,
  GitHubScopeDeniedError,
  parseRepositoryRef,
} from "./scope";

/**
 * Default-deny GitHub adapter: installation scope, AccessGrant, and leased credential are checked
 * before provider calls; mutations use effect markers and reconcile ambiguous 5xx writes.
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

/** Unlike `stringArg`, an absent or empty value is a legal "match everything" search. */
function optionalStringArg(source: Arguments, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
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

interface PushFile {
  readonly path: string;
  readonly content: string;
}

function filesArg(source: Arguments, key: string): PushFile[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0 || typeof content !== "string") {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    return { path, content };
  });
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

/** How far back `findCommitByMarker` looks for a redelivered effect's own earlier push. */
const MARKER_SEARCH_PER_PAGE = 100;
const MARKER_SEARCH_MAX_PAGES = 5;

const MUTATING_TOOLS = new Set<string>([
  GITHUB_TOOL_IDS.issueCreate,
  GITHUB_TOOL_IDS.issueComment,
  GITHUB_TOOL_IDS.issueLabel,
  GITHUB_TOOL_IDS.issueAssign,
  GITHUB_TOOL_IDS.issueClose,
  GITHUB_TOOL_IDS.pullRequestCreate,
  GITHUB_TOOL_IDS.pullRequestComment,
  GITHUB_TOOL_IDS.pullRequestReview,
  GITHUB_TOOL_IDS.pullRequestMerge,
  GITHUB_TOOL_IDS.repoPush,
  GITHUB_TOOL_IDS.repositoryCreate,
]);

/** Repository slug from a search result's `repository_url`. */
function repositoryFromUrl(url: unknown): string {
  const parts = String(url).split("/");
  return parts.slice(-2).join("/");
}

/** Manifest permission family an action is scoped under (locked in the App manifest). */
function permissionFor(action: string): "issues" | "pull_requests" | "checks" | "contents" {
  if (action.startsWith("github.pull_request.")) return "pull_requests";
  if (action.startsWith("github.check_run.")) return "checks";
  if (action.startsWith("github.repo.") || action.startsWith("github.content.")) return "contents";
  return "issues";
}

export class GitHubAdapter implements ToolAdapter, ToolReconciliationAdapter {
  readonly kind = "integration" as const;

  constructor(private readonly deps: GitHubAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    const { intent } = request;
    const source = args(intent);
    const mutating = MUTATING_TOOLS.has(intent.action);

    // Search alone may span more than one repository; every other action stays single-repo.
    if (intent.action === GITHUB_TOOL_IDS.issueSearch) {
      const repositories = await this.resolveSearchRepositories(intent, source, mutating);
      if (credential === undefined || credential.length === 0) {
        throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
      }
      return this.searchIssues(repositories, source, credential);
    }
    if (intent.action === GITHUB_TOOL_IDS.pullRequestSearch) {
      const repositories = await this.resolveSearchRepositories(intent, source, mutating);
      if (credential === undefined || credential.length === 0) {
        throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
      }
      return this.searchPullRequests(repositories, source, credential);
    }

    // Creating a repo targets an org, not an existing repo — it cannot go through the
    // per-repository `authorize()` below, since the target does not exist at authorization time.
    if (intent.action === GITHUB_TOOL_IDS.repositoryCreate) {
      const owner = stringArg(source, "owner");
      await this.authorizeAccount(intent, owner);
      if (credential === undefined || credential.length === 0) {
        throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
      }
      return this.createRepository(source, credential);
    }

    const repository = stringArg(source, "repository");

    await this.authorize(intent, repository, mutating);

    if (credential === undefined || credential.length === 0) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }

    switch (intent.action) {
      case GITHUB_TOOL_IDS.issueRead:
        return this.readIssue(repository, numberArg(source, "issueNumber"), credential);
      case GITHUB_TOOL_IDS.issueCreate:
        return this.createIssue(repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.issueComment:
        return this.comment(repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.issueLabel:
        return this.addLabels(repository, source, credential);
      case GITHUB_TOOL_IDS.issueAssign:
        return this.assign(repository, source, credential);
      case GITHUB_TOOL_IDS.issueClose:
        return this.close(repository, source, credential);
      case GITHUB_TOOL_IDS.pullRequestRead:
        return this.readPullRequest(repository, numberArg(source, "pullNumber"), credential);
      case GITHUB_TOOL_IDS.pullRequestCreate:
        return this.createPullRequest(repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.pullRequestComment:
        return this.pullRequestComment(repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.pullRequestReview:
        return this.review(repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.pullRequestMerge:
        return this.mergePullRequest(repository, source, credential);
      case GITHUB_TOOL_IDS.checkRunRead:
        return this.readCheckRun(repository, source, credential);
      case GITHUB_TOOL_IDS.repoPush:
        return this.pushCommit(repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.contentRead:
        return this.readContent(repository, source, credential);
      case GITHUB_TOOL_IDS.contentList:
        return this.listContent(repository, source, credential);
      default:
        throw new AdapterDispatchError("before_dispatch", "unsupported_action", false);
    }
  }

  /** Check installation scope before AccessGrant to avoid misreporting out-of-scope repos. */
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
        permission: permissionFor(intent.action),
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

  /** Authorize repo creation against the account and org grant because the repo does not exist. */
  private async authorizeAccount(intent: ToolIntent, owner: string): Promise<void> {
    const context = await this.deps.context.resolve(intent);
    if (context === undefined) {
      throw new AdapterDispatchError("before_dispatch", "integration_context_unresolved", false);
    }

    try {
      assertAccountInScope(context.installation, owner, {
        permission: "administration",
        level: "write",
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
          target: { type: GITHUB_ORGANIZATION_TARGET, id: owner },
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

  /**
   * Authorize every searched repo individually; account-wide installs must name repos explicitly.
   */
  private async resolveSearchRepositories(
    intent: ToolIntent,
    source: Arguments,
    mutating: boolean
  ): Promise<string[]> {
    const single = optionalStringArg(source, "repository");
    if (single.length > 0) {
      await this.authorize(intent, single, mutating);
      return [single];
    }

    const rawList = source.repositories;
    if (Array.isArray(rawList) && rawList.length > 0) {
      const repositories = stringListArg(source, "repositories");
      for (const repository of repositories) await this.authorize(intent, repository, mutating);
      return repositories;
    }

    const context = await this.deps.context.resolve(intent);
    if (context === undefined) {
      throw new AdapterDispatchError("before_dispatch", "integration_context_unresolved", false);
    }
    if (context.installation.repositories === "all") {
      throw new AdapterDispatchError("before_dispatch", "repository_list_required", false);
    }
    const repositories = [...context.installation.repositories];
    for (const repository of repositories) await this.authorize(intent, repository, mutating);
    return repositories;
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

  private issueOutput(repository: string, issue: Record<string, unknown>): unknown {
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
    return this.issueOutput(repository, record(response.body));
  }

  private async searchIssues(
    repositories: readonly string[],
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const state = typeof source.state === "string" ? source.state : "open";
    // Repeated `repo:` qualifiers OR together (an issue lives in exactly one repo, so ANDing them
    // could never match) — this is what turns N per-repo calls into a single search.
    const qualifiers = [...repositories.map((repository) => `repo:${repository}`), "is:issue"];
    if (state !== "all") qualifiers.push(`state:${state}`);
    const query = optionalStringArg(source, "query");
    if (query.length > 0) qualifiers.push(query);
    const response = await this.call(
      {
        method: "GET",
        path: "/search/issues",
        query: {
          q: qualifiers.join(" "),
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

  /** GitHub's `/issues` list endpoint also returns pull requests, but the marker is unique. */
  private async findMarkedIssue(
    repository: string,
    marker: string,
    credential: string
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.call(
      {
        method: "GET",
        path: `/repos/${repository}/issues`,
        query: { state: "all", per_page: "100" },
      },
      credential,
      false
    );
    return list(response.body)
      .map((entry) => record(entry))
      .find((issue) => String(issue.body ?? "").includes(marker));
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

  private async createIssue(
    repository: string,
    source: Arguments,
    idempotencyKey: string,
    credential: string
  ): Promise<unknown> {
    const marker = githubEffectMarker(idempotencyKey);

    // Read before write: a redelivered effect must return the issue it already opened.
    const existing = await this.findMarkedIssue(repository, marker, credential);
    if (existing !== undefined) return this.issueOutput(repository, existing);

    const body = typeof source.body === "string" ? source.body : "";
    const response = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/issues`,
        body: {
          title: stringArg(source, "title"),
          body: `${body}\n\n${marker}`,
          labels: Array.isArray(source.labels) ? stringListArg(source, "labels") : undefined,
          assignees: Array.isArray(source.assignees)
            ? stringListArg(source, "assignees")
            : undefined,
        },
      },
      credential,
      true
    );
    return this.issueOutput(repository, record(response.body));
  }

  private pullRequestOutput(repository: string, pr: Record<string, unknown>): unknown {
    return {
      repository,
      number: Number(pr.number),
      title: String(pr.title),
      body: typeof pr.body === "string" ? pr.body : "",
      state: String(pr.state),
      merged: pr.merged === true,
      htmlUrl: String(pr.html_url),
      headRef: String(record(pr.head).ref),
      baseRef: String(record(pr.base).ref),
    };
  }

  private async readPullRequest(
    repository: string,
    pullNumber: number,
    credential: string
  ): Promise<unknown> {
    const response = await this.call(
      { method: "GET", path: `/repos/${repository}/pulls/${pullNumber}` },
      credential,
      false
    );
    return this.pullRequestOutput(repository, record(response.body));
  }

  private async searchPullRequests(
    repositories: readonly string[],
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const state = typeof source.state === "string" ? source.state : "open";
    const qualifiers = [...repositories.map((repository) => `repo:${repository}`), "is:pr"];
    if (state !== "all") qualifiers.push(`state:${state}`);
    const query = optionalStringArg(source, "query");
    if (query.length > 0) qualifiers.push(query);
    const response = await this.call(
      {
        method: "GET",
        path: "/search/issues",
        query: {
          q: qualifiers.join(" "),
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

  private async findOpenPullRequestByHead(
    repository: string,
    head: string,
    credential: string
  ): Promise<Record<string, unknown> | undefined> {
    const owner = repository.split("/")[0];
    const response = await this.call(
      {
        method: "GET",
        path: `/repos/${repository}/pulls`,
        query: { head: `${owner}:${head}`, state: "open" },
      },
      credential,
      false
    );
    const [first] = list(response.body).map((entry) => record(entry));
    return first;
  }

  private async createPullRequest(
    repository: string,
    source: Arguments,
    idempotencyKey: string,
    credential: string
  ): Promise<unknown> {
    const head = stringArg(source, "head");
    const base = stringArg(source, "base");
    const marker = githubEffectMarker(idempotencyKey);

    // Read before write: a redelivered effect must return the PR it already opened.
    const existing = await this.findOpenPullRequestByHead(repository, head, credential);
    if (existing !== undefined) return this.pullRequestOutput(repository, existing);

    const body = typeof source.body === "string" ? source.body : "";
    const response = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/pulls`,
        body: {
          title: stringArg(source, "title"),
          body: `${body}\n\n${marker}`,
          head,
          base,
          draft: source.draft === true,
        },
      },
      credential,
      true
    );
    return this.pullRequestOutput(repository, record(response.body));
  }

  private async pullRequestComment(
    repository: string,
    source: Arguments,
    idempotencyKey: string,
    credential: string
  ): Promise<unknown> {
    const pullNumber = numberArg(source, "pullNumber");
    const marker = githubEffectMarker(idempotencyKey);

    // PR comments are issue comments under the hood — same endpoint, same marker convention.
    const existing = await this.findMarkedComment(repository, pullNumber, marker, credential);
    if (existing !== undefined) return this.commentOutput(existing);

    const response = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/issues/${pullNumber}/comments`,
        body: { body: `${stringArg(source, "body")}\n\n${marker}` },
      },
      credential,
      true
    );
    return this.commentOutput(record(response.body));
  }

  private async findMarkedReview(
    repository: string,
    pullNumber: number,
    marker: string,
    credential: string
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.call(
      { method: "GET", path: `/repos/${repository}/pulls/${pullNumber}/reviews` },
      credential,
      false
    );
    return list(response.body)
      .map((entry) => record(entry))
      .find((review) => String(review.body ?? "").includes(marker));
  }

  private reviewOutput(review: Record<string, unknown>): unknown {
    return {
      reviewId: String(review.id),
      state: String(review.state),
      htmlUrl: String(review.html_url),
    };
  }

  private async review(
    repository: string,
    source: Arguments,
    idempotencyKey: string,
    credential: string
  ): Promise<unknown> {
    const pullNumber = numberArg(source, "pullNumber");
    const marker = githubEffectMarker(idempotencyKey);

    const existing = await this.findMarkedReview(repository, pullNumber, marker, credential);
    if (existing !== undefined) return this.reviewOutput(existing);

    const body = typeof source.body === "string" ? source.body : "";
    const response = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/pulls/${pullNumber}/reviews`,
        body: { event: stringArg(source, "event"), body: `${body}\n\n${marker}` },
      },
      credential,
      true
    );
    return this.reviewOutput(record(response.body));
  }

  private async mergePullRequest(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const pullNumber = numberArg(source, "pullNumber");

    // Read before write: an already-merged PR must never be merged twice.
    const current = record(
      (
        await this.call(
          { method: "GET", path: `/repos/${repository}/pulls/${pullNumber}` },
          credential,
          false
        )
      ).body
    );
    if (current.merged === true) {
      return { merged: true, sha: String(current.merge_commit_sha ?? "") };
    }

    const mergeMethod = typeof source.mergeMethod === "string" ? source.mergeMethod : "merge";
    const mergeBody: Record<string, unknown> = { merge_method: mergeMethod };
    if (typeof source.commitTitle === "string") mergeBody.commit_title = source.commitTitle;

    const response = await this.call(
      { method: "PUT", path: `/repos/${repository}/pulls/${pullNumber}/merge`, body: mergeBody },
      credential,
      true
    );
    const result = record(response.body);
    return { merged: result.merged === true, sha: String(result.sha ?? "") };
  }

  private async readCheckRun(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const checkRunId = numberArg(source, "checkRunId");
    const response = await this.call(
      { method: "GET", path: `/repos/${repository}/check-runs/${checkRunId}` },
      credential,
      false
    );
    const checkRun = record(response.body);
    return {
      id: Number(checkRun.id),
      name: String(checkRun.name),
      status: String(checkRun.status),
      conclusion: typeof checkRun.conclusion === "string" ? checkRun.conclusion : null,
      htmlUrl: String(checkRun.html_url),
    };
  }

  private async readContent(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const path = stringArg(source, "path");
    const ref = typeof source.ref === "string" ? source.ref : undefined;
    const response = await this.call(
      {
        method: "GET",
        path: `/repos/${repository}/contents/${path}`,
        query: ref ? { ref } : undefined,
      },
      credential,
      false
    );
    const entry = record(response.body);
    return {
      repository,
      path: String(entry.path),
      sha: String(entry.sha),
      content: typeof entry.content === "string" ? entry.content : "",
      encoding: typeof entry.encoding === "string" ? entry.encoding : "base64",
      htmlUrl: String(entry.html_url),
    };
  }

  private async listContent(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<unknown> {
    const path = typeof source.path === "string" ? source.path : "";
    const ref = typeof source.ref === "string" ? source.ref : undefined;
    const response = await this.call(
      {
        method: "GET",
        path: `/repos/${repository}/contents/${path}`,
        query: ref ? { ref } : undefined,
      },
      credential,
      false
    );
    const entries = list(response.body).map((entry) => {
      const item = record(entry);
      return {
        name: String(item.name),
        path: String(item.path),
        type: String(item.type),
        sha: String(item.sha),
        htmlUrl: String(item.html_url),
      };
    });
    return { repository, path, entries };
  }

  private pushOutput(repository: string, branch: string, commit: Record<string, unknown>): unknown {
    const sha = String(commit.sha);
    return { repository, branch, sha, htmlUrl: `https://github.com/${repository}/commit/${sha}` };
  }

  /** Bounded marker lookup for duplicate pushes; not found means the effect likely never pushed. */
  private async findCommitByMarker(
    repository: string,
    branch: string,
    marker: string,
    credential: string
  ): Promise<Record<string, unknown> | undefined> {
    for (let page = 1; page <= MARKER_SEARCH_MAX_PAGES; page += 1) {
      const response = await this.call(
        {
          method: "GET",
          path: `/repos/${repository}/commits`,
          query: { sha: branch, per_page: String(MARKER_SEARCH_PER_PAGE), page: String(page) },
        },
        credential,
        false
      );
      const commits = list(response.body).map((entry) => record(entry));
      const match = commits.find((entry) =>
        String(record(entry.commit).message ?? "").includes(marker)
      );
      if (match !== undefined) return match;
      if (commits.length < MARKER_SEARCH_PER_PAGE) return undefined;
    }
    return undefined;
  }

  private async pushCommit(
    repository: string,
    source: Arguments,
    idempotencyKey: string,
    credential: string
  ): Promise<unknown> {
    const branch = stringArg(source, "branch");
    const marker = githubEffectMarker(idempotencyKey);

    // Read before write: a redelivered effect must return the commit it already pushed.
    const existing = await this.findCommitByMarker(repository, branch, marker, credential);
    if (existing !== undefined) return this.pushOutput(repository, branch, existing);

    const refResponse = await this.call(
      { method: "GET", path: `/repos/${repository}/git/ref/heads/${branch}` },
      credential,
      false
    );
    const headSha = String(record(record(refResponse.body).object).sha);

    const headCommitResponse = await this.call(
      { method: "GET", path: `/repos/${repository}/git/commits/${headSha}` },
      credential,
      false
    );
    const baseTreeSha = String(record(record(headCommitResponse.body).tree).sha);

    const files = filesArg(source, "files");
    const blobShas = await Promise.all(
      files.map(async (file) => {
        const blobResponse = await this.call(
          {
            method: "POST",
            path: `/repos/${repository}/git/blobs`,
            body: { content: file.content, encoding: "utf-8" },
          },
          credential,
          true
        );
        return String(record(blobResponse.body).sha);
      })
    );

    const treeResponse = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/git/trees`,
        body: {
          base_tree: baseTreeSha,
          tree: files.map((file, index) => ({
            path: file.path,
            mode: "100644",
            type: "blob",
            sha: blobShas[index],
          })),
        },
      },
      credential,
      true
    );
    const newTreeSha = String(record(treeResponse.body).sha);

    const newCommitResponse = await this.call(
      {
        method: "POST",
        path: `/repos/${repository}/git/commits`,
        body: {
          message: `${stringArg(source, "message")}\n\n${marker}`,
          tree: newTreeSha,
          parents: [headSha],
        },
      },
      credential,
      true
    );
    const newCommit = record(newCommitResponse.body);

    await this.call(
      {
        method: "PATCH",
        path: `/repos/${repository}/git/refs/heads/${branch}`,
        body: { sha: newCommit.sha, force: false },
      },
      credential,
      true
    );

    return this.pushOutput(repository, branch, newCommit);
  }

  private repositoryOutput(owner: string, name: string, repo: Record<string, unknown>): unknown {
    return {
      repository: `${owner}/${name}`,
      htmlUrl: String(repo.html_url),
      private: repo.private === true,
      defaultBranch: String(repo.default_branch ?? "main"),
    };
  }

  /**
   * A repo may or may not exist yet, so this reads the provider directly rather than through
   * `call()` — a 404 here is the expected "not created" case, not a failure to surface.
   */
  private async lookupRepository(
    owner: string,
    name: string,
    credential: string
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.deps.http.send(
      { method: "GET", path: `/repos/${owner}/${name}` },
      credential
    );
    if (response.status === 404) return undefined;
    const failure = classifyHttpFailure(response, false);
    if (failure !== null)
      throw new AdapterDispatchError(failure.phase, failure.code, failure.retryable);
    return record(response.body);
  }

  private async createRepository(source: Arguments, credential: string): Promise<unknown> {
    const owner = stringArg(source, "owner");
    const name = stringArg(source, "name");

    // Read before write: a redelivered effect must return the repo it already created.
    const existing = await this.lookupRepository(owner, name, credential);
    if (existing !== undefined) return this.repositoryOutput(owner, name, existing);

    const description = typeof source.description === "string" ? source.description : undefined;
    const isPrivate = source.private !== false;

    const response = await this.call(
      {
        method: "POST",
        path: `/orgs/${owner}/repos`,
        body: { name, description, private: isPrivate },
      },
      credential,
      true
    );
    return this.repositoryOutput(owner, name, record(response.body));
  }

  /** With no credential, reconciliation must stay `ambiguous`, never assume `not_applied`. */
  async reconcile(
    request: ToolReconciliationRequest,
    credential?: string
  ): Promise<ToolReconciliationOutcome> {
    if (credential === undefined || credential.length === 0) {
      return { outcome: "ambiguous", evidenceRef: "github:lookup_skipped:credential_missing" };
    }

    const source = args(request.intent);

    // Repo creation has no `repository` argument (it's `owner`/`name`, the repo doesn't exist at
    // dispatch time) — handle it before the generic extraction below throws on a missing field.
    if (request.operation === GITHUB_RECONCILIATION_OPERATIONS.repositoryCreate) {
      try {
        return await this.reconcileRepositoryCreate(source, credential);
      } catch {
        return { outcome: "ambiguous", evidenceRef: "github:lookup_failed" };
      }
    }

    const repository = stringArg(source, "repository");

    try {
      switch (request.operation) {
        case GITHUB_RECONCILIATION_OPERATIONS.issueCreate:
          return await this.reconcileIssueCreate(repository, request, credential);
        case GITHUB_RECONCILIATION_OPERATIONS.comment:
          return await this.reconcileComment(
            repository,
            numberArg(source, "issueNumber"),
            request,
            credential
          );
        case GITHUB_RECONCILIATION_OPERATIONS.state:
          return await this.reconcileState(
            repository,
            numberArg(source, "issueNumber"),
            credential
          );
        case GITHUB_RECONCILIATION_OPERATIONS.labels:
          return await this.reconcileLabels(
            repository,
            numberArg(source, "issueNumber"),
            source,
            credential
          );
        case GITHUB_RECONCILIATION_OPERATIONS.assignees:
          return await this.reconcileAssignees(
            repository,
            numberArg(source, "issueNumber"),
            source,
            credential
          );
        case GITHUB_RECONCILIATION_OPERATIONS.pullRequestCreate:
          return await this.reconcilePullRequestCreate(repository, source, credential);
        case GITHUB_RECONCILIATION_OPERATIONS.pullRequestComment:
          return await this.reconcileComment(
            repository,
            numberArg(source, "pullNumber"),
            request,
            credential
          );
        case GITHUB_RECONCILIATION_OPERATIONS.pullRequestReview:
          return await this.reconcilePullRequestReview(
            repository,
            numberArg(source, "pullNumber"),
            request,
            credential
          );
        case GITHUB_RECONCILIATION_OPERATIONS.pullRequestMerge:
          return await this.reconcilePullRequestMerge(
            repository,
            numberArg(source, "pullNumber"),
            credential
          );
        case GITHUB_RECONCILIATION_OPERATIONS.repoPush:
          return await this.reconcilePush(
            repository,
            stringArg(source, "branch"),
            request,
            credential
          );
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

  private async reconcileIssueCreate(
    repository: string,
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const issue = await this.findMarkedIssue(
      repository,
      githubEffectMarker(request.idempotencyKey),
      credential
    );
    return issue === undefined
      ? { outcome: "not_applied", evidenceRef: `github:issue:create:absent:${repository}` }
      : { outcome: "confirmed", evidenceRef: `github:issue:${String(issue.number)}` };
  }

  private async reconcileRepositoryCreate(
    source: Arguments,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const owner = stringArg(source, "owner");
    const name = stringArg(source, "name");
    const existing = await this.lookupRepository(owner, name, credential);
    const evidenceRef = `github:repository:${owner}/${name}`;
    return existing === undefined
      ? { outcome: "not_applied", evidenceRef }
      : { outcome: "confirmed", evidenceRef };
  }

  private async reconcilePullRequestCreate(
    repository: string,
    source: Arguments,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const head = stringArg(source, "head");
    const existing = await this.findOpenPullRequestByHead(repository, head, credential);
    const evidenceRef = `github:pull_request:${repository}:head:${head}`;
    return existing === undefined
      ? { outcome: "not_applied", evidenceRef }
      : { outcome: "confirmed", evidenceRef: `github:pull_request:${String(existing.number)}` };
  }

  private async reconcilePullRequestReview(
    repository: string,
    pullNumber: number,
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const review = await this.findMarkedReview(
      repository,
      pullNumber,
      githubEffectMarker(request.idempotencyKey),
      credential
    );
    return review === undefined
      ? {
          outcome: "not_applied",
          evidenceRef: `github:pull_request:review:absent:${repository}#${pullNumber}`,
        }
      : { outcome: "confirmed", evidenceRef: `github:pull_request:review:${String(review.id)}` };
  }

  private async reconcilePullRequestMerge(
    repository: string,
    pullNumber: number,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const response = await this.call(
      { method: "GET", path: `/repos/${repository}/pulls/${pullNumber}` },
      credential,
      false
    );
    const current = record(response.body);
    const evidenceRef = `github:pull_request:${repository}#${pullNumber}:merged`;
    return current.merged === true
      ? { outcome: "confirmed", evidenceRef }
      : { outcome: "not_applied", evidenceRef };
  }

  private async reconcilePush(
    repository: string,
    branch: string,
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const commit = await this.findCommitByMarker(
      repository,
      branch,
      githubEffectMarker(request.idempotencyKey),
      credential
    );
    const evidenceRef = `github:repo:push:${repository}:${branch}`;
    return commit === undefined
      ? { outcome: "not_applied", evidenceRef }
      : { outcome: "confirmed", evidenceRef: `github:repo:push:${String(commit.sha)}` };
  }
}
