import type { AccessGrant, AccessRequest } from "./grants";

export interface OperationalScope {
  readonly businessId: string;
  readonly installationId: string;
}

export const OPERATIONAL_UPDATE_READ = {
  action: "deployment.update.read",
  resourceType: "deployment",
} as const;

export function operationalUpdateRequest(scope: OperationalScope): AccessRequest {
  return {
    ...OPERATIONAL_UPDATE_READ,
    conditions: { businessId: scope.businessId, installationId: scope.installationId },
  };
}

/** A credential ceiling never turns a wildcard business grant into operational authority. */
export function narrowOperationalGrants(
  grants: readonly AccessGrant[],
  scope: OperationalScope
): readonly AccessGrant[] {
  return grants.filter(
    (grant) =>
      grant.effect === "deny" ||
      (grant.action === OPERATIONAL_UPDATE_READ.action &&
        grant.resourceType === OPERATIONAL_UPDATE_READ.resourceType &&
        grant.conditions?.businessId === scope.businessId &&
        grant.conditions?.installationId === scope.installationId)
  );
}

export function operationalScopeMatches(
  scope: OperationalScope,
  deployment: OperationalScope | undefined
): boolean {
  return (
    deployment !== undefined &&
    scope.businessId === deployment.businessId &&
    scope.installationId === deployment.installationId
  );
}
