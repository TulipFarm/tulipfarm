import { DEFAULT_ASSISTANT_ID, type Logger, type SoulAgent } from "@tulipfarm/soul";
import type { PrincipalRepo, RoleRepo } from "@tulipfarm/storage";
import { AGENT_ROLE_ID } from "./roles";

export interface SoulAgents {
  agents: Map<string, SoulAgent>;
}

export interface AgentPrincipalRepos {
  readonly principals: Pick<PrincipalRepo, "put" | "delete">;
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
 *
 * `agentId` is the Agent's permanent id, never its name: a rename must not strand the Principal
 * that carries the Agent's authority, nor mint a second one under the new name.
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
 * Retire a deleted Agent's Principal, and with it — by the `role_assignments` cascade — its Role.
 *
 * Left behind, the pair is an authority with no Agent to exercise it. That is harmless only while
 * every Agent holds the same Role and nothing routes a call to a deleted id, and it stops being
 * harmless the moment Roles differ or an id is reachable again.
 */
export async function removeAgentPrincipal(
  repos: AgentPrincipalRepos,
  businessId: string,
  agentId: string
): Promise<void> {
  await repos.principals.delete(businessId, agentId);
}

/**
 * Provision a Principal for every Agent a turn can route to.
 *
 * `DEFAULT_ASSISTANT_ID` is included because normal chat runs on it and it is not a Soul artifact,
 * so no publication would ever create it. Failures are logged per Agent rather than thrown: one
 * unprovisionable Agent must not stop the rest from being repaired.
 */
export async function reconcileAgentPrincipals(
  repos: AgentPrincipalRepos,
  soul: SoulAgents,
  businessId: string,
  logger?: Pick<Logger, "warn">
): Promise<void> {
  const ids = [DEFAULT_ASSISTANT_ID, ...[...soul.agents.values()].map((agent) => agent.id)];
  for (const agentId of ids) {
    try {
      await ensureAgentPrincipal(repos, businessId, agentId);
    } catch (err) {
      logger?.warn(`[agents] could not provision principal for "${agentId}": ${msg(err)}`);
    }
  }
}
