import { oimPackageDigest } from "@tulipfarm/schema";
import type { PersistedInstalledOimReleaseProvenance } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { InstallSelectedOimReleaseDeps, OimReleaseOperation } from "./installer";
import { type OimReleaseMaintenanceDeps, runOimReleaseMaintenance } from "./maintenance";
import type { SignedOimRelease } from "./signatures";
import { releasePackageFixture } from "./test-fixtures";

const provenance: PersistedInstalledOimReleaseProvenance = {
  businessId: "business-1",
  integrationId: "weather",
  majorVersion: 1,
  version: "1.2.3",
  packageDigest: "a".repeat(64),
  source: {
    kind: "git",
    repository: "https://example.test/releases.git",
    ref: "commit-a1b2c3",
    path: "packages/weather",
  },
  slug: "weather-v1",
  soulRevision: "soul-a1b2c3",
  trustClass: "official",
  signedRelease: {},
  originalRequirements: {},
  autoPatchOptIn: true,
  installationId: "11111111-1111-4111-8111-111111111111",
  installedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function patchDeps(input: {
  readonly apply: () => void;
  readonly begin: (value: unknown) => void;
  readonly commit?: "updated" | "skipped";
  readonly rollback?: (receipt: unknown) => void;
}): InstallSelectedOimReleaseDeps {
  let operation: OimReleaseOperation | undefined;
  return {
    trust: {
      authorizeSelectedOfficialRelease: async () => {
        throw new Error("unused");
      },
      authorizeCommunityRelease: async () => {
        throw new Error("unused");
      },
    },
    packageWriter: {
      prepare: async (value) => value,
      async apply() {
        input.apply();
        return { revision: "soul-patched", rollbackToken: { persisted: true } };
      },
      async install() {
        throw new Error("unused");
      },
      async rollback(receipt) {
        input.rollback?.(receipt);
        return { revision: provenance.soulRevision };
      },
    },
    provenance: {
      async recordInstalledProvenance() {},
      async recordRestoredSoulRevision() {},
    },
    operations: {
      async beginAuthorized(value) {
        input.begin(value);
        operation = {
          operationId: "22222222-2222-4222-8222-222222222222",
          businessId: value.businessId,
          installationId: provenance.installationId,
          integrationId: value.authorization.integrationId,
          majorVersion: provenance.majorVersion,
          slug: value.slug,
          kind: "patch",
          phase: "prepared",
          next: {
            version: value.authorization.version,
            packageDigest: value.authorization.packageDigest,
          },
          packageSnapshot: structuredClone(value.packageSnapshot),
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
        if (operation === undefined) throw new Error("operation_missing");
        if (input.commit === "skipped") {
          return { status: "skipped", reason: "installed_release_changed" };
        }
        operation = { ...operation, phase: "provenance_committed" };
        return { status: "updated", provenance };
      },
      async markCompleted() {
        if (operation === undefined) throw new Error("operation_missing");
        operation = { ...operation, phase: "completed" };
      },
      async markRolledBack() {},
      async requireReconciliation() {},
      async resumeReconciliation() {
        throw new Error("not used");
      },
    },
  };
}

function releaseEnvelope(
  integrationId: string,
  version: string,
  packageDigest: string
): SignedOimRelease {
  return {
    envelopeVersion: 1,
    release: { integrationId, version, packageDigest },
    signature: {
      algorithm: "Ed25519",
      keyId: "release-2026",
      value: `${"A".repeat(86)}==`,
    },
  };
}

describe("runOimReleaseMaintenance", () => {
  it("binds only the matching feed signature to the selected inspected candidate", async () => {
    const target = releasePackageFixture({ version: "1.2.4" });
    const unrelated = releasePackageFixture({ integrationId: "calendar", version: "9.0.0" });
    const selected = {
      integrationId: "weather",
      version: "1.2.4",
      packageDigest: oimPackageDigest(target.manifest),
    };
    const signedRelease = releaseEnvelope(
      selected.integrationId,
      selected.version,
      selected.packageDigest
    );
    const selectAutoPatch: OimReleaseMaintenanceDeps["trust"]["selectAutoPatch"] = vi.fn(
      async (input) => ({
        trustClass: "official" as const,
        ...selected,
        signerKeyId: "release-2026",
        signedRelease,
        files: [],
        package: input.candidates[1].package,
      })
    );
    const applyPatch = vi.fn();
    const beginPatch = vi.fn();
    const order: string[] = [];

    const result = await runOimReleaseMaintenance(
      {
        feedVersion: 1,
        revocations: { signed: "revocations" },
        releases: [
          {
            source: "https://example.test/other.git",
            ref: "other-ref",
            signedRelease: { malformed: true },
          },
          {
            source: "https://example.test/releases.git",
            ref: "target-ref",
            signedRelease,
          },
        ],
      },
      {
        businessId: "business-1",
        trust: {
          async updateRevocationList() {
            order.push("revocations");
          },
          recordKnownSignedReleases: async () => {},
          listAutoPatchProvenance: async () => [provenance],
          selectAutoPatch,
        },
        installedPackage: async () => releasePackageFixture({ version: "1.2.3" }),
        inspectSource: async () => ({
          ref: "commit-resolved-a1b2c3",
          candidates: [
            { sourcePath: "packages/calendar", package: unrelated },
            { sourcePath: "packages/weather", package: target },
          ],
        }),
        patch: patchDeps({
          apply() {
            order.push("patch");
            applyPatch();
          },
          begin: beginPatch,
        }),
      }
    );

    expect(result).toEqual({
      revocations: "updated",
      patches: [
        {
          integrationId: "weather",
          majorVersion: 1,
          status: "updated",
          version: "1.2.4",
        },
      ],
    });
    expect(order).toEqual(["revocations", "patch"]);
    expect(selectAutoPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: selected,
        candidates: [
          { sourcePath: "packages/calendar", package: unrelated },
          { sourcePath: "packages/weather", package: target, signedRelease },
        ],
      })
    );
    expect(applyPatch).toHaveBeenCalledOnce();
    expect(beginPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: "git",
          repository: "https://example.test/releases.git",
          ref: "commit-resolved-a1b2c3",
          path: "packages/weather",
        },
      })
    );
  });

  it("fails one patch without hiding its retry obligation or applying an ambiguous feed entry", async () => {
    const target = releasePackageFixture({ version: "1.2.4" });
    const signedRelease = releaseEnvelope("weather", "1.2.4", oimPackageDigest(target.manifest));
    const applyPatch = vi.fn();

    const result = await runOimReleaseMaintenance(
      {
        feedVersion: 1,
        revocations: { signed: "revocations" },
        releases: [
          { source: "https://example.test/releases.git", ref: "ref-1", signedRelease },
          { source: "https://example.test/releases.git", ref: "ref-2", signedRelease },
        ],
      },
      {
        businessId: "business-1",
        trust: {
          updateRevocationList: async () => {},
          recordKnownSignedReleases: async () => {},
          listAutoPatchProvenance: async () => [provenance],
          selectAutoPatch: async () => {
            throw new Error("must not select an ambiguous release");
          },
        },
        installedPackage: async () => releasePackageFixture({ version: "1.2.3" }),
        inspectSource: async () => ({
          ref: "commit-resolved",
          candidates: [{ sourcePath: "packages/weather", package: target }],
        }),
        patch: patchDeps({ apply: applyPatch, begin: vi.fn() }),
      }
    );

    expect(result.patches).toEqual([
      {
        integrationId: "weather",
        majorVersion: 1,
        status: "failed",
        reason: "release_feed_candidate_ambiguous",
      },
    ]);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("rolls back the exact Soul write when the installed generation changes before patch commit", async () => {
    const target = releasePackageFixture({ version: "1.2.4" });
    const selected = {
      integrationId: "weather",
      version: "1.2.4",
      packageDigest: oimPackageDigest(target.manifest),
    };
    const signedRelease = releaseEnvelope(
      selected.integrationId,
      selected.version,
      selected.packageDigest
    );
    const rollback = vi.fn();

    const result = await runOimReleaseMaintenance(
      {
        feedVersion: 1,
        revocations: { signed: "revocations" },
        releases: [
          { source: "https://example.test/releases.git", ref: "target-ref", signedRelease },
        ],
      },
      {
        businessId: "business-1",
        trust: {
          async updateRevocationList() {},
          recordKnownSignedReleases: async () => {},
          listAutoPatchProvenance: async () => [provenance],
          selectAutoPatch: async (input) => ({
            trustClass: "official",
            ...selected,
            signerKeyId: "release-2026",
            signedRelease,
            files: [],
            package: input.candidates[0].package,
          }),
        },
        installedPackage: async () => releasePackageFixture({ version: "1.2.3" }),
        inspectSource: async () => ({
          ref: "commit-resolved",
          candidates: [{ sourcePath: "packages/weather", package: target }],
        }),
        patch: patchDeps({
          apply() {},
          begin() {},
          commit: "skipped",
          rollback,
        }),
      }
    );

    expect(result.patches).toEqual([
      {
        integrationId: "weather",
        majorVersion: 1,
        status: "skipped",
        reason: "installed_release_changed",
      },
    ]);
    expect(rollback).toHaveBeenCalledWith({
      revision: "soul-patched",
      rollbackToken: { persisted: true },
    });
  });
});
