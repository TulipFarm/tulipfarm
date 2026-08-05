import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { CHANNEL_INBOUND_STORAGE_STATEMENTS, ChannelInboundStore } from "./channel-inbound-store";

const BUSINESS_ID = "business-1";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

describe("ChannelInboundStore", () => {
  let database: PGlite;
  let store: ChannelInboundStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of CHANNEL_INBOUND_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    store = new ChannelInboundStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE channel_inbound_events");
  });

  it("accepts the first delivery of an event and rejects a replay as a duplicate", async () => {
    const event = {
      businessId: BUSINESS_ID,
      provider: "slack",
      eventId: "Ev-1",
      deduplicationKey: "Ev-1",
      receivedAt: "2026-07-26T10:00:00.000Z",
    };

    expect(await store.accept(event)).toEqual({ outcome: "accepted" });
    expect(await store.accept(event)).toEqual({ outcome: "duplicate" });
  });

  it("scopes dedup by business and provider, not just the key", async () => {
    const base = {
      eventId: "Ev-1",
      deduplicationKey: "Ev-1",
      receivedAt: "2026-07-26T10:00:00.000Z",
    };

    expect(await store.accept({ ...base, businessId: BUSINESS_ID, provider: "slack" })).toEqual({
      outcome: "accepted",
    });
    expect(await store.accept({ ...base, businessId: BUSINESS_ID, provider: "telegram" })).toEqual({
      outcome: "accepted",
    });
    expect(await store.accept({ ...base, businessId: "business-2", provider: "slack" })).toEqual({
      outcome: "accepted",
    });
  });
});
