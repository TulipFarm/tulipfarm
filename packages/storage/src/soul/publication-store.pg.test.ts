import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import {
  PgSoulPublicationStore,
  SOUL_PUBLICATION_STORAGE_STATEMENTS,
  type SoulPublicationRecord,
} from "./publication-store";

const BUSINESS = "business-1";

function transactions(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function record(overrides: Partial<SoulPublicationRecord> = {}): SoulPublicationRecord {
  return {
    changesetId: "changeset-1",
    businessId: BUSINESS,
    commitSha: "commit-1",
    digest: "digest-1",
    stage: "committed",
    attempts: 0,
    ...overrides,
  };
}

describe("PgSoulPublicationStore", () => {
  let database: PGlite;
  let store: PgSoulPublicationStore;

  beforeEach(async () => {
    database = new PGlite();
    for (const statement of SOUL_PUBLICATION_STORAGE_STATEMENTS) {
      await database.query(statement);
    }
    store = new PgSoulPublicationStore(transactions(database));
  });

  it("commits a publication, projection, activation, and outbox acknowledgement", async () => {
    await store.withTransaction(async (transaction) => {
      await transaction.putPublication(record());
      await transaction.replaceProjection(BUSINESS, [
        {
          businessId: BUSINESS,
          digest: "digest-1",
          kind: "Routine",
          id: "routine-1",
          slug: "daily",
          authoredVersion: 1,
          hash: "hash-1",
        },
      ]);
      await transaction.enqueue({
        id: "changeset-1:publish",
        businessId: BUSINESS,
        changesetId: "changeset-1",
        topic: "soul.publication.requested",
      });
      await transaction.setActiveDigest(BUSINESS, "digest-1");
    });

    await store.withTransaction(async (transaction) => {
      expect(await transaction.getPublication("changeset-1")).toEqual(record());
      expect(await transaction.findPublicationByDigest(BUSINESS, "digest-1")).toEqual(record());
      expect(await transaction.listProjection(BUSINESS)).toEqual([
        expect.objectContaining({ kind: "Routine", slug: "daily" }),
      ]);
      expect(await transaction.getActiveDigest(BUSINESS)).toBe("digest-1");
      expect(await transaction.pendingOutbox(10)).toHaveLength(1);
      await transaction.markConsumed("changeset-1:publish", "worker-1");
      await transaction.markConsumed("changeset-1:publish", "worker-2");
      expect(await transaction.pendingOutbox(10)).toEqual([]);
    });

    const consumed = await database.query<{ consumed_by: string }>(
      "SELECT consumed_by FROM soul_publication_outbox WHERE id = 'changeset-1:publish'"
    );
    expect(consumed.rows[0]?.consumed_by).toBe("worker-1");
  });

  it("rolls back the entire publication transaction on failure", async () => {
    await expect(
      store.withTransaction(async (transaction) => {
        await transaction.putPublication(record());
        await transaction.setActiveDigest(BUSINESS, "digest-1");
        throw new Error("stop");
      })
    ).rejects.toThrow("stop");

    await store.withTransaction(async (transaction) => {
      expect(await transaction.getPublication("changeset-1")).toBeUndefined();
      expect(await transaction.getActiveDigest(BUSINESS)).toBeUndefined();
    });
  });

  it("atomically replaces one business projection", async () => {
    const definition = {
      businessId: BUSINESS,
      digest: "digest-1",
      kind: "Routine",
      id: "routine-1",
      slug: "daily",
      authoredVersion: 1,
      hash: "hash-1",
    };
    await store.withTransaction((transaction) =>
      transaction.replaceProjection(BUSINESS, [definition])
    );
    await store.withTransaction((transaction) =>
      transaction.replaceProjection(BUSINESS, [
        { ...definition, digest: "digest-2", authoredVersion: 2, hash: "hash-2" },
      ])
    );

    await store.withTransaction(async (transaction) => {
      expect(await transaction.listProjection(BUSINESS)).toEqual([
        { ...definition, digest: "digest-2", authoredVersion: 2, hash: "hash-2" },
      ]);
    });
  });
});
