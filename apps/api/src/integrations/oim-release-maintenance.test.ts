import { generateKeyPairSync } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EgressHttpPort } from "@tulipfarm/integrations";
import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import {
  createEd25519OimReleaseSigner,
  signOimRelease,
  signOimRevocationList,
} from "@tulipfarm/integrations/src/releases/signatures";
import type { OimPackageAuthorization } from "@tulipfarm/integrations/src/releases/trust-service";
import { oimPackageDigest } from "@tulipfarm/schema";
import { makeSoulWriterDouble, type SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { InstalledOimReleaseProvenance, OimTrustRoot } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import { serializeIntegrationLock, updateIntegrationFromSource } from "./install";
import { OimReleaseTrustHost, type OimReleaseTrustStorePort } from "./oim-release-compose";
import { OimReleaseMaintenanceWorker, runOimReleaseMaintenance } from "./oim-release-maintenance";

function manifest(version: string) {
  const fixture = knowledgeManifestFixture();
  return { ...fixture, metadata: { ...fixture.metadata, version } };
}

function provenance(current = manifest("2.1.0")): InstalledOimReleaseProvenance {
  const packageDigest = oimPackageDigest(current);
  return {
    businessId: "business-1",
    integrationId: current.metadata.id,
    majorVersion: 2,
    version: current.metadata.version,
    packageDigest,
    source: "https://catalog.example/wiki/oim.yml",
    trustClass: "official",
    signedRelease: {
      envelopeVersion: 1,
      release: {
        integrationId: current.metadata.id,
        version: current.metadata.version,
        packageDigest,
      },
      signature: { algorithm: "Ed25519", keyId: "release-2026", value: "current" },
    },
    originalRequirements: current,
    autoPatchOptIn: true,
    installedAt: "2026-09-07T06:00:00.000Z",
    updatedAt: "2026-09-07T06:00:00.000Z",
  };
}

function officialAuthorization(
  candidate = manifest("2.1.1")
): Extract<OimPackageAuthorization, { trustClass: "official" }> {
  const packageDigest = oimPackageDigest(candidate);
  return {
    trustClass: "official",
    integrationId: candidate.metadata.id,
    version: candidate.metadata.version,
    packageDigest,
    hooksAllowed: false,
    signerKeyId: "release-2026",
    revocationSequence: 2,
    signedRelease: {
      envelopeVersion: 1,
      release: {
        integrationId: candidate.metadata.id,
        version: candidate.metadata.version,
        packageDigest,
      },
      signature: { algorithm: "Ed25519", keyId: "release-2026", value: "candidate" },
    },
  };
}

function feed(candidate = manifest("2.1.1")) {
  const signedRelease = officialAuthorization(candidate).signedRelease;
  return {
    feedVersion: 1,
    revocations: {
      envelopeVersion: 1,
      list: {
        sequence: 2,
        issuedAt: "2026-09-07T07:00:00.000Z",
        expiresAt: "2026-09-08T07:00:00.000Z",
        revocations: [],
      },
      signature: { algorithm: "Ed25519", keyId: "revocations-2026", value: "revocations" },
    },
    releases: [
      {
        source: "https://catalog.example/wiki/oim.yml",
        ref: `sha256:${oimPackageDigest(candidate)}`,
        signedRelease,
      },
    ],
  };
}

function http(body: unknown): EgressHttpPort {
  return {
    async send() {
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    },
  };
}

function installed(current = manifest("2.1.0")): SoulIntegration {
  return {
    slug: "wiki",
    sourceIntegration: current.metadata.id,
    oimManifest: current,
    oimPackageFiles: {},
  };
}

describe("runOimReleaseMaintenance", () => {
  it("accepts the signed revocation feed before applying an authorized Official patch", async () => {
    const current = manifest("2.1.0");
    const candidate = manifest("2.1.1");
    const otherMajor = manifest("3.0.0");
    const accepted = vi.fn(async () => feed(candidate).revocations as never);
    const authorizeAutoPatch = vi.fn(async () => officialAuthorization(candidate));
    const applyPatch = vi.fn(async () => undefined);

    const result = await runOimReleaseMaintenance({
      actorId: "oim-release-maintenance",
      businessId: "business-1",
      http: http(feed(candidate)),
      integrations: () => [installed(current)],
      store: {
        getRevocationFeed: async () => ({
          url: "https://updates.example/oim-feed.json",
          updatedAt: "2026-09-07T06:00:00.000Z",
          updatedBy: "admin-1",
        }),
        listAutoPatchProvenance: async () => [provenance(current)],
        load: async () => undefined,
      },
      releaseTrust: { acceptRevocationList: accepted, authorizeAutoPatch },
      inspectSource: async () => ({
        source: "https://catalog.example/wiki/oim.yml",
        sourceType: "https",
        ref: `sha256:${oimPackageDigest(candidate)}`,
        integrations: [
          {
            name: candidate.metadata.id,
            oimManifest: candidate,
            companions: new Map(),
            packageDigest: oimPackageDigest(candidate),
            manifestPath: "oim.yml",
            issues: [],
          },
          {
            name: `${otherMajor.metadata.id}-v3`,
            oimManifest: otherMajor,
            companions: new Map(),
            packageDigest: oimPackageDigest(otherMajor),
            manifestPath: "oim.yml",
            issues: [],
          },
        ],
      }),
      applyPatch,
    });

    expect(accepted).toHaveBeenCalledBefore(authorizeAutoPatch);
    expect(authorizeAutoPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        optedIn: true,
        originalRequirements: current,
        current: expect.objectContaining({ signedRelease: provenance(current).signedRelease }),
        candidate: expect.objectContaining({
          signedRelease: feed(candidate).releases[0]?.signedRelease,
        }),
      })
    );
    expect(applyPatch).toHaveBeenCalledWith({
      source: "https://catalog.example/wiki/oim.yml",
      name: "wiki",
      ref: `sha256:${oimPackageDigest(candidate)}`,
      signedRelease: feed(candidate).releases[0]?.signedRelease,
    });
    expect(result.patches).toEqual([
      expect.objectContaining({ integrationId: current.metadata.id, status: "updated" }),
    ]);
  });

  it("does not call the installer when no signed envelope matches the inspected package", async () => {
    const current = manifest("2.1.0");
    const candidate = manifest("2.1.1");
    const document = { ...feed(candidate), releases: [] };
    const authorizeAutoPatch = vi.fn();
    const applyPatch = vi.fn();

    const result = await runOimReleaseMaintenance({
      actorId: "oim-release-maintenance",
      businessId: "business-1",
      http: http(document),
      integrations: () => [installed(current)],
      store: {
        getRevocationFeed: async () => ({
          url: "https://updates.example/oim-feed.json",
          updatedAt: "2026-09-07T06:00:00.000Z",
          updatedBy: "admin-1",
        }),
        listAutoPatchProvenance: async () => [provenance(current)],
        load: async () => undefined,
      },
      releaseTrust: {
        acceptRevocationList: async () => document.revocations as never,
        authorizeAutoPatch,
      },
      inspectSource: async () => ({
        source: "https://catalog.example/wiki/oim.yml",
        sourceType: "https",
        ref: `sha256:${oimPackageDigest(candidate)}`,
        integrations: [
          {
            name: candidate.metadata.id,
            oimManifest: candidate,
            companions: new Map(),
            packageDigest: oimPackageDigest(candidate),
            manifestPath: "oim.yml",
            issues: [],
          },
        ],
      }),
      applyPatch,
    });

    expect(authorizeAutoPatch).not.toHaveBeenCalled();
    expect(applyPatch).not.toHaveBeenCalled();
    expect(result.patches[0]).toMatchObject({
      status: "skipped",
      reason: "signed_release_missing",
    });
  });

  it("does not authorize or install a minor release as an automatic patch", async () => {
    const current = manifest("2.1.0");
    const candidate = manifest("2.2.0");
    const authorizeAutoPatch = vi.fn();
    const applyPatch = vi.fn();

    const result = await runOimReleaseMaintenance({
      actorId: "oim-release-maintenance",
      businessId: "business-1",
      http: http(feed(candidate)),
      integrations: () => [installed(current)],
      store: {
        getRevocationFeed: async () => ({
          url: "https://updates.example/oim-feed.json",
          updatedAt: "2026-09-07T06:00:00.000Z",
          updatedBy: "admin-1",
        }),
        listAutoPatchProvenance: async () => [provenance(current)],
        load: async () => undefined,
      },
      releaseTrust: {
        acceptRevocationList: async () => feed(candidate).revocations as never,
        authorizeAutoPatch,
      },
      inspectSource: async () => ({
        source: "https://catalog.example/wiki/oim.yml",
        sourceType: "https",
        ref: `sha256:${oimPackageDigest(candidate)}`,
        integrations: [
          {
            name: candidate.metadata.id,
            oimManifest: candidate,
            companions: new Map(),
            packageDigest: oimPackageDigest(candidate),
            manifestPath: "oim.yml",
            issues: [],
          },
        ],
      }),
      applyPatch,
    });

    expect(authorizeAutoPatch).not.toHaveBeenCalled();
    expect(applyPatch).not.toHaveBeenCalled();
    expect(result.patches[0]).toMatchObject({
      status: "skipped",
      reason: "no_eligible_patch",
    });
  });

  it("logs installer failures but not unchanged releases", async () => {
    const current = manifest("2.1.0");
    let candidate = manifest("2.1.1");
    const applyPatch = vi.fn(async () => {
      throw new Error("provenance persistence failed");
    });
    const log = { error: vi.fn() };
    const worker = new OimReleaseMaintenanceWorker(
      {
        actorId: "oim-release-maintenance",
        businessId: "business-1",
        http: {
          async send() {
            return { status: 200, headers: {}, body: JSON.stringify(feed(candidate)) };
          },
        },
        integrations: () => [installed(current)],
        store: {
          getRevocationFeed: async () => ({
            url: "https://updates.example/oim-feed.json",
            updatedAt: "2026-09-07T06:00:00.000Z",
            updatedBy: "admin-1",
          }),
          listAutoPatchProvenance: async () => [provenance(current)],
          load: async () => undefined,
        },
        releaseTrust: {
          acceptRevocationList: async () => feed(candidate).revocations as never,
          authorizeAutoPatch: async () => officialAuthorization(candidate),
        },
        inspectSource: async () => ({
          source: "https://catalog.example/wiki/oim.yml",
          sourceType: "https",
          ref: `sha256:${oimPackageDigest(candidate)}`,
          integrations: [
            {
              name: candidate.metadata.id,
              oimManifest: candidate,
              companions: new Map(),
              packageDigest: oimPackageDigest(candidate),
              manifestPath: "oim.yml",
              issues: [],
            },
          ],
        }),
        applyPatch,
      },
      log
    );

    await expect(worker.runOnce()).resolves.toEqual(
      expect.objectContaining({
        patches: [
          expect.objectContaining({
            status: "failed",
            reason: "provenance persistence failed",
          }),
        ],
      })
    );
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      "[oim-release-maintenance] wiki v2: provenance persistence failed"
    );

    candidate = current;
    await expect(worker.runOnce()).resolves.toEqual(
      expect.objectContaining({
        patches: [expect.objectContaining({ status: "skipped", reason: "no_eligible_patch" })],
      })
    );
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("composes through the installer without overwriting a preference changed during discovery", async () => {
    const now = new Date("2026-09-07T06:30:00.000Z");
    const current = manifest("2.1.0");
    const candidate = manifest("2.1.1");
    const currentPackage = { manifest: current, files: new Map<string, string>() };
    const candidatePackage = { manifest: candidate, files: new Map<string, string>() };
    const releaseKeys = generateKeyPairSync("ed25519");
    const revocationKeys = generateKeyPairSync("ed25519");
    const releaseSigner = createEd25519OimReleaseSigner(
      "release-2026",
      releaseKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    );
    const revocationSigner = createEd25519OimReleaseSigner(
      "revocations-2026",
      revocationKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    );
    const signedCurrent = signOimRelease(currentPackage, releaseSigner);
    const signedCandidate = signOimRelease(candidatePackage, releaseSigner);
    const currentRevocations = signOimRevocationList(
      {
        sequence: 1,
        issuedAt: "2026-09-07T05:00:00.000Z",
        expiresAt: "2026-09-08T05:00:00.000Z",
        revocations: [],
      },
      revocationSigner
    );
    const nextRevocations = signOimRevocationList(
      {
        sequence: 2,
        issuedAt: "2026-09-07T06:00:00.000Z",
        expiresAt: "2026-09-08T06:00:00.000Z",
        revocations: [],
      },
      revocationSigner
    );
    const source = "https://catalog.example/wiki/oim.yml";
    const feedUrl = "https://updates.example/oim-feed.json";
    const roots: readonly OimTrustRoot[] = [
      {
        purpose: "release",
        keyId: "release-2026",
        publicKeyPem: releaseKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        createdAt: now.toISOString(),
        createdBy: "admin-1",
      },
      {
        purpose: "revocation",
        keyId: "revocations-2026",
        publicKeyPem: revocationKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        createdAt: now.toISOString(),
        createdBy: "admin-1",
      },
    ];
    let storedRevocations: unknown = currentRevocations;
    const provenanceReads: boolean[] = [];
    let storedProvenance: InstalledOimReleaseProvenance = {
      businessId: DEPLOYMENT_BUSINESS_ID,
      integrationId: current.metadata.id,
      majorVersion: 2,
      version: current.metadata.version,
      packageDigest: oimPackageDigest(current),
      source,
      trustClass: "official",
      signedRelease: signedCurrent,
      originalRequirements: current,
      autoPatchOptIn: true,
      installedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const store: OimReleaseTrustStorePort = {
      addTrustRoot: async () => {
        throw new Error("not used");
      },
      compareAndSwap: async (_expected, next) => {
        storedRevocations = next;
        return true;
      },
      disableRevocationFeed: async () => false,
      disableTrustRoot: async () => null,
      findInstalledProvenance: async (businessId, integrationId, majorVersion) => {
        provenanceReads.push(storedProvenance.autoPatchOptIn);
        return businessId === storedProvenance.businessId &&
          integrationId === storedProvenance.integrationId &&
          majorVersion === storedProvenance.majorVersion
          ? storedProvenance
          : null;
      },
      getRevocationFeed: async () => ({
        url: feedUrl,
        updatedAt: now.toISOString(),
        updatedBy: "admin-1",
      }),
      listAutoPatchProvenance: async () => [storedProvenance],
      listTrustRoots: async () => roots,
      load: async () => storedRevocations,
      putInstalledProvenance: async (input) => {
        storedProvenance = {
          ...input,
          originalRequirements: storedProvenance.originalRequirements,
          installedAt: storedProvenance.installedAt,
          updatedAt: now.toISOString(),
        };
      },
      setInstalledAutoPatchPreference: async (businessId, integrationId, majorVersion, enabled) => {
        if (
          businessId !== storedProvenance.businessId ||
          integrationId !== storedProvenance.integrationId ||
          majorVersion !== storedProvenance.majorVersion
        ) {
          return null;
        }
        storedProvenance = { ...storedProvenance, autoPatchOptIn: enabled };
        return storedProvenance;
      },
      setRevocationFeed: async (input) => ({
        url: input.url,
        updatedAt: now.toISOString(),
        updatedBy: input.updatedBy,
      }),
    };
    const releaseTrust = new OimReleaseTrustHost(store, () => now);
    const integration: SoulIntegration = {
      slug: "wiki",
      sourceIntegration: current.metadata.id,
      oimManifest: current,
      oimPackageFiles: {},
    };
    class TestSoulLoader extends SoulLoader {
      constructor() {
        super(".", { info() {}, warn() {}, error() {} });
        this.integrations.set(integration.slug, integration);
      }

      override async reload(): Promise<void> {}
    }
    const soulLoader = new TestSoulLoader();
    const soulWriter = makeSoulWriterDouble();
    soulWriter.put(
      "IntegrationsLock",
      undefined,
      serializeIntegrationLock({
        version: 1,
        integrations: {
          wiki: {
            sourceUrl: source,
            sourceType: "https",
            manifestPath: "oim.yml",
            ref: `sha256:${oimPackageDigest(current)}`,
            hash: "0".repeat(64),
            definition: "oim",
            packageDigest: oimPackageDigest(current),
            integrationId: current.metadata.id,
            majorVersion: 2,
          },
        },
      })
    );
    const document = {
      feedVersion: 1,
      revocations: nextRevocations,
      releases: [
        {
          source,
          ref: `sha256:${oimPackageDigest(candidate)}`,
          signedRelease: signedCandidate,
        },
      ],
    };
    const network: EgressHttpPort = {
      async send(request) {
        if (request.url === feedUrl) {
          return { status: 200, headers: {}, body: JSON.stringify(document) };
        }
        if (request.url === source) {
          return { status: 200, headers: {}, body: stringifyYaml(candidate) };
        }
        return { status: 404, headers: {}, body: "" };
      },
    };

    const result = await runOimReleaseMaintenance({
      actorId: "system",
      businessId: DEPLOYMENT_BUSINESS_ID,
      http: network,
      integrations: () => soulLoader.integrations.values(),
      store,
      releaseTrust,
      applyPatch: async (input) => {
        await releaseTrust.setInstalledAutoPatchPreference(
          DEPLOYMENT_BUSINESS_ID,
          "wiki",
          2,
          false
        );
        return updateIntegrationFromSource(input, {
          soulLoader,
          soulWriter: soulWriter.writer,
          bundledSlugs: new Set(),
          actor: SYSTEM_SOUL_COMMIT_ACTOR,
          actorId: "system",
          http: network,
          releaseTrust,
        });
      },
    });

    expect(result.patches).toEqual([
      expect.objectContaining({ integrationId: "wiki", status: "updated" }),
    ]);
    expect(soulWriter.applied).toHaveLength(1);
    expect(provenanceReads).toEqual([false]);
    expect(storedProvenance).toMatchObject({
      version: "2.1.1",
      packageDigest: oimPackageDigest(candidate),
      signedRelease: signedCandidate,
      originalRequirements: current,
      autoPatchOptIn: false,
    });
  });
});
