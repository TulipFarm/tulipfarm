import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  RawPayloadDiscardedError,
  WEBHOOK_INBOX_STORAGE_STATEMENTS,
  type WebhookDeliveryInput,
  WebhookInboxStore,
} from "./webhook-inbox-store";

const BUSINESS_ID = "business-1";

function input(id: string, overrides: Partial<WebhookDeliveryInput> = {}): WebhookDeliveryInput {
  return {
    id,
    integrationId: "weather",
    integrationMajorVersion: 1,
    connectionId: "connection-1",
    deduplicationKey: `key-${id}`,
    bodySha256: "a".repeat(64),
    safeHeaders: { "x-delivery-id": id },
    encryptedBody: "ciphertext",
    eventType: "forecast.updated",
    verification: "hmac_sha256",
    ...overrides,
  };
}

describe("WebhookInboxStore", () => {
  let database: PGlite;
  let store: WebhookInboxStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of WEBHOOK_INBOX_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    store = new WebhookInboxStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE webhook_deliveries");
  });

  it("persists a delivery as accepted before anything downstream runs", async () => {
    const recorded = await store.record(BUSINESS_ID, input("d-1"));

    expect(recorded.accepted).toBe(true);
    expect(recorded.delivery).toMatchObject({
      id: "d-1",
      state: "accepted",
      attempts: 0,
      eventType: "forecast.updated",
      safeHeaders: { "x-delivery-id": "d-1" },
    });
  });

  it("never stores a raw payload", async () => {
    const recorded = await store.record(BUSINESS_ID, input("d-1"));
    expect(recorded.delivery.encryptedBody).toBe("ciphertext");
    const { rows } = await database.query<{ encrypted_body: string }>(
      "SELECT encrypted_body FROM webhook_deliveries"
    );
    expect(rows[0]?.encrypted_body).toBe("ciphertext");
  });

  it("returns the original when a provider retries the same delivery", async () => {
    const first = await store.record(BUSINESS_ID, input("d-1", { deduplicationKey: "evt_9" }));
    const retry = await store.record(BUSINESS_ID, input("d-2", { deduplicationKey: "evt_9" }));

    expect(first.accepted).toBe(true);
    expect(retry.accepted).toBe(false);
    expect(retry.delivery.id).toBe("d-1");
    const { rows } = await database.query("SELECT id FROM webhook_deliveries");
    expect(rows).toHaveLength(1);
  });

  it("keeps a retry that reaches a different Integration", async () => {
    await store.record(BUSINESS_ID, input("d-1", { deduplicationKey: "evt_9" }));
    const other = await store.record(
      BUSINESS_ID,
      input("d-2", { deduplicationKey: "evt_9", integrationId: "billing" })
    );
    expect(other.accepted).toBe(true);
  });

  it("keeps a retry that reaches a different business", async () => {
    // Two instances sharing a database must not be able to swallow each other's deliveries.
    await store.record(BUSINESS_ID, input("d-1", { deduplicationKey: "evt_9" }));
    const other = await store.record("business-2", input("d-2", { deduplicationKey: "evt_9" }));
    expect(other.accepted).toBe(true);
  });

  it("keeps every delivery when the Integration declares no deduplication", async () => {
    await store.record(BUSINESS_ID, input("d-1", { deduplicationKey: null }));
    await store.record(BUSINESS_ID, input("d-2", { deduplicationKey: null }));
    const { rows } = await database.query("SELECT id FROM webhook_deliveries");
    expect(rows).toHaveLength(2);
  });

  it("leases due deliveries and counts the attempt", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    const claimed = await store.claim(10, 30);

    expect(claimed.map((row) => row.id)).toEqual(["d-1"]);
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed[0]?.leaseExpiresAt).not.toBeNull();
  });

  it("does not lease a delivery another worker holds", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.claim(10, 300);
    expect(await store.claim(10, 300)).toEqual([]);
  });

  it("re-leases a delivery whose worker died", async () => {
    // A lease is a deadline, not a lock: an expired one has to return the work to the pool.
    await store.record(BUSINESS_ID, input("d-1"));
    await store.claim(10, 30);

    const later = new Date(Date.now() + 60_000);
    expect((await store.claim(10, 30, later)).map((row) => row.id)).toEqual(["d-1"]);
  });

  it("stops leasing a delivery once it is normalized", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.claim(10, 30);
    await store.markNormalized(BUSINESS_ID, "d-1", { city: "Indore" });

    const stored = await store.findById(BUSINESS_ID, "d-1");
    expect(stored?.state).toBe("normalized");
    expect(stored?.normalizedPayload).toEqual({ city: "Indore" });
    expect(await store.claim(10, 30, new Date(Date.now() + 600_000))).toEqual([]);
  });

  it("returns a failed delivery to the queue until its attempts run out", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.claim(10, 30);

    const state = await store.markFailed(BUSINESS_ID, "d-1", "boom", {
      maxAttempts: 3,
      backoffSeconds: 0,
    });
    expect(state).toBe("accepted");
    expect((await store.findById(BUSINESS_ID, "d-1"))?.lastError).toBe("boom");
    expect((await store.claim(10, 30)).map((row) => row.id)).toEqual(["d-1"]);
  });

  it("holds a failed delivery back until its backoff has passed", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.claim(10, 30);
    await store.markFailed(BUSINESS_ID, "d-1", "boom", { maxAttempts: 3, backoffSeconds: 120 });

    expect(await store.claim(10, 30)).toEqual([]);
    expect((await store.claim(10, 30, new Date(Date.now() + 130_000))).map((r) => r.id)).toEqual([
      "d-1",
    ]);
  });

  it("dead-letters a delivery that has used its attempts", async () => {
    // A payload the Integration cannot normalize will not start being normalizable; retrying it
    // forever only hides it from whoever has to fix it.
    await store.record(BUSINESS_ID, input("d-1"));
    await store.claim(10, 30);
    const state = await store.markFailed(BUSINESS_ID, "d-1", "boom", {
      maxAttempts: 1,
      backoffSeconds: 0,
    });

    expect(state).toBe("dead_letter");
    expect(await store.claim(10, 30, new Date(Date.now() + 600_000))).toEqual([]);
    expect((await store.listDeadLettered(BUSINESS_ID)).map((row) => row.id)).toEqual(["d-1"]);
  });

  it("bounds the recorded failure so a provider cannot fill the table with one error", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.markFailed(BUSINESS_ID, "d-1", "x".repeat(5000), {
      maxAttempts: 3,
      backoffSeconds: 0,
    });
    expect((await store.findById(BUSINESS_ID, "d-1"))?.lastError).toHaveLength(2000);
  });

  it("replays a delivery as a new row that names the original", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.claim(10, 30);
    await store.markFailed(BUSINESS_ID, "d-1", "boom", { maxAttempts: 1, backoffSeconds: 0 });

    const replayed = await store.replay(BUSINESS_ID, "d-1", "d-1-replay");

    expect(replayed).toMatchObject({
      id: "d-1-replay",
      state: "accepted",
      attempts: 0,
      replayOfId: "d-1",
      deduplicationKey: null,
    });
    expect((await store.findById(BUSINESS_ID, "d-1"))?.state).toBe("dead_letter");
  });

  it("names the first delivery when a replay is itself replayed", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.replay(BUSINESS_ID, "d-1", "d-2");
    const third = await store.replay(BUSINESS_ID, "d-2", "d-3");
    expect(third?.replayOfId).toBe("d-1");
  });

  it("refuses to replay a delivery whose payload retention has expired", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    await store.discardRawPayloadsBefore(new Date(Date.now() + 1000));

    await expect(store.replay(BUSINESS_ID, "d-1", "d-2")).rejects.toBeInstanceOf(
      RawPayloadDiscardedError
    );
  });

  it("discards expired payloads but keeps the evidence the delivery arrived", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    const discarded = await store.discardRawPayloadsBefore(new Date(Date.now() + 1000));

    expect(discarded).toBe(1);
    const stored = await store.findById(BUSINESS_ID, "d-1");
    expect(stored?.encryptedBody).toBeNull();
    expect(stored?.rawDeletedAt).not.toBeNull();
    expect(stored?.bodySha256).toBe("a".repeat(64));
    expect(stored?.safeHeaders).toEqual({ "x-delivery-id": "d-1" });
  });

  it("leaves payloads inside the retention window alone", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    expect(await store.discardRawPayloadsBefore(new Date(Date.now() - 60_000))).toBe(0);
    expect((await store.findById(BUSINESS_ID, "d-1"))?.encryptedBody).toBe("ciphertext");
  });

  it("returns nothing for a delivery another business owns", async () => {
    await store.record(BUSINESS_ID, input("d-1"));
    expect(await store.findById("business-2", "d-1")).toBeNull();
    expect(await store.replay("business-2", "d-1", "d-2")).toBeNull();
  });
});
