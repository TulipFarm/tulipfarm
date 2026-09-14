import {
  createOimReleaseInstallOperationHost,
  createOimReleaseTrustHost,
  type EgressHttpPort,
  getOimUninstallStatus,
  type InstallReviewedCommunityOimReleaseDeps,
  type InstallSelectedOimReleaseDeps,
  inspectGitOimReleasePackages,
  installOimReleaseFromSource,
  installReviewedCommunityOimRelease,
  type OimReleaseActivationDeps,
  type OimReleaseSourceInspection,
  oimManifestMajor,
  reconcileOimReleaseOperations,
  recoverQuarantinedOimRelease,
  runOimReleaseMaintenance,
  type SignedOimRevocationList,
  uninstallOimReleaseGeneration,
  verifyOimReleasePackage,
} from "@tulipfarm/integrations";
import {
  type CommitActor,
  createGitBackedOimSoulReleasePackageWriter,
  type GitBackedOimSoulReleasePackageWriterDeps,
  type SoulIntegration,
} from "@tulipfarm/soul";
import { createOimReleaseStorage, type OimReleaseStorageDatabase } from "@tulipfarm/storage";
import {
  createReviewedCommunityIntegrationInstaller,
  type ReviewedCommunityIntegrationInstallerDependencies,
} from "../../soul/integrations/community-installer";
import {
  activatedOimIntegrations,
  type BundledOimCatalogEntry,
  unifiedOimPackageCatalog,
} from "../oim-catalog";
import { OimReleaseControlPlane } from "./control-plane";
import { createOimReleaseDispatchHost, type OimReleaseDispatchPort } from "./dispatch-host";
import { createOimReleaseMaintenanceService } from "./maintenance-service";
import { projectOimReleaseSourceInspection } from "./source-inspection";
import {
  createTrustedInstalledOimCatalog,
  type TrustedInstalledOimCatalogDeps,
} from "./trusted-installed-catalog";
import { createOimReleaseUninstallHost, type OimReleaseUninstallHostDeps } from "./uninstall-host";

export interface PinnedOimReleaseSourceInspector {
  inspect(source: string, ref: string, actorId: string): Promise<OimReleaseSourceInspection>;
}

export interface OimReleaseFeatureDeps {
  readonly businessId: string;
  readonly database: OimReleaseStorageDatabase;
  readonly bundled: readonly BundledOimCatalogEntry[];
  readonly soulIntegrations: () => ReadonlyMap<string, SoulIntegration>;
  readonly soulPackageWriter: GitBackedOimSoulReleasePackageWriterDeps;
  readonly trustedCatalog: Pick<TrustedInstalledOimCatalogDeps, "logger">;
  readonly uninstall: Omit<
    OimReleaseUninstallHostDeps,
    "dispatchLeases" | "packageWriter" | "releaseTrust"
  >;
  readonly reviewedDrafts: InstallReviewedCommunityOimReleaseDeps["reviewedDrafts"];
  readonly http: EgressHttpPort;
  readonly pinnedSources: PinnedOimReleaseSourceInspector;
  readonly maintenanceActor: CommitActor;
}

export interface OimReleaseFeature {
  readonly controlPlane: OimReleaseControlPlane;
  readonly reviewedCommunityInstaller: ReturnType<
    typeof createReviewedCommunityIntegrationInstaller
  >;
  readonly dispatch: OimReleaseDispatchPort;
  readonly packages: () => ReturnType<typeof unifiedOimPackageCatalog>;
  readonly integrations: () => ReadonlyMap<string, SoulIntegration>;
  readonly refresh: {
    readonly boot: () => Promise<void>;
    readonly soulReloaded: () => Promise<void>;
    readonly remoteSynced: () => Promise<void>;
  };
}

export function createOimReleaseFeature(deps: OimReleaseFeatureDeps): OimReleaseFeature {
  const stores = createOimReleaseStorage(deps.database);
  const trust = createOimReleaseTrustHost(stores.trust);
  const packageWriter = createGitBackedOimSoulReleasePackageWriter(deps.soulPackageWriter);
  const trusted = createTrustedInstalledOimCatalog({
    businessId: deps.businessId,
    integrations: () => deps.soulIntegrations().entries(),
    trust: {
      findInstalledProvenance: (businessId, integrationId, majorVersion) =>
        stores.trust.findInstalledGeneration(businessId, integrationId, majorVersion),
      authorizeInstalledRelease: trust.authorizeInstalledRelease,
    },
    soulStore: deps.soulPackageWriter.soulStore,
    logger: deps.trustedCatalog.logger,
  });
  const operations = createOimReleaseInstallOperationHost(stores.operations);
  const installDeps = {
    trust,
    packageWriter,
    provenance: trust,
    operations,
  } satisfies InstallSelectedOimReleaseDeps;
  const uninstallHost = createOimReleaseUninstallHost({
    ...deps.uninstall,
    dispatchLeases: stores.dispatchLeases,
    releaseTrust: stores.trust,
    packageWriter,
  });

  async function refresh(): Promise<void> {
    await trusted.refresh();
  }

  async function boot(): Promise<void> {
    await reconcileOimReleaseOperations(installDeps);
    await refresh();
  }

  function assertIdentityAvailable(
    integrationId: string,
    majorVersion: number,
    requestedSlug: string
  ): void {
    const bundledOwner = deps.bundled.find(
      (entry) =>
        entry.manifest.metadata.id === integrationId &&
        oimManifestMajor(entry.manifest) === majorVersion
    );
    if (bundledOwner !== undefined) {
      throw new Error(`oim_release_identity_reserved_by_bundled_package:${bundledOwner.key}`);
    }
    for (const [slug, integration] of trusted.integrations) {
      if (
        slug !== requestedSlug &&
        integration.oimManifest?.metadata.id === integrationId &&
        oimManifestMajor(integration.oimManifest) === majorVersion
      ) {
        throw new Error(`oim_release_identity_already_installed:${slug}`);
      }
    }
  }

  async function inspectPinned(source: string, ref: string, actorId: string) {
    const inspected = await deps.pinnedSources.inspect(source, ref, actorId);
    if (inspected.ref !== ref) throw new Error("oim_release_source_ref_mismatch");
    return inspected;
  }

  const maintenance = createOimReleaseMaintenanceService({
    http: deps.http,
    store: stores.trust,
    run: async (feed, businessId) => {
      const result = await runOimReleaseMaintenance(feed, {
        businessId,
        trust: {
          updateRevocationList: trust.updateRevocationList,
          recordKnownSignedReleases: trust.recordKnownSignedReleases,
          selectAutoPatch: trust.selectAutoPatch,
          listAutoPatchProvenance: async (currentBusinessId) => {
            const listed = await trust.listAutoPatchProvenance(currentBusinessId);
            return Promise.all(
              listed.map(async (entry) => {
                const generation = await stores.trust.findInstalledGeneration(
                  entry.businessId,
                  entry.integrationId,
                  entry.majorVersion
                );
                if (
                  generation === null ||
                  generation.packageDigest !== entry.packageDigest ||
                  generation.soulRevision !== entry.soulRevision
                ) {
                  throw new Error("oim_release_generation_changed");
                }
                return generation;
              })
            );
          },
        },
        installedPackage: (provenance) => trusted.packageFor(provenance),
        inspectSource: (source, ref) =>
          inspectPinned(source, ref, deps.maintenanceActor.principalId),
        patch: installDeps,
      });
      await refresh();
      return result;
    },
  });

  const controlPlane = new OimReleaseControlPlane({
    inspect: async (source, actorId) =>
      projectOimReleaseSourceInspection(
        source,
        await inspectGitOimReleasePackages(source, actorId)
      ),
    install: async (input) => {
      assertIdentityAvailable(
        input.selection.integrationId,
        Number(input.selection.version.split(".")[0]),
        input.slug
      );
      const approvedCommunityDigest = input.approvedCommunityDigest;
      if (input.trustClass === "community" && approvedCommunityDigest === undefined) {
        throw new Error("approved_community_digest_required");
      }
      const installInput =
        input.trustClass === "official"
          ? {
              businessId: input.businessId,
              source: input.source,
              sourceRef: input.sourceRef,
              slug: input.slug,
              selection: input.selection,
              trustClass: input.trustClass,
              autoPatchOptIn: input.autoPatchOptIn,
              actorId: input.actorId,
            }
          : {
              businessId: input.businessId,
              source: input.source,
              sourceRef: input.sourceRef,
              slug: input.slug,
              selection: input.selection,
              trustClass: input.trustClass,
              approvedCommunityDigest: approvedCommunityDigest as string,
              actorId: input.actorId,
            };
      const installed = await installOimReleaseFromSource(installInput, {
        ...installDeps,
        inspectSource: async (source, actorId) => {
          const inspected = await inspectGitOimReleasePackages(source, actorId);
          if (inspected.ref !== input.sourceRef) {
            throw new Error("oim_release_source_ref_changed");
          }
          return inspected;
        },
        lifecycle: stores.lifecycle,
      });
      await refresh();
      return installed;
    },
    uninstall: async (input) => {
      const result = await uninstallOimReleaseGeneration(
        {
          journal: stores.uninstallJournal,
          host: uninstallHost,
          findTarget: ({ businessId, integrationId, majorVersion, installationId }) =>
            stores.trust.findUninstallTarget(
              businessId,
              integrationId,
              majorVersion,
              installationId
            ),
        },
        input
      );
      await refresh();
      return result;
    },
    uninstallStatus: (input) => getOimUninstallStatus(stores.uninstallJournal, input),
    recover: async (input) => {
      const recovered = await recoverQuarantinedOimRelease(input, {
        provenance: {
          findQuarantined: (businessId, integrationId, majorVersion) =>
            stores.trust.findQuarantinedProvenance(businessId, integrationId, majorVersion),
          recover: (recovery) => stores.trust.recoverQuarantinedProvenance(recovery),
        },
        inspectSource: async (source, sourceRef, candidatePath) => {
          const inspected = await inspectPinned(source, sourceRef, input.actorId);
          const candidate = inspected.candidates.find(
            (current) => current.sourcePath === candidatePath
          );
          if (candidate === undefined) throw new Error("oim_release_candidate_source_missing");
          const verified = verifyOimReleasePackage(candidate.package);
          return {
            ...verified,
            majorVersion: Number(verified.version.split(".")[0]),
            resolvedRef: inspected.ref,
          };
        },
        inspectSoulArtifact: (slug) => trusted.inspectSoulArtifact(slug),
      });
      await refresh();
      return recovered;
    },
    getAutoPatchPreference: (input) =>
      stores.trust.findInstalledProvenance(
        input.businessId,
        input.integrationId,
        input.majorVersion
      ),
    setAutoPatchPreference: (input) =>
      stores.trust.setInstalledAutoPatchPreference(
        input.businessId,
        input.integrationId,
        input.majorVersion,
        input.enabled
      ),
    listTrustRoots: (includeDisabled) => stores.trust.listTrustRoots(includeDisabled),
    addTrustRoot: async ({ actorId, ...input }) => {
      const result = await trust.addTrustRoot({ ...input, createdBy: actorId });
      await refresh();
      return result;
    },
    disableTrustRoot: async ({ actorId, ...input }) => {
      const result = await trust.disableTrustRoot(input.purpose, input.keyId, actorId);
      await refresh();
      return result;
    },
    getRevocationFeed: () => trust.getRevocationFeed(),
    setRevocationFeed: ({ url, actorId }) => trust.setRevocationFeed({ url, updatedBy: actorId }),
    disableRevocationFeed: (actorId) => trust.disableRevocationFeed(actorId),
    acceptRevocationList: async (input) => {
      const result = await trust.updateRevocationList(input as SignedOimRevocationList);
      await refresh();
      return result;
    },
    runMaintenance: (businessId) => maintenance.runOnce(businessId),
  });

  const reviewedCommunityInstaller = createReviewedCommunityIntegrationInstaller({
    installReviewedCommunityOimRelease: async (input, releaseDeps) => {
      const result = await installReviewedCommunityOimRelease(input, releaseDeps);
      await refresh();
      return result;
    },
    releaseDependencies: {
      ...installDeps,
      reviewedDrafts: {
        async claim(input) {
          const draft = await deps.reviewedDrafts.claim(input);
          if (draft !== null) {
            assertIdentityAvailable(
              draft.package.manifest.metadata.id,
              oimManifestMajor(draft.package.manifest),
              draft.slug
            );
          }
          return draft;
        },
        acknowledge: (input) => deps.reviewedDrafts.acknowledge(input),
      },
    },
  } satisfies ReviewedCommunityIntegrationInstallerDependencies);

  const activation: OimReleaseActivationDeps = {
    uninstallStatus: async (scope: {
      readonly businessId: string;
      readonly integrationId: string;
      readonly majorVersion: number;
    }) => {
      const generation = await stores.trust.findInstalledGeneration(
        scope.businessId,
        scope.integrationId,
        scope.majorVersion
      );
      if (generation === null) {
        return {
          status: "not_started" as const,
          activationAllowed: true,
          retryRequired: false,
        };
      }
      return getOimUninstallStatus(stores.uninstallJournal, {
        ...scope,
        installationId: generation.installationId,
      });
    },
    trust,
    dispatchLeases: stores.dispatchLeases,
  };

  return Object.freeze({
    controlPlane,
    reviewedCommunityInstaller,
    dispatch: createOimReleaseDispatchHost({
      bundled: deps.bundled,
      activation: {
        ...activation,
        dispatchLeases: stores.dispatchLeases,
      },
    }),
    packages: () => unifiedOimPackageCatalog(deps.bundled, trusted.integrations),
    integrations: () =>
      activatedOimIntegrations(deps.bundled, deps.soulIntegrations(), trusted.integrations),
    refresh: Object.freeze({
      boot,
      soulReloaded: refresh,
      remoteSynced: refresh,
    }),
  });
}
