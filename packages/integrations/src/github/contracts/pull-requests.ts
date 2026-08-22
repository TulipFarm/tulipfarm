import type { ToolContractDefinition } from "@tulipfarm/schema";
import {
  GITHUB_ADAPTER_REF,
  GITHUB_DESTINATION,
  GITHUB_RECONCILIATION_OPERATIONS,
  GITHUB_TOOL_IDS,
  issueInput,
  issueNumberProperty,
  legacySearchInput,
  PR_DATA_CLASSES,
  publish,
  repositoryProperty,
  SEARCH_TOOL_VERSION,
  searchInput,
  TOOL_VERSION,
} from "./core";

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

const pullRequestSearchProperties = {
  query: {
    type: "string",
    maxLength: 256,
    description:
      "Free-text search terms. Omit or pass an empty string to list every result matching " +
      "only `state`, instead of filtering by text.",
  },
  state: { type: "string", enum: ["open", "closed", "all"] },
  limit: { type: "integer", minimum: 1, maximum: 50 },
} as const;

const pullRequestSearchOutputSchema = {
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
} as const;

const pullRequestSearchV1 = publish(
  {
    toolId: GITHUB_TOOL_IDS.pullRequestSearch,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.pullRequestSearch,
    inputSchema: legacySearchInput(pullRequestSearchProperties),
    outputSchema: pullRequestSearchOutputSchema,
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

const pullRequestSearch = publish(
  {
    ...pullRequestSearchV1.spec,
    toolVersion: SEARCH_TOOL_VERSION,
    inputSchema: searchInput(pullRequestSearchProperties),
  },
  "aaaaaaaa-0008-4000-8000-000000000018",
  "github-pull-request-search-v2"
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

export const PULL_REQUEST_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  pullRequestRead,
  pullRequestSearchV1,
  pullRequestSearch,
  pullRequestCreate,
  pullRequestComment,
  pullRequestReview,
  pullRequestMerge,
];
