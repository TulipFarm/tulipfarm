import { createHash, generateKeyPairSync } from "node:crypto";
import { oimPackageDigest } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import {
  type InstallSelectedOimReleaseDeps,
  installReviewedCommunityOimRelease,
  installSelectedOimRelease,
  type OimReleaseInstallSnapshot,
  type OimReleasePackageInstallReceipt,
  reconcileOimReleaseOperations,
} from "./installer";
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

function trustService() {
  const releaseKey = signingKey("release-2026");
  const revocationKey = signingKey("revocations-2026");
  const revocations = signOimRevocationList(
    {
      sequence: 1,
      issuedAt: "2026-09-13T00:00:00.000Z",
      expiresAt: "2026-09-15T00:00:00.000Z",
      revocations: [],
    },
    createEd25519OimReleaseSigner(revocationKey.keyId, revocationKey.privateKeyPem)
  );
  const knownSignedReleases = new Set<string>();
  return {
    releaseKey,
    service: createOimReleaseTrustService({
      trustedReleaseKeys: [{ keyId: releaseKey.keyId, publicKeyPem: releaseKey.publicKeyPem }],
      trustedRevocationKeys: [
        { keyId: revocationKey.keyId, publicKeyPem: revocationKey.publicKeyPem },
      ],
      revocationStore: {
        load: async () => revocations,
        compareAndSwap: async () => true,
      },
      knownSignedReleaseStore: {
        isKnownSignedRelease: async (identity) =>
          knownSignedReleases.has(
            `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`
          ),
        recordKnownSignedRelease: async (identity) => {
          knownSignedReleases.add(
            `${identity.integrationId}\n${identity.version}\n${identity.packageDigest}`
          );
        },
      },
      now: () => new Date("2026-09-14T00:00:00.000Z"),
    }),
  };
}

function authoredDraftSource() {
  return {
    kind: "authored_draft" as const,
    reviewId: "review-1",
    reviewedAt: "2026-09-13T08:00:00.000Z",
    reviewedBy: {
      businessId: "business-1",
      principal: { kind: "user", id: "user-1" },
    },
    runId: "run-1",
  };
}

function reviewedDraft(
  package_: ReturnType<typeof releasePackageFixture>,
  overrides: Record<string, unknown> = {}
) {
  return {
    slug: "weather-v1",
    package: package_,
    source: authoredDraftSource(),
    ...overrides,
  };
}

function durableDeps(
  deps: Omit<InstallSelectedOimReleaseDeps, "operations" | "packageWriter"> & {
    readonly packageWriter: {
      install(input: {
        readonly businessId: string;
        readonly slug: string;
        readonly snapshot: OimReleaseInstallSnapshot;
      }): Promise<OimReleasePackageInstallReceipt>;
      rollback(receipt: OimReleasePackageInstallReceipt): Promise<{
        readonly revision: string;
        readonly restored?: {
          readonly integrationId: string;
          readonly version: string;
          readonly majorVersion: number;
          readonly packageDigest: string;
        };
      }>;
    };
  }
): InstallSelectedOimReleaseDeps {
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
          installationId:
            input.kind === "patch"
              ? (input.expected?.installationId as string)
              : "22222222-2222-4222-8222-222222222222",
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

describe("installSelectedOimRelease", () => {
  it("installs reviewed Community bytes with explicit authored provenance", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const recorded: unknown[] = [];
    const consume = vi.fn(async () =>
      reviewedDraft(package_, {
        source: {
          ...authoredDraftSource(),
          runId: "run-1",
          toolCallId: "call-1",
        },
      })
    );

    await expect(
      installReviewedCommunityOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          approvedPackageDigest: oimPackageDigest(package_.manifest),
          principal: { kind: "user", id: "user-1" },
          runId: "run-1",
          replace: false,
        },
        {
          ...durableDeps({
            trust: service,
            packageWriter: {
              async install() {
                return { revision: "soul-1", rollbackToken: "rollback-1" };
              },
              async rollback() {
                return { revision: "rollback" };
              },
            },
            provenance: {
              async recordInstalledProvenance(input) {
                recorded.push(input);
              },
              async recordRestoredSoulRevision() {},
            },
          }),
          reviewedDrafts: { consume },
        }
      )
    ).resolves.toMatchObject({
      integrationId: "weather",
      trustClass: "community",
      revision: "soul-1",
    });
    expect(recorded).toEqual([
      expect.objectContaining({
        source: {
          kind: "authored_draft",
          reviewId: "review-1",
          reviewedAt: "2026-09-13T08:00:00.000Z",
          reviewedBy: {
            businessId: "business-1",
            principal: { kind: "user", id: "user-1" },
          },
          runId: "run-1",
          toolCallId: "call-1",
        },
      }),
    ]);
    expect(consume).toHaveBeenCalledWith({
      businessId: "business-1",
      approvedPackageDigest: oimPackageDigest(package_.manifest),
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
    });
  });

  it("recovers a consumed reviewed draft from the durable package snapshot", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const consume = vi.fn(async () => reviewedDraft(package_));
    const install = vi.fn(async () => ({
      revision: "soul-1",
      rollbackToken: "rollback-1",
    }));
    const base = durableDeps({
      trust: service,
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
    });
    let interrupted = true;
    const deps = {
      ...base,
      packageWriter: {
        ...base.packageWriter,
        async prepare(input: Parameters<typeof base.packageWriter.prepare>[0]) {
          if (interrupted) {
            interrupted = false;
            throw new Error("process_stopped");
          }
          return input;
        },
      },
      reviewedDrafts: { consume },
    };

    await expect(
      installReviewedCommunityOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          approvedPackageDigest: oimPackageDigest(package_.manifest),
          principal: { kind: "user", id: "user-1" },
          runId: "run-1",
          replace: false,
        },
        deps
      )
    ).rejects.toThrow("process_stopped");

    await reconcileOimReleaseOperations(deps);

    expect(consume).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          packageDigest: oimPackageDigest(package_.manifest),
        }),
      })
    );
  });

  it("rejects an unavailable reviewed draft before starting an operation", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const deps = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          return { revision: "unexpected", rollbackToken: "unexpected" };
        },
        async rollback() {
          return { revision: "rollback" };
        },
      },
      provenance: {
        async recordInstalledProvenance() {},
        async recordRestoredSoulRevision() {},
      },
    });
    const begin = vi.spyOn(deps.operations, "beginAuthorized");

    await expect(
      installReviewedCommunityOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          approvedPackageDigest: oimPackageDigest(package_.manifest),
          principal: { kind: "user", id: "user-1" },
          runId: "run-1",
          replace: false,
        },
        {
          ...deps,
          reviewedDrafts: {
            async consume() {
              return null;
            },
          },
        }
      )
    ).rejects.toMatchObject({ code: "REVIEWED_COMMUNITY_DRAFT_UNAVAILABLE" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("rejects reviewed Community bytes that do not match the approved digest", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const write = vi.fn();

    await expect(
      installReviewedCommunityOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          approvedPackageDigest: "f".repeat(64),
          principal: { kind: "user", id: "user-1" },
          runId: "run-1",
          replace: false,
        },
        {
          ...durableDeps({
            trust: service,
            packageWriter: {
              async install() {
                write();
                return { revision: "unexpected", rollbackToken: "unexpected" };
              },
              async rollback() {
                return { revision: "rollback" };
              },
            },
            provenance: {
              async recordInstalledProvenance() {},
              async recordRestoredSoulRevision() {},
            },
          }),
          reviewedDrafts: {
            async consume() {
              return reviewedDraft(package_);
            },
          },
        }
      )
    ).rejects.toMatchObject({ code: "COMMUNITY_DIGEST_REQUIRED" });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects draft review provenance owned by another business before writing", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const write = vi.fn();
    const deps = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          write();
          return { revision: "unexpected", rollbackToken: "unexpected" };
        },
        async rollback() {
          return { revision: "rollback" };
        },
      },
      provenance: {
        async recordInstalledProvenance() {},
        async recordRestoredSoulRevision() {},
      },
    });
    const begin = vi.spyOn(deps.operations, "beginAuthorized");

    await expect(
      installReviewedCommunityOimRelease(
        {
          businessId: "business-2",
          slug: "weather-v1",
          approvedPackageDigest: oimPackageDigest(package_.manifest),
          principal: { kind: "user", id: "user-1" },
          runId: "run-1",
          replace: false,
        },
        {
          ...deps,
          reviewedDrafts: {
            async consume() {
              return reviewedDraft(package_);
            },
          },
        }
      )
    ).rejects.toMatchObject({ code: "INVALID_AUTHORED_RELEASE_SOURCE" });
    expect(begin).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("replaces only the explicitly approved installed generation", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const previousInstallationId = "33333333-3333-4333-8333-333333333333";
    const deps = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          return { revision: "soul-after", rollbackToken: "rollback-1" };
        },
        async rollback() {
          return { revision: "soul-before" };
        },
      },
      provenance: {
        async recordInstalledProvenance() {},
        async recordRestoredSoulRevision() {},
      },
    });
    const begin = vi.spyOn(deps.operations, "beginAuthorized");

    const result = await installReviewedCommunityOimRelease(
      {
        businessId: "business-1",
        slug: "weather-v1",
        approvedPackageDigest: oimPackageDigest(package_.manifest),
        principal: { kind: "user", id: "user-1" },
        runId: "run-1",
        replace: true,
      },
      {
        ...deps,
        reviewedDrafts: {
          async consume() {
            return reviewedDraft(package_, {
              replace: {
                businessId: "business-1",
                integrationId: "weather",
                majorVersion: 1,
                installationId: previousInstallationId,
                version: "1.1.0",
                packageDigest: "b".repeat(64),
                source: authoredDraftSource(),
                slug: "weather-v1",
                soulRevision: "soul-before",
                trustClass: "community",
                approvedCommunityDigest: "b".repeat(64),
                originalRequirements: {
                  metadata: { id: "weather", version: "1.1.0" },
                },
                autoPatchOptIn: false,
                installedAt: "2026-09-13T08:00:00.000Z",
                updatedAt: "2026-09-13T08:00:00.000Z",
              },
            });
          },
        },
      }
    );

    expect(result.installationId).not.toBe(previousInstallationId);
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "replace",
        expected: expect.objectContaining({ installationId: previousInstallationId }),
        source: authoredDraftSource(),
      })
    );
  });

  it("rejects replacement when no installed generation was part of the review", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const deps = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          return { revision: "unexpected", rollbackToken: "unexpected" };
        },
        async rollback() {
          return { revision: "rollback" };
        },
      },
      provenance: {
        async recordInstalledProvenance() {},
        async recordRestoredSoulRevision() {},
      },
    });
    const begin = vi.spyOn(deps.operations, "beginAuthorized");

    await expect(
      installReviewedCommunityOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          approvedPackageDigest: oimPackageDigest(package_.manifest),
          principal: { kind: "user", id: "user-1" },
          runId: "run-1",
          replace: true,
        },
        {
          ...deps,
          reviewedDrafts: {
            async consume() {
              return reviewedDraft(package_);
            },
          },
        }
      )
    ).rejects.toMatchObject({ code: "REPLACE_PRECONDITION_MISMATCH" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("rejects a replacement precondition for another installed identity before writing", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture();
    const write = vi.fn();

    await expect(
      installReviewedCommunityOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          approvedPackageDigest: oimPackageDigest(package_.manifest),
          principal: { kind: "user", id: "user-1" },
          runId: "run-1",
          replace: true,
        },
        {
          ...durableDeps({
            trust: service,
            packageWriter: {
              async install() {
                write();
                return { revision: "unexpected", rollbackToken: "unexpected" };
              },
              async rollback() {
                return { revision: "rollback" };
              },
            },
            provenance: {
              async recordInstalledProvenance() {},
              async recordRestoredSoulRevision() {},
            },
          }),
          reviewedDrafts: {
            async consume() {
              return reviewedDraft(package_, {
                replace: {
                  businessId: "business-1",
                  integrationId: "calendar",
                  majorVersion: 1,
                  installationId: "33333333-3333-4333-8333-333333333333",
                  version: "1.1.0",
                  packageDigest: "b".repeat(64),
                  source: authoredDraftSource(),
                  slug: "weather-v1",
                  soulRevision: "soul-before",
                  trustClass: "community",
                  approvedCommunityDigest: "b".repeat(64),
                  originalRequirements: {
                    metadata: { id: "calendar", version: "1.1.0" },
                  },
                  autoPatchOptIn: false,
                  installedAt: "2026-09-13T08:00:00.000Z",
                  updatedAt: "2026-09-13T08:00:00.000Z",
                },
              });
            },
          },
        }
      )
    ).rejects.toMatchObject({ code: "REPLACE_PRECONDITION_MISMATCH" });
    expect(write).not.toHaveBeenCalled();
  });

  it("recovers after a durable write-plan commit response is lost", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    const apply = vi.fn(async () => ({
      revision: "soul-1",
      rollbackToken: { persisted: true },
    }));
    const base = durableDeps({
      trust: service,
      packageWriter: {
        install: apply,
        async rollback() {
          return { revision: "soul-before" };
        },
      },
      provenance: {
        async recordInstalledProvenance() {},
        async recordRestoredSoulRevision() {},
      },
    });
    const recordPlan = base.operations.recordPlan.bind(base.operations);
    const interrupted: InstallSelectedOimReleaseDeps = {
      ...base,
      operations: {
        ...base.operations,
        async recordPlan(operationId, plan, updatedAt) {
          await recordPlan(operationId, plan, updatedAt);
          throw new Error("write-plan response lost");
        },
      },
    };
    const input = {
      businessId: "business-1",
      slug: "weather-v1",
      source: "https://example.test/weather.git",
      sourceRef: "commit-1",
      candidatePath: "packages/weather",
      trustClass: "official" as const,
      selection: {
        integrationId: "weather",
        version: "1.2.3",
        packageDigest: oimPackageDigest(package_.manifest),
      },
      candidates: [
        {
          package: package_,
          signedRelease: signOimRelease(
            package_,
            createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
          ),
        },
      ],
      autoPatchOptIn: false,
    };

    await expect(installSelectedOimRelease(input, interrupted)).rejects.toThrow(
      "write-plan response lost"
    );
    expect(apply).not.toHaveBeenCalled();
    await reconcileOimReleaseOperations(base);
    expect(apply).toHaveBeenCalledOnce();
    await expect(base.operations.listPending()).resolves.toEqual([
      expect.objectContaining({ phase: "completed" }),
    ]);
  });

  it("resumes a reconciliation-required write after restart", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    let commitFails = true;
    let rollbackFails = true;
    const deps = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          return { revision: "soul-1", rollbackToken: { persisted: true } };
        },
        async rollback() {
          if (rollbackFails) throw new Error("rollback response lost");
          return { revision: "soul-before" };
        },
      },
      provenance: {
        async recordInstalledProvenance() {
          if (commitFails) throw new Error("database unavailable");
        },
        async recordRestoredSoulRevision() {},
      },
    });
    const input = {
      businessId: "business-1",
      slug: "weather-v1",
      source: "https://example.test/weather.git",
      sourceRef: "commit-1",
      candidatePath: "packages/weather",
      trustClass: "official" as const,
      selection: {
        integrationId: "weather",
        version: "1.2.3",
        packageDigest: oimPackageDigest(package_.manifest),
      },
      candidates: [
        {
          package: package_,
          signedRelease: signOimRelease(
            package_,
            createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
          ),
        },
      ],
      autoPatchOptIn: false,
    };

    await expect(installSelectedOimRelease(input, deps)).rejects.toMatchObject({
      code: "INSTALL_ROLLBACK_FAILED",
    });
    commitFails = false;
    rollbackFails = false;
    await reconcileOimReleaseOperations(deps);
    await expect(deps.operations.listPending()).resolves.toEqual([
      expect.objectContaining({ phase: "completed" }),
    ]);
  });

  it("reads back a committed operation instead of rolling back after a lost commit response", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    const rollback = vi.fn(async () => ({ revision: "rollback" }));
    const base = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          return { revision: "soul-1", rollbackToken: { persisted: true } };
        },
        rollback,
      },
      provenance: {
        async recordInstalledProvenance() {},
        async recordRestoredSoulRevision() {},
      },
    });
    const commit = base.operations.commitProvenance.bind(base.operations);
    const deps: InstallSelectedOimReleaseDeps = {
      ...base,
      operations: {
        ...base.operations,
        async commitProvenance(operationId, committedAt) {
          await commit(operationId, committedAt);
          throw new Error("database response lost");
        },
      },
    };

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-1",
          candidatePath: "packages/weather",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [
            {
              package: package_,
              signedRelease: signOimRelease(
                package_,
                createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
              ),
            },
          ],
          autoPatchOptIn: false,
        },
        deps
      )
    ).resolves.toMatchObject({
      installationId: "22222222-2222-4222-8222-222222222222",
      revision: "soul-1",
    });
    expect(rollback).not.toHaveBeenCalled();
  });

  it("reads back a durable Soul-write receipt after its response is lost", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    const base = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          return { revision: "soul-1", rollbackToken: { persisted: true } };
        },
        async rollback() {
          throw new Error("must not roll back a durable write");
        },
      },
      provenance: {
        async recordInstalledProvenance() {},
        async recordRestoredSoulRevision() {},
      },
    });
    const recordSoulWrite = base.operations.recordSoulWrite.bind(base.operations);
    const deps: InstallSelectedOimReleaseDeps = {
      ...base,
      operations: {
        ...base.operations,
        async recordSoulWrite(operationId, receipt, soulRevision, updatedAt) {
          await recordSoulWrite(operationId, receipt, soulRevision, updatedAt);
          throw new Error("Soul-write response lost");
        },
      },
    };

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-1",
          candidatePath: "packages/weather",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [
            {
              package: package_,
              signedRelease: signOimRelease(
                package_,
                createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
              ),
            },
          ],
          autoPatchOptIn: false,
        },
        deps
      )
    ).resolves.toMatchObject({ revision: "soul-1" });
  });
  it("installs one selected signed candidate from an immutable verified byte snapshot", async () => {
    const { releaseKey, service } = trustService();
    const target = releasePackageFixture({
      files: { "setup-guide.md": "# Reviewed guide\n" },
    });
    const unrelated = releasePackageFixture({
      integrationId: "calendar",
      files: { "setup-guide.md": "# Calendar\n" },
    });
    const candidates = [
      { package: unrelated, signedRelease: { malformed: true } },
      {
        package: target,
        signedRelease: signOimRelease(
          target,
          createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
        ),
      },
    ];
    const installed: {
      businessId: string;
      slug: string;
      snapshot: OimReleaseInstallSnapshot;
    }[] = [];
    const recorded: unknown[] = [];

    const result = await installSelectedOimRelease(
      {
        businessId: "business-1",
        slug: "weather-v1",
        source: "https://example.test/weather.git",
        sourceRef: "commit-1",
        candidatePath: "packages/weather",
        trustClass: "official",
        selection: {
          integrationId: "weather",
          version: "1.2.3",
          packageDigest: oimPackageDigest(target.manifest),
        },
        candidates,
        autoPatchOptIn: true,
      },
      durableDeps({
        trust: service,
        packageWriter: {
          async install(input) {
            target.files.set("setup-guide.md", "# Mutated after review\n");
            installed.push(input);
            return { revision: "soul-1", rollbackToken: "rollback-1" };
          },
          async rollback() {
            return { revision: "rollback" };
          },
        },
        provenance: {
          async recordInstalledProvenance(input) {
            recorded.push(input);
          },
          async recordRestoredSoulRevision() {},
        },
      })
    );

    expect(result).toMatchObject({
      integrationId: "weather",
      version: "1.2.3",
      packageDigest: oimPackageDigest(target.manifest),
      trustClass: "official",
      revision: "soul-1",
    });
    expect(installed).toEqual([
      expect.objectContaining({
        businessId: "business-1",
        slug: "weather-v1",
        snapshot: expect.objectContaining({
          integrationId: "weather",
          version: "1.2.3",
          files: [
            expect.objectContaining({
              path: "setup-guide.md",
              contentBase64: Buffer.from("# Reviewed guide\n").toString("base64"),
            }),
          ],
        }),
      }),
    ]);
    const [write] = installed;
    expect(write).toBeDefined();
    if (write === undefined) throw new Error("install write missing");
    expect(createHash("sha256").update(write.snapshot.manifestText).digest("hex")).toBe(
      write.snapshot.packageDigest
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      slug: "weather-v1",
      source: {
        kind: "git",
        repository: "https://example.test/weather.git",
        ref: "commit-1",
        path: "packages/weather",
      },
      soulRevision: "soul-1",
    });
  });

  it("rejects changed companion bytes before the Soul writer can run", async () => {
    const { service } = trustService();
    const package_ = releasePackageFixture({
      files: { "setup-guide.md": "# Reviewed guide\n" },
    });
    package_.files.set("setup-guide.md", "# Changed guide\n");
    let writes = 0;

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-1",
          candidatePath: "packages/weather",
          trustClass: "community",
          approvedCommunityDigest: oimPackageDigest(package_.manifest),
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [{ package: package_ }],
        },
        durableDeps({
          trust: service,
          packageWriter: {
            async install() {
              writes += 1;
              return { revision: "unexpected", rollbackToken: "unexpected" };
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
    ).rejects.toThrow("setup-guide.md digest does not match the manifest");
    expect(writes).toBe(0);
  });

  it("rolls back the exact Soul revision when provenance persistence fails", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    const failure = new Error("provenance unavailable");
    const rolledBack: unknown[] = [];

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-1",
          candidatePath: "packages/weather",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [
            {
              package: package_,
              signedRelease: signOimRelease(
                package_,
                createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
              ),
            },
          ],
          autoPatchOptIn: false,
        },
        durableDeps({
          trust: service,
          packageWriter: {
            async install() {
              return { revision: "soul-1", rollbackToken: "rollback-1" };
            },
            async rollback(receipt) {
              rolledBack.push(receipt);
              return { revision: "rollback" };
            },
          },
          provenance: {
            async recordInstalledProvenance() {
              throw failure;
            },
            async recordRestoredSoulRevision() {},
          },
        })
      )
    ).rejects.toBe(failure);
    expect(rolledBack).toEqual([{ revision: "soul-1", rollbackToken: "rollback-1" }]);
  });

  it("records the restored Soul revision after rolling back a replacement", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture({ version: "1.2.4" });
    const failure = new Error("provenance changed");
    const recordRestoredSoulRevision = vi.fn(async () => {});

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-2",
          candidatePath: "packages/weather",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.4",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [
            {
              package: package_,
              signedRelease: signOimRelease(
                package_,
                createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
              ),
            },
          ],
          autoPatchOptIn: true,
        },
        durableDeps({
          trust: service,
          packageWriter: {
            async install() {
              return { revision: "soul-patch", rollbackToken: "rollback-patch" };
            },
            async rollback() {
              return {
                revision: "soul-restored",
                restored: {
                  integrationId: "weather",
                  version: "1.2.3",
                  majorVersion: 1,
                  packageDigest: "a".repeat(64),
                },
              };
            },
          },
          provenance: {
            async recordInstalledProvenance() {
              throw failure;
            },
            recordRestoredSoulRevision,
          },
        })
      )
    ).rejects.toBe(failure);
    expect(recordRestoredSoulRevision).toHaveBeenCalledWith({
      businessId: "business-1",
      integrationId: "weather",
      version: "1.2.3",
      majorVersion: 1,
      packageDigest: "a".repeat(64),
      slug: "weather-v1",
      soulRevision: "soul-restored",
    });
  });

  it("records restored provenance when package publication fails after rollback", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture({ version: "1.2.4" });
    const publicationFailure = Object.assign(new Error("publication failed"), {
      rollbackReceipt: {
        revision: "soul-restored",
        restored: {
          integrationId: "weather",
          version: "1.2.3",
          majorVersion: 1,
          packageDigest: "a".repeat(64),
        },
      },
    });
    const recordRestoredSoulRevision = vi.fn(async () => {});

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-2",
          candidatePath: "packages/weather",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.4",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [
            {
              package: package_,
              signedRelease: signOimRelease(
                package_,
                createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
              ),
            },
          ],
          autoPatchOptIn: true,
        },
        durableDeps({
          trust: service,
          packageWriter: {
            async install() {
              throw publicationFailure;
            },
            async rollback() {
              throw new Error("must not rollback twice");
            },
          },
          provenance: {
            async recordInstalledProvenance() {
              throw new Error("must not record failed install");
            },
            recordRestoredSoulRevision,
          },
        })
      )
    ).rejects.toBe(publicationFailure);
    expect(recordRestoredSoulRevision).toHaveBeenCalledWith({
      businessId: "business-1",
      integrationId: "weather",
      version: "1.2.3",
      majorVersion: 1,
      packageDigest: "a".repeat(64),
      slug: "weather-v1",
      soulRevision: "soul-restored",
    });
  });

  it("preserves the original requirements when installing an automatic patch", async () => {
    const { releaseKey, service } = trustService();
    const original = releasePackageFixture({ version: "1.2.0" });
    const patch = releasePackageFixture({ version: "1.2.1" });
    const recorded: unknown[] = [];

    await installSelectedOimRelease(
      {
        businessId: "business-1",
        slug: "weather-v1",
        source: "https://example.test/weather.git",
        sourceRef: "commit-1",
        candidatePath: "packages/weather",
        originalRequirements: original.manifest,
        trustClass: "official",
        selection: {
          integrationId: "weather",
          version: "1.2.1",
          packageDigest: oimPackageDigest(patch.manifest),
        },
        candidates: [
          {
            package: patch,
            signedRelease: signOimRelease(
              patch,
              createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
            ),
          },
        ],
        autoPatchOptIn: true,
      },
      durableDeps({
        trust: service,
        packageWriter: {
          async install() {
            return { revision: "soul-2", rollbackToken: "rollback-2" };
          },
          async rollback() {
            return { revision: "rollback" };
          },
        },
        provenance: {
          async recordInstalledProvenance(input) {
            recorded.push(input);
          },
          async recordRestoredSoulRevision() {},
        },
      })
    );

    expect(recorded).toEqual([
      expect.objectContaining({
        originalRequirements: original.manifest,
      }),
    ]);
  });

  it("does not downgrade signed candidates to Community trust", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    let writes = 0;

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-1",
          candidatePath: "packages/weather",
          trustClass: "community",
          approvedCommunityDigest: oimPackageDigest(package_.manifest),
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [
            {
              package: package_,
              signedRelease: signOimRelease(
                package_,
                createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
              ),
            },
          ],
        },
        durableDeps({
          trust: service,
          packageWriter: {
            async install() {
              writes += 1;
              return { revision: "unexpected", rollbackToken: "unexpected" };
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
    ).rejects.toMatchObject({ code: "COMMUNITY_SIGNATURE_DOWNGRADE" });
    expect(writes).toBe(0);
  });

  it("does not downgrade a server-known signed release copied without its signature", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );
    await service.recordKnownSignedRelease(signedRelease);
    let writes = 0;

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://mirror.example.test/weather.git",
          sourceRef: "copied-commit",
          candidatePath: "copied/weather",
          trustClass: "community",
          approvedCommunityDigest: oimPackageDigest(package_.manifest),
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [{ package: package_ }],
        },
        durableDeps({
          trust: service,
          packageWriter: {
            async install() {
              writes += 1;
              return { revision: "unexpected", rollbackToken: "unexpected" };
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
    ).rejects.toMatchObject({ code: "COMMUNITY_OFFICIAL_RELEASE" });
    expect(writes).toBe(0);
  });

  it("does not write when the selected package is ambiguous", async () => {
    const { releaseKey, service } = trustService();
    const package_ = releasePackageFixture();
    const signedRelease = signOimRelease(
      package_,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );
    let writes = 0;

    await expect(
      installSelectedOimRelease(
        {
          businessId: "business-1",
          slug: "weather-v1",
          source: "https://example.test/weather.git",
          sourceRef: "commit-1",
          candidatePath: "packages/weather",
          trustClass: "official",
          selection: {
            integrationId: "weather",
            version: "1.2.3",
            packageDigest: oimPackageDigest(package_.manifest),
          },
          candidates: [
            { package: package_, signedRelease },
            { package: structuredClone(package_), signedRelease },
          ],
          autoPatchOptIn: false,
        },
        durableDeps({
          trust: service,
          packageWriter: {
            async install() {
              writes += 1;
              return { revision: "unexpected", rollbackToken: "unexpected" };
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
    ).rejects.toMatchObject({ code: "RELEASE_CANDIDATE_AMBIGUOUS" });
    expect(writes).toBe(0);
  });

  it("rejects unsafe selected source entries but ignores issues on unrelated candidates", async () => {
    const { releaseKey, service } = trustService();
    const target = releasePackageFixture();
    const signedRelease = signOimRelease(
      target,
      createEd25519OimReleaseSigner(releaseKey.keyId, releaseKey.privateKeyPem)
    );
    const base = {
      businessId: "business-1",
      slug: "weather-v1",
      source: "https://example.test/weather.git",
      sourceRef: "commit-1",
      candidatePath: "packages/weather",
      trustClass: "official" as const,
      selection: {
        integrationId: "weather",
        version: "1.2.3",
        packageDigest: oimPackageDigest(target.manifest),
      },
      autoPatchOptIn: false,
    };
    let writes = 0;
    const deps = durableDeps({
      trust: service,
      packageWriter: {
        async install() {
          writes += 1;
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
    });

    await expect(
      installSelectedOimRelease(
        {
          ...base,
          candidates: [
            {
              package: releasePackageFixture({ integrationId: "calendar" }),
              sourceIssues: ["escape.json is a symbolic link"],
            },
            { package: target, signedRelease },
          ],
        },
        deps
      )
    ).resolves.toMatchObject({ integrationId: "weather" });
    await expect(
      installSelectedOimRelease(
        {
          ...base,
          candidates: [
            {
              package: target,
              signedRelease,
              sourceIssues: ["setup-guide.md is a symbolic link"],
            },
          ],
        },
        deps
      )
    ).rejects.toMatchObject({ code: "RELEASE_CANDIDATE_INVALID" });
    expect(writes).toBe(1);
  });
});
