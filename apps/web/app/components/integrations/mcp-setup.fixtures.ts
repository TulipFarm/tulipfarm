import type {
  McpAccountSummary,
  McpCapabilityReview,
  McpIntegrationDefinition,
  McpSetupEligibility,
} from "@tulipfarm/schema";

export const githubEligibilityFixture: McpSetupEligibility = {
  definitionRevision: "c".repeat(64),
  policy: "initialize",
  publishedReady: false,
  canConfigure: true,
  canUseStandardAccess: false,
};

const names = [
  "add_issue_comment",
  "create_issue",
  "create_pull_request",
  "create_branch",
  "create_repository",
  "delete_file",
  "fork_repository",
  "get_commit",
  "get_file_contents",
  "get_me",
  "list_branches",
  "list_commits",
  "list_issues",
  "list_pull_requests",
  "list_releases",
  "list_tags",
  "merge_pull_request",
  "pull_request_read",
  "pull_request_review_write",
  "push_files",
  "request_copilot_review",
  "search_code",
  "search_issues",
  "search_pull_requests",
  "search_repositories",
  "update_issue",
  "update_pull_request",
  "update_pull_request_branch",
];

export const githubAccessFixture: McpCapabilityReview = {
  tools: names.map((name, index) => ({
    name,
    description: `${name.replaceAll("_", " ")} in the GitHub repositories this account can access.`,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner." },
        repo: { type: "string", description: "Repository name." },
        ...(name === "add_issue_comment"
          ? { issue_number: { type: "integer" }, body: { type: "string" } }
          : {}),
      },
      required: ["owner", "repo"],
    },
    digest: (index + 1).toString(16).padStart(64, "0"),
    mutating: true,
    requiresApproval: true,
  })),
  resources: [
    { name: "Repository handbook", uri: "repository://handbook", digest: "resource-digest" },
  ],
  prompts: [{ name: "review_pull_request", digest: "prompt-digest" }],
};

export const githubDefinitionFixture: McpIntegrationDefinition = {
  server: {
    id: "github-mcp",
    label: "GitHub",
    transport: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
    authentication: { type: "token", sharedAllowed: false },
  },
  enabled: false,
  reviewPolicy: "uninitialized",
  reviewed: { tools: [], resources: [], prompts: [] },
};

export const githubAccountFixture: McpAccountSummary = {
  id: "fixture-personal-account",
  integrationKey: "github-mcp",
  businessId: "fixture-business",
  definitionDigest: "a".repeat(64),
  label: "GitHub account",
  owner: { scope: "personal", principalId: "fixture-user" },
  authentication: "token",
  status: "active",
  isDefault: false,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};
