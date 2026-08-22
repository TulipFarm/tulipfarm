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
import { GITHUB_ORGANIZATION_TARGET, GITHUB_REPOSITORY_TARGET, GITHUB_TOOL_IDS } from "./contracts";
import { readCheckRun } from "./operations/checks";
import { listContent, readContent } from "./operations/content";
import {
  addLabels,
  assign,
  close,
  comment,
  createIssue,
  readIssue,
  searchIssues,
} from "./operations/issues";
import {
  createPullRequest,
  mergePullRequest,
  pullRequestComment,
  readPullRequest,
  review,
  searchPullRequests,
} from "./operations/pull-requests";
import { reconcileGitHubEffect } from "./operations/reconcile";
import { createRepository, pushCommit } from "./operations/repository";
import { args, type GitHubApi, numberArg, stringArg } from "./operations/shared";
import {
  assertAccountInScope,
  assertRepositoryInScope,
  type GitHubInstallationScope,
  GitHubScopeDeniedError,
  parseRepositoryRef,
} from "./scope";

export { githubEffectMarker } from "./operations/shared";

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

/** Manifest permission family an action is scoped under (locked in the App manifest). */
function permissionFor(action: string): "issues" | "pull_requests" | "checks" | "contents" {
  if (action.startsWith("github.pull_request.")) return "pull_requests";
  if (action.startsWith("github.check_run.")) return "checks";
  if (action.startsWith("github.repo.") || action.startsWith("github.content.")) return "contents";
  return "issues";
}

export class GitHubAdapter implements ToolAdapter, ToolReconciliationAdapter {
  readonly kind = "integration" as const;

  private readonly api: GitHubApi;

  constructor(private readonly deps: GitHubAdapterDeps) {
    this.api = {
      call: (request, credential, mutating) => this.call(request, credential, mutating),
      http: deps.http,
    };
  }

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    const { intent } = request;
    const source = args(intent);
    const mutating = MUTATING_TOOLS.has(intent.action);

    // Search requires one concrete repository, like every other repository-scoped action.
    if (intent.action === GITHUB_TOOL_IDS.issueSearch) {
      const repository = stringArg(source, "repository");
      await this.authorize(intent, repository, mutating);
      if (credential === undefined || credential.length === 0) {
        throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
      }
      return searchIssues(this.api, repository, source, credential);
    }
    if (intent.action === GITHUB_TOOL_IDS.pullRequestSearch) {
      const repository = stringArg(source, "repository");
      await this.authorize(intent, repository, mutating);
      if (credential === undefined || credential.length === 0) {
        throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
      }
      return searchPullRequests(this.api, repository, source, credential);
    }

    // Creating a repo targets an org, not an existing repo — it cannot go through the
    // per-repository `authorize()` below, since the target does not exist at authorization time.
    if (intent.action === GITHUB_TOOL_IDS.repositoryCreate) {
      const owner = stringArg(source, "owner");
      await this.authorizeAccount(intent, owner);
      if (credential === undefined || credential.length === 0) {
        throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
      }
      return createRepository(this.api, source, credential);
    }

    const repository = stringArg(source, "repository");

    await this.authorize(intent, repository, mutating);

    if (credential === undefined || credential.length === 0) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }

    switch (intent.action) {
      case GITHUB_TOOL_IDS.issueRead:
        return readIssue(this.api, repository, numberArg(source, "issueNumber"), credential);
      case GITHUB_TOOL_IDS.issueCreate:
        return createIssue(this.api, repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.issueComment:
        return comment(this.api, repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.issueLabel:
        return addLabels(this.api, repository, source, credential);
      case GITHUB_TOOL_IDS.issueAssign:
        return assign(this.api, repository, source, credential);
      case GITHUB_TOOL_IDS.issueClose:
        return close(this.api, repository, source, credential);
      case GITHUB_TOOL_IDS.pullRequestRead:
        return readPullRequest(this.api, repository, numberArg(source, "pullNumber"), credential);
      case GITHUB_TOOL_IDS.pullRequestCreate:
        return createPullRequest(this.api, repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.pullRequestComment:
        return pullRequestComment(this.api, repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.pullRequestReview:
        return review(this.api, repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.pullRequestMerge:
        return mergePullRequest(this.api, repository, source, credential);
      case GITHUB_TOOL_IDS.checkRunRead:
        return readCheckRun(this.api, repository, source, credential);
      case GITHUB_TOOL_IDS.repoPush:
        return pushCommit(this.api, repository, source, request.idempotencyKey, credential);
      case GITHUB_TOOL_IDS.contentRead:
        return readContent(this.api, repository, source, credential);
      case GITHUB_TOOL_IDS.contentList:
        return listContent(this.api, repository, source, credential);
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

  async reconcile(
    request: ToolReconciliationRequest,
    credential?: string
  ): Promise<ToolReconciliationOutcome> {
    return reconcileGitHubEffect(this.api, request, credential);
  }
}
