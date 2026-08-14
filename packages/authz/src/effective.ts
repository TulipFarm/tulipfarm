/** Authority is an intersection: any deny or missing allow denies with safe reason evidence. */

import { type AccessGrant, type AccessRequest, grantMatches } from "./grants";

/** One layer's verdict: an explicit deny, an allow, or no matching grant at all. */
export type GrantOutcome = "allow" | "deny" | "abstain";

/** One layer: matching deny wins; no matching grant abstains, which the intersection denies. */
export function evaluateGrants(
  grants: readonly AccessGrant[],
  request: AccessRequest,
  now: Date
): GrantOutcome {
  let outcome: GrantOutcome = "abstain";
  for (const grant of grants) {
    if (!grantMatches(grant, request, now)) continue;
    if (grant.effect === "deny") return "deny";
    outcome = "allow";
  }
  return outcome;
}

/** A named authority source contributing to the intersection (e.g. "user", "agent"). */
export interface AuthorityLayer {
  readonly name: string;
  readonly grants: readonly AccessGrant[];
}

export type AuthzDecisionReason = "allowed" | "no_layers" | "explicit_deny" | "no_matching_allow";

export interface AuthzDecision {
  readonly allowed: boolean;
  readonly reason: AuthzDecisionReason;
  /** Name of the first layer that denied; absent when allowed or when no layers were given. */
  readonly deniedLayer?: string;
}

/** Intersects layers: every layer must allow; no layers means fail closed. */
export function decideEffectivePermission(
  layers: readonly AuthorityLayer[],
  request: AccessRequest,
  now: Date = new Date()
): AuthzDecision {
  if (layers.length === 0) {
    return { allowed: false, reason: "no_layers" };
  }
  for (const layer of layers) {
    const outcome = evaluateGrants(layer.grants, request, now);
    if (outcome === "deny") {
      return { allowed: false, reason: "explicit_deny", deniedLayer: layer.name };
    }
    if (outcome === "abstain") {
      return { allowed: false, reason: "no_matching_allow", deniedLayer: layer.name };
    }
  }
  return { allowed: true, reason: "allowed" };
}
