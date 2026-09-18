import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  NATIVE_CHANNEL_INBOX_STORAGE_STATEMENTS,
  type NativeChannelInboxInput,
  NativeChannelInboxStore,
} from "./native-channel-inbox-store";

describe("NativeChannelInboxStore", () => {
  let db: PGlite;
  let store: NativeChannelInboxStore;
  const event: NativeChannelInboxInput = {
    id: "event-1",
    businessId: "business-1",
    provider: "github",
    integrationId: "installation-1",
    externalAppId: "123",
    externalTenantId: "456",
    deliveryId: "delivery-1",
    payloadDigest: "signed-payload-digest",
    eventType: "issue_comment",
    payload: { action: "created" },
    binding: { snapshotHash: "reviewed-route" },
  };
  beforeAll(async () => {
    db = new PGlite();
    for (const statement of NATIVE_CHANNEL_INBOX_STORAGE_STATEMENTS) await db.exec(statement);
    store = new NativeChannelInboxStore(transactionPort(db));
  });
  beforeEach(async () => {
    await db.query("TRUNCATE native_channel_inbox, native_channel_routine_routes");
  });
  afterAll(async () => {
    await db.close();
  });

  it("persists an accepted event and deduplicates unsigned delivery-header substitutions", async () => {
    expect((await store.accept(event)).outcome).toBe("accepted");
    const replay = await store.accept({ ...event, id: "other-id", deliveryId: "forged-header" });
    expect(replay.outcome).toBe("duplicate");
    expect(replay.event.id).toBe(event.id);
    expect((await store.find(event.businessId, event.id))?.payload).toEqual(event.payload);
    await expect(
      store.accept({ ...event, id: "conflict", payloadDigest: "different-payload" })
    ).rejects.toThrow("native_delivery_conflict");
  });

  it("recovers expired claims and fences all stale acknowledgements and Run bindings", async () => {
    await store.accept(event);
    const now = new Date(Date.now() + 1000);
    const [first] = await store.claim(event.businessId, "lease-1", 20, now);
    expect(first.id).toBe(event.id);
    expect(await store.claim(event.businessId, "other-worker", 20, now)).toEqual([]);
    const recoveredAt = new Date(now.getTime() + 121_000);
    const [second] = await store.claim(event.businessId, "lease-2", 20, recoveredAt);
    expect(second.attempts).toBe(2);
    await expect(store.assertClaim(first, recoveredAt)).rejects.toThrow(
      "native_delivery_lease_lost"
    );
    await expect(store.bindRun(first, "stale-run", recoveredAt)).rejects.toThrow(
      "native_delivery_lease_lost"
    );
    expect(await store.finish(first, { status: "dispatched" }, recoveredAt)).toBe(false);
    await store.bindRun(second, "run-1", recoveredAt);
    expect(await store.finish(second, { status: "dispatched" }, recoveredAt)).toBe(true);
    expect((await store.findByRun(event.businessId, "run-1"))?.status).toBe("dispatched");
    expect(await store.findByRun("another-business", "run-1")).toBeUndefined();
  });

  it("retains a Run binding on retry so dispatch can repair its delivery without minting twice", async () => {
    await store.accept(event);
    const now = new Date(Date.now() + 1000);
    const [first] = await store.claim(event.businessId, "lease-1", 1, now);
    await store.bindRun(first, "run-1", now);
    await store.finish(first, { status: "retry", code: "delivery_store_unavailable" }, now);
    expect(await store.claim(event.businessId, "lease-2", 1, now)).toEqual([]);
    const [second] = await store.claim(
      event.businessId,
      "lease-2",
      1,
      new Date(now.getTime() + 11_000)
    );
    expect(second.runId).toBe("run-1");
  });

  it.each([false, true])(
    "joins the invocation transaction without opening another transaction (rollback: %s)",
    async (rollback) => {
      await store.accept(event);
      const now = new Date(Date.now() + 1000);
      const [claimed] = await store.claim(event.businessId, "lease", 1, now);
      const enlistedStore = new NativeChannelInboxStore({
        withTransaction: async () => {
          throw new Error("binding must join the existing transaction");
        },
      });
      const operation = transactionPort(db).withTransaction(async (transaction) => {
        await enlistedStore.bindRun(claimed, "atomic-run", now, transaction);
        const result = await transaction.query<{ run_id: string }>(
          "SELECT run_id FROM native_channel_inbox WHERE business_id=$1 AND id=$2",
          [event.businessId, event.id]
        );
        expect(result.rows[0].run_id).toBe("atomic-run");
        if (rollback) throw new Error("invocation transaction aborted");
      });
      if (rollback) await expect(operation).rejects.toThrow("invocation transaction aborted");
      else await operation;
      expect((await store.find(event.businessId, event.id))?.runId).toBe(
        rollback ? null : "atomic-run"
      );
    }
  );

  it("rejects unbounded drains and isolates provider installations", async () => {
    await store.accept(event);
    expect(
      (await store.accept({ ...event, id: "event-2", externalTenantId: "another-installation" }))
        .outcome
    ).toBe("accepted");
    await expect(store.claim(event.businessId, "lease", 21)).rejects.toThrow(
      "native_claim_limit_invalid"
    );
  });

  it("stores draft Routine destinations without granting execution", async () => {
    const route = {
      id: "route-1",
      businessId: event.businessId,
      provider: "github" as const,
      integrationId: event.integrationId,
      destination: "business/project",
      eventType: "github.push",
      routineId: "routine-1",
      enabled: false,
      authority: null,
    };
    await store.putRoutineRoute(route);
    expect(await store.routineRoutes(event.businessId, "github")).toEqual([route]);
    await expect(store.putRoutineRoute({ ...route, enabled: true })).rejects.toThrow();
    await store.putRoutineRoute({
      ...route,
      enabled: true,
      authority: {
        definitionRef: "published:routine:review",
        principal: { kind: "user", id: "routine-owner" },
        configurationDigest: "approved-material",
      },
    });
    expect((await store.routineRoutes(event.businessId, "github"))[0].enabled).toBe(true);
  });
});
