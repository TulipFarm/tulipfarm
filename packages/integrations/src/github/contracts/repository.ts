import type { ToolContractDefinition } from "@tulipfarm/schema";
import {
  GITHUB_ADAPTER_REF,
  GITHUB_DESTINATION,
  GITHUB_RECONCILIATION_OPERATIONS,
  GITHUB_TOOL_IDS,
  issueInput,
  PR_DATA_CLASSES,
  publish,
  repositoryProperty,
  TOOL_VERSION,
} from "./core";

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

export const REPOSITORY_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  repoPush,
  repositoryCreate,
];
