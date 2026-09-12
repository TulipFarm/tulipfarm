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

  it("keeps a confirmed output immutable after settlement", async () => {
    const store = new MemoryEffectStore();
    await store.reserve(input());
    const attempt = await store.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-07-25T00:00:01.000Z");
    const output = { providerId: "external-42", nested: { status: "created" } };

    await store.finishAttempt({
      businessId: BUSINESS_ID,
      effectId: EFFECT_ID,
      attempt: attempt.attempt,
      attemptState: "confirmed",
      effectState: "confirmed",
      output: { value: output },
      finishedAt: "2026-07-25T00:00:02.000Z",
    });
    output.nested.status = "changed";

    const stored = await store.get(BUSINESS_ID, EFFECT_ID);
    expect(stored).toMatchObject({
      outputStored: true,
      output: { providerId: "external-42", nested: { status: "created" } },
    });
    expect(Object.isFrozen(stored?.output)).toBe(true);
    await expect(
      store.finishAttempt({
        businessId: BUSINESS_ID,
        effectId: EFFECT_ID,
        attempt: attempt.attempt,
        attemptState: "confirmed",
        effectState: "confirmed",
        output: { value: { providerId: "replacement" } },
        finishedAt: "2026-07-25T00:00:03.000Z",
      })
    ).rejects.toThrow(new EffectLedgerError("attempt_not_found", String(attempt.attempt)));
    expect((await store.get(BUSINESS_ID, EFFECT_ID))?.output).toEqual({
      providerId: "external-42",
      nested: { status: "created" },
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

  it("reloads the exact confirmed output after a store restart", async () => {
    await store.reserve(input());
    const attempt = await store.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-07-25T00:00:01.000Z");
    await store.finishAttempt({
      businessId: BUSINESS_ID,
      effectId: EFFECT_ID,
      attempt: attempt.attempt,
      attemptState: "confirmed",
      effectState: "confirmed",
      output: { value: { providerId: "external-42", labels: ["triaged"] } },
      finishedAt: "2026-07-25T00:00:02.000Z",
    });

    const restarted = new PgEffectStore({
      withTransaction: (operation) => database.transaction(operation),
    });
    const replay = await restarted.reserve(input());

    expect(replay).toMatchObject({
      outcome: "duplicate",
      effect: {
        state: "confirmed",
        outputStored: true,
        output: { providerId: "external-42", labels: ["triaged"] },
      },
    });
    await expect(
      restarted.finishAttempt({
        businessId: BUSINESS_ID,
        effectId: EFFECT_ID,
        attempt: attempt.attempt,
        attemptState: "confirmed",
        effectState: "confirmed",
        output: { value: { providerId: "replacement" } },
        finishedAt: "2026-07-25T00:00:03.000Z",
      })
    ).rejects.toThrow(new EffectLedgerError("attempt_not_found", String(attempt.attempt)));
    expect((await restarted.get(BUSINESS_ID, EFFECT_ID))?.output).toEqual({
      providerId: "external-42",
      labels: ["triaged"],
    });
  });

  it("loads recovery evidence with a business-and-Run-scoped query", async () => {
    const otherRun = "55555555-5555-4555-8555-555555555555";
    const otherBusiness = "business-2";
    await store.reserve(input());
    await store.reserve(
      input({
        effectId: "66666666-6666-4666-8666-666666666666",
        runId: otherRun,
        stateId: "other-run",
        logicalEffectOrdinal: 2,
        idempotencyKey: "effect-key-other-run",
        intent: {
          ...input().intent,
          intentId: "intent-other-run",
          runId: otherRun,
          stateId: "other-run",
          idempotencyKey: "effect-key-other-run",
        },
      })
    );
    await store.reserve(
      input({
        effectId: "77777777-7777-4777-8777-777777777777",
        businessId: otherBusiness,
        stateId: "other-business",
        logicalEffectOrdinal: 3,
        idempotencyKey: "effect-key-other-business",
        intent: {
          ...input().intent,
          intentId: "intent-other-business",
          businessId: otherBusiness,
          stateId: "other-business",
          idempotencyKey: "effect-key-other-business",
        },
      })
    );

    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const scoped = new PgEffectStore({
      withTransaction: (operation) =>
        database.transaction((transaction) =>
          operation({
            query: (sql, parameters) => {
              const copiedParameters = parameters === undefined ? undefined : [...parameters];
              queries.push({ sql, parameters: copiedParameters });
              return transaction.query(sql, copiedParameters);
            },
          })
        ),
    });

    await expect(scoped.listByRun(BUSINESS_ID, RUN_ID)).resolves.toMatchObject([
      { businessId: BUSINESS_ID, runId: RUN_ID, effectId: EFFECT_ID },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("WHERE effects.business_id = $1 AND effects.run_id = $2");
    expect(queries[0]?.parameters).toEqual([BUSINESS_ID, RUN_ID]);
  });

  it("distinguishes explicit null or void output from missing legacy output", async () => {
    await store.reserve(input());
    const attempt = await store.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-07-25T00:00:01.000Z");
    await store.finishAttempt({
      businessId: BUSINESS_ID,
      effectId: EFFECT_ID,
      attempt: attempt.attempt,
      attemptState: "confirmed",
      effectState: "confirmed",
      output: { value: null },
      finishedAt: "2026-07-25T00:00:02.000Z",
    });

    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({
      state: "confirmed",
      outputStored: true,
      output: null,
    });

    const voidEffect = input({
      effectId: "33333333-3333-4333-8333-333333333333",
      stateId: "void-label",
      logicalEffectOrdinal: 2,
      idempotencyKey: "effect-key-void",
      intent: {
        ...input().intent,
        intentId: "intent-void",
        stateId: "void-label",
        idempotencyKey: "effect-key-void",
      },
    });
    await store.reserve(voidEffect);
    const voidAttempt = await store.beginAttempt(
      BUSINESS_ID,
      voidEffect.effectId,
      "2026-07-25T00:00:03.000Z"
    );
    await store.finishAttempt({
      businessId: BUSINESS_ID,
      effectId: voidEffect.effectId,
      attempt: voidAttempt.attempt,
      attemptState: "confirmed",
      effectState: "confirmed",
      output: { value: undefined },
      finishedAt: "2026-07-25T00:00:04.000Z",
    });
    expect(await store.get(BUSINESS_ID, voidEffect.effectId)).toMatchObject({
      state: "confirmed",
      outputStored: true,
      output: null,
    });

    const legacy = input({
      effectId: "44444444-4444-4444-8444-444444444444",
      stateId: "legacy-label",
      logicalEffectOrdinal: 3,
      idempotencyKey: "effect-key-legacy",
      intent: {
        ...input().intent,
        intentId: "intent-legacy",
        stateId: "legacy-label",
        idempotencyKey: "effect-key-legacy",
      },
    });
    await store.reserve(legacy);
    await store.transition({
      businessId: BUSINESS_ID,
      effectId: legacy.effectId,
      expectedStates: ["authorized"],
      state: "confirmed",
      updatedAt: "2026-07-25T00:00:03.000Z",
    });

    expect(await store.get(BUSINESS_ID, legacy.effectId)).toMatchObject({
      state: "confirmed",
      outputStored: false,
      output: null,
    });
  });
});
