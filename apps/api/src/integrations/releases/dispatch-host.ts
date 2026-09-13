import {
  acquireOimReleaseDispatchPermit,
  type OimReleaseActivationDeps,
  type OimReleasePackage,
  oimManifestMajor,
} from "@tulipfarm/integrations";
import { type OimManifest, oimPackageDigest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";

export type OimDispatchSettlement = "ambiguous" | "not_dispatched" | "settled";

export type OimProviderDispatch = <T>(operation: () => Promise<T>) => Promise<T>;

export interface OimReleaseDispatchPort {
  dispatch<T>(
    input: {
      readonly businessId: string;
      readonly integration: SoulIntegration;
    },
    run: (providerDispatch: OimProviderDispatch) => Promise<T>,
    settlement: () => Promise<OimDispatchSettlement>
  ): Promise<T>;
}

export interface OimReleaseDispatchHostDeps {
  readonly bundled: readonly {
    readonly manifest: OimManifest;
  }[];
  readonly activation: OimReleaseActivationDeps & {
    readonly dispatchLeases: OimReleaseActivationDeps["dispatchLeases"] & {
      complete(leaseId: string): Promise<void>;
      releaseNotDispatched(leaseId: string): Promise<void>;
      markReconciliationRequired(leaseId: string, reason: string): Promise<void>;
    };
  };
}

function releasePackage(integration: SoulIntegration): OimReleasePackage {
  if (integration.oimManifest === undefined) throw new Error("oim_release_manifest_missing");
  return {
    manifest: integration.oimManifest,
    files: new Map(Object.entries(integration.oimPackageFiles ?? {})),
  };
}

export function createOimReleaseDispatchHost(
  deps: OimReleaseDispatchHostDeps
): OimReleaseDispatchPort {
  const bundled = new Set(
    deps.bundled.map(
      ({ manifest }) =>
        `${manifest.metadata.id}@${oimManifestMajor(manifest)}@${oimPackageDigest(manifest)}`
    )
  );

  return Object.freeze({
    async dispatch<T>(
      input: {
        readonly businessId: string;
        readonly integration: SoulIntegration;
      },
      run: (providerDispatch: OimProviderDispatch) => Promise<T>,
      settlement: () => Promise<OimDispatchSettlement>
    ): Promise<T> {
      const package_ = releasePackage(input.integration);
      const integrationId = package_.manifest.metadata.id;
      const majorVersion = oimManifestMajor(package_.manifest);
      if (bundled.has(`${integrationId}@${majorVersion}@${oimPackageDigest(package_.manifest)}`)) {
        return run((operation) => operation());
      }

      const permit = await acquireOimReleaseDispatchPermit(
        { businessId: input.businessId, integrationId, majorVersion, package: package_ },
        deps.activation
      );
      let providerState: "ambiguous" | "not_dispatched" | "settled" = "not_dispatched";
      const providerDispatch: OimProviderDispatch = async (operation) => {
        try {
          const result = await operation();
          providerState = "settled";
          return result;
        } catch (error) {
          providerState =
            error instanceof Error &&
            "phase" in error &&
            (error as { readonly phase?: unknown }).phase === "before_dispatch"
              ? "not_dispatched"
              : "ambiguous";
          throw error;
        }
      };

      let execution:
        | { readonly ok: true; readonly value: T }
        | { readonly ok: false; readonly error: unknown };
      try {
        execution = { ok: true, value: await run(providerDispatch) };
      } catch (error) {
        execution = { ok: false, error };
      }

      let outcome: OimDispatchSettlement;
      try {
        outcome = await settlement();
      } catch (error) {
        outcome = providerState === "not_dispatched" ? "not_dispatched" : "ambiguous";
        execution = execution.ok
          ? { ok: false, error }
          : {
              ok: false,
              error: new AggregateError(
                [execution.error, error],
                "OIM dispatch settlement read failed"
              ),
            };
      }
      if (outcome === "settled") {
        await deps.activation.dispatchLeases.complete(permit.lease.leaseId);
      } else if (outcome === "not_dispatched" && providerState === "not_dispatched") {
        await deps.activation.dispatchLeases.releaseNotDispatched(permit.lease.leaseId);
      } else {
        await deps.activation.dispatchLeases.markReconciliationRequired(
          permit.lease.leaseId,
          "dispatch_outcome_ambiguous"
        );
      }

      if (!execution.ok) throw execution.error;
      if (outcome !== "settled") throw new Error("oim_dispatch_outcome_not_settled");
      return execution.value;
    },
  });
}
