import type { ToolContractDefinition } from "@tulipfarm/schema";
import { CHECK_TOOL_CONTRACTS } from "./contracts/checks";
import { CONTENT_TOOL_CONTRACTS } from "./contracts/content";

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
