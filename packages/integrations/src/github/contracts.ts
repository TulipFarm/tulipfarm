import type { ToolContractDefinition } from "@tulipfarm/schema";
import { CHECK_TOOL_CONTRACTS } from "./contracts/checks";
import { CONTENT_TOOL_CONTRACTS } from "./contracts/content";
import {
  GITHUB_TOOL_IDS,
  type GitHubToolId,
  SEARCH_TOOL_VERSION,
  TOOL_VERSION,
} from "./contracts/core";

export type { GitHubToolId } from "./contracts/core";
export {
  GITHUB_ADAPTER_REF,
  GITHUB_ISSUE_TARGET,
  GITHUB_ORGANIZATION_TARGET,
  GITHUB_RECONCILIATION_OPERATIONS,
  GITHUB_REPOSITORY_TARGET,
  GITHUB_TOOL_IDS,
} from "./contracts/core";

import { ISSUE_TOOL_CONTRACTS } from "./contracts/issues";
import { PULL_REQUEST_TOOL_CONTRACTS } from "./contracts/pull-requests";
import { REPOSITORY_TOOL_CONTRACTS } from "./contracts/repository";

export const GITHUB_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  ...ISSUE_TOOL_CONTRACTS,
  ...PULL_REQUEST_TOOL_CONTRACTS,
  ...CHECK_TOOL_CONTRACTS,
  ...REPOSITORY_TOOL_CONTRACTS,
  ...CONTENT_TOOL_CONTRACTS,
];

function currentVersion(toolId: GitHubToolId): string {
  return toolId === GITHUB_TOOL_IDS.issueSearch || toolId === GITHUB_TOOL_IDS.pullRequestSearch
    ? SEARCH_TOOL_VERSION
    : TOOL_VERSION;
}

const declaration = (toolId: GitHubToolId, name: string, description: string) => {
  const toolVersion = currentVersion(toolId);
  const contract = GITHUB_TOOL_CONTRACTS.find(
    (candidate) => candidate.spec.toolId === toolId && candidate.spec.toolVersion === toolVersion
  );
  if (contract === undefined) throw new Error(`GitHub Tool declaration has no contract: ${toolId}`);
  return {
    toolId,
    toolVersion: contract.spec.toolVersion,
    name,
    description,
    inputSchema: contract.spec.inputSchema,
  };
};

/** Shipped model-facing declarations, bound to each Tool's current immutable contract version. */
export const GITHUB_TOOL_DECLARATIONS = [
  declaration(
    GITHUB_TOOL_IDS.issueRead,
    "github_issue_read",
    "Read one GitHub issue's title, body, state, labels, and assignees."
  ),
  declaration(
    GITHUB_TOOL_IDS.issueSearch,
    "github_issue_search",
    "Search one explicitly named GitHub repository's issues by query and state. Call " +
      "github_repository_list first if the repository is unknown."
  ),
  declaration(
    GITHUB_TOOL_IDS.issueCreate,
    "github_issue_create",
    "Open a new GitHub issue, optionally with labels and assignees."
  ),
  declaration(
    GITHUB_TOOL_IDS.issueComment,
    "github_issue_comment",
    "Post a comment on a GitHub issue."
  ),
  declaration(
    GITHUB_TOOL_IDS.issueLabel,
    "github_issue_label",
    "Set the labels on a GitHub issue."
  ),
  declaration(
    GITHUB_TOOL_IDS.issueAssign,
    "github_issue_assign",
    "Set the assignees on a GitHub issue."
  ),
  declaration(
    GITHUB_TOOL_IDS.issueClose,
    "github_issue_close",
    "Close a GitHub issue, optionally with a state reason."
  ),
  declaration(
    GITHUB_TOOL_IDS.pullRequestRead,
    "github_pull_request_read",
    "Read one GitHub pull request's title, body, state, and branches."
  ),
  declaration(
    GITHUB_TOOL_IDS.pullRequestSearch,
    "github_pull_request_search",
    "Search one explicitly named GitHub repository's pull requests by query and state. Call " +
      "github_repository_list first if the repository is unknown."
  ),
  declaration(
    GITHUB_TOOL_IDS.pullRequestCreate,
    "github_pull_request_create",
    "Open a new GitHub pull request from a head branch into a base branch."
  ),
  declaration(
    GITHUB_TOOL_IDS.pullRequestComment,
    "github_pull_request_comment",
    "Post a comment on a GitHub pull request."
  ),
  declaration(
    GITHUB_TOOL_IDS.pullRequestReview,
    "github_pull_request_review",
    "Submit a review (approve, request changes, or comment) on a GitHub pull request."
  ),
  declaration(
    GITHUB_TOOL_IDS.pullRequestMerge,
    "github_pull_request_merge",
    "Merge a GitHub pull request."
  ),
  declaration(
    GITHUB_TOOL_IDS.checkRunRead,
    "github_check_run_read",
    "Read one GitHub check run's status and conclusion."
  ),
  declaration(
    GITHUB_TOOL_IDS.repoPush,
    "github_repo_push",
    "Commit one or more files to a GitHub branch."
  ),
  declaration(
    GITHUB_TOOL_IDS.repositoryCreate,
    "github_repository_create",
    "Create a new GitHub repository under an org this installation covers. Requires the App's " +
      "administration:write permission, which is not granted by default — if this fails, ask an " +
      "org admin to upgrade the GitHub App's permissions from the installation's settings page."
  ),
  declaration(
    GITHUB_TOOL_IDS.contentRead,
    "github_content_read",
    "Read a file's contents from a GitHub repository."
  ),
  declaration(
    GITHUB_TOOL_IDS.contentList,
    "github_content_list",
    "List a directory's contents in a GitHub repository (or the repository root)."
  ),
] as const;

export const GITHUB_REPOSITORY_LIST_DECLARATION = {
  name: "github_repository_list",
  description:
    "List the GitHub repositories this business has an active installation for. Call this " +
    "first when the user names no repository, or names one you're not sure is installed. This " +
    "reports only which repositories the workspace's GitHub App can see — it does not mean " +
    "you personally can act on them. Every other GitHub Tool also requires the calling person " +
    "to have connected their own GitHub account, separately from that App installation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
} as const;
