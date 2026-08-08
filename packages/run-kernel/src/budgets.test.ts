import { describe, expect, it } from "vitest";
import {
  type BudgetConsumeResult,
  BudgetError,
  modelProfileBudgetScopedLimits,
  RunBudgetManager,
  type RunBudgetStore,
  resolveModelProfileBudgetLimits,
  usdToCostMicros,
} from "./budgets";
import { resolveLimits } from "./limits";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";

/** Single-threaded fake with the same "never overdraw" contract the PostgreSQL store enforces. */
class FakeBudgetStore implements RunBudgetStore {
  readonly budgets = new Map<string, { limit: number; consumed: number; policy: string }>();
  openCalls = 0;

  async open(input: {
    businessId: string;
    runId: string;
    limits: Readonly<Record<string, number>>;
    exhaustionPolicy: string;
  }): Promise<void> {
    this.openCalls += 1;
    for (const [key, limit] of Object.entries(input.limits)) {
      const id = `${input.businessId}:${input.runId}:${key}`;
      // Opening twice never raises an existing ceiling.
      if (!this.budgets.has(id)) {
        this.budgets.set(id, { limit, consumed: 0, policy: input.exhaustionPolicy });
      }
    }
  }

  async consume(
    businessId: string,
    runId: string,
    key: string,
    amount: number
  ): Promise<BudgetConsumeResult> {
    const budget = this.budgets.get(`${businessId}:${runId}:${key}`);
    if (!budget) return { outcome: "unbounded", consumed: 0, limit: null, exhaustionPolicy: null };
    if (budget.consumed + amount > budget.limit) {
      return {
        outcome: "exhausted",
        consumed: budget.consumed,
        limit: budget.limit,
        exhaustionPolicy: budget.policy as "failure_path",
      };
    }
    budget.consumed += amount;
    return {
      outcome: "allowed",
      consumed: budget.consumed,
      limit: budget.limit,
      exhaustionPolicy: budget.policy as "failure_path",
    };
  }
}

function manager(store: RunBudgetStore): RunBudgetManager {
  return new RunBudgetManager(store);
}

describe("RunBudgetManager", () => {
  it("opens a Run budget from the narrowest-wins resolved limits", async () => {
    const store = new FakeBudgetStore();
    const resolved = resolveLimits([
      { scope: "deployment", limits: { tokens: 1_000 } },
      { scope: "agent", limits: { tokens: 100, sideEffects: 2 } },
    ]);

    await manager(store).open({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      limits: resolved,
      exhaustionPolicy: "failure_path",
    });

    expect(store.budgets.get(`${BUSINESS_ID}:${RUN_ID}:tokens`)?.limit).toBe(100);
    expect(store.budgets.get(`${BUSINESS_ID}:${RUN_ID}:sideEffects`)?.limit).toBe(2);
  });

  it("allows consumption up to the ceiling and reports remaining budget", async () => {
    const store = new FakeBudgetStore();
    const budgets = manager(store);
    await budgets.open({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      limits: resolveLimits([{ scope: "run", limits: { tokens: 10 } }]),
      exhaustionPolicy: "failure_path",
    });

    const first = await budgets.consume({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      key: "tokens",
      amount: 7,
    });

    expect(first).toEqual({
      outcome: "allowed",
      key: "tokens",
      consumed: 7,
      limit: 10,
      remaining: 3,
    });
  });

  it("fails deterministically to the declared exhaustion disposition", async () => {
    const store = new FakeBudgetStore();
    const budgets = manager(store);
    await budgets.open({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      limits: resolveLimits([{ scope: "run", limits: { tokens: 10 } }]),
      exhaustionPolicy: "attention_required",
    });

    const denied = await budgets.consume({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      key: "tokens",
      amount: 11,
    });

    expect(denied).toEqual({
      outcome: "exhausted",
      key: "tokens",
      consumed: 0,
      limit: 10,
      remaining: 10,
      disposition: "attention_required",
    });
  });

  it("treats an undeclared key as unbounded instead of denying it", async () => {
    const store = new FakeBudgetStore();
    const budgets = manager(store);
    await budgets.open({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      limits: resolveLimits([{ scope: "run", limits: { tokens: 10 } }]),
      exhaustionPolicy: "failure_path",
    });

    const result = await budgets.consume({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      key: "networkBytes",
      amount: 4_096,
    });

    expect(result.outcome).toBe("unbounded");
  });

  it("rejects a non-positive consumption so a refund cannot raise a budget", async () => {
    const budgets = manager(new FakeBudgetStore());

    await expect(
      budgets.consume({ businessId: BUSINESS_ID, runId: RUN_ID, key: "tokens", amount: -5 })
    ).rejects.toThrow(new BudgetError("invalid_consumption", "tokens"));
  });

  it("never raises an already-open ceiling when a Run is re-opened after a crash", async () => {
    const store = new FakeBudgetStore();
    const budgets = manager(store);
    const open = (tokens: number) =>
      budgets.open({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        limits: resolveLimits([{ scope: "run", limits: { tokens } }]),
        exhaustionPolicy: "failure_path",
      });

    await open(10);
    await open(1_000_000);

    expect(store.budgets.get(`${BUSINESS_ID}:${RUN_ID}:tokens`)?.limit).toBe(10);
  });
});

describe("ModelProfile budget limits", () => {
  it("contributes no limits when the profile authors no execution budgets", () => {
    expect(modelProfileBudgetScopedLimits({})).toBeUndefined();
    expect(resolveModelProfileBudgetLimits({})).toEqual({});
  });

  it("contributes authored token and cost budgets at the model scope", () => {
    const resolved = resolveModelProfileBudgetLimits({
      budgets: { maxTokens: 2_000, maxCostUsd: 0.25 },
    });

    expect(resolved.tokens).toEqual({ value: 2_000, scope: "model" });
    expect(resolved.costMicros).toEqual({ value: 250_000, scope: "model" });
  });

  it("rounds positive fractional USD budgets up to at least one micro-USD", () => {
    expect(usdToCostMicros(0.0000001)).toBe(1);
    expect(usdToCostMicros(0)).toBe(0);
  });

  it("lets resolveLimits keep a lower non-model ceiling over the model ceiling", () => {
    const resolved = resolveModelProfileBudgetLimits(
      { budgets: { maxTokens: 2_000, maxCostUsd: 5 } },
      [{ scope: "state", limits: { tokens: 500, costMicros: 1_000_000 } }]
    );

    expect(resolved.tokens).toEqual({ value: 500, scope: "state" });
    expect(resolved.costMicros).toEqual({ value: 1_000_000, scope: "state" });
  });
});
