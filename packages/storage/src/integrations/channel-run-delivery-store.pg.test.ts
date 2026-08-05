import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import {
  CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS,
  ChannelRunDeliveryStore,
} from "./channel-run-delivery-store";

const BUSINESS_ID = "business-1";
const NOW = "2026-07-26T10:00:00.000Z";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

const delivery = {
  businessId: BUSINESS_ID,
  runId: "run-1",
  integrationId: "integration-1",
  routeId: "route-1",
  provider: "slack",
  destination: "C-OPS",
  threadId: "1720000000.000100",
  agentId: "agent-1",
  principalId: "user-1",
  idempotencyKey: "run-1",
};

describe("ChannelRunDeliveryStore", () => {
  let database: PGlite;
  let store: ChannelRunDeliveryStore;
  let now: string;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of CHANNEL_RUN_DELIVERY_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    store = new ChannelRunDeliveryStore(transactionPort(database), () => now);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE channel_run_deliveries");
    now = NOW;
  });

  it("creates a pending correlation row for a newly started Run", async () => {
    const record = await store.create(delivery);
    expect(record).toMatchObject({ runId: "run-1", status: "pending" });
  });

  it("lists only pending rows for the business", async () => {
    await store.create(delivery);
    await store.create({ ...delivery, businessId: "business-2", runId: "run-2" });
    await store.create({ ...delivery, runId: "run-3" });
    await store.markStatus(BUSINESS_ID, "run-3", "done");

    const pending = await store.listPending(BUSINESS_ID);
    expect(pending.map((row) => row.runId)).toEqual(["run-1"]);
  });

  it("finds the correlation row for a Run, or null when none exists", async () => {
    await store.create(delivery);
    const found = await store.find(BUSINESS_ID, "run-1");
    expect(found).toMatchObject({ provider: "slack", destination: "C-OPS" });
    expect(await store.find(BUSINESS_ID, "run-missing")).toBeNull();
  });

  it("transitions status and rejects an unknown Run", async () => {
    await store.create(delivery);
    const updated = await store.markStatus(BUSINESS_ID, "run-1", "done");
    expect(updated.status).toBe("done");

    await expect(store.markStatus(BUSINESS_ID, "run-missing", "done")).rejects.toThrow(
      "channel_run_delivery_not_found"
    );
  });

  it("records the placeholder Slack message ts for status-rotation updates", async () => {
    const created = await store.create(delivery);
    expect(created.slackMessageTs).toBeUndefined();

    const updated = await store.setSlackMessageTs(BUSINESS_ID, "run-1", "1720000000.000200");
    expect(updated.slackMessageTs).toBe("1720000000.000200");

    await expect(
      store.setSlackMessageTs(BUSINESS_ID, "run-missing", "1720000000.000200")
    ).rejects.toThrow("channel_run_delivery_not_found");
  });

  it("records which approval's prompt was posted, so a repost can be told apart from a repeat", async () => {
    const created = await store.create(delivery);
    expect(created.approvalPostedId).toBeUndefined();

    const updated = await store.setApprovalPosted(
      BUSINESS_ID,
      "run-1",
      "approval-1",
      "1720000000.000300"
    );
    expect(updated.approvalPostedId).toBe("approval-1");
    expect(updated.approvalMessageTs).toBe("1720000000.000300");

    await expect(
      store.setApprovalPosted(BUSINESS_ID, "run-missing", "approval-1", "1720000000.000300")
    ).rejects.toThrow("channel_run_delivery_not_found");
  });
});
