import { describe, expect, it } from "vitest";
import { InMemorySoulPublicationStore, type SoulPublicationRecord } from "./publication-store";

const BUSINESS = "biz-1";

function record(overrides: Partial<SoulPublicationRecord> = {}): SoulPublicationRecord {
  return {
    changesetId: "cs-1",
    businessId: BUSINESS,
    commitSha: "c0ffee",
    digest: "digest-1",
    stage: "committed",
    attempts: 0,
    ...overrides,
  };
}

describe("InMemorySoulPublicationStore", () => {
  it("rolls back every write when the transaction throws", async () => {
    const store = new InMemorySoulPublicationStore();

    await expect(
      store.withTransaction(async (tx) => {
        await tx.putPublication(record());
        await tx.setActiveDigest(BUSINESS, "digest-1");
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

  it("hides consumed messages and keeps the first consumer", async () => {
    const store = new InMemorySoulPublicationStore();
    await store.withTransaction((tx) =>
      tx.enqueue({
        id: "cs-1:publish",
        businessId: BUSINESS,
        changesetId: "cs-1",
        topic: "soul.publication.requested",
      })
    );

    await store.withTransaction(async (tx) => {
      expect(await tx.pendingOutbox(10)).toHaveLength(1);
      await tx.markConsumed("cs-1:publish", "worker-1");
      await tx.markConsumed("cs-1:publish", "worker-2");
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
});
