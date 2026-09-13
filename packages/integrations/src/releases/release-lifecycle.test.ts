import { generateKeyPairSync } from "node:crypto";
import { oimPackageDigest } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import type {
  InstallSelectedOimReleaseDeps,
  OimReleaseInstallSnapshot,
  OimReleasePackageInstallReceipt,
} from "./installer";
import {
  type InstallOimReleaseFromSourceDeps,
  installOimReleaseFromSource,
} from "./release-lifecycle";
import { createEd25519OimReleaseSigner, signOimRelease, signOimRevocationList } from "./signatures";
import { releasePackageFixture } from "./test-fixtures";
import { createOimReleaseTrustService } from "./trust-service";

function trustFixture() {
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
  let revocations = signOimRevocationList(
    {
      sequence: 1,
      issuedAt: "2026-09-13T09:00:00.000Z",
      expiresAt: "2026-09-14T09:00:00.000Z",
      revocations: [],
    },
    revocationSigner
  );
  return {
    releaseSigner,
    revocationSigner,
    setRevocations(next: typeof revocations) {
      revocations = next;
    },
    trust: createOimReleaseTrustService({
      trustedReleaseKeys: [
        {
          keyId: "release-2026",
          publicKeyPem: releaseKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      ],
      trustedRevocationKeys: [
        {
          keyId: "revocations-2026",
          publicKeyPem: revocationKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      ],
      revocationStore: {
        load: async () => revocations,
        compareAndSwap: async () => true,
      },
      knownSignedReleaseStore: {
        isKnownSignedRelease: async () => false,
        recordKnownSignedRelease: async () => {},
      },
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    }),
  };
}

function durableDeps(
  deps: Omit<InstallOimReleaseFromSourceDeps, "operations" | "packageWriter"> & {
    readonly packageWriter: {
      install(input: {
        readonly businessId: string;
        readonly slug: string;
        readonly snapshot: OimReleaseInstallSnapshot;
      }): Promise<OimReleasePackageInstallReceipt>;
      rollback(receipt: OimReleasePackageInstallReceipt): Promise<{ readonly revision: string }>;
    };
  }
): InstallOimReleaseFromSourceDeps {
  let operation:
    | Awaited<ReturnType<InstallSelectedOimReleaseDeps["operations"]["beginAuthorized"]>>
    | undefined;
  let beginInput:
    | Parameters<InstallSelectedOimReleaseDeps["operations"]["beginAuthorized"]>[0]
    | undefined;
  return {
    ...deps,
    packageWriter: {
      ...deps.packageWriter,
      prepare: async (input) => input,
      apply: async (plan) =>
        deps.packageWriter.install(
          plan as {
            readonly businessId: string;
            readonly slug: string;
            readonly snapshot: OimReleaseInstallSnapshot;
          }
        ),
    },
    operations: {
      async beginAuthorized(input) {
        beginInput = input;
        operation = {
          operationId: "11111111-1111-4111-8111-111111111111",
          businessId: input.businessId,
          installationId: "22222222-2222-4222-8222-222222222222",
          integrationId: input.authorization.integrationId,
          majorVersion: Number(input.authorization.version.split(".")[0]),
          slug: input.slug,
          kind: input.kind,
          phase: "prepared",
          next: {
            version: input.authorization.version,
            packageDigest: input.authorization.packageDigest,
          },
          packageSnapshot: structuredClone(input.packageSnapshot),
          writePlan: null,
          writeReceipt: null,
          soulRevision: null,
        };
        return operation;
      },
      async get() {
        return operation ?? null;
      },
      async listPending() {
        return operation === undefined ? [] : [operation];
      },
      async recordPlan(_operationId, plan) {
        if (operation === undefined) throw new Error("operation_missing");
        operation = { ...operation, phase: "plan_recorded", writePlan: plan };
      },
      async recordSoulWrite(_operationId, receipt, soulRevision) {
        if (operation === undefined) throw new Error("operation_missing");
        operation = {
          ...operation,
          phase: "soul_written",
          writeReceipt: receipt,
          soulRevision,
        };
      },
      async commitProvenance() {
        if (
          operation === undefined ||
          beginInput === undefined ||
          operation.soulRevision === null
        ) {
          throw new Error("operation_missing");
        }
        const soulRevision = operation.soulRevision;
        await deps.provenance.recordInstalledProvenance({
          authorization: beginInput.authorization,
          businessId: beginInput.businessId,
          source: beginInput.source,
          slug: beginInput.slug,
          soulRevision,
          originalRequirements: beginInput.originalRequirements,
          autoPatchOptIn: beginInput.autoPatchOptIn,
        });
        operation = { ...operation, phase: "provenance_committed" };
        return {
          status: "updated",
          provenance: {
            businessId: operation.businessId,
            integrationId: operation.integrationId,
            majorVersion: operation.majorVersion,
            installationId: operation.installationId,
            version: operation.next.version,
            packageDigest: operation.next.packageDigest,
            source: beginInput.source,
            slug: operation.slug,
            soulRevision,
            trustClass: beginInput.authorization.trustClass,
            originalRequirements: beginInput.originalRequirements,
            autoPatchOptIn: beginInput.autoPatchOptIn,
            installedAt: "2026-09-13T00:00:00.000Z",
            updatedAt: "2026-09-13T00:00:00.000Z",
          },
        };
      },
      async markCompleted() {
        if (operation === undefined) throw new Error("operation_missing");
        operation = { ...operation, phase: "completed" };
      },
      async markRolledBack() {
        if (operation === undefined) throw new Error("operation_missing");
        operation = { ...operation, phase: "rolled_back" };
      },
      async requireReconciliation() {
        if (operation === undefined) throw new Error("operation_missing");
        operation = { ...operation, phase: "reconciliation_required" };
      },
      async resumeReconciliation() {
        if (operation === undefined) throw new Error("operation_missing");
        operation = {
          ...operation,
          phase: operation.writePlan === null ? "prepared" : "plan_recorded",
        };
        return operation;
      },
    },
  };
}

describe("installOimReleaseFromSource", () => {
  it("attaches authoritative signature evidence only to the exact selected candidate", async () => {
    const fixture = trustFixture();
    const target = releasePackageFixture();
    const unrelated = releasePackageFixture({ integrationId: "calendar" });
    const signedRelease = signOimRelease(target, fixture.releaseSigner);
    const install = vi.fn(async () => ({ revision: "soul-1", rollbackToken: "rollback-1" }));

    await expect(
      installOimReleaseFromSource(
        {
          actorId: "operator-1",
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/releases.git",
          trustClass: "official",
          selection: signedRelease.release,
          autoPatchOptIn: false,
        },
        durableDeps({
          inspectSource: async () => ({
            ref: "commit-1",
            candidates: [
              {
                sourcePath: "packages/calendar",
                package: unrelated,
                signedRelease: { malformed: true },
              },
              { sourcePath: "packages/weather", package: target, signedRelease },
            ],
          }),
          lifecycle: {
            runInstallExclusive: async (_scope, operation) => operation(),
          },
          trust: fixture.trust,
          packageWriter: {
            install,
            async rollback() {
              return { revision: "rollback" };
            },
          },
          provenance: {
            async recordInstalledProvenance() {},
            async recordRestoredSoulRevision() {},
          },
        })
      )
    ).resolves.toMatchObject({
      integrationId: "weather",
      sourceRef: "commit-1",
      candidatePath: "packages/weather",
    });

    expect(install).toHaveBeenCalledOnce();
  });

  it("persists the immutable inspected ref and selected package path", async () => {
    const fixture = trustFixture();
    const target = releasePackageFixture();
    const signedRelease = signOimRelease(target, fixture.releaseSigner);
    const recordInstalledProvenance = vi.fn(async () => {});
    let branchHead = "commit-a1b2c3";

    await installOimReleaseFromSource(
      {
        actorId: "operator-1",
        businessId: "business-1",
        slug: "weather-v1",
        source: "https://example.test/releases.git",
        trustClass: "official",
        selection: signedRelease.release,
        autoPatchOptIn: false,
      },
      durableDeps({
        inspectSource: async () => ({
          ref: branchHead,
          candidates: [{ sourcePath: "packages/weather", package: target, signedRelease }],
        }),
        lifecycle: {
          runInstallExclusive: async (_scope, operation) => {
            branchHead = "commit-moved";
            return operation();
          },
        },
        trust: fixture.trust,
        packageWriter: {
          async install() {
            return { revision: "soul-1", rollbackToken: "rollback-1" };
          },
          async rollback() {
            return { revision: "rollback" };
          },
        },
        provenance: {
          recordInstalledProvenance,
          async recordRestoredSoulRevision() {},
        },
      })
    );

    expect(recordInstalledProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "weather-v1",
        source: {
          kind: "git",
          repository: "https://example.test/releases.git",
          ref: "commit-a1b2c3",
          path: "packages/weather",
        },
        soulRevision: "soul-1",
      })
    );
  });

  it("does not let a signature for another package authorize the selected candidate", async () => {
    const fixture = trustFixture();
    const target = releasePackageFixture();
    const unrelated = releasePackageFixture({ integrationId: "calendar" });
    const wrongSignature = signOimRelease(unrelated, fixture.releaseSigner);
    const install = vi.fn();

    await expect(
      installOimReleaseFromSource(
        {
          actorId: "operator-1",
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/releases.git",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(target.manifest),
          },
          autoPatchOptIn: false,
        },
        durableDeps({
          inspectSource: async () => ({
            ref: "commit-1",
            candidates: [
              { sourcePath: "packages/weather", package: target },
              {
                sourcePath: "packages/calendar",
                package: unrelated,
                signedRelease: wrongSignature,
              },
            ],
          }),
          lifecycle: {
            runInstallExclusive: async (_scope, operation) => operation(),
          },
          trust: fixture.trust,
          packageWriter: {
            async install() {
              install();
              return { revision: "soul-1", rollbackToken: "rollback-1" };
            },
            async rollback() {
              return { revision: "rollback" };
            },
          },
          provenance: {
            async recordInstalledProvenance() {},
            async recordRestoredSoulRevision() {},
          },
        })
      )
    ).rejects.toMatchObject({ code: "RELEASE_ENVELOPE_INVALID" });
    expect(install).not.toHaveBeenCalled();
  });

  it("does not write while exact-major uninstall has fenced installation", async () => {
    const fixture = trustFixture();
    const target = releasePackageFixture();
    const install = vi.fn();

    await expect(
      installOimReleaseFromSource(
        {
          actorId: "operator-1",
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/releases.git",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(target.manifest),
          },
          autoPatchOptIn: false,
        },
        durableDeps({
          inspectSource: async () => ({
            ref: "commit-1",
            candidates: [
              {
                sourcePath: "packages/weather",
                package: target,
                signedRelease: signOimRelease(target, fixture.releaseSigner),
              },
            ],
          }),
          lifecycle: {
            async runInstallExclusive() {
              throw new Error("oim_uninstall_pending");
            },
          },
          trust: fixture.trust,
          packageWriter: {
            async install() {
              install();
              return { revision: "soul-1", rollbackToken: "rollback-1" };
            },
            async rollback() {
              return { revision: "rollback" };
            },
          },
          provenance: {
            async recordInstalledProvenance() {},
            async recordRestoredSoulRevision() {},
          },
        })
      )
    ).rejects.toThrow("oim_uninstall_pending");
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects a revoked release from an alternate candidate path without client signature data", async () => {
    const fixture = trustFixture();
    const target = releasePackageFixture();
    const signedRelease = signOimRelease(target, fixture.releaseSigner);
    fixture.setRevocations(
      signOimRevocationList(
        {
          sequence: 2,
          issuedAt: "2026-09-13T09:00:00.000Z",
          expiresAt: "2026-09-14T09:00:00.000Z",
          revocations: [{ ...signedRelease.release, reason: "Unsafe release" }],
        },
        fixture.revocationSigner
      )
    );
    const install = vi.fn();

    await expect(
      installOimReleaseFromSource(
        {
          actorId: "operator-1",
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://mirror.example.test/releases.git",
          trustClass: "community",
          selection: signedRelease.release,
          approvedCommunityDigest: signedRelease.release.packageDigest,
        },
        durableDeps({
          inspectSource: async () => ({
            ref: "mirror-commit",
            candidates: [{ sourcePath: "alternate/weather", package: target }],
          }),
          lifecycle: {
            runInstallExclusive: async (_scope, operation) => operation(),
          },
          trust: fixture.trust,
          packageWriter: {
            async install() {
              install();
              return { revision: "soul-1", rollbackToken: "rollback-1" };
            },
            async rollback() {
              return { revision: "rollback" };
            },
          },
          provenance: {
            async recordInstalledProvenance() {},
            async recordRestoredSoulRevision() {},
          },
        })
      )
    ).rejects.toMatchObject({ code: "OFFICIAL_RELEASE_REVOKED" });
    expect(install).not.toHaveBeenCalled();
  });
});
