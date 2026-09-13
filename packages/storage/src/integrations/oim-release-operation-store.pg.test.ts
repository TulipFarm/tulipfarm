import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import { OIM_RELEASE_LIFECYCLE_STORAGE_STATEMENTS } from "./oim-release-lifecycle-store";
import { OimReleaseOperationStore } from "./oim-release-operation-store";
import { OIM_RELEASE_TRUST_STORAGE_STATEMENTS } from "./oim-release-trust-store";

function nextRelease(
  overrides: Partial<Parameters<OimReleaseOperationStore["begin"]>[0]["next"]> = {}
) {
  return {
    businessId: "business-1",
    integrationId: "weather",
    majorVersion: 1,
    version: "1.2.3",
    packageDigest: "a".repeat(64),
    source: {
      kind: "git" as const,
      repository: "https://example.test/weather.git",
      ref: "commit-a1b2c3",
      path: "packages/weather",
    },
    slug: "weather-v1",
    trustClass: "official" as const,
    signedRelease: { envelopeVersion: 1 },
    originalRequirements: { metadata: { id: "weather", version: "1.2.3" } },
    autoPatchOptIn: true,
    ...overrides,
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
    toolCallId: "call-1",
  };
}

function packageSnapshot() {
  return {
    integrationId: "weather",
    version: "1.2.3",
    majorVersion: 1,
    packageDigest: "a".repeat(64),
    manifestText: '{"metadata":{"id":"weather","version":"1.2.3"}}',
    files: [],
  };
}

describe("OimReleaseOperationStore", () => {
  let database: PGlite;
  let store: OimReleaseOperationStore;

  beforeEach(async () => {
    database = new PGlite();
    for (const statement of [
      ...OIM_RELEASE_TRUST_STORAGE_STATEMENTS,
      ...OIM_RELEASE_LIFECYCLE_STORAGE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    store = new OimReleaseOperationStore(transactionPort(database));
  });

  afterEach(async () => {
    await database.close();
  });

  it("persists every install phase and reconciles a lost provenance commit response", async () => {
    const started = await store.begin({
      kind: "install",
      next: nextRelease(),
      packageSnapshot: packageSnapshot(),
      startedAt: "2026-09-13T09:00:00.000Z",
    });
    await expect(
      new OimReleaseOperationStore(transactionPort(database)).get(started.operationId)
    ).resolves.toMatchObject({
      phase: "prepared",
      installationId: started.installationId,
      packageSnapshot: packageSnapshot(),
    });
    await expect(
      new OimReleaseOperationStore(transactionPort(database)).begin({
        kind: "install",
        next: nextRelease(),
        packageSnapshot: packageSnapshot(),
        startedAt: "2026-09-13T09:00:00.000Z",
      })
    ).resolves.toMatchObject({ operationId: started.operationId });
    await expect(
      store.begin({
        kind: "install",
        next: nextRelease(),
        packageSnapshot: { ...packageSnapshot(), manifestText: "substituted" },
        startedAt: "2026-09-13T09:00:00.000Z",
      })
    ).rejects.toThrow("oim_release_operation_pending");

    const plan = { expectedBaseCommit: "soul-before", snapshot: { exactBytes: true } };
    await store.recordPlan(started.operationId, plan, "2026-09-13T09:01:00.000Z");
    await expect(
      new OimReleaseOperationStore(transactionPort(database)).recordPlan(
        started.operationId,
        plan,
        "2026-09-13T09:01:01.000Z"
      )
    ).resolves.toBeUndefined();
    await expect(
      store.recordPlan(
        started.operationId,
        { expectedBaseCommit: "substituted" },
        "2026-09-13T09:01:02.000Z"
      )
    ).rejects.toThrow("oim_release_operation_phase_mismatch");
    await expect(
      new OimReleaseOperationStore(transactionPort(database)).get(started.operationId)
    ).resolves.toMatchObject({ phase: "plan_recorded", writePlan: plan });
    await store.requireReconciliation(
      started.operationId,
      "write response lost",
      "2026-09-13T09:01:30.000Z"
    );
    await expect(
      new OimReleaseOperationStore(transactionPort(database)).resumeReconciliation(
        started.operationId,
        "2026-09-13T09:01:31.000Z"
      )
    ).resolves.toMatchObject({ phase: "plan_recorded", writePlan: plan });

    const receipt = {
      revision: "soul-after",
      rollbackToken: { previous: null, installedRevision: "soul-after" },
    };
    await store.recordSoulWrite(
      started.operationId,
      receipt,
      "soul-after",
      "2026-09-13T09:02:00.000Z"
    );
    await expect(
      new OimReleaseOperationStore(transactionPort(database)).recordSoulWrite(
        started.operationId,
        receipt,
        "soul-after",
        "2026-09-13T09:02:01.000Z"
      )
    ).resolves.toBeUndefined();
    await expect(
      store.recordSoulWrite(
        started.operationId,
        { ...receipt, rollbackToken: { substituted: true } },
        "soul-after",
        "2026-09-13T09:02:02.000Z"
      )
    ).rejects.toThrow("oim_release_operation_phase_mismatch");
    await expect(
      new OimReleaseOperationStore(transactionPort(database)).get(started.operationId)
    ).resolves.toMatchObject({ phase: "soul_written", writeReceipt: receipt });

    await store.commitProvenance(started.operationId, "2026-09-13T09:03:00.000Z");
    const restarted = new OimReleaseOperationStore(transactionPort(database));
    await expect(restarted.get(started.operationId)).resolves.toMatchObject({
      phase: "provenance_committed",
      soulRevision: "soul-after",
    });
    await expect(
      restarted.commitProvenance(started.operationId, "2026-09-13T09:04:00.000Z")
    ).resolves.toMatchObject({
      status: "updated",
      provenance: {
        installationId: started.installationId,
        soulRevision: "soul-after",
      },
    });

    await restarted.markCompleted(started.operationId, "2026-09-13T09:05:00.000Z");
    await expect(restarted.get(started.operationId)).resolves.toMatchObject({
      phase: "completed",
    });
  });

  it("holds the global slug while an install is pending and releases it after rollback", async () => {
    const first = await store.begin({
      kind: "install",
      next: nextRelease(),
      packageSnapshot: packageSnapshot(),
      startedAt: "2026-09-13T09:00:00.000Z",
    });
    await expect(
      store.begin({
        kind: "install",
        next: nextRelease({
          integrationId: "calendar",
          majorVersion: 3,
          version: "3.0.0",
          packageDigest: "b".repeat(64),
        }),
        packageSnapshot: packageSnapshot(),
        startedAt: "2026-09-13T09:01:00.000Z",
      })
    ).rejects.toThrow("oim_release_location_conflict");

    await store.markRolledBack(first.operationId, "2026-09-13T09:02:00.000Z");
    await expect(
      store.begin({
        kind: "install",
        next: nextRelease({
          integrationId: "calendar",
          majorVersion: 3,
          version: "3.0.0",
          packageDigest: "b".repeat(64),
        }),
        packageSnapshot: packageSnapshot(),
        startedAt: "2026-09-13T09:03:00.000Z",
      })
    ).resolves.toMatchObject({ integrationId: "calendar", slug: "weather-v1" });
  });

  it("persists the complete previous package identity and location for a patch", async () => {
    const installationId = "11111111-1111-4111-8111-111111111111";
    await database.query(
      `INSERT INTO oim_release_slug_reservations (
         business_id, slug, integration_id, major_version, installation_id, state
       ) VALUES ($1, $2, $3, $4, $5::uuid, 'installed')`,
      ["business-1", "weather-v1", "weather", 1, installationId]
    );
    const expected = {
      installationId,
      version: "1.2.3",
      packageDigest: "a".repeat(64),
      source: {
        kind: "git" as const,
        repository: "https://example.test/weather.git",
        ref: "commit-old",
        path: "packages/weather",
      },
      slug: "weather-v1",
      soulRevision: "soul-old",
      updatedAt: "2026-09-13T08:00:00.000Z",
    };

    await expect(
      store.begin({
        kind: "patch",
        expected,
        next: nextRelease({
          version: "1.2.4",
          packageDigest: "b".repeat(64),
          source: {
            kind: "git",
            repository: "https://example.test/weather.git",
            ref: "commit-new",
            path: "packages/weather",
          },
        }),
        packageSnapshot: packageSnapshot(),
        startedAt: "2026-09-13T09:00:00.000Z",
      })
    ).resolves.toMatchObject({ kind: "patch", expected });
  });

  it("replaces only the exact installed generation and records authored provenance", async () => {
    const installed = await store.begin({
      kind: "install",
      next: nextRelease(),
      packageSnapshot: packageSnapshot(),
      startedAt: "2026-09-13T08:00:00.000Z",
    });
    await store.recordPlan(installed.operationId, { plan: "install" }, "2026-09-13T08:01:00.000Z");
    await store.recordSoulWrite(
      installed.operationId,
      { revision: "soul-old", rollbackToken: "old" },
      "soul-old",
      "2026-09-13T08:02:00.000Z"
    );
    const committed = await store.commitProvenance(
      installed.operationId,
      "2026-09-13T08:03:00.000Z"
    );
    if (committed.status !== "updated") throw new Error("install_failed");
    await store.markCompleted(installed.operationId, "2026-09-13T08:04:00.000Z");

    const replacement = await store.begin({
      kind: "replace",
      expected: committed.provenance,
      next: nextRelease({
        version: "1.3.0",
        packageDigest: "c".repeat(64),
        source: authoredDraftSource(),
        trustClass: "community",
        signedRelease: undefined,
        approvedCommunityDigest: "c".repeat(64),
        autoPatchOptIn: false,
      }),
      packageSnapshot: packageSnapshot(),
      startedAt: "2026-09-13T09:00:00.000Z",
    });
    expect(replacement.installationId).not.toBe(installed.installationId);
    await store.recordPlan(
      replacement.operationId,
      { plan: "replace" },
      "2026-09-13T09:01:00.000Z"
    );
    await store.recordSoulWrite(
      replacement.operationId,
      { revision: "soul-new", rollbackToken: "new" },
      "soul-new",
      "2026-09-13T09:02:00.000Z"
    );
    await expect(
      store.commitProvenance(replacement.operationId, "2026-09-13T09:03:00.000Z")
    ).resolves.toMatchObject({
      status: "updated",
      provenance: {
        installationId: replacement.installationId,
        source: authoredDraftSource(),
      },
    });
    await store.markCompleted(replacement.operationId, "2026-09-13T09:04:00.000Z");

    await expect(
      store.begin({
        kind: "replace",
        expected: committed.provenance,
        next: nextRelease({
          version: "1.4.0",
          packageDigest: "d".repeat(64),
          source: authoredDraftSource(),
          trustClass: "community",
          signedRelease: undefined,
          approvedCommunityDigest: "d".repeat(64),
          autoPatchOptIn: false,
        }),
        packageSnapshot: packageSnapshot(),
        startedAt: "2026-09-13T10:00:00.000Z",
      })
    ).rejects.toThrow("oim_release_location_conflict");
  });
});
