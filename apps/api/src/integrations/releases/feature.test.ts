import type { OimPackageCatalogEntry } from "@tulipfarm/integrations";
import * as oimReleases from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import type { OimReleaseFeatureDeps } from "./feature";
import { createOimReleaseFeature } from "./feature";

const manifest = {
  metadata: { id: "bundled", version: "1.0.0" },
} as unknown as OimManifest;

function dependencies(): OimReleaseFeatureDeps {
  const bundledIntegration = {
    slug: "bundled",
    sourceIntegration: "bundled",
    oimManifest: manifest,
  } satisfies SoulIntegration;
  return {
    businessId: "business-1",
    database: {} as OimReleaseFeatureDeps["database"],
    bundled: [
      {
        key: "bundled",
        manifest,
        packageDigest: "a".repeat(64),
        integration: bundledIntegration,
      },
    ],
    soulIntegrations: () => new Map(),
    soulPackageWriter: {
      soulWriter: {} as OimReleaseFeatureDeps["soulPackageWriter"]["soulWriter"],
      soulStore: {
        async lastCommitForPath() {
          return null;
        },
        listFiles() {
          return [];
        },
      },
      publisher: {
        async publishCommittedTree() {
          throw new Error("not used");
        },
      },
      actor: { principalId: "service:test", name: "Test", email: "" },
    },
    trustedCatalog: {
      logger: {
        warn: vi.fn(),
      },
    },
    uninstall: {} as OimReleaseFeatureDeps["uninstall"],
    reviewedDrafts: {
      async claim() {
        return null;
      },
      async acknowledge() {
        throw new Error("not used");
      },
    },
    http: {
      async send() {
        throw new Error("not used");
      },
    },
    pinnedSources: {
      async inspect() {
        throw new Error("not used");
      },
    },
    maintenanceActor: { principalId: "service:test", name: "Test", email: "" },
  };
}

describe("createOimReleaseFeature", () => {
  it("exposes root-bindable control, catalog, dispatch, and refresh interfaces", async () => {
    const feature = createOimReleaseFeature(dependencies());

    await feature.refresh.soulReloaded();
    await feature.refresh.remoteSynced();

    expect(feature.controlPlane).toBeDefined();
    expect(feature.reviewedCommunityInstaller).toBeDefined();
    expect(feature.dispatch).toBeDefined();
    expect(feature.packages()).toEqual([
      expect.objectContaining({ key: "bundled" }),
    ] satisfies readonly Partial<OimPackageCatalogEntry>[]);
    expect([...feature.integrations().keys()]).toEqual(["bundled"]);
  });

  it("reconciles durable approved operations before boot refresh without source or draft fetch", async () => {
    const events: string[] = [];
    const claim = vi.fn(async () => null);
    const inspect = vi.fn(async () => {
      throw new Error("not used");
    });
    const reconcile = vi
      .spyOn(oimReleases, "reconcileOimReleaseOperations")
      .mockImplementation(async (deps) => {
        expect(deps).toMatchObject({
          operations: expect.any(Object),
          packageWriter: expect.any(Object),
          provenance: expect.any(Object),
        });
        events.push("reconcile");
      });
    const feature = createOimReleaseFeature({
      ...dependencies(),
      soulIntegrations: () => {
        events.push("refresh");
        return new Map();
      },
      reviewedDrafts: {
        claim,
        async acknowledge() {
          throw new Error("not used");
        },
      },
      pinnedSources: { inspect },
    });

    await feature.refresh.boot();
    expect(events).toEqual(["reconcile", "refresh"]);
    expect(claim).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();

    await feature.refresh.soulReloaded();
    await feature.refresh.remoteSynced();
    expect(reconcile).toHaveBeenCalledOnce();
    reconcile.mockRestore();
  });

  it("rejects a source install over a bundled identity before source inspection", async () => {
    const deps = dependencies();
    const feature = createOimReleaseFeature(deps);

    await expect(
      feature.controlPlane.install({
        businessId: "business-1",
        source: "example/integrations",
        sourceRef: "commit-1",
        slug: "community-bundled",
        selection: {
          integrationId: "bundled",
          version: "1.2.3",
          packageDigest: "a".repeat(64),
        },
        trustClass: "community",
        approvedCommunityDigest: "a".repeat(64),
        autoPatchOptIn: false,
        actorId: "user-1",
      })
    ).rejects.toThrow("oim_release_identity_reserved_by_bundled_package:bundled");
  });

  it("rejects an install when the fetched source no longer matches the reviewed ref", async () => {
    const inspect = vi.spyOn(oimReleases, "inspectGitOimReleasePackages").mockResolvedValue({
      ref: "commit-changed",
      candidates: [],
    });
    const install = vi
      .spyOn(oimReleases, "installOimReleaseFromSource")
      .mockImplementation(async (input, deps) => {
        await deps.inspectSource(input.source, input.actorId);
        throw new Error("not reached");
      });
    const feature = createOimReleaseFeature(dependencies());

    await expect(
      feature.controlPlane.install({
        businessId: "business-1",
        source: "example/integrations",
        sourceRef: "commit-reviewed",
        slug: "community-weather",
        selection: {
          integrationId: "weather",
          version: "1.2.3",
          packageDigest: "b".repeat(64),
        },
        trustClass: "official",
        autoPatchOptIn: false,
        actorId: "user-1",
      })
    ).rejects.toThrow("oim_release_source_ref_changed");
    expect(inspect).toHaveBeenCalledWith("example/integrations", "user-1");
    expect(install).toHaveBeenCalledOnce();
    install.mockRestore();
    inspect.mockRestore();
  });

  it("rejects a reviewed Community package over a bundled identity before acknowledgement", async () => {
    const acknowledge = vi.fn(async () => {});
    const deps = {
      ...dependencies(),
      reviewedDrafts: {
        async claim() {
          return {
            slug: "community-bundled",
            package: { manifest, files: new Map() },
            source: {
              kind: "authored_draft" as const,
              reviewId: "review-1",
              reviewedAt: "2026-09-13T00:00:00.000Z",
              reviewedBy: {
                businessId: "business-1",
                principal: { kind: "user", id: "user-1" },
              },
              runId: "run-1",
            },
            replacementIssues: [],
          };
        },
        acknowledge,
      },
    };
    const feature = createOimReleaseFeature(deps);

    await expect(
      feature.reviewedCommunityInstaller.install({
        businessId: "business-1",
        slug: "community-bundled",
        packageDigest: "a".repeat(64),
        principal: { kind: "user", id: "user-1" },
        runId: "run-1",
        replace: false,
      })
    ).resolves.toMatchObject({ success: false });
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
