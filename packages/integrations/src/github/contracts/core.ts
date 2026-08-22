import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

/** Typed GitHub Tools; mutating contracts reconcile unknown outcomes instead of retrying. */

export const GITHUB_ADAPTER_REF = "integration:github";

export const GITHUB_REPOSITORY_TARGET = "github.repository";
export const GITHUB_ISSUE_TARGET = "github.issue";
/** AccessGrant target for an org-level action whose repository does not exist yet. */
export const GITHUB_ORGANIZATION_TARGET = "github.organization";

export const GITHUB_TOOL_IDS = {
  issueRead: "github.issue.read",
  issueSearch: "github.issue.search",
  issueCreate: "github.issue.create",
  issueComment: "github.issue.comment",
  issueLabel: "github.issue.label",
  issueAssign: "github.issue.assign",
  issueClose: "github.issue.close",
  pullRequestRead: "github.pull_request.read",
  pullRequestSearch: "github.pull_request.search",
  pullRequestCreate: "github.pull_request.create",
  pullRequestComment: "github.pull_request.comment",
  pullRequestReview: "github.pull_request.review",
  pullRequestMerge: "github.pull_request.merge",
  checkRunRead: "github.check_run.read",
  repoPush: "github.repo.push",
  repositoryCreate: "github.repository.create",
  contentRead: "github.content.read",
  contentList: "github.content.list",
} as const;

export type GitHubToolId = (typeof GITHUB_TOOL_IDS)[keyof typeof GITHUB_TOOL_IDS];

/** Reconciliation lookups the adapter implements for each mutating Tool. */
export const GITHUB_RECONCILIATION_OPERATIONS = {
  comment: "github.issue.comment.lookup",
  labels: "github.issue.labels.lookup",
  assignees: "github.issue.assignees.lookup",
  state: "github.issue.state.lookup",
  issueCreate: "github.issue.create.lookup",
  pullRequestCreate: "github.pull_request.create.lookup",
  pullRequestComment: "github.pull_request.comment.lookup",
  pullRequestReview: "github.pull_request.review.lookup",
  pullRequestMerge: "github.pull_request.merge.lookup",
  repoPush: "github.repo.push.lookup",
  repositoryCreate: "github.repository.create.lookup",
} as const;

export const TOOL_VERSION = "1.0.0";
export const SEARCH_TOOL_VERSION = "2.0.0";
export const GITHUB_DESTINATION = "github";
export const ISSUE_DATA_CLASSES = ["source_content"];
export const PR_DATA_CLASSES = ["source_content"];

export const repositoryProperty = {
  type: "string",
  minLength: 3,
  maxLength: 140,
  pattern: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$",
} as const;

export const issueNumberProperty = { type: "integer", minimum: 1 } as const;

export function issueInput(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["repository", ...required],
    properties: {
      repository: repositoryProperty,
      ...properties,
    },
  };
}

/** The immutable v1 search shape retained for Runs pinned before repository-scoped entitlement. */
export function legacySearchInput(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      repository: repositoryProperty,
      repositories: {
        type: "array",
        minItems: 1,
        maxItems: 25,
        uniqueItems: true,
        items: repositoryProperty,
        description:
          "Search multiple repositories in one call instead of one `github_issue_search`/" +
          "`github_pull_request_search` call per repository. Omit both `repository` and " +
          "`repositories` to search every repository this business has installed GitHub for.",
      },
      ...properties,
    },
  };
}

/** Current searches stay on one repository so live entitlement has one concrete target. */
export function searchInput(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["repository"],
    properties: {
      repository: {
        ...repositoryProperty,
        description:
          "One explicit owner/name repository. Call `github_repository_list` first if you do " +
          "not know which repository is installed.",
      },
      ...properties,
    },
  };
}

export const issueOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "number", "title", "body", "state", "labels", "assignees", "htmlUrl"],
  properties: {
    repository: repositoryProperty,
    number: issueNumberProperty,
    title: { type: "string" },
    body: { type: "string" },
    state: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    assignees: { type: "array", items: { type: "string" } },
    htmlUrl: { type: "string" },
  },
} as const;

/**
 * Authored definitions are content-addressed. Deriving the digest from the spec keeps these
 * first-party contracts publishable without hand-maintained hashes that would silently drift.
 */
export function publish(spec: ToolContractSpec, id: string, slug: string): ToolContractDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(spec),
    },
    spec,
  };
}
