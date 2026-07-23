/**
 * Effective permission is the intersection of authority layers (invoking identity, Agent, Run
 * Context, Tool/target Guardrail, AccessGrant/Credential scope — SPEC §12): every layer must
 * independently allow, an explicit deny in any layer wins, and adding a layer can only narrow.
 * Teams, delegation, and Agents therefore never union authority (SPEC §5.3, §10). The decision
 * carries deterministic reason codes and the denying layer name as audit evidence — never
 * request payloads.
 */

import { type AccessGrant, type AccessRequest, grantMatches } from "./grants";

/** One layer's verdict: an explicit deny, an allow, or no matching grant at all. */
export type GrantOutcome = "allow" | "deny" | "abstain";

/**
 * Evaluates one layer's grants against `request`. Any matching deny wins over every matching
 * allow; with no matching grant the layer abstains — which the intersection treats as a denial
 * (default deny).
 */
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

/**
 * Intersects `layers` over `request`: allowed only when every layer allows. An explicit deny
 * or a missing allow in any layer denies, naming that layer. No layers at all denies
 * (fail closed).
 */
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
