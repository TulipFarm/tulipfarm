import type { AccessGrantDefinition } from "@tulipfarm/schema";

/** Integration AccessGrants only narrow authority across principal, integration, action, target. */

export interface IntegrationPrincipalRef {
  readonly kind: string;
  readonly id: string;
}

export interface IntegrationExternalTarget {
  readonly type: string;
  readonly id: string;
}

export interface IntegrationAccessRequest {
  readonly integrationId: string;
  /** The acting principal plus any roles it holds; a grant matching any one of them suffices. */
  readonly principals: readonly IntegrationPrincipalRef[];
  readonly action: string;
  readonly target: IntegrationExternalTarget;
}

export type IntegrationAccessDenialReason =
  | "no_grant"
  | "integration_mismatch"
  | "grant_expired"
  | "principal_not_granted"
  | "action_not_granted"
  | "target_not_granted";

export type IntegrationAccessDecision =
  | { readonly allowed: true; readonly grantId: string }
  | { readonly allowed: false; readonly reason: IntegrationAccessDenialReason };

/** Denial carries the reason code only — never the external target or the grant contents. */
export class IntegrationAccessDeniedError extends Error {
  readonly name = "IntegrationAccessDeniedError";

  constructor(readonly reason: IntegrationAccessDenialReason) {
    super(`integration_access_denied:${reason}`);
  }
}

function principalMatches(
  grant: AccessGrantDefinition,
  principals: readonly IntegrationPrincipalRef[]
): boolean {
  return grant.spec.principals.some((granted) =>
    principals.some((held) => held.kind === granted.kind && held.id === granted.id)
  );
}

function targetMatches(grant: AccessGrantDefinition, target: IntegrationExternalTarget): boolean {
  return grant.spec.externalTargets.some(
    (scoped) => scoped.type === target.type && scoped.ids.includes(target.id)
  );
}

/** Return the narrowest blocking reason without widening the decision. */
export function decideIntegrationAccess(
  grants: readonly AccessGrantDefinition[],
  request: IntegrationAccessRequest,
  now: Date
): IntegrationAccessDecision {
  if (grants.length === 0) return { allowed: false, reason: "no_grant" };

  const forIntegration = grants.filter(
    (grant) => grant.spec.integrationId === request.integrationId
  );
  if (forIntegration.length === 0) return { allowed: false, reason: "integration_mismatch" };

  const live = forIntegration.filter(
    (grant) => grant.spec.expiresAt === undefined || new Date(grant.spec.expiresAt) > now
  );
  if (live.length === 0) return { allowed: false, reason: "grant_expired" };

  const forPrincipal = live.filter((grant) => principalMatches(grant, request.principals));
  if (forPrincipal.length === 0) return { allowed: false, reason: "principal_not_granted" };

  const forAction = forPrincipal.filter((grant) => grant.spec.actions.includes(request.action));
  if (forAction.length === 0) return { allowed: false, reason: "action_not_granted" };

  const allowing = forAction.find((grant) => targetMatches(grant, request.target));
  if (allowing === undefined) return { allowed: false, reason: "target_not_granted" };
  return { allowed: true, grantId: allowing.metadata.id };
}

/** Assert access and return the id of the grant that authorized it, for effect evidence. */
export function assertIntegrationAccess(
  grants: readonly AccessGrantDefinition[],
  request: IntegrationAccessRequest,
  now: Date
): string {
  const decision = decideIntegrationAccess(grants, request, now);
  if (!decision.allowed) throw new IntegrationAccessDeniedError(decision.reason);
  return decision.grantId;
}
