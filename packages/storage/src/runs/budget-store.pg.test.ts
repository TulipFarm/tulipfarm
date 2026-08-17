import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { BUDGET_STORAGE_STATEMENTS, BudgetStore } from "./budget-store";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";

const BUSINESS = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-25T10:00:00.000Z";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function run(): StartRunInput {
  return {
    id: RUN_ID,
    businessId: BUSINESS,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT,
    states: [{ key: "apply", definitionRef: "sha256:bundle-1#/states/apply", resolvedInput: {} }],
  };
}

describe("BudgetStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: BudgetStore;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [...RUN_STORAGE_STATEMENTS, ...BUDGET_STORAGE_STATEMENTS]) {
      await database.exec(sql);
    }
    const transactions = transactionPort(database);
    store = new BudgetStore(transactions);
    runs = new RunStore(transactions);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM run_budgets");
    await database.exec("DELETE FROM state_attempts");
    await database.exec("DELETE FROM run_states");
    await database.exec("DELETE FROM run_lineage");
    await database.exec("DELETE FROM runs");
    await runs.start(run());
  });

  it("opens one budget row per bounded limit key", async () => {
    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 100, sideEffects: 2 },
      exhaustionPolicy: "failure_path",
    });

    const usage = await store.usage(BUSINESS, RUN_ID);
    expect(usage).toEqual([
      { key: "sideEffects", limit: 2, consumed: 0, exhaustionPolicy: "failure_path" },
      { key: "tokens", limit: 100, consumed: 0, exhaustionPolicy: "failure_path" },
    ]);
  });

  it("accumulates consumption up to the ceiling", async () => {
    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 10 },
      exhaustionPolicy: "failure_path",
    });

    expect(await store.consume(BUSINESS, RUN_ID, "tokens", 6)).toEqual({
      outcome: "allowed",
      consumed: 6,
      limit: 10,
      exhaustionPolicy: "failure_path",
    });
    expect(await store.consume(BUSINESS, RUN_ID, "tokens", 4)).toEqual({
      outcome: "allowed",
      consumed: 10,
      limit: 10,
      exhaustionPolicy: "failure_path",
    });
  });

  it("refuses the consumption that would overdraw and leaves the ledger untouched", async () => {
    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 10 },
      exhaustionPolicy: "attention_required",
    });
    await store.consume(BUSINESS, RUN_ID, "tokens", 9);

    expect(await store.consume(BUSINESS, RUN_ID, "tokens", 2)).toEqual({
      outcome: "exhausted",
      consumed: 9,
      limit: 10,
      exhaustionPolicy: "attention_required",
    });
    const usage = await store.usage(BUSINESS, RUN_ID);
    expect(usage[0]?.consumed).toBe(9);
  });

  it("reports an undeclared key as unbounded rather than creating a budget on demand", async () => {
    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 10 },
      exhaustionPolicy: "failure_path",
    });

    expect(await store.consume(BUSINESS, RUN_ID, "networkBytes", 1)).toEqual({
      outcome: "unbounded",
      consumed: 0,
      limit: null,
      exhaustionPolicy: null,
    });
  });

  it("keeps the first ceiling when a Run re-opens its budget after a crash", async () => {
    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 10 },
      exhaustionPolicy: "failure_path",
    });
    await store.consume(BUSINESS, RUN_ID, "tokens", 4);

    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 1_000_000 },
      exhaustionPolicy: "failure_path",
    });

    const usage = await store.usage(BUSINESS, RUN_ID);
    expect(usage[0]).toEqual({
      key: "tokens",
      limit: 10,
      consumed: 4,
      exhaustionPolicy: "failure_path",
    });
  });

  it("rejects a direct attempt to raise a persisted ceiling", async () => {
    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 10 },
      exhaustionPolicy: "failure_path",
    });

    await expect(
      database.exec(`UPDATE run_budgets SET limit_value = 999 WHERE limit_key = 'tokens'`)
    ).rejects.toThrow(/run_budget_limit_immutable/);
  });

  it("rejects a ledger row that overdraws its ceiling", async () => {
    await store.open({
      businessId: BUSINESS,
      runId: RUN_ID,
      limits: { tokens: 10 },
      exhaustionPolicy: "failure_path",
    });

    await expect(
      database.exec("UPDATE run_budgets SET consumed = 11 WHERE limit_key = 'tokens'")
    ).rejects.toThrow();
  });
});
