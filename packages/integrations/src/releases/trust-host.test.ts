import { generateKeyPairSync } from "node:crypto";
import { oimPackageDigest } from "@tulipfarm/schema";
import type {
  AddOimTrustRootInput,
  InstalledOimReleaseProvenance,
  OimRevocationFeed,
  OimTrustRoot,
  PutInstalledOimReleaseProvenanceInput,
  SetOimRevocationFeedInput,
} from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { createEd25519OimReleaseSigner, signOimRelease, signOimRevocationList } from "./signatures";
import { releasePackageFixture } from "./test-fixtures";
import { createOimReleaseTrustHost } from "./trust-host";

function signingKey(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

class MemoryTrustStore {
  roots: OimTrustRoot[] = [];
  revocations: unknown;
  provenance: InstalledOimReleaseProvenance | null = null;
  feed: OimRevocationFeed | null = null;
  knownSignedReleases = new Set<string>();

  async listTrustRoots() {
    return this.roots.filter((root) => root.disabledAt === undefined);
  }

  async addTrustRoot(input: AddOimTrustRootInput) {
    const root = {
      ...input,
      createdAt: "2026-09-13T09:00:00.000Z",
    };
    this.roots.push(root);
    return root;
  }

  async disableTrustRoot() {
    return null;
  }

  async load() {
    return this.revocations;
  }

  async compareAndSwap(expectedSequence: number | undefined, next: unknown) {
    const current =
      typeof this.revocations === "object" &&
      this.revocations !== null &&
      "list" in this.revocations &&
      typeof this.revocations.list === "object" &&
      this.revocations.list !== null &&
      "sequence" in this.revocations.list
        ? this.revocations.list.sequence
        : undefined;
    if (current !== expectedSequence) return false;
    this.revocations = next;
    return true;
  }

  async isKnownSignedRelease(identity: {
    integrationId: string;
    version: string;
    packageDigest: string;
  }) {
    return this.knownSignedReleases.has(
      `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`
    );
  }

  async recordKnownSignedRelease(identity: {
    integrationId: string;
    version: string;
    packageDigest: string;
  }) {
    this.knownSignedReleases.add(
      `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`
    );
  }

  async getRevocationFeed() {
    return this.feed;
  }

  async setRevocationFeed(input: SetOimRevocationFeedInput) {
    this.feed = {
      url: input.url,
      updatedAt: "2026-09-13T09:00:00.000Z",
      updatedBy: input.updatedBy,
    };
    return this.feed;
  }

  async disableRevocationFeed() {
    this.feed = null;
    return true;
  }

  async putInstalledProvenance(input: PutInstalledOimReleaseProvenanceInput) {
    this.provenance = {
      ...input,
      installedAt: "2026-09-13T09:00:00.000Z",
      updatedAt: "2026-09-13T09:00:00.000Z",
    };
  }

  async updateRestoredSoulRevision(input: { soulRevision: string }) {
    if (this.provenance === null) throw new Error("missing provenance");
    this.provenance = { ...this.provenance, soulRevision: input.soulRevision };
  }

  async findInstalledProvenance() {
    return this.provenance;
  }

  async listAutoPatchProvenance() {
    return this.provenance?.autoPatchOptIn ? [this.provenance] : [];
  }

  async setInstalledAutoPatchPreference(
    _businessId: string,
    _integrationId: string,
    _majorVersion: number,
    enabled: boolean
  ) {
    if (this.provenance === null) return null;
    this.provenance = { ...this.provenance, autoPatchOptIn: enabled };
    return this.provenance;
  }
}

describe("createOimReleaseTrustHost", () => {
  it("records verified provenance and rejects later package substitution", async () => {
    const releaseKey = signingKey("release-2026");
    const revocationKey = signingKey("revocations-2026");
    const releaseSigner = createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem);
    const store = new MemoryTrustStore();
    store.roots = [
      {
        purpose: "release",
        keyId: releaseKey.keyId,
        publicKeyPem: releaseKey.publicKeyPem,
        createdAt: "2026-09-13T09:00:00.000Z",
        createdBy: "operator",
      },
      {
        purpose: "revocation",
        keyId: revocationKey.keyId,
        publicKeyPem: revocationKey.publicKeyPem,
        createdAt: "2026-09-13T09:00:00.000Z",
        createdBy: "operator",
      },
    ];
    store.revocations = signOimRevocationList(
      {
        sequence: 1,
        issuedAt: "2026-09-13T09:00:00.000Z",
        expiresAt: "2026-09-14T09:00:00.000Z",
        revocations: [],
      },
      createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
    );
    const host = createOimReleaseTrustHost(store, {
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    const package_ = releasePackageFixture();
    const authorization = await host.authorizeSelectedOfficialRelease({
      selection: {
        integrationId: package_.manifest.metadata.id,
        version: package_.manifest.metadata.version,
        packageDigest: oimPackageDigest(package_.manifest),
      },
      candidates: [
        {
          package: package_,
          signedRelease: signOimRelease(package_, releaseSigner),
        },
      ],
    });
    await host.recordInstalledProvenance({
      authorization,
      businessId: "business-1",
      source: {
        kind: "git",
        repository: "https://catalog.example/releases.json",
        ref: "commit-a1b2c3",
        path: "packages/weather",
      },
      slug: "weather-v1",
      soulRevision: "soul-a1b2c3",
      originalRequirements: package_.manifest,
      autoPatchOptIn: true,
    });
    const substituted = {
      ...package_,
      manifest: {
        ...package_.manifest,
        metadata: {
          ...package_.manifest.metadata,
          description: "Substituted bytes.",
        },
      },
    };

    await expect(
      host.authorizeInstalledRelease({
        businessId: "business-1",
        integrationId: "weather",
        majorVersion: 1,
        package: substituted,
      })
    ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });
  });

  it("validates added roots and resolves active roots and feed configuration dynamically", async () => {
    const releaseKey = signingKey("release-2026");
    const revocationKey = signingKey("revocations-2026");
    const store = new MemoryTrustStore();
    store.roots = [
      {
        purpose: "release",
        keyId: releaseKey.keyId,
        publicKeyPem: releaseKey.publicKeyPem,
        createdAt: "2026-09-13T09:00:00.000Z",
        createdBy: "operator",
      },
      {
        purpose: "revocation",
        keyId: revocationKey.keyId,
        publicKeyPem: revocationKey.publicKeyPem,
        createdAt: "2026-09-13T09:00:00.000Z",
        createdBy: "operator",
      },
    ];
    store.revocations = signOimRevocationList(
      {
        sequence: 1,
        issuedAt: "2026-09-13T09:00:00.000Z",
        expiresAt: "2026-09-14T09:00:00.000Z",
        revocations: [],
      },
      createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
    );
    const host = createOimReleaseTrustHost(store, {
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );

    await expect(
      host.setRevocationFeed({
        url: "https://catalog.example/revocations.json",
        updatedBy: "operator",
      })
    ).resolves.toMatchObject({ url: "https://catalog.example/revocations.json" });
    await expect(host.getRevocationFeed()).resolves.toMatchObject({
      url: "https://catalog.example/revocations.json",
    });

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      host.addTrustRoot({
        purpose: "release",
        keyId: "invalid-rsa",
        publicKeyPem: rsa.publicKey.export({ format: "pem", type: "spki" }).toString(),
        createdBy: "operator",
      })
    ).rejects.toMatchObject({ code: "TRUSTED_KEY_INVALID" });

    const authorization = await host.authorizeSelectedOfficialRelease({
      selection: signedRelease.release,
      candidates: [{ package: package_, signedRelease }],
    });
    await expect(
      host.recordInstalledProvenance({
        authorization,
        businessId: "business-1",
        source: {
          kind: "git",
          repository: "https://catalog.example/releases.json",
          ref: "commit-a1b2c3",
          path: "packages/weather",
        },
        slug: "weather-v1",
        soulRevision: "soul-a1b2c3",
        originalRequirements: package_.manifest,
        autoPatchOptIn: true,
      })
    ).resolves.toBeUndefined();
    expect(store.provenance).toMatchObject({
      integrationId: "weather",
      packageDigest: signedRelease.release.packageDigest,
      trustClass: "official",
    });
    await expect(
      host.recordInstalledProvenance({
        authorization,
        businessId: "business-1",
        source: {
          kind: "git",
          repository: "https://catalog.example/releases.json",
          ref: "commit-a1b2c3",
          path: "packages/weather",
        },
        slug: "weather-v1",
        soulRevision: "soul-a1b2c3",
        originalRequirements: releasePackageFixture({ integrationId: "calendar" }).manifest,
        autoPatchOptIn: true,
      })
    ).rejects.toMatchObject({ code: "PROVENANCE_MISMATCH" });

    store.roots = store.roots.filter((root) => root.purpose !== "release");
    await expect(
      host.authorizeSelectedOfficialRelease({
        selection: signedRelease.release,
        candidates: [{ package: package_, signedRelease }],
      })
    ).rejects.toMatchObject({ code: "RELEASE_SIGNER_UNKNOWN" });
  });
});
