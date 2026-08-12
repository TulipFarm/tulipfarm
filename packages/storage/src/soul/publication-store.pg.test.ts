import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import {
  PgSoulPublicationStore,
  SOUL_PUBLICATION_STORAGE_STATEMENTS,
  type SoulPublicationRecord,
  StaleActivationError,
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
    actorPrincipalId: "user-1",
    attempts: 0,
    ...overrides,
  };
}

function activation(digest: string, activatedByPrincipalId = "user-1") {
  return { businessId: BUSINESS, digest, activatedByPrincipalId };
}

async function insertBundle(
  database: PGlite,
  digest: string,
  businessId = BUSINESS
): Promise<void> {
  await database.query(
    `INSERT INTO soul_execution_bundles (digest, business_id)
     VALUES ($1, $2)
     ON CONFLICT (digest) DO NOTHING`,
    [digest, businessId]
  );
}

describe("PgSoulPublicationStore", () => {
  let database: PGlite;
  let store: PgSoulPublicationStore;

  beforeEach(async () => {
    database = new PGlite();
    for (const statement of SOUL_PUBLICATION_STORAGE_STATEMENTS) {
      await database.query(statement);
    }
    await database.query(`CREATE TABLE IF NOT EXISTS soul_execution_bundles (
      digest text PRIMARY KEY,
      business_id text NOT NULL,
      UNIQUE (business_id, digest)
    )`);
    store = new PgSoulPublicationStore(transactions(database));
  });

  it("commits a publication, projection, activation, and outbox acknowledgement", async () => {
    await insertBundle(database, "digest-1");

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
      await transaction.setActiveDigest(activation("digest-1"));
    });

    await store.withTransaction(async (transaction) => {
      expect(await transaction.getPublication("changeset-1")).toMatchObject(record());
      expect(await transaction.findPublicationByDigest(BUSINESS, "digest-1")).toMatchObject(
        record()
      );
      expect(await transaction.listProjection(BUSINESS)).toEqual([
        expect.objectContaining({ kind: "Routine", slug: "daily" }),
      ]);
      expect(await transaction.getActiveDigest(BUSINESS)).toBe("digest-1");
      expect(await transaction.listActivationHistory(BUSINESS, 10)).toEqual([
        expect.objectContaining({ digest: "digest-1", activatedByPrincipalId: "user-1" }),
      ]);
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
    await insertBundle(database, "digest-1");

    await expect(
      store.withTransaction(async (transaction) => {
        await transaction.putPublication(record());
        await transaction.setActiveDigest(activation("digest-1"));
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

  it("claims only due, unleased outbox rows", async () => {
    await store.withTransaction(async (transaction) => {
      await transaction.putPublication(record());
      await transaction.enqueue({
        id: "changeset-1:publish",
        businessId: BUSINESS,
        changesetId: "changeset-1",
        topic: "soul.publication.requested",
      });
    });

    await store.withTransaction(async (transaction) => {
      expect(
        await transaction.claimOutbox({
          consumer: "worker-1",
          max: 10,
          now: "2027-01-01T00:00:00.000Z",
          leaseExpiresAt: "2027-01-01T00:01:00.000Z",
        })
      ).toEqual([expect.objectContaining({ id: "changeset-1:publish", claimedBy: "worker-1" })]);
    });

    await store.withTransaction(async (transaction) => {
      expect(
        await transaction.claimOutbox({
          consumer: "worker-2",
          max: 10,
          now: "2027-01-01T00:00:30.000Z",
          leaseExpiresAt: "2027-01-01T00:01:30.000Z",
        })
      ).toEqual([]);
      expect(
        await transaction.claimOutbox({
          consumer: "worker-2",
          max: 10,
          now: "2027-01-01T00:01:01.000Z",
          leaseExpiresAt: "2027-01-01T00:02:01.000Z",
        })
      ).toEqual([expect.objectContaining({ id: "changeset-1:publish", claimedBy: "worker-2" })]);
    });
  });

  it("refuses stale activation after a newer publication is active", async () => {
    await insertBundle(database, "digest-1");
    await insertBundle(database, "digest-2");

    await store.withTransaction(async (transaction) => {
      await transaction.putPublication(record({ changesetId: "changeset-1", digest: "digest-1" }));
      await transaction.putPublication(record({ changesetId: "changeset-2", digest: "digest-2" }));
      await transaction.setActiveDigest(activation("digest-2"));
      await expect(transaction.setActiveDigest(activation("digest-1"))).rejects.toBeInstanceOf(
        StaleActivationError
      );
      expect(await transaction.getActiveDigest(BUSINESS)).toBe("digest-2");
    });
  });

  // The stale and missing cases were once a single "stale_or_missing" error, which forced the
  // caller to treat benign supersession as a hard failure. Keep them provably distinct.
  it("distinguishes a missing bundle from a stale activation", async () => {
    await store.withTransaction(async (transaction) => {
      await expect(transaction.setActiveDigest(activation("digest-absent"))).rejects.toThrow(
        "missing_bundle_for_activation"
      );
      await expect(
        transaction.setActiveDigest(activation("digest-absent"))
      ).rejects.not.toBeInstanceOf(StaleActivationError);
    });
  });

  it("force-activates older publications with new history rows and operator attribution", async () => {
    await insertBundle(database, "digest-1");
    await insertBundle(database, "digest-2");

    await store.withTransaction(async (transaction) => {
      await transaction.putPublication(record({ changesetId: "changeset-1", digest: "digest-1" }));
      await transaction.putPublication(record({ changesetId: "changeset-2", digest: "digest-2" }));
      await transaction.setActiveDigest(activation("digest-2", "publisher-2"));
      await transaction.forceActivateDigest(activation("digest-1", "operator-1"));
      await transaction.forceActivateDigest(activation("digest-2", "operator-2"));
      await transaction.forceActivateDigest(activation("digest-1", "operator-1"));
    });

    await store.withTransaction(async (transaction) => {
      expect(await transaction.getActiveDigest(BUSINESS)).toBe("digest-1");
      expect(await transaction.listActivationHistory(BUSINESS, 10)).toEqual([
        expect.objectContaining({
          digest: "digest-1",
          activationSequence: 4,
          activatedByPrincipalId: "operator-1",
        }),
        expect.objectContaining({
          digest: "digest-2",
          activationSequence: 3,
          activatedByPrincipalId: "operator-2",
        }),
        expect.objectContaining({
          digest: "digest-1",
          activationSequence: 2,
          activatedByPrincipalId: "operator-1",
        }),
        expect.objectContaining({
          digest: "digest-2",
          activationSequence: 1,
          activatedByPrincipalId: "publisher-2",
        }),
      ]);
    });
  });

  it("records retry timing and dead letters without changing stage", async () => {
    await store.withTransaction(async (transaction) => {
      await transaction.putPublication(record());
      await transaction.recordFailure({
        changesetId: "changeset-1",
        failureCode: "PROJECTION_FAILED",
        nextAttemptAt: "2027-01-01T00:05:00.000Z",
        deadLetteredAt: "2027-01-01T00:00:00.000Z",
        deadLetterReason: "max_attempts_exceeded",
      });
    });

    await store.withTransaction(async (transaction) => {
      expect(await transaction.listDeadLetters({ businessId: BUSINESS, max: 10 })).toEqual([
        expect.objectContaining({
          changesetId: "changeset-1",
          stage: "committed",
          attempts: 1,
          nextAttemptAt: "2027-01-01T00:05:00.000Z",
          deadLetterReason: "max_attempts_exceeded",
        }),
      ]);
      expect(await transaction.pendingOutbox(10)).toEqual([]);
    });
  });
});
