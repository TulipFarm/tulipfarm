import type { McpKnowledgePut, McpKnowledgeStatus } from "@tulipfarm/schema";
import { apiGet, apiWrite } from "./api";
import { mcpAccountPath } from "./mcp-accounts";

const knowledgePath = (key: string, accountId: string) =>
  `${mcpAccountPath(key, accountId)}/knowledge`;

export type McpKnowledgePageSource = {
  readOnly: true;
  sourceUrl: string;
  lastSyncedAt: string;
  stale: boolean;
};

export function getMcpKnowledgePageSource(pageId: string): Promise<McpKnowledgePageSource> {
  return apiGet(`/api/v1/knowledge/pages/${encodeURIComponent(pageId)}/source`);
}

export function getMcpKnowledge(key: string, accountId: string): Promise<McpKnowledgeStatus> {
  return apiGet(knowledgePath(key, accountId));
}

export function saveMcpKnowledge(
  key: string,
  accountId: string,
  input: McpKnowledgePut
): Promise<McpKnowledgeStatus> {
  return apiWrite("PUT", knowledgePath(key, accountId), input);
}

export function syncMcpKnowledge(
  key: string,
  accountId: string,
  expectedRevision: number
): Promise<McpKnowledgeStatus> {
  return apiWrite("POST", `${knowledgePath(key, accountId)}/sync`, { expectedRevision });
}

export function removeMcpKnowledge(
  key: string,
  accountId: string,
  expectedRevision: number
): Promise<McpKnowledgeStatus> {
  return apiWrite("DELETE", knowledgePath(key, accountId), { expectedRevision });
}
