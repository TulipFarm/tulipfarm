import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

/** Typed Jira Tools; mutating contracts reconcile unknown outcomes instead of retrying. */

export const JIRA_ADAPTER_REF = "integration:jira";

export const JIRA_PROJECT_TARGET = "jira.project";
export const JIRA_ISSUE_TARGET = "jira.issue";

export const JIRA_TOOL_IDS = {
  issueRead: "jira.issue.read",
  issueSearch: "jira.issue.search",
  issueCreate: "jira.issue.create",
  issueTransition: "jira.issue.transition",
  userSearch: "jira.user.search",
  userAvailability: "jira.user.availability",
} as const;

export type JiraToolId = (typeof JIRA_TOOL_IDS)[keyof typeof JIRA_TOOL_IDS];

/** Reconciliation lookups the adapter implements for each mutating Tool. */
export const JIRA_RECONCILIATION_OPERATIONS = {
  create: "jira.issue.create.lookup",
  status: "jira.issue.status.lookup",
} as const;

const TOOL_VERSION = "1.0.0";
const JIRA_DESTINATION = "jira";
const ISSUE_DATA_CLASSES = ["source_content"];

const projectKeyProperty = {
  type: "string",
  minLength: 1,
  maxLength: 32,
  pattern: "^[A-Z][A-Z0-9]*$",
} as const;

const issueKeyProperty = {
  type: "string",
  minLength: 3,
  maxLength: 64,
  pattern: "^[A-Z][A-Z0-9]*-[1-9][0-9]*$",
} as const;

function input(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", additionalProperties: false, required, properties };
}

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
    toolId: JIRA_TOOL_IDS.issueRead,
    toolVersion: TOOL_VERSION,
    action: JIRA_TOOL_IDS.issueRead,
    inputSchema: input({ issueKey: issueKeyProperty }, ["issueKey"]),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issueKey", "projectKey", "summary", "status", "issueType", "labels"],
      properties: {
        issueKey: issueKeyProperty,
        projectKey: projectKeyProperty,
        summary: { type: "string" },
        description: { type: "string" },
        status: { type: "string" },
        issueType: { type: "string" },
        assignee: { type: ["string", "null"] },
        labels: { type: "array", items: { type: "string" } },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [JIRA_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: JIRA_ADAPTER_REF },
  },
  "bbbbbbbb-0001-4000-8000-000000000001",
  "jira-issue-read"
);

const issueSearch = publish(
  {
    toolId: JIRA_TOOL_IDS.issueSearch,
    toolVersion: TOOL_VERSION,
    action: JIRA_TOOL_IDS.issueSearch,
    inputSchema: input(
      {
        projectKey: projectKeyProperty,
        jql: { type: "string", minLength: 1, maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["projectKey", "jql"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["total", "items"],
      properties: {
        total: { type: "integer", minimum: 0 },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["issueKey", "summary", "status"],
            properties: {
              issueKey: issueKeyProperty,
              summary: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [JIRA_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 20_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: JIRA_ADAPTER_REF },
  },
  "bbbbbbbb-0002-4000-8000-000000000002",
  "jira-issue-search"
);

const issueCreate = publish(
  {
    toolId: JIRA_TOOL_IDS.issueCreate,
    toolVersion: TOOL_VERSION,
    action: JIRA_TOOL_IDS.issueCreate,
    inputSchema: input(
      {
        projectKey: projectKeyProperty,
        summary: { type: "string", minLength: 1, maxLength: 255 },
        description: { type: "string", maxLength: 32_768 },
        issueType: { type: "string", minLength: 1, maxLength: 64 },
        labels: {
          type: "array",
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
      ["projectKey", "summary", "issueType"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issueKey", "issueId", "url"],
      properties: {
        issueKey: issueKeyProperty,
        issueId: { type: "string" },
        url: { type: "string" },
      },
    },
    riskClass: "medium",
    mutating: true,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [JIRA_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 20_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "jira.issue.delete",
      reconciliation: JIRA_RECONCILIATION_OPERATIONS.create,
    },
    adapter: { kind: "integration", ref: JIRA_ADAPTER_REF },
  },
  "bbbbbbbb-0003-4000-8000-000000000003",
  "jira-issue-create"
);

const issueTransition = publish(
  {
    toolId: JIRA_TOOL_IDS.issueTransition,
    toolVersion: TOOL_VERSION,
    action: JIRA_TOOL_IDS.issueTransition,
    inputSchema: input(
      {
        issueKey: issueKeyProperty,
        transitionId: { type: "string", minLength: 1, maxLength: 32 },
        // Named so an ambiguous transition can be reconciled against observable state.
        targetStatus: { type: "string", minLength: 1, maxLength: 64 },
      },
      ["issueKey", "transitionId", "targetStatus"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issueKey", "status"],
      properties: { issueKey: issueKeyProperty, status: { type: "string" } },
    },
    riskClass: "medium",
    mutating: true,
    dataClasses: ISSUE_DATA_CLASSES,
    allowedDestinations: [JIRA_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 20_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "jira.issue.transition.revert",
      reconciliation: JIRA_RECONCILIATION_OPERATIONS.status,
    },
    adapter: { kind: "integration", ref: JIRA_ADAPTER_REF },
  },
  "bbbbbbbb-0004-4000-8000-000000000004",
  "jira-issue-transition"
);

const userSearch = publish(
  {
    toolId: JIRA_TOOL_IDS.userSearch,
    toolVersion: TOOL_VERSION,
    action: JIRA_TOOL_IDS.userSearch,
    inputSchema: input(
      {
        projectKey: projectKeyProperty,
        query: { type: "string", minLength: 1, maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      ["projectKey", "query"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["users"],
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["accountId", "displayName", "active"],
            properties: {
              accountId: { type: "string" },
              displayName: { type: "string" },
              active: { type: "boolean" },
            },
          },
        },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: ["directory"],
    allowedDestinations: [JIRA_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: JIRA_ADAPTER_REF },
  },
  "bbbbbbbb-0005-4000-8000-000000000005",
  "jira-user-search"
);

const userAvailability = publish(
  {
    toolId: JIRA_TOOL_IDS.userAvailability,
    toolVersion: TOOL_VERSION,
    action: JIRA_TOOL_IDS.userAvailability,
    inputSchema: input(
      {
        projectKey: projectKeyProperty,
        accountIds: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        maxOpenIssues: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["projectKey", "accountIds"]
    ),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["candidates"],
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["accountId", "openIssueCount", "available"],
            properties: {
              accountId: { type: "string" },
              openIssueCount: { type: "integer", minimum: 0 },
              available: { type: "boolean" },
            },
          },
        },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: ["directory"],
    allowedDestinations: [JIRA_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 20_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: JIRA_ADAPTER_REF },
  },
  "bbbbbbbb-0006-4000-8000-000000000006",
  "jira-user-availability"
);

export const JIRA_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  issueRead,
  issueSearch,
  issueCreate,
  issueTransition,
  userSearch,
  userAvailability,
];
