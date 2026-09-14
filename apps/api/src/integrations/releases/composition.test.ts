import { IntegrationDraftStore, type OimPackageCatalogEntry } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { buildToolRegistry } from "../../tools/setup";
import {
  liveOimPackageCatalog,
  synchronizeOimReleaseControlPlane,
  synchronizeReviewedCommunityInstaller,
} from "./composition";
import { OimReleaseControlPlane } from "./control-plane";

const manifest = {
  metadata: { id: "weather", version: "1.0.0" },
} as unknown as OimManifest;

describe("OIM release production composition", () => {
  it("keeps catalogs live and registers Chat authoring against the reviewed installer", async () => {
    let packages: readonly OimPackageCatalogEntry[] = [];
    const catalog = liveOimPackageCatalog(() => packages);
    expect(catalog.find((entry) => entry.key === "weather")).toBeUndefined();

    packages = [{ key: "weather", manifest }];
    expect(catalog.find((entry) => entry.key === "weather")?.manifest).toBe(manifest);

    const sync = vi.fn();
    const installer = synchronizeReviewedCommunityInstaller(
      {
        install: vi.fn(async () => ({ success: true as const, data: { revision: "soul-1" } })),
      },
      sync
    );
    const registry = buildToolRegistry({
      integrationAuthoring: {
        businessId: "business-1",
        drafts: new IntegrationDraftStore(),
        integrations: () => new Map(),
        installedGenerations: {
          async findInstalledGeneration() {
            return null;
          },
        },
        installer,
      },
    });

    expect(registry.getAll().map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "integration_draft_review",
        "integration_draft_create",
        "integration_get",
        "integration_list",
      ])
    );
    await installer.install({
      businessId: "business-1",
      slug: "weather",
      packageDigest: "a".repeat(64),
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
      replace: false,
    });
    expect(sync).toHaveBeenCalledOnce();
  });

  it("refreshes runtime registrations after public release mutations", async () => {
    const sync = vi.fn();
    const install = vi.fn(async () => ({ revision: "soul-1" }));
    const control = synchronizeOimReleaseControlPlane(
      new OimReleaseControlPlane({
        inspect: vi.fn(),
        install,
        uninstall: vi.fn(),
        uninstallStatus: vi.fn(),
        recover: vi.fn(),
        getAutoPatchPreference: vi.fn(),
        setAutoPatchPreference: vi.fn(),
        listTrustRoots: vi.fn(),
        addTrustRoot: vi.fn(),
        disableTrustRoot: vi.fn(),
        getRevocationFeed: vi.fn(),
        setRevocationFeed: vi.fn(),
        disableRevocationFeed: vi.fn(),
        acceptRevocationList: vi.fn(),
        runMaintenance: vi.fn(),
      }),
      sync
    );

    await control.install({
      businessId: "business-1",
      source: "TulipFarm/integrations",
      sourceRef: "commit-1",
      slug: "weather",
      selection: {
        integrationId: "weather",
        version: "1.0.0",
        packageDigest: "a".repeat(64),
      },
      trustClass: "community",
      approvedCommunityDigest: "a".repeat(64),
      autoPatchOptIn: false,
      actorId: "user-1",
    });

    expect(install).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
  });
});
