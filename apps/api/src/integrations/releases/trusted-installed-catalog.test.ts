import {
  type AuthorizedOimRelease,
  OimReleaseTrustError,
  verifyOimReleasePackage,
} from "@tulipfarm/integrations";
import {
  type OimManifest,
  type OimPackageContent,
  oimFileDigest,
  oimPackageDigest,
} from "@tulipfarm/schema";
import type { Logger, SoulIntegration } from "@tulipfarm/soul";
import type {
  InstalledOimReleaseProvenance,
  PersistedInstalledOimReleaseProvenance,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  createTrustedInstalledOimCatalog,
  type TrustedInstalledOimCatalogDeps,
} from "./trusted-installed-catalog";

const BUSINESS_ID = "business-1";

function integration(
  slug = "weather-v1",
  options: {
    readonly id?: string;
    readonly version?: string;
    readonly files?: Readonly<Record<string, OimPackageContent>>;
  } = {}
): SoulIntegration {
  const files = options.files ?? { "guide.md": "trusted bytes" };
  const manifest: OimManifest = {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: options.id ?? "weather",
      name: "Weather",
      version: options.version ?? "1.2.3",
      description: "Read current weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    files: Object.entries(files).map(([path, content]) => ({
      path,
      role: "guide",
      sha256: oimFileDigest(content),
    })),
    operations: [
      {
        id: "current-weather",
        name: "current_weather",
        description: "Read current weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/v1/current",
        },
        response: {
          schema: { type: "object" },
          maxBytes: 16_384,
        },
      },
    ],
  };
  return {
    slug,
    sourceIntegration: manifest.metadata.id,
    oimManifest: manifest,
    oimPackageFiles: files,
  };
}

function provenance(
  value: SoulIntegration,
  overrides: Partial<InstalledOimReleaseProvenance & { readonly installationId: string }> = {}
): InstalledOimReleaseProvenance & { readonly installationId: string } {
  const manifest = value.oimManifest;
  if (manifest === undefined) throw new Error("test OIM manifest missing");
  return {
    businessId: BUSINESS_ID,
    integrationId: manifest.metadata.id,
    majorVersion: Number(manifest.metadata.version.split(".")[0]),
    version: manifest.metadata.version,
    packageDigest: oimPackageDigest(manifest),
    source: {
      kind: "git",
      repository: "https://github.com/example/integrations.git",
      ref: "refs/tags/weather-v1.2.3",
      path: "weather",
    },
    slug: value.slug,
    soulRevision: "revision-1",
    trustClass: "community",
    approvedCommunityDigest: oimPackageDigest(manifest),
    originalRequirements: manifest,
    autoPatchOptIn: false,
    installationId: "11111111-1111-4111-8111-111111111111",
    installedAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    ...overrides,
  };
}

function authorized(value: SoulIntegration): AuthorizedOimRelease {
  const manifest = value.oimManifest;
  if (manifest === undefined) throw new Error("test OIM manifest missing");
  const verified = verifyOimReleasePackage({
    manifest,
    files: new Map(Object.entries(value.oimPackageFiles ?? {})),
  });
  return {
    trustClass: "community",
    ...verified,
    approvedCommunityDigest: verified.packageDigest,
  };
}

function logger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function harness(value: SoulIntegration, overrides: Partial<TrustedInstalledOimCatalogDeps> = {}) {
  const installed = provenance(value);
  const deps: TrustedInstalledOimCatalogDeps = {
    businessId: BUSINESS_ID,
    integrations: () => new Map([[value.slug, value]]),
    trust: {
      findInstalledProvenance: vi.fn(async () => installed),
      authorizeInstalledRelease: vi.fn(async () => authorized(value)),
    },
    soulStore: {
      lastCommitForPath: vi.fn(async () => installed.soulRevision),
    },
    logger: logger(),
    ...overrides,
  };
  return { catalog: createTrustedInstalledOimCatalog(deps), deps, installed };
}

describe("TrustedInstalledOimCatalog", () => {
  it("loads an exact current Soul package after provenance and trust authorization", async () => {
    const value = integration();
    const { catalog, deps } = harness(value);

    await expect(catalog.refresh()).resolves.toEqual(new Map([[value.slug, value]]));
    expect(deps.trust.findInstalledProvenance).toHaveBeenCalledWith(BUSINESS_ID, "weather", 1);
    expect(deps.soulStore.lastCommitForPath).toHaveBeenCalledWith("integrations/weather-v1");
    expect(deps.trust.authorizeInstalledRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        integrationId: "weather",
        majorVersion: 1,
      })
    );
  });

  it("excludes a package whose digest changed after installation", async () => {
    const value = integration();
    const { catalog, deps } = harness(value, {
      trust: {
        findInstalledProvenance: vi.fn(async () =>
          provenance(value, { packageDigest: "0".repeat(64) })
        ),
        authorizeInstalledRelease: vi.fn(async () => authorized(value)),
      },
    });

    await expect(catalog.refresh()).resolves.toEqual(new Map());
    expect(deps.trust.authorizeInstalledRelease).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("excludes a package when any declared companion byte changed", async () => {
    const value = integration();
    const changed = {
      ...value,
      oimPackageFiles: { "guide.md": "changed bytes" },
    };
    const { catalog, deps } = harness(changed, {
      trust: {
        findInstalledProvenance: vi.fn(async () => provenance(value)),
        authorizeInstalledRelease: vi.fn(async () => authorized(changed)),
      },
    });

    await expect(catalog.refresh()).resolves.toEqual(new Map());
    expect(deps.trust.findInstalledProvenance).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("digest"));
  });

  it("excludes a package whose artifact-scoped Git revision changed", async () => {
    const value = integration();
    const { catalog, deps } = harness(value, {
      soulStore: {
        lastCommitForPath: vi.fn(async () => "revision-2"),
      },
    });

    await expect(catalog.refresh()).resolves.toEqual(new Map());
    expect(deps.trust.authorizeInstalledRelease).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("artifact revision"));
  });

  it("excludes a quarantined generation hidden by findInstalledProvenance", async () => {
    const value = integration();
    const { catalog, deps } = harness(value, {
      trust: {
        findInstalledProvenance: vi.fn(async () => null),
        authorizeInstalledRelease: vi.fn(async () => authorized(value)),
      },
    });

    await expect(catalog.refresh()).resolves.toEqual(new Map());
    expect(deps.soulStore.lastCommitForPath).not.toHaveBeenCalled();
    expect(deps.trust.authorizeInstalledRelease).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("provenance"));
  });

  it("excludes a release revoked by the current trust authorization", async () => {
    const value = integration();
    const { catalog, deps } = harness(value, {
      trust: {
        findInstalledProvenance: vi.fn(async () => provenance(value)),
        authorizeInstalledRelease: vi.fn(async () => {
          throw new OimReleaseTrustError("OFFICIAL_RELEASE_REVOKED", "OIM release is revoked");
        }),
      },
    });

    await expect(catalog.refresh()).resolves.toEqual(new Map());
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("revoked"));
  });

  it("preserves the previous catalog when infrastructure refresh fails", async () => {
    const value = integration();
    let available = true;
    const { catalog } = harness(value, {
      trust: {
        findInstalledProvenance: vi.fn(async () => {
          if (!available) throw new Error("database unavailable");
          return provenance(value);
        }),
        authorizeInstalledRelease: vi.fn(async () => authorized(value)),
      },
    });
    await catalog.refresh();
    const previous = catalog.integrations;
    available = false;

    await expect(catalog.refresh()).rejects.toThrow("database unavailable");
    expect(catalog.integrations).toBe(previous);
    expect(catalog.integrations.get(value.slug)).toBe(value);
  });

  it("does not let an older overlapping refresh overwrite a newer result", async () => {
    const older = integration("weather-v1", { version: "1.2.3" });
    const newer = integration("weather-next-v2", { id: "weather-next", version: "2.0.0" });
    let integrations = new Map([[older.slug, older]]);
    let finishOlder: ((value: PersistedInstalledOimReleaseProvenance) => void) | undefined;
    const olderProvenance = new Promise<PersistedInstalledOimReleaseProvenance>((resolve) => {
      finishOlder = resolve;
    });
    const deps: TrustedInstalledOimCatalogDeps = {
      businessId: BUSINESS_ID,
      integrations: () => integrations,
      trust: {
        findInstalledProvenance: vi.fn(async (_businessId, integrationId) =>
          integrationId === "weather" ? olderProvenance : provenance(newer)
        ),
        authorizeInstalledRelease: vi.fn(async (input) =>
          authorized(input.majorVersion === 1 ? older : newer)
        ),
      },
      soulStore: {
        lastCommitForPath: vi.fn(async () => "revision-1"),
      },
      logger: logger(),
    };
    const catalog = createTrustedInstalledOimCatalog(deps);

    const first = catalog.refresh();
    integrations = new Map([[newer.slug, newer]]);
    await catalog.refresh();
    finishOlder?.(provenance(older));
    await first;

    expect([...catalog.integrations.keys()]).toEqual(["weather-next-v2"]);
    expect(catalog.integrations.get("weather-next-v2")).toBe(newer);
  });
});
