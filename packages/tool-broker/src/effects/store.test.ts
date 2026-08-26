import { PGlite } from "@electric-sql/pglite";
import type { TransactionPort } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EffectLedgerError, type ReserveEffectInput } from "./model";
import { EFFECT_STORAGE_STATEMENTS, EffectLedger, MemoryEffectStore, PgEffectStore } from "./store";

const BUSINESS_ID = "business-1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
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
    for (const statement of EFFECT_STORAGE_STATEMENTS) await database.query(statement);
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
});
