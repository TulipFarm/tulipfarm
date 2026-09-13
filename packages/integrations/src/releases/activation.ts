import type { OimReleasePackage } from "./package-verifier";
import type { AuthorizedOimRelease } from "./trust-service";
import type { OimUninstallScope, OimUninstallStatus } from "./uninstall";

export interface AuthorizeOimReleaseActivationInput extends OimUninstallScope {
  readonly package: OimReleasePackage;
}

export interface OimReleasePreparationDeps {
  readonly uninstallStatus: (
    scope: OimUninstallScope
  ) => Promise<Pick<OimUninstallStatus, "activationAllowed" | "retryRequired" | "status">>;
  readonly trust: {
    authorizeInstalledRelease(
      input: AuthorizeOimReleaseActivationInput
    ): Promise<AuthorizedOimRelease>;
  };
}

export interface OimReleaseActivationDeps extends OimReleasePreparationDeps {
  readonly dispatchLeases: {
    acquire(input: {
      readonly businessId: string;
      readonly integrationId: string;
      readonly majorVersion: number;
      readonly packageDigest: string;
    }): Promise<OimReleaseDispatchLease>;
    complete?(leaseId: string): Promise<void>;
    markReconciliationRequired?(leaseId: string, reason: string): Promise<void>;
  };
}

export interface OimReleaseDispatchLease {
  readonly leaseId: string;
  readonly installationId: string;
  readonly packageDigest: string;
  readonly expiresAt: string;
}

export interface OimReleaseDispatchPermit {
  readonly authorization: AuthorizedOimRelease;
  readonly lease: OimReleaseDispatchLease;
}

export class OimReleaseActivationError extends Error {
  readonly code = "OIM_RELEASE_UNINSTALL_PENDING";

  constructor(readonly scope: OimUninstallScope) {
    super("OIM release activation is fenced while exact-major teardown is pending");
    this.name = "OimReleaseActivationError";
  }
}

export async function authorizeOimReleasePreparation(
  input: AuthorizeOimReleaseActivationInput,
  deps: OimReleasePreparationDeps
): Promise<AuthorizedOimRelease> {
  const scope = {
    businessId: input.businessId,
    integrationId: input.integrationId,
    majorVersion: input.majorVersion,
  };
  const uninstall = await deps.uninstallStatus(scope);
  if (!uninstall.activationAllowed) throw new OimReleaseActivationError(scope);
  return deps.trust.authorizeInstalledRelease(input);
}

export async function acquireOimReleaseDispatchPermit(
  input: AuthorizeOimReleaseActivationInput,
  deps: OimReleaseActivationDeps
): Promise<OimReleaseDispatchPermit> {
  const authorization = await authorizeOimReleasePreparation(input, deps);
  const lease = await deps.dispatchLeases.acquire({
    businessId: input.businessId,
    integrationId: input.integrationId,
    majorVersion: input.majorVersion,
    packageDigest: authorization.packageDigest,
  });
  return Object.freeze({ authorization, lease });
}

export const authorizeOimReleaseActivation = acquireOimReleaseDispatchPermit;

export async function dispatchWithOimReleasePermit<T>(
  input: AuthorizeOimReleaseActivationInput,
  deps: OimReleaseActivationDeps,
  dispatch: (permit: OimReleaseDispatchPermit) => Promise<T>
): Promise<T> {
  const permit = await acquireOimReleaseDispatchPermit(input, deps);
  try {
    const result = await dispatch(permit);
    if (deps.dispatchLeases.complete === undefined) {
      throw new Error("oim_dispatch_lease_completion_unavailable");
    }
    await deps.dispatchLeases.complete(permit.lease.leaseId);
    return result;
  } catch (error) {
    if (deps.dispatchLeases.markReconciliationRequired !== undefined) {
      try {
        await deps.dispatchLeases.markReconciliationRequired(
          permit.lease.leaseId,
          "dispatch_outcome_ambiguous"
        );
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          "OIM dispatch failed and its lease could not record reconciliation"
        );
      }
    }
    throw error;
  }
}
