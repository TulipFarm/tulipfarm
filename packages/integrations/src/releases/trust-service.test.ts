import { generateKeyPairSync } from "node:crypto";
import { oimFileDigest, oimPackageDigest } from "@tulipfarm/schema";
import type { InstalledOimReleaseProvenance } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { createEd25519OimReleaseSigner, signOimRelease, signOimRevocationList } from "./signatures";
import { releasePackageFixture } from "./test-fixtures";
import { createOimReleaseTrustService } from "./trust-service";

function signingKey(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function trustFixture() {
  const releaseKey = signingKey("release-2026");
  const revocationKey = signingKey("revocations-2026");
  const revocationSigner = createEd25519OimReleaseSigner(
    revocationKey.keyId,
    revocationKey.privateKeyPem
  );
  let state: unknown = signOimRevocationList(
    {
      sequence: 1,
      issuedAt: "2026-09-13T09:00:00.000Z",
      expiresAt: "2026-09-14T09:00:00.000Z",
      revocations: [],
    },
    revocationSigner
  );
  const store = {
    async load() {
      return state;
    },
    async compareAndSwap(expectedSequence: number | undefined, next: unknown) {
      const currentSequence =
        typeof state === "object" &&
        state !== null &&
        "list" in state &&
        typeof state.list === "object" &&
        state.list !== null &&
        "sequence" in state.list
          ? state.list.sequence
          : undefined;
      if (currentSequence !== expectedSequence) return false;
      state = next;
      return true;
    },
  };
  const knownSignedReleases = new Set<string>();
  const knownSignedReleaseStore = {
    async isKnownSignedRelease(identity: {
      integrationId: string;
      version: string;
      packageDigest: string;
    }) {
      return knownSignedReleases.has(
        `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`
      );
    },
    async recordKnownSignedRelease(identity: {
      integrationId: string;
      version: string;
      packageDigest: string;
    }) {
      knownSignedReleases.add(
        `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`
      );
    },
  };
  return {
    releaseKey,
    releaseSigner: createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem),
    revocationKey,
    revocationSigner,
    store,
    knownSignedReleaseStore,
    setState(next: unknown) {
      state = next;
    },
  };
}

function provenance(
  package_: ReturnType<typeof releasePackageFixture>,
  overrides: Partial<InstalledOimReleaseProvenance> = {}
): InstalledOimReleaseProvenance {
  return {
    businessId: "business-1",
    integrationId: package_.manifest.metadata.id,
    majorVersion: Number(package_.manifest.metadata.version.split(".")[0]),
    version: package_.manifest.metadata.version,
    packageDigest: oimPackageDigest(package_.manifest),
    source: {
      kind: "git",
      repository: "https://catalog.example/releases.json",
      ref: "commit-a1b2c3",
      path: "packages/weather",
    },
    slug: "weather-v1",
    soulRevision: "soul-a1b2c3",
    trustClass: "official",
    signedRelease: {},
    originalRequirements: package_.manifest,
    autoPatchOptIn: true,
    installedAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    ...overrides,
  };
}

function hookPackageFixture() {
  const package_ = releasePackageFixture({
    files: { "normalize.js": "export default () => {};\n" },
  });
  return {
    ...package_,
    manifest: {
      ...package_.manifest,
      profiles: { ...package_.manifest.profiles, hooks: "1.0" as const },
      files: [
        {
          path: "normalize.js",
          role: "hook" as const,
          sha256: oimFileDigest("export default () => {};\n"),
        },
      ],
      hooks: [
        {
          kind: "response_normalize" as const,
          file: "normalize.js",
          export: "default",
        },
      ],
    },
  };
}

describe("createOimReleaseTrustService", () => {
  it("authorizes exactly the selected official candidate without inspecting unrelated packages", async () => {
    const fixture = trustFixture();
    const target = releasePackageFixture();
    const unrelated = releasePackageFixture({ integrationId: "calendar" });
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.authorizeSelectedOfficialRelease({
        selection: {
          integrationId: target.manifest.metadata.id,
          version: target.manifest.metadata.version,
          packageDigest: oimPackageDigest(target.manifest),
        },
        candidates: [
          { package: unrelated, signedRelease: { malformed: true } },
          { package: target, signedRelease: signOimRelease(target, fixture.releaseSigner) },
        ],
      })
    ).resolves.toMatchObject({
      trustClass: "official",
      integrationId: "weather",
      version: "1.2.3",
    });
  });

  it("denies an exact revoked official identity and fails closed on expired state", async () => {
    const fixture = trustFixture();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(package_, fixture.releaseSigner);
    fixture.setState(
      signOimRevocationList(
        {
          sequence: 2,
          issuedAt: "2026-09-13T10:00:00.000Z",
          expiresAt: "2026-09-13T13:00:00.000Z",
          revocations: [
            {
              ...signedRelease.release,
              packageDigest: "0".repeat(64),
              reason: "Unsafe release",
            },
          ],
        },
        fixture.revocationSigner
      )
    );
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.authorizeOfficialRelease({ package: package_, signedRelease })
    ).resolves.toMatchObject({ integrationId: "weather" });

    fixture.setState(
      signOimRevocationList(
        {
          sequence: 3,
          issuedAt: "2026-09-13T10:30:00.000Z",
          expiresAt: "2026-09-13T13:00:00.000Z",
          revocations: [{ ...signedRelease.release, reason: "Unsafe release" }],
        },
        fixture.revocationSigner
      )
    );

    await expect(
      service.authorizeOfficialRelease({ package: package_, signedRelease })
    ).rejects.toMatchObject({ code: "OFFICIAL_RELEASE_REVOKED" });

    fixture.setState(
      signOimRevocationList(
        {
          sequence: 4,
          issuedAt: "2026-09-13T10:00:00.000Z",
          expiresAt: "2026-09-13T11:00:00.000Z",
          revocations: [],
        },
        fixture.revocationSigner
      )
    );
    await expect(
      service.authorizeInstalledRelease({
        package: package_,
        provenance: provenance(package_, { signedRelease }),
      })
    ).rejects.toMatchObject({ code: "REVOCATION_EXPIRED" });
  });

  it("requires an exact digest and forbids Hooks and auto-patch for community releases", async () => {
    const fixture = trustFixture();
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [],
      trustedRevocationKeys: [],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
    });

    const package_ = releasePackageFixture();

    await expect(
      service.authorizeCommunityRelease({
        package: package_,
        approvedPackageDigest: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "COMMUNITY_DIGEST_REQUIRED" });
    await expect(
      service.authorizeCommunityRelease({
        package: package_,
        approvedPackageDigest: oimPackageDigest(package_.manifest),
        autoPatchOptIn: true,
      })
    ).rejects.toMatchObject({ code: "COMMUNITY_AUTO_PATCH_FORBIDDEN" });
    await expect(
      service.authorizeCommunityRelease({
        package: hookPackageFixture(),
        approvedPackageDigest: oimPackageDigest(hookPackageFixture().manifest),
      })
    ).rejects.toMatchObject({ code: "COMMUNITY_HOOKS_FORBIDDEN" });
  });

  it("does not authorize an exact revoked release as Community when its signature is omitted", async () => {
    const fixture = trustFixture();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(package_, fixture.releaseSigner);
    fixture.setState(
      signOimRevocationList(
        {
          sequence: 2,
          issuedAt: "2026-09-13T10:00:00.000Z",
          expiresAt: "2026-09-13T13:00:00.000Z",
          revocations: [{ ...signedRelease.release, reason: "Unsafe release" }],
        },
        fixture.revocationSigner
      )
    );
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.authorizeCommunityRelease({
        package: package_,
        approvedPackageDigest: oimPackageDigest(package_.manifest),
      })
    ).rejects.toMatchObject({ code: "OFFICIAL_RELEASE_REVOKED" });
  });

  it("does not authorize a server-known signed release as Community when its signature is omitted", async () => {
    const fixture = trustFixture();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(package_, fixture.releaseSigner);
    const knownSignedReleaseStore = {
      isKnownSignedRelease: async () => true,
      recordKnownSignedRelease: async () => {},
    };
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await service.recordKnownSignedRelease(signedRelease);
    await expect(
      service.authorizeCommunityRelease({
        package: package_,
        approvedPackageDigest: oimPackageDigest(package_.manifest),
      })
    ).rejects.toMatchObject({ code: "COMMUNITY_OFFICIAL_RELEASE" });
  });

  it("does not remember unverified signed-release metadata", async () => {
    const fixture = trustFixture();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(package_, fixture.releaseSigner);
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.recordKnownSignedRelease({
        ...signedRelease,
        signature: { ...signedRelease.signature, value: `${"A".repeat(86)}==` },
      })
    ).rejects.toThrow();
    await expect(
      fixture.knownSignedReleaseStore.isKnownSignedRelease(signedRelease.release)
    ).resolves.toBe(false);
  });

  it("applies only monotonic, non-removing, current revocation updates", async () => {
    const fixture = trustFixture();
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    const revoked = {
      integrationId: "weather",
      version: "1.2.3",
      packageDigest: "a".repeat(64),
      reason: "Unsafe release",
    };
    const update = (
      sequence: number,
      issuedAt: string,
      expiresAt = "2026-09-14T12:00:00.000Z",
      entries = [revoked]
    ) =>
      signOimRevocationList(
        { sequence, issuedAt, expiresAt, revocations: entries },
        fixture.revocationSigner
      );

    await expect(
      service.updateRevocationList(update(2, "2026-09-13T10:00:00.000Z"))
    ).resolves.toMatchObject({ sequence: 2 });
    await expect(
      service.updateRevocationList(update(2, "2026-09-13T10:30:00.000Z"))
    ).rejects.toMatchObject({ code: "REVOCATION_REPLAY" });
    await expect(
      service.updateRevocationList(update(1, "2026-09-13T10:30:00.000Z"))
    ).rejects.toMatchObject({ code: "REVOCATION_ROLLBACK" });
    await expect(
      service.updateRevocationList(update(3, "2026-09-13T09:30:00.000Z"))
    ).rejects.toMatchObject({ code: "REVOCATION_STALE" });
    await expect(
      service.updateRevocationList(update(3, "2026-09-13T10:30:00.000Z", undefined, []))
    ).rejects.toMatchObject({ code: "REVOCATION_REMOVAL" });
    await expect(
      service.updateRevocationList(
        update(3, "2026-09-13T10:30:00.000Z", "2026-09-13T11:00:00.000Z")
      )
    ).rejects.toMatchObject({ code: "REVOCATION_EXPIRED" });
  });

  it("bounds compare-and-swap retries", async () => {
    const fixture = trustFixture();
    let attempts = 0;
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: {
        load: fixture.store.load,
        async compareAndSwap() {
          attempts += 1;
          return false;
        },
      },
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
      maxRevocationUpdateAttempts: 2,
    });
    const update = signOimRevocationList(
      {
        sequence: 2,
        issuedAt: "2026-09-13T10:00:00.000Z",
        expiresAt: "2026-09-14T10:00:00.000Z",
        revocations: [],
      },
      fixture.revocationSigner
    );

    await expect(service.updateRevocationList(update)).rejects.toMatchObject({
      code: "REVOCATION_CAS_EXHAUSTED",
    });
    expect(attempts).toBe(2);
  });

  it("rejects installed provenance with the wrong major-version identity", async () => {
    const fixture = trustFixture();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(package_, fixture.releaseSigner);
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.authorizeInstalledRelease({
        package: package_,
        provenance: provenance(package_, { majorVersion: 9, signedRelease }),
      })
    ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
  });

  it("auto-patches only opted-in official newer compatible patches", async () => {
    const fixture = trustFixture();
    const currentPackage = releasePackageFixture({ version: "1.2.3" });
    const nextPackage = releasePackageFixture({ version: "1.2.4" });
    const signedCurrent = signOimRelease(currentPackage, fixture.releaseSigner);
    const signedNext = signOimRelease(nextPackage, fixture.releaseSigner);
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.selectAutoPatch({
        provenance: provenance(currentPackage, { signedRelease: signedCurrent }),
        originalManifest: currentPackage.manifest,
        currentPackage,
        selection: {
          integrationId: nextPackage.manifest.metadata.id,
          version: nextPackage.manifest.metadata.version,
          packageDigest: oimPackageDigest(nextPackage.manifest),
        },
        candidates: [
          {
            package: releasePackageFixture({ integrationId: "calendar" }),
            signedRelease: { malformed: true },
          },
          { package: nextPackage, signedRelease: signedNext },
        ],
      })
    ).resolves.toMatchObject({ version: "1.2.4", trustClass: "official" });
  });

  it("can replace a revoked current release with a non-revoked signed patch", async () => {
    const fixture = trustFixture();
    const currentPackage = releasePackageFixture({ version: "1.2.3" });
    const nextPackage = releasePackageFixture({ version: "1.2.4" });
    const signedCurrent = signOimRelease(currentPackage, fixture.releaseSigner);
    const signedNext = signOimRelease(nextPackage, fixture.releaseSigner);
    fixture.setState(
      signOimRevocationList(
        {
          sequence: 2,
          issuedAt: "2026-09-13T10:00:00.000Z",
          expiresAt: "2026-09-13T13:00:00.000Z",
          revocations: [{ ...signedCurrent.release, reason: "Unsafe release" }],
        },
        fixture.revocationSigner
      )
    );
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.selectAutoPatch({
        provenance: provenance(currentPackage, { signedRelease: signedCurrent }),
        originalManifest: currentPackage.manifest,
        currentPackage,
        selection: signedNext.release,
        candidates: [{ package: nextPackage, signedRelease: signedNext }],
      })
    ).resolves.toMatchObject({ version: "1.2.4", trustClass: "official" });
  });

  it("rejects an official patch incompatible with the original or current manifest", async () => {
    const fixture = trustFixture();
    const currentPackage = releasePackageFixture({ version: "1.2.3" });
    const incompatibleBase = releasePackageFixture({ version: "1.2.4" });
    const incompatiblePackage = {
      ...incompatibleBase,
      manifest: {
        ...incompatibleBase.manifest,
        operations: [
          {
            ...incompatibleBase.manifest.operations[0],
            id: "replacement-operation",
            name: "replacement_operation",
          },
        ],
      },
    };
    const signedCurrent = signOimRelease(currentPackage, fixture.releaseSigner);
    const service = createOimReleaseTrustService({
      trustedReleaseKeys: [
        { keyId: fixture.releaseKey.keyId, publicKeyPem: fixture.releaseKey.publicKeyPem },
      ],
      trustedRevocationKeys: [
        { keyId: fixture.revocationKey.keyId, publicKeyPem: fixture.revocationKey.publicKeyPem },
      ],
      revocationStore: fixture.store,
      knownSignedReleaseStore: fixture.knownSignedReleaseStore,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });

    await expect(
      service.selectAutoPatch({
        provenance: provenance(currentPackage, { signedRelease: signedCurrent }),
        originalManifest: currentPackage.manifest,
        currentPackage,
        selection: {
          integrationId: incompatiblePackage.manifest.metadata.id,
          version: incompatiblePackage.manifest.metadata.version,
          packageDigest: oimPackageDigest(incompatiblePackage.manifest),
        },
        candidates: [
          {
            package: incompatiblePackage,
            signedRelease: signOimRelease(incompatiblePackage, fixture.releaseSigner),
          },
        ],
      })
    ).rejects.toMatchObject({ code: "AUTO_PATCH_INCOMPATIBLE" });
  });
});
