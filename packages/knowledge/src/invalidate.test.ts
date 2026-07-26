import { describe, expect, it } from "vitest";
import { deleteSource, revokeSource, syncSourceRevision } from "./delete";
import { InMemoryKnowledgeIndex } from "./indexing";
import type { InvalidationTargetKind, InvalidationTargetPort } from "./invalidate";
import {
  drainInvalidations,
  enqueueInvalidation,
  INVALIDATION_TARGET_KINDS,
  InMemoryInvalidationQueue,
  invalidationStatus,
  runInvalidation,
} from "./invalidate";
import { retrieve } from "./retrieve";
import type { KnowledgeSourceRecord } from "./source";
import { InMemoryKnowledgeSourceStore } from "./source";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

function source(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
  return {
    sourceId: "hr-salaries",
    businessId: "biz-1",
    integrationId: "int-drive",
    provider: "google-drive",
    externalId: "salaries",
    externalTenantId: "tenant-1",
    ownerExternalId: "hr@example.com",
    revision: "3",
    classification: ["restricted"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-1", maximumAgeSeconds: 3600 },
    acl: {
      aclRevision: "acl-1",
      capturedAt: NOW.toISOString(),
      principals: [{ kind: "user", id: "user-1" }],
    },
    provenance: { capturedAt: NOW.toISOString(), contentHash: "a".repeat(64) },
    lastSyncedAt: NOW.toISOString(),
    ...overrides,
  };
}

class CountingTarget implements InvalidationTargetPort {
  purged = 0;
  failUntil = 0;
  constructor(readonly kind: InvalidationTargetKind) {}

  async purge(): Promise<number> {
    if (this.purged < this.failUntil) {
      this.purged += 1;
      throw new Error(`purge failed for hr-salaries`);
    }
    this.purged += 1;
    return 1;
  }
}

function targets(): CountingTarget[] {
  return INVALIDATION_TARGET_KINDS.map((kind) => new CountingTarget(kind));
}

interface TestDeps {
  queue: InMemoryInvalidationQueue;
  sources: InMemoryKnowledgeSourceStore;
  targets: CountingTarget[];
  now: () => Date;
  newId: () => string;
}

function deps(overrides: Partial<TestDeps> = {}): TestDeps {
  return {
    queue: new InMemoryInvalidationQueue(),
    sources: new InMemoryKnowledgeSourceStore([source()]),
    targets: targets(),
    now,
    newId: (() => {
      let counter = 0;
      return () => `job-${++counter}`;
    })(),
    ...overrides,
  };
}

describe("enqueueInvalidation", () => {
  it("covers every derived artifact a source can leave behind", async () => {
    const d = deps();
    const job = await enqueueInvalidation(d, {
      businessId: "biz-1",
      sourceId: "hr-salaries",
      trigger: "source_deleted",
    });

    expect(job.targets).toEqual([...INVALIDATION_TARGET_KINDS]);
    expect(job.status).toBe("pending");
    expect(INVALIDATION_TARGET_KINDS).toEqual(
      expect.arrayContaining([
        "keyword_index",
        "vector_index",
        "retrieval_cache",
        "summary",
        "context",
        "citation",
      ])
    );
  });
});

describe("runInvalidation", () => {
  it("purges every target and converges observably", async () => {
    const d = deps();
    const job = await enqueueInvalidation(d, {
      businessId: "biz-1",
      sourceId: "hr-salaries",
      trigger: "acl_change",
    });

    const before = await invalidationStatus(d, "biz-1", "hr-salaries");
    expect(before.converged).toBe(false);
    expect(before.pendingTargets).toEqual([...INVALIDATION_TARGET_KINDS]);

    const outcome = await runInvalidation(d, job.jobId);
    expect(outcome.status).toBe("complete");
    expect(d.targets.every((target) => target.purged === 1)).toBe(true);

    const after = await invalidationStatus(d, "biz-1", "hr-salaries");
    expect(after.converged).toBe(true);
    expect(after.pendingTargets).toEqual([]);
  });

  it("resumes a failed job without re-purging what already converged", async () => {
    const d = deps();
    // The third target fails once; everything before it has already been purged.
    const failing = d.targets[2];
    if (failing === undefined) throw new Error("expected target");
    failing.failUntil = 1;

    const job = await enqueueInvalidation(d, {
      businessId: "biz-1",
      sourceId: "hr-salaries",
      trigger: "source_revoked",
    });

    const first = await runInvalidation(d, job.jobId);
    expect(first.status).toBe("pending");
    expect(first.failures).toEqual([{ kind: failing.kind }]);
    const midway = await invalidationStatus(d, "biz-1", "hr-salaries");
    expect(midway.converged).toBe(false);
    expect(midway.pendingTargets).toContain(failing.kind);

    const second = await runInvalidation(d, job.jobId);
    expect(second.status).toBe("complete");
    // Targets that already converged are not purged a second time.
    expect(d.targets[0]?.purged).toBe(1);
    expect(d.targets[1]?.purged).toBe(1);
    expect((await invalidationStatus(d, "biz-1", "hr-salaries")).converged).toBe(true);
  });

  it("reports failures as target kinds only, never as source ids or provider errors", async () => {
    const d = deps();
    const failing = d.targets[0];
    if (failing === undefined) throw new Error("expected target");
    failing.failUntil = 5;

    const job = await enqueueInvalidation(d, {
      businessId: "biz-1",
      sourceId: "hr-salaries",
      trigger: "source_deleted",
    });
    const outcome = await runInvalidation(d, job.jobId);

    expect(JSON.stringify(outcome.failures)).not.toContain("hr-salaries");
    expect(JSON.stringify(outcome.failures)).not.toContain("purge failed");
  });

  it("drains the whole queue and reports what has not converged", async () => {
    const d = deps();
    await enqueueInvalidation(d, {
      businessId: "biz-1",
      sourceId: "hr-salaries",
      trigger: "revision_change",
    });
    await enqueueInvalidation(d, {
      businessId: "biz-1",
      sourceId: "handbook",
      trigger: "revision_change",
    });

    const summary = await drainInvalidations(d);
    expect(summary.completed).toBe(2);
    expect(summary.pending).toBe(0);
  });
});

describe("source lifecycle propagation", () => {
  it("denies retrieval of a deleted source immediately, before invalidation converges", async () => {
    const sources = new InMemoryKnowledgeSourceStore([source()]);
    const index = new InMemoryKnowledgeIndex();
    await index.upsert({
      businessId: "biz-1",
      sourceId: "hr-salaries",
      chunkId: "hr-salaries#0",
      revision: "3",
      classification: ["restricted"],
      digest: "d".repeat(64),
      text: "jane doe base salary 210000",
    });
    const d = deps({ sources, targets: [] });

    await deleteSource(d, { businessId: "biz-1", sourceId: "hr-salaries" });

    const result = await retrieve(
      { sources, index, now },
      {
        businessId: "biz-1",
        principalId: "user-1",
        principals: [{ kind: "user", id: "user-1" }],
        query: "salary",
        limit: 5,
        guardrailEpoch: "g1",
        contextEpoch: "c1",
        correlationId: "corr-1",
      }
    );

    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "source_deleted", count: 1 }]);
    expect(JSON.stringify(result)).not.toContain("210000");
  });

  it("enqueues invalidation for deletion, revocation, and revision change alike", async () => {
    const d = deps();
    await deleteSource(d, { businessId: "biz-1", sourceId: "hr-salaries" });
    await revokeSource(d, { businessId: "biz-1", sourceId: "hr-salaries" });
    await syncSourceRevision(d, { businessId: "biz-1", sourceId: "hr-salaries", revision: "4" });

    const status = await invalidationStatus(d, "biz-1", "hr-salaries");
    expect(status.jobs).toBe(3);
    expect(status.converged).toBe(false);
  });

  it("treats a new ACL revision at the same content revision as an invalidation trigger", async () => {
    const d = deps();
    const result = await syncSourceRevision(d, {
      businessId: "biz-1",
      sourceId: "hr-salaries",
      revision: "3",
      acl: {
        aclRevision: "acl-2",
        capturedAt: NOW.toISOString(),
        principals: [{ kind: "user", id: "user-2" }],
      },
    });

    expect(result.outcome).toBe("propagated");
    if (result.outcome !== "propagated") return;
    expect(result.job.trigger).toBe("acl_change");
    // The stored access control moves to the new ACL revision, so cached answers keyed on the old
    // one can no longer validate.
    const stored = await d.sources.get("biz-1", "hr-salaries");
    expect(stored?.accessControl).toEqual({
      mode: "snapshot",
      aclRevision: "acl-2",
      maximumAgeSeconds: 3600,
    });
  });

  it("does not enqueue anything when a sync reports the same revision", async () => {
    const d = deps();
    await syncSourceRevision(d, { businessId: "biz-1", sourceId: "hr-salaries", revision: "3" });

    expect((await invalidationStatus(d, "biz-1", "hr-salaries")).jobs).toBe(0);
  });
});
