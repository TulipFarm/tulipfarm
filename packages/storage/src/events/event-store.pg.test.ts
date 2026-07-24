import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import {
  EVENT_STORAGE_STATEMENTS,
  EventStore,
  OutboxLeaseError,
  type StoreEventInput,
} from "./event-store";

const FIRST_RECEIVED_AT = "2026-07-24T10:00:00.000Z";
const AFTER_LEASE = "2026-07-24T10:01:01.000Z";

function event(overrides: Partial<StoreEventInput> = {}): StoreEventInput {
  return {
    eventId: "event-1",
    type: "github.issue.created",
    version: 1,
    occurredAt: "2026-07-24T09:59:00.000Z",
    receivedAt: FIRST_RECEIVED_AT,
    businessId: "business-1",
    source: {
      provider: "github",
      integrationId: "integration-1",
      externalTenantId: "tenant-1",
      deliveryId: "delivery-1",
    },
    principal: { kind: "service", internalId: "principal-1" },
    record: { type: "Issue", id: "42", version: "1" },
    deduplicationKey: "delivery-1",
    classification: ["internal"],
    data: { action: "opened" },
    rawArtifactId: "artifact-1",
    rawPayloadHash: "sha256:abc",
    verification: { status: "verified", method: "hmac-sha256" },
    ...overrides,
  };
}

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("EventStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: EventStore;
  let nextId: () => string;

  beforeAll(async () => {
    database = await PGlite.create();
    for (const statement of EVENT_STORAGE_STATEMENTS) {
      await database.query(statement);
    }
  }, 60_000);

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE events_inbox CASCADE");
    let id = 0;
    nextId = () => {
      id += 1;
      return `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`;
    };
    store = new EventStore(transactionPort(database), nextId);
  });

  afterAll(async () => {
    await database.close();
  });

  it("atomically persists the canonical event, raw references, and outbox before ack", async () => {
    const accepted = await store.accept(event());

    expect(accepted.outcome).toBe("accepted");
    const inbox = await database.query<{
      canonical_event: StoreEventInput;
      raw_artifact_id: string;
      raw_payload_hash: string;
    }>("SELECT canonical_event, raw_artifact_id, raw_payload_hash FROM events_inbox");
    expect(inbox.rows[0]?.canonical_event).toEqual(event());
    expect(inbox.rows[0]?.raw_artifact_id).toBe("artifact-1");
    expect(inbox.rows[0]?.raw_payload_hash).toBe("sha256:abc");

    const outbox = await database.query<{ inbox_id: string }>(
      "SELECT inbox_id FROM outbox_messages"
    );
    expect(outbox.rows).toEqual([{ inbox_id: accepted.event.id }]);
  });

  it("rolls back the inbox when creating its outbox message fails", async () => {
    const failingTransactions: TransactionPort = {
      withTransaction: (operation) =>
        database.transaction((transaction) =>
          operation({
            query: (text, params) => {
              if (text.includes("INSERT INTO outbox_messages")) {
                throw new Error("injected outbox failure");
              }
              return (transaction as Queryable).query(text, params);
            },
          })
        ),
    };

    await expect(new EventStore(failingTransactions, nextId).accept(event())).rejects.toThrow(
      "injected outbox failure"
    );
    expect((await database.query("SELECT id FROM events_inbox")).rows).toEqual([]);
  });

  it("deduplicates concurrent delivery retries without creating another logical event", async () => {
    const results = await Promise.all([
      store.accept(event()),
      store.accept(event({ eventId: "event-retry-1" })),
      store.accept(event({ eventId: "event-retry-2" })),
    ]);

    expect(results.filter((result) => result.outcome === "accepted")).toHaveLength(1);
    expect(new Set(results.map((result) => result.event.id))).toHaveLength(1);
    expect((await database.query("SELECT id FROM events_inbox")).rows).toHaveLength(1);
    expect((await database.query("SELECT id FROM outbox_messages")).rows).toHaveLength(1);
  });

  it("isolates identical source deduplication keys between businesses", async () => {
    const first = await store.accept(event());
    const second = await store.accept(event({ eventId: "event-2", businessId: "business-2" }));

    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("accepted");
    expect(second.event.id).not.toBe(first.event.id);
  });

  it("does not lease another business's outbox message", async () => {
    await store.accept(event({ businessId: "business-2" }));

    expect(
      await store.claim({
        businessId: "business-1",
        owner: "worker-1",
        now: FIRST_RECEIVED_AT,
        leaseDurationMs: 60_000,
        limit: 1,
      })
    ).toEqual([]);
  });

  it("recovers an expired lease with the same stable message identity", async () => {
    await store.accept(event());
    const first = await store.claim({
      businessId: "business-1",
      owner: "worker-crashed",
      now: FIRST_RECEIVED_AT,
      leaseDurationMs: 60_000,
      limit: 1,
    });
    expect(first).toHaveLength(1);

    expect(
      await store.claim({
        businessId: "business-1",
        owner: "worker-early",
        now: "2026-07-24T10:00:30.000Z",
        leaseDurationMs: 60_000,
        limit: 1,
      })
    ).toEqual([]);

    const recovered = await store.claim({
      businessId: "business-1",
      owner: "worker-recovery",
      now: AFTER_LEASE,
      leaseDurationMs: 60_000,
      limit: 1,
    });
    expect(recovered[0]?.id).toBe(first[0]?.id);
    expect(recovered[0]?.attempts).toBe(2);
  });

  it("records a receipt and dispatch outcome atomically and idempotently", async () => {
    await store.accept(event());
    const [message] = await store.claim({
      businessId: "business-1",
      owner: "worker-1",
      now: FIRST_RECEIVED_AT,
      leaseDurationMs: 60_000,
      limit: 1,
    });
    if (!message) throw new Error("expected a claimed message");

    expect(await store.complete(message.businessId, message.id, "worker-1", "trigger-router")).toBe(
      "recorded"
    );
    expect(await store.complete(message.businessId, message.id, "worker-1", "trigger-router")).toBe(
      "duplicate"
    );
    expect((await database.query("SELECT id FROM consumer_receipts")).rows).toHaveLength(1);
    expect(
      (await database.query<{ status: string }>("SELECT status FROM outbox_messages")).rows[0]
        ?.status
    ).toBe("dispatched");
  });

  it("quarantines exhausted dispatches with safe evidence and rejects a foreign lease owner", async () => {
    await store.accept(event());
    const [message] = await store.claim({
      businessId: "business-1",
      owner: "worker-1",
      now: FIRST_RECEIVED_AT,
      leaseDurationMs: 60_000,
      limit: 1,
    });
    if (!message) throw new Error("expected a claimed message");

    await expect(
      store.fail(message.businessId, message.id, "worker-other", {
        code: "handler_failed",
        maxAttempts: 1,
        quarantineOwner: "integration-operations",
        replayEligible: true,
      })
    ).rejects.toEqual(new OutboxLeaseError("lease_not_owned"));

    expect(
      await store.fail(message.businessId, message.id, "worker-1", {
        code: "handler_failed",
        evidenceRef: "audit-event-1",
        maxAttempts: 1,
        quarantineOwner: "integration-operations",
        replayEligible: true,
      })
    ).toBe("quarantined");
    const quarantine = await database.query<{
      reason_code: string;
      evidence_ref: string;
      owner: string;
      replay_eligible: boolean;
    }>("SELECT reason_code, evidence_ref, owner, replay_eligible FROM quarantine_records");
    expect(quarantine.rows).toEqual([
      {
        reason_code: "handler_failed",
        evidence_ref: "audit-event-1",
        owner: "integration-operations",
        replay_eligible: true,
      },
    ]);
  });
});
