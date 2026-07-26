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

export const GITHUB_TOOL_IDS = {
  issueRead: "github.issue.read",
  issueSearch: "github.issue.search",
  issueComment: "github.issue.comment",
  issueLabel: "github.issue.label",
  issueAssign: "github.issue.assign",
  issueClose: "github.issue.close",
} as const;

export type GitHubToolId = (typeof GITHUB_TOOL_IDS)[keyof typeof GITHUB_TOOL_IDS];

/** Reconciliation lookups the adapter implements for each mutating Tool. */
export const GITHUB_RECONCILIATION_OPERATIONS = {
  comment: "github.issue.comment.lookup",
  labels: "github.issue.labels.lookup",
  assignees: "github.issue.assignees.lookup",
  state: "github.issue.state.lookup",
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
    inputSchema: issueInput(
      {
        query: { type: "string", minLength: 1, maxLength: 256 },
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      ["query"]
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

export const GITHUB_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  issueRead,
  issueSearch,
  issueComment,
  issueLabel,
  issueAssign,
  issueClose,
];
