import type { ToolContractDefinition } from "@tulipfarm/schema";
import {
  GITHUB_ADAPTER_REF,
  GITHUB_DESTINATION,
  GITHUB_RECONCILIATION_OPERATIONS,
  GITHUB_TOOL_IDS,
  ISSUE_DATA_CLASSES,
  issueInput,
  issueNumberProperty,
  issueOutputSchema,
  legacySearchInput,
  publish,
  repositoryProperty,
  SEARCH_TOOL_VERSION,
  searchInput,
  TOOL_VERSION,
} from "./core";

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

const issueSearchProperties = {
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

const issueSearchOutputSchema = {
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

const issueSearchV1 = publish(
  {
    toolId: GITHUB_TOOL_IDS.issueSearch,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.issueSearch,
    inputSchema: legacySearchInput(issueSearchProperties),
    outputSchema: issueSearchOutputSchema,
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

const issueSearch = publish(
  {
    ...issueSearchV1.spec,
    toolVersion: SEARCH_TOOL_VERSION,
    inputSchema: searchInput(issueSearchProperties),
  },
  "aaaaaaaa-0002-4000-8000-000000000012",
  "github-issue-search-v2"
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

export const ISSUE_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  issueRead,
  issueSearchV1,
  issueSearch,
  issueCreate,
  issueComment,
  issueLabel,
  issueAssign,
  issueClose,
];
