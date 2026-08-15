import type { Queryable } from "./db";

/** What the spend check found, whether or not it crossed the line. */
export interface SpendWindow {
  readonly spentUsd: number;
  readonly thresholdUsd: number;
  readonly unpricedCalls: number;
}

/** Rolling window the daily ceiling is read against. */
export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Sums what the last 24 hours of model calls actually cost.
 *
 * Unpriceable calls are counted separately rather than folded in as zero. A breach report that
 * silently treats unknown cost as no cost is how an operator ends up under-alerted on exactly
 * the models nobody has priced yet.
 */
export async function readSpendWindow(
  db: Queryable,
  thresholdUsd: number,
  now: Date
): Promise<SpendWindow> {
  const since = new Date(now.getTime() - SPEND_WINDOW_MS);
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spent,
            COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unpriced
       FROM obs_event
      WHERE type = 'llm_call' AND ts >= $1`,
    [since]
  );
  const row = rows[0];
  return {
    spentUsd: Number(row?.spent ?? 0),
    unpricedCalls: Number(row?.unpriced ?? 0),
    thresholdUsd,
  };
}

/** Whether the window crossed the ceiling the operator set. */
export function breached(window: SpendWindow): boolean {
  return window.spentUsd > window.thresholdUsd;
}

/** Operator-facing wording; unpriced calls are named so the number is not read as complete. */
export function spendAlertMessage(window: SpendWindow): string {
  const base =
    `Model spend in the last 24h is $${window.spentUsd.toFixed(2)}, ` +
    `over the configured ceiling of $${window.thresholdUsd.toFixed(2)}`;
  return window.unpricedCalls === 0
    ? base
    : `${base} (excluding ${window.unpricedCalls} call(s) no price is known for)`;
}
