import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  OIM_RELEASE_MAINTENANCE_STORAGE_STATEMENTS,
  OIM_RELEASE_TRUST_STORAGE_STATEMENTS,
  OimReleaseTrustStore,
  OimTrustRootConflictError,
} from "./oim-release-trust-store";

function revocations(sequence: number) {
  return {
    envelopeVersion: 1,
    list: {
      sequence,
      issuedAt: `2026-09-07T06:0${sequence}:00.000Z`,
      expiresAt: "2026-09-08T06:00:00.000Z",
      revocations: [],
    },
    signature: { algorithm: "Ed25519", keyId: "revocations", value: "signed" },
  };
}

describe("OimReleaseTrustStore", () => {
  let database: PGlite;
  let store: OimReleaseTrustStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...OIM_RELEASE_TRUST_STORAGE_STATEMENTS,
      ...OIM_RELEASE_MAINTENANCE_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    store = new OimReleaseTrustStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec(
      "TRUNCATE oim_release_trust_roots, oim_release_revocation_state, oim_installed_release_provenance, oim_release_maintenance_config"
    );
  });

  it("keeps operator roots explicit and never replaces a key under an existing id", async () => {
    await store.addTrustRoot({
      purpose: "release",
      keyId: "release-2026",
      publicKeyPem: "public-key-a",
      createdBy: "admin-1",
    });
    await expect(
      store.addTrustRoot({
        purpose: "release",
        keyId: "release-2026",
        publicKeyPem: "public-key-b",
        createdBy: "admin-2",
      })
    ).rejects.toBeInstanceOf(OimTrustRootConflictError);

    expect(await store.listTrustRoots()).toEqual([
      expect.objectContaining({
        purpose: "release",
        keyId: "release-2026",
        publicKeyPem: "public-key-a",
        createdBy: "admin-1",
      }),
    ]);

    await store.disableTrustRoot("release", "release-2026", "admin-2");
    expect(await store.listTrustRoots()).toEqual([]);
    expect(await store.listTrustRoots(true)).toEqual([
      expect.objectContaining({ keyId: "release-2026", disabledBy: "admin-2" }),
    ]);
  });

  it("atomically accepts only one revocation update for an expected sequence", async () => {
    expect(await store.compareAndSwap(undefined, revocations(1))).toBe(true);

    const replicas = [
      store,
      new OimReleaseTrustStore(transactionPort(database)),
      new OimReleaseTrustStore(transactionPort(database)),
    ];
    const results = await Promise.all(
      replicas.map((replica) => replica.compareAndSwap(1, revocations(2)))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = (await store.load()) as ReturnType<typeof revocations>;
    expect(stored.list.sequence).toBe(2);
  });

  it("persists signed provenance and the original automatic-patch requirements", async () => {
    await store.putInstalledProvenance({
      businessId: "business-1",
      integrationId: "wiki",
      majorVersion: 2,
      version: "2.1.0",
      packageDigest: "a".repeat(64),
      source: "https://catalog.example/wiki-2.1.0.oim",
      trustClass: "official",
      signedRelease: { envelopeVersion: 1, signature: { keyId: "release-2026" } },
      originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
      autoPatchOptIn: true,
    });

    expect(await store.findInstalledProvenance("business-1", "wiki", 2)).toEqual(
      expect.objectContaining({
        trustClass: "official",
        packageDigest: "a".repeat(64),
        autoPatchOptIn: true,
        signedRelease: expect.objectContaining({ envelopeVersion: 1 }),
        originalRequirements: expect.objectContaining({
          metadata: { id: "wiki", version: "2.1.0" },
        }),
      })
    );

    await store.putInstalledProvenance({
      businessId: "business-1",
      integrationId: "wiki",
      majorVersion: 2,
      version: "2.1.1",
      packageDigest: "b".repeat(64),
      source: "https://catalog.example/wiki-2.1.1.oim",
      trustClass: "official",
      signedRelease: { envelopeVersion: 1, signature: { keyId: "release-2026" } },
      originalRequirements: { metadata: { id: "wiki", version: "2.1.1" } },
      autoPatchOptIn: false,
    });

    expect(await store.findInstalledProvenance("business-1", "wiki", 2)).toEqual(
      expect.objectContaining({
        version: "2.1.1",
        packageDigest: "b".repeat(64),
        autoPatchOptIn: false,
        originalRequirements: {
          metadata: { id: "wiki", version: "2.1.0" },
        },
      })
    );
  });

  it("refuses patch opt-in or missing digest approval for Community provenance", async () => {
    await expect(
      store.putInstalledProvenance({
        businessId: "business-1",
        integrationId: "wiki",
        majorVersion: 2,
        version: "2.1.0",
        packageDigest: "a".repeat(64),
        source: "https://community.example/wiki",
        trustClass: "community",
        originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
        autoPatchOptIn: true,
      })
    ).rejects.toThrow("community_oim_release_auto_patch_forbidden");

    await expect(
      store.putInstalledProvenance({
        businessId: "business-1",
        integrationId: "wiki",
        majorVersion: 2,
        version: "2.1.0",
        packageDigest: "a".repeat(64),
        source: "https://community.example/wiki",
        trustClass: "community",
        originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
        autoPatchOptIn: false,
      })
    ).rejects.toThrow("community_oim_release_digest_approval_required");
  });

  it("stores one operator-configured HTTPS revocation feed and preserves disable attribution", async () => {
    await expect(
      store.setRevocationFeed({
        url: "http://updates.example/revocations.json",
        updatedBy: "admin-1",
      })
    ).rejects.toThrow("invalid_oim_revocation_feed");

    await store.setRevocationFeed({
      url: "https://updates.example/revocations.json",
      updatedBy: "admin-1",
    });
    expect(await store.getRevocationFeed()).toEqual(
      expect.objectContaining({
        url: "https://updates.example/revocations.json",
        updatedBy: "admin-1",
      })
    );

    expect(await store.disableRevocationFeed("admin-2")).toBe(true);
    expect(await store.getRevocationFeed()).toBeNull();
    expect(await store.getRevocationFeed(true)).toEqual(
      expect.objectContaining({
        url: "https://updates.example/revocations.json",
        disabledBy: "admin-2",
      })
    );
  });

  it("defaults Official releases to automatic patch maintenance after migration 109", async () => {
    const inserted = await database.query<{ auto_patch_opt_in: boolean }>(
      `INSERT INTO oim_installed_release_provenance (
         business_id, integration_id, major_version, version, package_digest, source,
         trust_class, signed_release, original_requirements
       ) VALUES ($1, $2, $3, $4, $5, $6, 'official', $7::jsonb, $8::jsonb)
       RETURNING auto_patch_opt_in`,
      [
        "business-1",
        "wiki",
        2,
        "2.1.0",
        "a".repeat(64),
        "https://catalog.example/wiki/oim.yml",
        JSON.stringify({ envelopeVersion: 1 }),
        JSON.stringify({ metadata: { id: "wiki", version: "2.1.0" } }),
      ]
    );

    expect(inserted.rows[0]?.auto_patch_opt_in).toBe(true);
  });

  it("lists only enabled Official releases for automatic patch maintenance", async () => {
    await store.putInstalledProvenance({
      businessId: "business-1",
      integrationId: "wiki",
      majorVersion: 2,
      version: "2.1.0",
      packageDigest: "a".repeat(64),
      source: "https://catalog.example/wiki/oim.yml",
      trustClass: "official",
      signedRelease: { envelopeVersion: 1, signature: { keyId: "release-2026" } },
      originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
      autoPatchOptIn: true,
    });
    await store.putInstalledProvenance({
      businessId: "business-1",
      integrationId: "mail",
      majorVersion: 1,
      version: "1.0.0",
      packageDigest: "b".repeat(64),
      source: "https://catalog.example/mail/oim.yml",
      trustClass: "official",
      signedRelease: { envelopeVersion: 1, signature: { keyId: "release-2026" } },
      originalRequirements: { metadata: { id: "mail", version: "1.0.0" } },
      autoPatchOptIn: false,
    });

    expect(await store.listAutoPatchProvenance("business-1")).toEqual([
      expect.objectContaining({ integrationId: "wiki", autoPatchOptIn: true }),
    ]);
  });

  it("changes only the saved Official patch preference without replacing provenance", async () => {
    await store.putInstalledProvenance({
      businessId: "business-1",
      integrationId: "wiki",
      majorVersion: 2,
      version: "2.1.0",
      packageDigest: "a".repeat(64),
      source: "https://catalog.example/wiki/oim.yml",
      trustClass: "official",
      signedRelease: { envelopeVersion: 1, signature: { keyId: "release-2026" } },
      originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
      autoPatchOptIn: true,
    });

    await expect(
      store.setInstalledAutoPatchPreference("business-1", "wiki", 2, false)
    ).resolves.toEqual(
      expect.objectContaining({
        version: "2.1.0",
        packageDigest: "a".repeat(64),
        autoPatchOptIn: false,
      })
    );
    expect(await store.findInstalledProvenance("business-1", "wiki", 2)).toEqual(
      expect.objectContaining({
        signedRelease: { envelopeVersion: 1, signature: { keyId: "release-2026" } },
        originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
        autoPatchOptIn: false,
      })
    );
  });

  it("does not enable automatic patches for a Community release", async () => {
    await store.putInstalledProvenance({
      businessId: "business-1",
      integrationId: "wiki",
      majorVersion: 2,
      version: "2.1.0",
      packageDigest: "a".repeat(64),
      source: "https://community.example/wiki/oim.yml",
      trustClass: "community",
      approvedCommunityDigest: "a".repeat(64),
      originalRequirements: { metadata: { id: "wiki", version: "2.1.0" } },
      autoPatchOptIn: false,
    });

    await expect(
      store.setInstalledAutoPatchPreference("business-1", "wiki", 2, true)
    ).rejects.toThrow("community_oim_release_auto_patch_forbidden");
    expect(await store.findInstalledProvenance("business-1", "wiki", 2)).toEqual(
      expect.objectContaining({ trustClass: "community", autoPatchOptIn: false })
    );
  });
});
