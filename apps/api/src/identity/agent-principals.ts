import { DEFAULT_ASSISTANT_NAME, type Logger, type SoulAgent } from "@tulipfarm/soul";
import type { PrincipalRepo, RoleRepo } from "@tulipfarm/storage";
import { AGENT_ROLE_ID } from "./roles";

export interface SoulAgents {
  agents: Map<string, SoulAgent>;
}

export interface AgentPrincipalRepos {
  readonly principals: Pick<PrincipalRepo, "put">;
  readonly roles: Pick<RoleRepo, "assign">;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register one Agent as a Principal holding the `agent` Role.
 *
 * The Tool gate resolves an Agent authority layer for every call and intersects it with the
 * caller's. An Agent with no Principal resolves to an empty layer, which denies every Tool for
 * every caller rather than denying something specific — so provisioning is not an enhancement to
 * an Agent, it is the difference between an Agent that works and one that cannot act at all.
 * Idempotent, so publication, the boot sweep and the post-sync sweep can all call it.
 */
export async function ensureAgentPrincipal(
  repos: AgentPrincipalRepos,
  businessId: string,
  agentId: string
): Promise<void> {
  await repos.principals.put({ id: agentId, businessId, kind: "agent", status: "active" });
  await repos.roles.assign({ principalId: agentId, roleId: AGENT_ROLE_ID, businessId });
}

/**
 * Provision a Principal for every Agent a turn can route to.
 *
 * `DEFAULT_ASSISTANT_NAME` is included because normal chat runs on it and it is not a Soul
 * artifact, so no publication would ever create it. Failures are logged per Agent rather than
 * thrown: one unprovisionable Agent must not stop the rest from being repaired.
 */
export async function reconcileAgentPrincipals(
  repos: AgentPrincipalRepos,
  soul: SoulAgents,
  businessId: string,
  logger?: Pick<Logger, "warn">
): Promise<void> {
  for (const agentId of [DEFAULT_ASSISTANT_NAME, ...soul.agents.keys()]) {
    try {
      await ensureAgentPrincipal(repos, businessId, agentId);
    } catch (err) {
      logger?.warn(`[agents] could not provision principal for "${agentId}": ${msg(err)}`);
    }
  }
}
