import { describe, expect, it } from "vitest";
import { InMemoryInvalidationQueue, invalidationStatus } from "./invalidate";
import type { KnowledgeSourceRecord } from "./source";
import { InMemoryKnowledgeSourceStore } from "./source";
import { enqueueStaleRevalidation, evaluateStaleness, selectStaleSources } from "./staleness";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

function source(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
  return {
    sourceId: "handbook",
    businessId: "biz-1",
    integrationId: "int-drive",
    provider: "google-drive",
    externalId: "handbook",
    externalTenantId: "tenant-1",
    ownerExternalId: "alice@example.com",
    revision: "3",
    classification: ["internal"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-1", maximumAgeSeconds: 300 },
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

function agedBy(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe("evaluateStaleness", () => {
  it("measures a snapshot ACL against its own maximum age", () => {
    const fresh = source({
      acl: {
        aclRevision: "acl-1",
        capturedAt: agedBy(60),
        principals: [{ kind: "user", id: "user-1" }],
      },
    });
    expect(evaluateStaleness(fresh, NOW)).toEqual({ stale: false, ageSeconds: 60 });

    const stale = source({
      acl: {
        aclRevision: "acl-1",
        capturedAt: agedBy(600),
        principals: [{ kind: "user", id: "user-1" }],
      },
    });
    expect(evaluateStaleness(stale, NOW)).toEqual({ stale: true, ageSeconds: 600 });
  });

  it("treats a snapshot source with no captured ACL as stale, not as fresh", () => {
    const missing = source({ acl: undefined });
    expect(evaluateStaleness(missing, NOW).stale).toBe(true);
  });

  it("measures a live source against its last sync, since it holds no cached ACL", () => {
    const live = source({
      accessControl: { mode: "live", maximumAgeSeconds: 60 },
      acl: undefined,
      lastSyncedAt: agedBy(600),
    });
    expect(evaluateStaleness(live, NOW)).toEqual({ stale: true, ageSeconds: 600 });
  });
});

describe("selectStaleSources", () => {
  it("selects only sources past their own TTL, and ignores deleted ones", async () => {
    const store = new InMemoryKnowledgeSourceStore([
      source(),
      source({
        sourceId: "old",
        acl: {
          aclRevision: "acl-1",
          capturedAt: agedBy(600),
          principals: [{ kind: "user", id: "user-1" }],
        },
      }),
      source({
        sourceId: "gone",
        status: "deleted",
        acl: {
          aclRevision: "acl-1",
          capturedAt: agedBy(9000),
          principals: [{ kind: "user", id: "user-1" }],
        },
      }),
    ]);

    const stale = await selectStaleSources({ sources: store }, "biz-1", NOW);
    expect(stale.map((entry) => entry.sourceId)).toEqual(["old"]);
  });
});

describe("enqueueStaleRevalidation", () => {
  it("enqueues durable revalidation so staleness converges instead of denying forever", async () => {
    const sources = new InMemoryKnowledgeSourceStore([
      source({
        sourceId: "old",
        acl: {
          aclRevision: "acl-1",
          capturedAt: agedBy(600),
          principals: [{ kind: "user", id: "user-1" }],
        },
      }),
    ]);
    let counter = 0;
    const deps = {
      sources,
      queue: new InMemoryInvalidationQueue(),
      now,
      newId: () => `job-${++counter}`,
    };

    const enqueued = await enqueueStaleRevalidation(deps, "biz-1");
    expect(enqueued).toBe(1);
    const status = await invalidationStatus(deps, "biz-1", "old");
    expect(status.jobs).toBe(1);
    expect(status.converged).toBe(false);

    // Replaying the sweep before the first job converges must not pile up duplicates.
    expect(await enqueueStaleRevalidation(deps, "biz-1")).toBe(0);
  });
});
