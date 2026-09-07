import type {
  assertOimHookExecutionGrant,
  issueOimHookExecutionGrant,
  OimHookExecutionGrant,
  OimHookPhaseRunner,
  OimPackageAuthorization,
  OimReleasePackage,
  OimReleaseTrustService,
} from "@tulipfarm/integrations";
import type { HookExecutor } from "@tulipfarm/sandbox";
import type { OimHook } from "@tulipfarm/schema";

export type OimHookReleasePackage = OimReleasePackage;
export type OimHookReleaseAuthorization = OimPackageAuthorization;
export type OimOfficialHookReleaseAuthorization = Extract<
  OimPackageAuthorization,
  { readonly trustClass: "official" }
>;
export type OimCommunityHookReleaseAuthorization = Extract<
  OimPackageAuthorization,
  { readonly trustClass: "community" }
>;
export type OimHookReleaseTrust = Pick<OimReleaseTrustService, "authorizeToolCompilation">;
export type OimHookExecutionGrantView = OimHookExecutionGrant;
export type IssueOimHookExecutionGrant = typeof issueOimHookExecutionGrant;
export type AssertOimHookExecutionGrant = typeof assertOimHookExecutionGrant;

export interface ExecuteVerifiedOimHookDeps {
  readonly releaseTrust: OimHookReleaseTrust;
  readonly issueHookExecutionGrant: IssueOimHookExecutionGrant;
  readonly assertHookExecutionGrant: AssertOimHookExecutionGrant;
  readonly executor: Pick<HookExecutor, "runPureHook">;
}

export interface ExecuteVerifiedOimHookInput {
  readonly package: OimHookReleasePackage;
  readonly signedRelease?: unknown;
  readonly hook: OimHook;
  readonly value: unknown;
}

export type VerifiedOimHookPhaseRunner = OimHookPhaseRunner;

export interface VerifiedOimHookPhaseRunnerInput {
  readonly package: OimHookReleasePackage;
  readonly signedRelease?: unknown;
}

/**
 * Authorizes the exact package, obtains its opaque in-process Hook grant, and asserts that grant
 * immediately before crossing the isolate boundary.
 */
export async function executeVerifiedOimHook(
  deps: ExecuteVerifiedOimHookDeps,
  input: ExecuteVerifiedOimHookInput
): Promise<unknown> {
  const authorization = await deps.releaseTrust.authorizeToolCompilation({
    package: input.package,
    ...(input.signedRelease === undefined ? {} : { signedRelease: input.signedRelease }),
  });
  const grant = deps.issueHookExecutionGrant(
    authorization,
    input.package,
    input.hook.kind,
    input.hook.export
  );

  deps.assertHookExecutionGrant(grant);
  return deps.executor.runPureHook({
    source: grant.source,
    sourceSha256: grant.fileSha256,
    exportName: grant.exportName,
    input: input.value,
    breakerKey: `oim:${grant.integrationId}@${grant.version}:${grant.packageDigest}:${grant.hookKind}:${grant.exportName}`,
  });
}

/** Binds one exact installed package and signed envelope to the shared OIM phase-runner port. */
export function createVerifiedOimHookPhaseRunner(
  deps: ExecuteVerifiedOimHookDeps,
  input: VerifiedOimHookPhaseRunnerInput
): VerifiedOimHookPhaseRunner {
  return Object.freeze({
    run(hook: OimHook, value: unknown): Promise<unknown> {
      return executeVerifiedOimHook(deps, {
        package: input.package,
        ...(input.signedRelease === undefined ? {} : { signedRelease: input.signedRelease }),
        hook,
        value,
      });
    },
  });
}
