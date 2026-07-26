/**
 * Memory scope authorization (SPEC §14.2).
 *
 * Every scope names *whose* memory an assertion is. Authorization is therefore an identity match
 * against that owner, never a capability the caller carries: a principal with broad Business
 * authority still cannot read another user's `user_private` memory, because that scope's owner is
 * a different person.
 *
 * Default-deny throughout — an unrecognised scope, a scope the Agent's MemorySettings does not
 * enable, or a target missing the identity its scope requires all deny.
 */

import type { MemoryScope } from "@tulipfarm/schema";

/** Who an assertion belongs to. Which fields are required depends on the scope. */
export interface MemoryScopeTarget {
  readonly scope: MemoryScope;
  readonly businessId: string;
  /** Owner of `user_private` / `user_agent` memory. */
  readonly subjectPrincipalId?: string;
  /** Owner of `agent_private`, and the paired Agent for `user_agent`. */
  readonly agentId?: string;
  /** Owner of `team_role` memory. */
  readonly roleId?: string;
  /** Owner of `run_local` memory. */
  readonly runId?: string;
}

/** Who is asking, and what identities they actually hold right now. */
export interface MemoryScopeRequest {
  readonly businessId: string;
  readonly principalId: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly roleIds?: readonly string[];
}

export type MemoryScopeDenialReason =
  | "business_mismatch"
  | "scope_not_enabled"
  | "scope_unknown"
  | "target_incomplete"
  | "principal_mismatch"
  | "agent_mismatch"
  | "role_not_held"
  | "run_mismatch";

export type MemoryScopeDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: MemoryScopeDenialReason };

const DENY = (reason: MemoryScopeDenialReason): MemoryScopeDecision => ({
  allowed: false,
  reason,
});
const ALLOW: MemoryScopeDecision = { allowed: true };

/**
 * Decide whether `request` may read or write memory owned by `target`.
 *
 * `enabledScopes` comes from the Agent's MemorySettings; a scope absent from it is denied even
 * when the identity would otherwise match, so narrowing an Agent's settings immediately narrows
 * what it can remember and recall.
 */
export function authorizeMemoryScope(
  enabledScopes: readonly MemoryScope[],
  target: MemoryScopeTarget,
  request: MemoryScopeRequest
): MemoryScopeDecision {
  if (target.businessId !== request.businessId) return DENY("business_mismatch");
  if (!enabledScopes.includes(target.scope)) return DENY("scope_not_enabled");

  switch (target.scope) {
    case "user_private":
      if (target.subjectPrincipalId === undefined) return DENY("target_incomplete");
      return target.subjectPrincipalId === request.principalId ? ALLOW : DENY("principal_mismatch");

    case "user_agent": {
      // Both halves must match: this is one user's memory *with one Agent*, and neither the user
      // nor the Agent alone may reach it.
      if (target.subjectPrincipalId === undefined || target.agentId === undefined) {
        return DENY("target_incomplete");
      }
      if (target.subjectPrincipalId !== request.principalId) return DENY("principal_mismatch");
      return target.agentId === request.agentId ? ALLOW : DENY("agent_mismatch");
    }

    case "agent_private":
      if (target.agentId === undefined) return DENY("target_incomplete");
      return target.agentId === request.agentId ? ALLOW : DENY("agent_mismatch");

    case "team_role":
      if (target.roleId === undefined) return DENY("target_incomplete");
      return (request.roleIds ?? []).includes(target.roleId) ? ALLOW : DENY("role_not_held");

    case "business":
      // The business match was already established above; nothing further narrows this scope.
      return ALLOW;

    case "run_local":
      if (target.runId === undefined) return DENY("target_incomplete");
      return target.runId === request.runId ? ALLOW : DENY("run_mismatch");

    default:
      return DENY("scope_unknown");
  }
}
