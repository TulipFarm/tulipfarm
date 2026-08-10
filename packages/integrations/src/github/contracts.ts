import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

/**
 * Published GitHub ToolContracts (SPEC §11, §15).
 *
 * These are typed, bounded Tools — never a shell around `gh` and never a raw HTTP passthrough.
 * Each one names the single provider operation it performs, declares its own risk class and
 * mutation flag, and binds to the governed Integration adapter so every call re-enters the Tool
 * Broker. Mutating contracts declare `idempotency.strategy: "reconcile"` (GitHub has no native
 * idempotency key) plus the reconciliation lookup that resolves an ambiguous effect, and are
 * explicitly *not* safe to blind-retry: a write whose outcome is unknown must be reconciled
 * against provider state, not repeated.
 */

export const GITHUB_ADAPTER_REF = "integration:github";

export const GITHUB_REPOSITORY_TARGET = "github.repository";
export const GITHUB_ISSUE_TARGET = "github.issue";
export const GITHUB_PULL_REQUEST_TARGET = "github.pull_request";
export const GITHUB_CHECK_RUN_TARGET = "github.check_run";
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

const TOOL_VERSION = "1.0.0";
const GITHUB_DESTINATION = "github";
const ISSUE_DATA_CLASSES = ["source_content"];

const repositoryProperty = {
  type: "string",
  minLength: 3,
  maxLength: 140,
  pattern: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$",
} as const;

const issueNumberProperty = { type: "integer", minimum: 1 } as const;

function issueInput(properties: Record<string, unknown>, required: string[]) {
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

/**
 * A search input takes `repository` alone (unchanged behavior), `repositories` (an OR-searched
 * bounded set), or neither (every repository the installation covers) — never both `required`,
 * since exactly which of the three applies is resolved by the adapter, not this schema. Bounded to
 * 25 as a sanity cap on query length; GitHub's issue/PR search has no documented limit on repeated
 * `repo:` qualifiers (the 5-operator cap is Code Search only, not Issues/PR search).
 */
function searchInput(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required,
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

const issueOutputSchema = {
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
function publish(spec: ToolContractSpec, id: string, slug: string): ToolContractDefinition {
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

const issueRead = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueRead,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueRead,
    inputSchema: issueInput({ issueNumber: issueNumberProperty }, ["issueNumber"]),
    outputSchema: issueOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0001-4000-8000-000000000001",
  "github-issue-read"
);

const issueSearch = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueSearch,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueSearch,
    inputSchema: searchInput(
      {
        query: {
          type: "string",
          maxLength: 256,
          description:
            "Free-text search terms. Omit or pass an empty string to list every result matching " +
            "only `state`, instead of filtering by text.",
        },
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      []
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["totalCount", "items"],
      properties: {
        totalCount: { type: "integer", minimum: 0 },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["repository", "number", "title", "state", "htmlUrl"],
            properties: {
              repository: repositoryProperty,
              number: issueNumberProperty,
              title: { type: "string" },
              state: { type: "string" },
              htmlUrl: { type: "string" },
            },
          },
        },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0002-4000-8000-000000000002",
  "github-issue-search"
);

const issueCreate = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueCreate,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueCreate,
    inputSchema: issueInput(
      {
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", maxLength: 65_536 },
        labels: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 50 },
        },
        assignees: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 39 },
        },
      },
      ["title"]
    ),
    outputSchema: issueOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.issue.close",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.issueCreate,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0011-4000-8000-000000000011",
  "github-issue-create"
);

const issueComment = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueComment,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueComment,
    inputSchema: issueInput(
      {
        issueNumber: issueNumberProperty,
        body: { type: "string", minLength: 1, maxLength: 65_536 },
      },
      ["issueNumber", "body"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["commentId", "htmlUrl", "createdAt"],
      properties: {
        commentId: { type: "string" },
        htmlUrl: { type: "string" },
        createdAt: { type: "string" },
      },
    },
    riskClass: "medium",
    mutating: true,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.issue.comment.delete",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.comment,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0003-4000-8000-000000000003",
  "github-issue-comment"
);

const issueLabel = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueLabel,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueLabel,
    inputSchema: issueInput(
      {
        issueNumber: issueNumberProperty,
        labels: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 50 },
        },
      },
      ["issueNumber", "labels"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["labels"],
      properties: { labels: { type: "array", items: { type: "string" } } },
    },
    riskClass: "low",
    mutating: true,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.issue.label.remove",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.labels,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0004-4000-8000-000000000004",
  "github-issue-label"
);

const issueAssign = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueAssign,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueAssign,
    inputSchema: issueInput(
      {
        issueNumber: issueNumberProperty,
        assignees: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 39 },
        },
      },
      ["issueNumber", "assignees"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["assignees"],
      properties: { assignees: { type: "array", items: { type: "string" } } },
    },
    riskClass: "medium",
    mutating: true,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.issue.assign.remove",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.assignees,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0005-4000-8000-000000000005",
  "github-issue-assign"
);

const issueClose = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueClose,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueClose,
    inputSchema: issueInput(
      {
        issueNumber: issueNumberProperty,
        stateReason: { type: "string", enum: ["completed", "not_planned"] },
      },
      ["issueNumber"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["number", "state"],
      properties: {
        number: issueNumberProperty,
        state: { type: "string" },
        stateReason: { type: "string" },
      },
    },
    // Closing someone else's issue is the most consequential thing this Integration can do.
    riskClass: "high",
    mutating: true,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.issue.reopen",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.state,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0006-4000-8000-000000000006",
  "github-issue-close"
);

const PR_DATA_CLASSES = ["source_content"];

const pullRequestOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "repository",
    "number",
    "title",
    "body",
    "state",
    "merged",
    "htmlUrl",
    "headRef",
    "baseRef",
  ],
  properties: {
    repository: repositoryProperty,
    number: issueNumberProperty,
    title: { type: "string" },
    body: { type: "string" },
    state: { type: "string" },
    merged: { type: "boolean" },
    htmlUrl: { type: "string" },
    headRef: { type: "string" },
    baseRef: { type: "string" },
  },
} as const;

const pullRequestRead = publish(
  {
    toolId: GITHUB_TOOL_IDS.pullRequestRead,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.pullRequestRead,
    inputSchema: issueInput({ pullNumber: issueNumberProperty }, ["pullNumber"]),
    outputSchema: pullRequestOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0007-4000-8000-000000000007",
  "github-pull-request-read"
);

const pullRequestSearch = publish(
  {
    toolId: GITHUB_TOOL_IDS.pullRequestSearch,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.pullRequestSearch,
    inputSchema: searchInput(
      {
        query: {
          type: "string",
          maxLength: 256,
          description:
            "Free-text search terms. Omit or pass an empty string to list every result matching " +
            "only `state`, instead of filtering by text.",
        },
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      []
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["totalCount", "items"],
      properties: {
        totalCount: { type: "integer", minimum: 0 },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["repository", "number", "title", "state", "htmlUrl"],
            properties: {
              repository: repositoryProperty,
              number: issueNumberProperty,
              title: { type: "string" },
              state: { type: "string" },
              htmlUrl: { type: "string" },
            },
          },
        },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0008-4000-8000-000000000008",
  "github-pull-request-search"
);

const pullRequestCreate = publish(
  {
    toolId: GITHUB_TOOL_IDS.pullRequestCreate,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.pullRequestCreate,
    inputSchema: issueInput(
      {
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", maxLength: 65_536 },
        head: { type: "string", minLength: 1, maxLength: 250 },
        base: { type: "string", minLength: 1, maxLength: 250 },
        draft: { type: "boolean" },
      },
      ["title", "head", "base"]
    ),
    outputSchema: pullRequestOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.pull_request.close",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.pullRequestCreate,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0009-4000-8000-000000000009",
  "github-pull-request-create"
);

const pullRequestComment = publish(
  {
    toolId: GITHUB_TOOL_IDS.pullRequestComment,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.pullRequestComment,
    inputSchema: issueInput(
      {
        pullNumber: issueNumberProperty,
        body: { type: "string", minLength: 1, maxLength: 65_536 },
      },
      ["pullNumber", "body"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["commentId", "htmlUrl", "createdAt"],
      properties: {
        commentId: { type: "string" },
        htmlUrl: { type: "string" },
        createdAt: { type: "string" },
      },
    },
    riskClass: "medium",
    mutating: true,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.pull_request.comment.delete",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.pullRequestComment,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-000a-4000-8000-00000000000a",
  "github-pull-request-comment"
);

const pullRequestReview = publish(
  {
    toolId: GITHUB_TOOL_IDS.pullRequestReview,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.pullRequestReview,
    inputSchema: issueInput(
      {
        pullNumber: issueNumberProperty,
        event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
        body: { type: "string", maxLength: 65_536 },
      },
      ["pullNumber", "event"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["reviewId", "state", "htmlUrl"],
      properties: {
        reviewId: { type: "string" },
        state: { type: "string" },
        htmlUrl: { type: "string" },
      },
    },
    // A binding signal on someone else's change — as consequential as closing an issue.
    riskClass: "high",
    mutating: true,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.pull_request.review.dismiss",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.pullRequestReview,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-000b-4000-8000-00000000000b",
  "github-pull-request-review"
);

const pullRequestMerge = publish(
  {
    toolId: GITHUB_TOOL_IDS.pullRequestMerge,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.pullRequestMerge,
    inputSchema: issueInput(
      {
        pullNumber: issueNumberProperty,
        mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
        commitTitle: { type: "string", maxLength: 256 },
      },
      ["pullNumber"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["merged", "sha"],
      properties: { merged: { type: "boolean" }, sha: { type: "string" } },
    },
    // The single most irreversible action this Integration performs.
    riskClass: "high",
    mutating: true,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.pull_request.merge.revert",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.pullRequestMerge,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-000c-4000-8000-00000000000c",
  "github-pull-request-merge"
);

const checkRunRead = publish(
  {
    toolId: GITHUB_TOOL_IDS.checkRunRead,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.checkRunRead,
    inputSchema: issueInput({ checkRunId: { type: "integer", minimum: 1 } }, ["checkRunId"]),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "status", "conclusion", "htmlUrl"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        status: { type: "string" },
        conclusion: { type: ["string", "null"] },
        htmlUrl: { type: "string" },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-000d-4000-8000-00000000000d",
  "github-check-run-read"
);

const repoPush = publish(
  {
    toolId: GITHUB_TOOL_IDS.repoPush,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.repoPush,
    inputSchema: issueInput(
      {
        branch: { type: "string", minLength: 1, maxLength: 250 },
        message: { type: "string", minLength: 1, maxLength: 2000 },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "content"],
            properties: {
              path: { type: "string", minLength: 1, maxLength: 1024 },
              content: { type: "string", maxLength: 1_000_000 },
            },
          },
        },
      },
      ["branch", "message", "files"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "branch", "sha", "htmlUrl"],
      properties: {
        repository: repositoryProperty,
        branch: { type: "string" },
        sha: { type: "string" },
        htmlUrl: { type: "string" },
      },
    },
    // The single most consequential write this Integration performs against a customer's history.
    riskClass: "high",
    mutating: true,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 20_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "github.repo.push.revert",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.repoPush,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-000e-4000-8000-00000000000e",
  "github-repo-push"
);

const repositoryOwnerProperty = {
  type: "string",
  minLength: 1,
  maxLength: 39,
  pattern: "^[A-Za-z0-9-]+$",
} as const;

const repositoryNameProperty = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9._-]+$",
} as const;

const repositoryCreate = publish(
  {
    toolId: GITHUB_TOOL_IDS.repositoryCreate,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.repositoryCreate,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "name"],
      properties: {
        owner: repositoryOwnerProperty,
        name: repositoryNameProperty,
        description: { type: "string", maxLength: 350 },
        private: {
          type: "boolean",
          description: "Defaults to true (private) when omitted.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "htmlUrl", "private", "defaultBranch"],
      properties: {
        repository: repositoryProperty,
        htmlUrl: { type: "string" },
        private: { type: "boolean" },
        defaultBranch: { type: "string" },
      },
    },
    // Creates a new asset under the org and consumes seats/quota — as consequential as pushing to
    // an existing repo's history.
    riskClass: "high",
    mutating: true,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 20_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    // Detect-only: reconciliation reports whether the repo now exists after an ambiguous write,
    // it never calls a delete API — repo deletion is too destructive to automate.
    compensation: {
      operation: "github.repository.create.report_duplicate",
      reconciliation: GITHUB_RECONCILIATION_OPERATIONS.repositoryCreate,
    },
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0012-4000-8000-000000000012",
  "github-repository-create"
);

const contentPathProperty = { type: "string", minLength: 1, maxLength: 1024 } as const;
const contentRefProperty = { type: "string", minLength: 1, maxLength: 250 } as const;

const contentRead = publish(
  {
    toolId: GITHUB_TOOL_IDS.contentRead,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.contentRead,
    inputSchema: issueInput({ path: contentPathProperty, ref: contentRefProperty }, ["path"]),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "path", "sha", "content", "encoding", "htmlUrl"],
      properties: {
        repository: repositoryProperty,
        path: { type: "string" },
        sha: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string" },
        htmlUrl: { type: "string" },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-000f-4000-8000-00000000000f",
  "github-content-read"
);

const contentList = publish(
  {
    toolId: GITHUB_TOOL_IDS.contentList,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.contentList,
    inputSchema: issueInput({ path: contentPathProperty, ref: contentRefProperty }, []),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "path", "entries"],
      properties: {
        repository: repositoryProperty,
        path: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "path", "type", "sha", "htmlUrl"],
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              type: { type: "string", enum: ["file", "dir", "symlink", "submodule"] },
              sha: { type: "string" },
              htmlUrl: { type: "string" },
            },
          },
        },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-0010-4000-8000-000000000010",
  "github-content-list"
);

export const GITHUB_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  issueRead,
  issueSearch,
  issueCreate,
  issueComment,
  issueLabel,
  issueAssign,
  issueClose,
  pullRequestRead,
  pullRequestSearch,
  pullRequestCreate,
  pullRequestComment,
  pullRequestReview,
  pullRequestMerge,
  checkRunRead,
  repoPush,
  repositoryCreate,
  contentRead,
  contentList,
];
