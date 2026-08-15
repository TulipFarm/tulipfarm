import { describe, expect, it } from "vitest";
import type { Queryable } from "./db";
import { breached, readSpendWindow, spendAlertMessage } from "./spend-alert";

function db(rows: Record<string, unknown>[]): { q: Queryable; params: unknown[][] } {
  const params: unknown[][] = [];
  return {
    params,
    q: {
      query: async (_text: string, p?: unknown[]) => {
        params.push(p ?? []);
        return { rows };
      },
    },
  };
}

describe("spend alert", () => {
  it("reads spend over the trailing 24 hours", async () => {
    const { q, params } = db([{ spent: "12.5", unpriced: "0" }]);
    const now = new Date("2025-01-02T00:00:00.000Z");

    const window = await readSpendWindow(q, 50, now);

    expect(window.spentUsd).toBe(12.5);
    expect(params[0]?.[0]).toEqual(new Date("2025-01-01T00:00:00.000Z"));
  });

  it("fires only when spend is over the ceiling the operator set", () => {
    expect(breached({ spentUsd: 51, thresholdUsd: 50, unpricedCalls: 0 })).toBe(true);
    expect(breached({ spentUsd: 50, thresholdUsd: 50, unpricedCalls: 0 })).toBe(false);
    expect(breached({ spentUsd: 0, thresholdUsd: 50, unpricedCalls: 0 })).toBe(false);
  });

  it("counts unpriceable calls apart from the total instead of as zero", async () => {
    const { q } = db([{ spent: "48", unpriced: "37" }]);

    const window = await readSpendWindow(q, 50, new Date());

    // Folding these in as free is how an operator ends up under-alerted on exactly the models
    // nobody has priced yet, which is where surprise spend comes from.
    expect(window.unpricedCalls).toBe(37);
    expect(spendAlertMessage({ ...window, spentUsd: 60 })).toContain("37 call(s)");
  });

  it("says both the amount and the ceiling, so the number needs no lookup", () => {
    const message = spendAlertMessage({ spentUsd: 63.456, thresholdUsd: 50, unpricedCalls: 0 });

    expect(message).toContain("$63.46");
    expect(message).toContain("$50.00");
  });
});
