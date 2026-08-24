import { describe, expect, it } from "vitest";
import { createNetworkBudget } from "./budget";

describe("createNetworkBudget", () => {
  it("allows calls up to the limit and refuses the one after", () => {
    const budget = createNetworkBudget(3);

    expect([1, 2, 3].map(() => budget.spend("run-1").allowed)).toEqual([true, true, true]);
    expect(budget.spend("run-1")).toEqual({ allowed: false, spent: 4, limit: 3 });
  });

  it("budgets each Run separately, so one crawl cannot starve another Turn", () => {
    const budget = createNetworkBudget(1);

    expect(budget.spend("run-1").allowed).toBe(true);
    expect(budget.spend("run-1").allowed).toBe(false);
    expect(budget.spend("run-2").allowed).toBe(true);
  });

  it("does not charge a call made outside a durable Run to one shared bucket", () => {
    const budget = createNetworkBudget(1);

    expect(budget.spend("").allowed).toBe(true);
    expect(budget.spend("").allowed).toBe(true);
  });

  it("keeps refusing once exhausted, rather than letting a retry through", () => {
    const budget = createNetworkBudget(1);
    budget.spend("run-1");

    expect(budget.spend("run-1").allowed).toBe(false);
    expect(budget.spend("run-1").allowed).toBe(false);
  });
});
