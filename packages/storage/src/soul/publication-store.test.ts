import { describe, expect, it } from "vitest";
import {
  InMemorySoulPublicationStore,
  type SoulPublicationRecord,
  StaleActivationError,
} from "./publication-store";

const BUSINESS = "biz-1";

function record(overrides: Partial<SoulPublicationRecord> = {}): SoulPublicationRecord {
  return {
    changesetId: "cs-1",
    businessId: BUSINESS,
    commitSha: "c0ffee",
    digest: "digest-1",
    stage: "committed",
    actorPrincipalId: "user-1",
    attempts: 0,
    ...overrides,
  };
}

function activation(digest: string, activatedByPrincipalId = "user-1") {
  return { businessId: BUSINESS, digest, activatedByPrincipalId };
}

describe("InMemorySoulPublicationStore", () => {
  it("rolls back every write when the transaction throws", async () => {
    const store = new InMemorySoulPublicationStore();

    await expect(
      store.withTransaction(async (tx) => {
        await tx.putPublication(record());
        await tx.setActiveDigest(activation("digest-1"));
        await tx.enqueue({
          id: "cs-1:publish",
          businessId: BUSINESS,
          changesetId: "cs-1",
          topic: "soul.publication.requested",
        });
        throw new Error("crash before commit");
      })
    ).rejects.toThrow("crash before commit");

    await store.withTransaction(async (tx) => {
      expect(await tx.getPublication("cs-1")).toBeUndefined();
      expect(await tx.getActiveDigest(BUSINESS)).toBeUndefined();
      expect(await tx.pendingOutbox(10)).toEqual([]);
    });
  });

  it("claims with a lease, reclaims after expiry, and keeps the first consumer", async () => {
    const store = new InMemorySoulPublicationStore();
    await store.withTransaction(async (tx) => {
      await tx.putPublication(record());
      await tx.enqueue({
        id: "cs-1:publish",
        businessId: BUSINESS,
        changesetId: "cs-1",
        topic: "soul.publication.requested",
      });
    });

    await store.withTransaction(async (tx) => {
      expect(
        await tx.claimOutbox({
          consumer: "worker-1",
          max: 10,
          now: "2027-01-01T00:00:00.000Z",
          leaseExpiresAt: "2027-01-01T00:01:00.000Z",
        })
      ).toHaveLength(1);
      expect(
        await tx.claimOutbox({
          consumer: "worker-2",
          max: 10,
          now: "2027-01-01T00:00:30.000Z",
          leaseExpiresAt: "2027-01-01T00:01:30.000Z",
        })
      ).toEqual([]);
      expect(
        await tx.claimOutbox({
          consumer: "worker-2",
          max: 10,
          now: "2027-01-01T00:01:01.000Z",
          leaseExpiresAt: "2027-01-01T00:02:01.000Z",
        })
      ).toEqual([expect.objectContaining({ claimedBy: "worker-2" })]);
      await tx.markConsumed("cs-1:publish", "worker-1");
      expect(await tx.pendingOutbox(10)).toHaveLength(1);
      await tx.markConsumed("cs-1:publish", "worker-2");
      await tx.markConsumed("cs-1:publish", "worker-3");
      expect(await tx.pendingOutbox(10)).toEqual([]);
    });
  });

  it("ignores a duplicate enqueue of the same message id", async () => {
    const store = new InMemorySoulPublicationStore();
    const message = {
      id: "cs-1:publish",
      businessId: BUSINESS,
      changesetId: "cs-1",
      topic: "soul.publication.requested",
    };

    await store.withTransaction(async (tx) => {
      await tx.putPublication(record());
      await tx.enqueue(message);
      await tx.enqueue(message);
      expect(await tx.pendingOutbox(10)).toHaveLength(1);
    });
  });

  it("replaces the projection rather than appending to it", async () => {
    const store = new InMemorySoulPublicationStore();
    const row = {
      businessId: BUSINESS,
      digest: "digest-1",
      kind: "ModelProfile",
      id: "id-fast",
      slug: "fast",
      authoredVersion: 1,
      hash: "hash-1",
    };

    await store.withTransaction(async (tx) => {
      await tx.replaceProjection(BUSINESS, [row]);
      await tx.replaceProjection(BUSINESS, [{ ...row, digest: "digest-2", authoredVersion: 2 }]);
    });

    const projection = await store.withTransaction((tx) => tx.listProjection(BUSINESS));
    expect(projection).toEqual([{ ...row, digest: "digest-2", authoredVersion: 2 }]);
  });

  it("finds the publication behind a digest and isolates businesses", async () => {
    const store = new InMemorySoulPublicationStore();

    await store.withTransaction(async (tx) => {
      await tx.putPublication(record());
      await tx.putPublication(
        record({ changesetId: "cs-2", businessId: "biz-2", digest: "digest-2" })
      );
    });

    await store.withTransaction(async (tx) => {
      expect(await tx.findPublicationByDigest(BUSINESS, "digest-1")).toMatchObject({
        changesetId: "cs-1",
      });
      expect(await tx.findPublicationByDigest(BUSINESS, "digest-2")).toBeUndefined();
      expect(await tx.getActiveDigest("biz-2")).toBeUndefined();
    });
  });

  it("rejects a second publication that reuses a digest under a new changeset", async () => {
    const store = new InMemorySoulPublicationStore();

    await store.withTransaction(async (tx) => {
      await tx.putPublication(record({ changesetId: "cs-1", digest: "digest-1" }));
      // Postgres enforces UNIQUE (business_id, digest); the in-memory store must too, or this
      // class of bug passes in tests while a revert raises a unique violation in production.
      await expect(
        tx.putPublication(record({ changesetId: "cs-2", digest: "digest-1" }))
      ).rejects.toThrow();
      expect(await tx.getPublication("cs-2")).toBeUndefined();
    });
  });

  it("still updates an existing publication row without tripping digest uniqueness", async () => {
    const store = new InMemorySoulPublicationStore();

    await store.withTransaction(async (tx) => {
      await tx.putPublication(
        record({ changesetId: "cs-1", digest: "digest-1", stage: "committed" })
      );
      await tx.putPublication(
        record({ changesetId: "cs-1", digest: "digest-1", stage: "projected" })
      );
      expect(await tx.getPublication("cs-1")).toMatchObject({ stage: "projected" });
    });
  });

  it("refuses to move the active digest backwards", async () => {
    const store = new InMemorySoulPublicationStore();

    await store.withTransaction(async (tx) => {
      await tx.putPublication(record({ changesetId: "cs-1", digest: "digest-1" }));
      await tx.putPublication(record({ changesetId: "cs-2", digest: "digest-2" }));
      await tx.setActiveDigest(activation("digest-2"));
      await expect(tx.setActiveDigest(activation("digest-1"))).rejects.toBeInstanceOf(
        StaleActivationError
      );
      expect(await tx.getActiveDigest(BUSINESS)).toBe("digest-2");
      expect(await tx.listActivationHistory(BUSINESS, 10)).toEqual([
        expect.objectContaining({ digest: "digest-2", activationSequence: 1 }),
      ]);
    });
  });

  it("force-activates older publications, records each event, and attributes the operator", async () => {
    const store = new InMemorySoulPublicationStore();

    await store.withTransaction(async (tx) => {
      await tx.putPublication(record({ changesetId: "cs-1", digest: "digest-1" }));
      await tx.putPublication(record({ changesetId: "cs-2", digest: "digest-2" }));
      await tx.setActiveDigest(activation("digest-2", "publisher-2"));
      await tx.forceActivateDigest(activation("digest-1", "operator-1"));
      await tx.forceActivateDigest(activation("digest-2", "operator-2"));
      await tx.forceActivateDigest(activation("digest-1", "operator-1"));
    });

    await store.withTransaction(async (tx) => {
      expect(await tx.getActiveDigest(BUSINESS)).toBe("digest-1");
      expect(await tx.listActivationHistory(BUSINESS, 10)).toEqual([
        expect.objectContaining({
          digest: "digest-1",
          activationSequence: 4,
          activatedByPrincipalId: "operator-1",
        }),
        expect.objectContaining({ digest: "digest-2", activationSequence: 3 }),
        expect.objectContaining({
          digest: "digest-1",
          activationSequence: 2,
          activatedByPrincipalId: "operator-1",
        }),
        expect.objectContaining({ digest: "digest-2", activationSequence: 1 }),
      ]);
    });
  });

  it("keeps dead-letter as a terminal flag instead of a stage", async () => {
    const store = new InMemorySoulPublicationStore();

    await store.withTransaction(async (tx) => {
      await tx.putPublication(record());
      await tx.recordFailure({
        changesetId: "cs-1",
        failureCode: "PROJECTION_FAILED",
        nextAttemptAt: "2027-01-01T00:05:00.000Z",
        deadLetteredAt: "2027-01-01T00:00:00.000Z",
        deadLetterReason: "max_attempts_exceeded",
      });
      expect(await tx.listDeadLetters({ businessId: BUSINESS, max: 10 })).toEqual([
        expect.objectContaining({
          changesetId: "cs-1",
          stage: "committed",
          attempts: 1,
          deadLetterReason: "max_attempts_exceeded",
        }),
      ]);
    });
  });
});
