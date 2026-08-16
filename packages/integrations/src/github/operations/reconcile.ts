import type { ToolReconciliationOutcome, ToolReconciliationRequest } from "@tulipfarm/tool-broker";
import { GITHUB_RECONCILIATION_OPERATIONS } from "../contracts";
import { findMarkedComment, findMarkedIssue, issueState } from "./issues";
import { findMarkedReview, findOpenPullRequestByHead, pullRequestState } from "./pull-requests";
import { findCommitByMarker, lookupRepository } from "./repository";
import {
  type Arguments,
  args,
  type GitHubApi,
  githubEffectMarker,
  logins,
  names,
  numberArg,
  stringArg,
  stringListArg,
} from "./shared";

async function reconcileComment(
  api: GitHubApi,
  repository: string,
  issueNumber: number,
  request: ToolReconciliationRequest,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const comment = await findMarkedComment(
    api,
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

async function reconcileState(
  api: GitHubApi,
  repository: string,
  issueNumber: number,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const issue = await issueState(api, repository, issueNumber, credential);
  const state = String(issue.state);
  const evidenceRef = `github:issue:${repository}#${issueNumber}:${state}`;
  return state === "closed"
    ? { outcome: "confirmed", evidenceRef }
    : { outcome: "not_applied", evidenceRef };
}

async function reconcileLabels(
  api: GitHubApi,
  repository: string,
  issueNumber: number,
  source: Arguments,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const issue = await issueState(api, repository, issueNumber, credential);
  const present = new Set(names(issue.labels));
  const applied = stringListArg(source, "labels").every((label) => present.has(label));
  const evidenceRef = `github:issue:${repository}#${issueNumber}:labels`;
  return applied ? { outcome: "confirmed", evidenceRef } : { outcome: "not_applied", evidenceRef };
}

async function reconcileAssignees(
  api: GitHubApi,
  repository: string,
  issueNumber: number,
  source: Arguments,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const issue = await issueState(api, repository, issueNumber, credential);
  const present = new Set(logins(issue.assignees));
  const applied = stringListArg(source, "assignees").every((login) => present.has(login));
  const evidenceRef = `github:issue:${repository}#${issueNumber}:assignees`;
  return applied ? { outcome: "confirmed", evidenceRef } : { outcome: "not_applied", evidenceRef };
}

async function reconcileIssueCreate(
  api: GitHubApi,
  repository: string,
  request: ToolReconciliationRequest,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const issue = await findMarkedIssue(
    api,
    repository,
    githubEffectMarker(request.idempotencyKey),
    credential
  );
  return issue === undefined
    ? { outcome: "not_applied", evidenceRef: `github:issue:create:absent:${repository}` }
    : { outcome: "confirmed", evidenceRef: `github:issue:${String(issue.number)}` };
}

async function reconcileRepositoryCreate(
  api: GitHubApi,
  source: Arguments,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const owner = stringArg(source, "owner");
  const name = stringArg(source, "name");
  const existing = await lookupRepository(api, owner, name, credential);
  const evidenceRef = `github:repository:${owner}/${name}`;
  return existing === undefined
    ? { outcome: "not_applied", evidenceRef }
    : { outcome: "confirmed", evidenceRef };
}

async function reconcilePullRequestCreate(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const head = stringArg(source, "head");
  const existing = await findOpenPullRequestByHead(api, repository, head, credential);
  const evidenceRef = `github:pull_request:${repository}:head:${head}`;
  return existing === undefined
    ? { outcome: "not_applied", evidenceRef }
    : { outcome: "confirmed", evidenceRef: `github:pull_request:${String(existing.number)}` };
}

async function reconcilePullRequestReview(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  request: ToolReconciliationRequest,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const review = await findMarkedReview(
    api,
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

async function reconcilePullRequestMerge(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const current = await pullRequestState(api, repository, pullNumber, credential);
  const evidenceRef = `github:pull_request:${repository}#${pullNumber}:merged`;
  return current.merged === true
    ? { outcome: "confirmed", evidenceRef }
    : { outcome: "not_applied", evidenceRef };
}

async function reconcilePush(
  api: GitHubApi,
  repository: string,
  branch: string,
  request: ToolReconciliationRequest,
  credential: string
): Promise<ToolReconciliationOutcome> {
  const commit = await findCommitByMarker(
    api,
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

/** With no credential, reconciliation must stay `ambiguous`, never assume `not_applied`. */
export async function reconcileGitHubEffect(
  api: GitHubApi,
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
      return await reconcileRepositoryCreate(api, source, credential);
    } catch {
      return { outcome: "ambiguous", evidenceRef: "github:lookup_failed" };
    }
  }

  const repository = stringArg(source, "repository");

  try {
    switch (request.operation) {
      case GITHUB_RECONCILIATION_OPERATIONS.issueCreate:
        return await reconcileIssueCreate(api, repository, request, credential);
      case GITHUB_RECONCILIATION_OPERATIONS.comment:
        return await reconcileComment(
          api,
          repository,
          numberArg(source, "issueNumber"),
          request,
          credential
        );
      case GITHUB_RECONCILIATION_OPERATIONS.state:
        return await reconcileState(api, repository, numberArg(source, "issueNumber"), credential);
      case GITHUB_RECONCILIATION_OPERATIONS.labels:
        return await reconcileLabels(
          api,
          repository,
          numberArg(source, "issueNumber"),
          source,
          credential
        );
      case GITHUB_RECONCILIATION_OPERATIONS.assignees:
        return await reconcileAssignees(
          api,
          repository,
          numberArg(source, "issueNumber"),
          source,
          credential
        );
      case GITHUB_RECONCILIATION_OPERATIONS.pullRequestCreate:
        return await reconcilePullRequestCreate(api, repository, source, credential);
      case GITHUB_RECONCILIATION_OPERATIONS.pullRequestComment:
        return await reconcileComment(
          api,
          repository,
          numberArg(source, "pullNumber"),
          request,
          credential
        );
      case GITHUB_RECONCILIATION_OPERATIONS.pullRequestReview:
        return await reconcilePullRequestReview(
          api,
          repository,
          numberArg(source, "pullNumber"),
          request,
          credential
        );
      case GITHUB_RECONCILIATION_OPERATIONS.pullRequestMerge:
        return await reconcilePullRequestMerge(
          api,
          repository,
          numberArg(source, "pullNumber"),
          credential
        );
      case GITHUB_RECONCILIATION_OPERATIONS.repoPush:
        return await reconcilePush(
          api,
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
