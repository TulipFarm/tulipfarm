import type { TeamBusinessAssetOwnership } from "@tulipfarm/schema";
import { apiCommand, apiGet, CATALOG_TTL_MS, shareInFlight } from "./api";

/* Cookie-first read client for soul-backed Agents; non-2xx responses throw `ApiError`. */

export type Autonomy = "full" | "supervised" | "approval-required" | "manual";

export type AgentRecordAction = "list" | "search" | "read" | "create" | "update" | "delete";
export type AgentResourceTypeAction = "list" | "read" | "create" | "update";

export type AllowDeny<T extends string = string> = {
  allow?: T[];
  deny?: T[];
};

/**
 * What the runtime will and will not let this agent do. Authored in AGENT.md frontmatter and
 * enforced on every Tool call, so it is the honest answer to "what permissions does it have".
 */
export type AgentCapabilityRestrictions = {
  tools?: AllowDeny & { allowMutating?: boolean };
  skills?: AllowDeny;
  records?: { actions?: AllowDeny<AgentRecordAction>; resourceTypes?: string[] };
  resourceTypes?: { actions?: AllowDeny<AgentResourceTypeAction>; names?: string[] };
};

export type AgentSummary = {
  name: string;
  label?: string;
  domain?: string;
  description?: string;
  model?: string;
  autonomy?: Autonomy;
  capabilityRestrictions?: AgentCapabilityRestrictions;
  ownership?: TeamBusinessAssetOwnership;
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

export const listAgents = shareInFlight(async (): Promise<AgentSummary[]> => {
  const body = await apiGet<{ agents: AgentSummary[] }>("/api/v1/agents");
  return body.agents;
}, CATALOG_TTL_MS);

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
