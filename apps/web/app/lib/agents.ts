import { apiGet } from "./api";

/*
 * Read-only client for the agents API (AGENTS / UI-V1-003). Agents are AGENT.md files in the soul
 * repo; the list view carries frontmatter only, the detail view adds the markdown `body` (the agent's
 * system prompt). Mirrors lib/api.ts conventions (cookie-first auth, ApiError on non-2xx).
 */

export type Autonomy = "full" | "supervised" | "approval-required" | "manual";

export type AgentSummary = {
  name: string;
  label?: string;
  domain?: string;
  description?: string;
  model?: string;
  autonomy?: Autonomy;
};

export type AgentDetail = AgentSummary & {
  placeholder?: string[];
  suggestions?: string[];
  body: string;
};

export async function listAgents(): Promise<AgentSummary[]> {
  const body = await apiGet<{ agents: AgentSummary[] }>("/api/v1/agents");
  return body.agents;
}

export async function getAgent(name: string): Promise<AgentDetail> {
  return apiGet<AgentDetail>(`/api/v1/agents/${encodeURIComponent(name)}`);
}
