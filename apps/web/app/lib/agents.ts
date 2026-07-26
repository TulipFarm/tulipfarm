import { apiCommand, apiGet } from "./api";

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
  governance?: AgentGovernance;
};

export type AgentGovernance = {
  version: string;
  roles: string[];
  skills: string[];
  tools: string[];
  modelProfile: string;
  limits: Record<string, number>;
  evaluation: {
    status: "pending" | "passed" | "failed" | "stale";
    suite: string;
    passedAt?: string;
  };
  publication: {
    candidateVersion: string;
    status: "draft" | "validated" | "awaiting_approval" | "published" | "blocked";
    canPublish: boolean;
    reason?: string;
  };
};

export async function listAgents(): Promise<AgentSummary[]> {
  const body = await apiGet<{ agents: AgentSummary[] }>("/api/v1/agents");
  return body.agents;
}

export async function getAgent(name: string): Promise<AgentDetail> {
  return apiGet<AgentDetail>(`/api/v1/agents/${encodeURIComponent(name)}`);
}

export async function proposeAgentCandidate(
  name: string,
  governance: AgentGovernance
): Promise<{ changesetId: string; candidateVersion: string; status: string }> {
  const candidate = governance.publication.candidateVersion;
  return apiCommand(
    `/api/v1/agents/${encodeURIComponent(name)}/changesets`,
    {
      baseVersion: governance.version,
      candidateVersion: candidate,
      patch: {},
    },
    `agent-${name}-${candidate}`
  );
}
