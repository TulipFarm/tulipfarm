import { PGlite } from "@electric-sql/pglite";
import type { TransactionPort } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EffectLedgerError, type ReserveEffectInput } from "./model";
import { EFFECT_STORAGE_STATEMENTS, EffectLedger, MemoryEffectStore, PgEffectStore } from "./store";

const BUSINESS_ID = "business-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "11111111-1111-4111-8111-111111111112";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";

function input(overrides: Partial<ReserveEffectInput> = {}): ReserveEffectInput {
  return {
    effectId: EFFECT_ID,
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    stateId: "label",
    logicalEffectOrdinal: 1,
    idempotencyKey: "effect-key-1",
    intentDigest: "a".repeat(64),
    intent: {
      intentId: "intent-1",
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: "label",
      toolId: "github.issue.label",
      toolVersion: "1.0.0",
      action: "issue.label",
      targetRefs: [{ type: "issue", id: "issue-42" }],
      arguments: { label: "triaged" },
      destination: "github.com",
      credentialRef: "secret://github",
      idempotencyKey: "effect-key-1",
    },
    guardrailRevision: "guardrail-v3",
    approvalId: "approval-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryEffectStore", () => {
  it("persists the authorized intent and evidence before returning", async () => {
    const ledger = new EffectLedger(new MemoryEffectStore());

    const result = await ledger.reserve(input());

    expect(result).toMatchObject({
      outcome: "created",
      effect: {
        state: "authorized",
        intentDigest: "a".repeat(64),
        guardrailRevision: "guardrail-v3",
        approvalId: "approval-1",
        intent: { credentialRef: "secret://github" },
      },
    });
  });

  it("deduplicates concurrent matching keys into one durable intent", async () => {
    const store = new MemoryEffectStore();
    const ledger = new EffectLedger(store);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => ledger.reserve(input({ effectId: crypto.randomUUID() })))
    );

    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(new Set(results.map((result) => result.effect.effectId))).toHaveLength(1);
    expect(await store.list(BUSINESS_ID)).toHaveLength(1);
  });

  it("denies reuse of a key for a different intent digest", async () => {
    const ledger = new EffectLedger(new MemoryEffectStore());
    await ledger.reserve(input());

    await expect(
      ledger.reserve(input({ effectId: crypto.randomUUID(), intentDigest: "b".repeat(64) }))
    ).rejects.toThrow(new EffectLedgerError("idempotency_digest_mismatch", "effect-key-1"));
  });
});

describe("PgEffectStore", () => {
  let database: PGlite;
  let store: PgEffectStore;

  beforeEach(async () => {
    database = new PGlite();
    await database.query(`CREATE TABLE runs (
      id uuid PRIMARY KEY,
      business_id text NOT NULL,
      status text NOT NULL,
      UNIQUE (business_id, id)
    )`);
    for (const statement of EFFECT_STORAGE_STATEMENTS) await database.query(statement);
    await insertRun(RUN_ID);
    const transactions: TransactionPort = {
      withTransaction: (operation) => database.transaction(operation),
    };
    store = new PgEffectStore(transactions);
  });

  afterEach(async () => {
    await database.close();
  });

  it("enforces one matching intent per business idempotency key", async () => {
    const ledger = new EffectLedger(store);
    const [first, duplicate] = await Promise.all([
      ledger.reserve(input()),
      ledger.reserve(input({ effectId: crypto.randomUUID() })),
    ]);

    expect(new Set([first.outcome, duplicate.outcome])).toEqual(new Set(["created", "duplicate"]));
    expect(first.effect.effectId).toBe(duplicate.effect.effectId);
    await expect(
      ledger.reserve(input({ effectId: crypto.randomUUID(), intentDigest: "c".repeat(64) }))
    ).rejects.toThrow(EffectLedgerError);
  });

  it("lists only effects owned by the requested Run", async () => {
    await insertRun(OTHER_RUN_ID);
    await store.reserve(input());
    await store.reserve(
      input({
        effectId: "22222222-2222-4222-8222-222222222223",
        runId: OTHER_RUN_ID,
        idempotencyKey: "effect-key-2",
        intent: {
          ...input().intent,
          intentId: "intent-2",
          runId: OTHER_RUN_ID,
          idempotencyKey: "effect-key-2",
        },
      })
    );

    await expect(store.listByRun(BUSINESS_ID, RUN_ID)).resolves.toEqual([
      expect.objectContaining({ effectId: EFFECT_ID, runId: RUN_ID }),
    ]);
  });

  it("blocks cancellation on the Run row until an authorized effect reservation commits", async () => {
    const fenceReached = deferred<void>();
    const releaseFence = deferred<void>();
    const order: string[] = [];
    let pauseFence = true;
    const transactions: TransactionPort = {
      withTransaction: (operation) =>
        database.transaction((transaction) =>
          operation({
            query: async <Row>(text: string, params?: readonly unknown[]) => {
              const result = await transaction.query<Row>(text, params ? [...params] : undefined);
              if (pauseFence && text.includes("FROM runs") && text.includes("FOR UPDATE")) {
                pauseFence = false;
                fenceReached.resolve();
                await releaseFence.promise;
              }
              return result;
            },
          })
        ),
    };
    const fencedStore = new PgEffectStore(transactions);
    const reservation = fencedStore.reserve(input()).then((result) => {
      order.push("reserved");
      return result;
    });
    await fenceReached.promise;
    const cancellation = (async () => {
      order.push("cancellation-started");
      await database.query(
        "UPDATE runs SET status = 'cancelling' WHERE business_id = $1 AND id = $2",
        [BUSINESS_ID, RUN_ID]
      );
      order.push("cancelled");
    })();
    await Promise.resolve();
    expect(order).toEqual(["cancellation-started"]);

    releaseFence.resolve();
    await Promise.all([reservation, cancellation]);

    expect(order).toEqual(["cancellation-started", "reserved", "cancelled"]);
    await expect(fencedStore.listByRun(BUSINESS_ID, RUN_ID)).resolves.toHaveLength(1);
  });

  it("waits for a cancelling transaction and then rejects a new reservation", async () => {
    const fenceReached = deferred<void>();
    const releaseFence = deferred<void>();
    const cancellation = database.transaction(async (transaction) => {
      await transaction.query(
        "UPDATE runs SET status = 'cancelling' WHERE business_id = $1 AND id = $2",
        [BUSINESS_ID, RUN_ID]
      );
      fenceReached.resolve();
      await releaseFence.promise;
    });
    await fenceReached.promise;

    let reservationSettled = false;
    const reservation = store.reserve(input()).finally(() => {
      reservationSettled = true;
    });
    await Promise.resolve();
    expect(reservationSettled).toBe(false);

    releaseFence.resolve();
    await cancellation;
    await expect(reservation).rejects.toThrow(
      new EffectLedgerError("run_not_dispatchable", RUN_ID)
    );
    await expect(store.listByRun(BUSINESS_ID, RUN_ID)).resolves.toEqual([]);
  });

  it("rejects effect reservation and provider attempts after cancellation owns the fence", async () => {
    const reserved = await store.reserve(input());
    await database.query(
      "UPDATE runs SET status = 'cancelling' WHERE business_id = $1 AND id = $2",
      [BUSINESS_ID, RUN_ID]
    );

    await expect(
      store.reserve(
        input({
          effectId: "22222222-2222-4222-8222-222222222223",
          idempotencyKey: "effect-key-2",
          intent: {
            ...input().intent,
            intentId: "intent-2",
            idempotencyKey: "effect-key-2",
          },
        })
      )
    ).rejects.toThrow(new EffectLedgerError("run_not_dispatchable", RUN_ID));
    await expect(
      store.beginAttempt(BUSINESS_ID, reserved.effect.effectId, "2026-07-25T00:00:01.000Z")
    ).rejects.toThrow(new EffectLedgerError("run_not_dispatchable", RUN_ID));
  });

  it("allows reconciliation compensation only through a verified parent effect", async () => {
    const original = await store.reserve(input());
    await store.transition({
      businessId: BUSINESS_ID,
      effectId: original.effect.effectId,
      expectedStates: ["authorized"],
      state: "confirmed",
      updatedAt: "2026-07-25T00:00:01.000Z",
    });
    await database.query(
      "UPDATE runs SET status = 'needs_reconciliation' WHERE business_id = $1 AND id = $2",
      [BUSINESS_ID, RUN_ID]
    );
    const compensation = input({
      effectId: "22222222-2222-4222-8222-222222222223",
      logicalEffectOrdinal: 2,
      idempotencyKey: "compensation-key",
      intentDigest: "b".repeat(64),
      intent: {
        ...input().intent,
        intentId: "intent-compensation",
        action: "issue.unlabel",
        idempotencyKey: "compensation-key",
      },
    });

    await expect(
      store.reserve({ ...compensation, parentEffectId: original.effect.effectId })
    ).rejects.toThrow(new EffectLedgerError("effect_state_conflict", original.effect.effectId));
    await expect(store.reserve(compensation)).rejects.toThrow(
      new EffectLedgerError("run_not_dispatchable", RUN_ID)
    );
    const reserved = await store.reserveCompensation(compensation, original.effect.effectId);
    await expect(
      store.beginAttempt(BUSINESS_ID, reserved.effect.effectId, "2026-07-25T00:00:02.000Z")
    ).resolves.toMatchObject({ state: "dispatched" });
  });

  async function insertRun(runId: string, status = "running") {
    await database.query("INSERT INTO runs (id, business_id, status) VALUES ($1, $2, $3)", [
      runId,
      BUSINESS_ID,
      status,
    ]);
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
