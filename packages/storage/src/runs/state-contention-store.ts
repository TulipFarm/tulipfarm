import type { TransactionPort } from "../ports";

/** Durable count of the backoff waits a Routine State occurrence spent on a contended key. */
export interface StateContentionWaits {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly waits: number;
}

export const STATE_CONTENTION_STORAGE_STATEMENTS: readonly string[] = [
  // Keyed by the State occurrence, like state_retry_attempts: a contender parks on a durable
  // timer and comes back as a fresh execution, so the budget it already spent has to be reloaded
  // rather than restarted — a per-park ceiling is no ceiling. The `runs` FK ties the counter to a
  // real Run and lets Run deletion take it along.
  `CREATE TABLE IF NOT EXISTS state_concurrency_waits (
    business_id  text NOT NULL,
    run_id       uuid NOT NULL,
    state_key    text NOT NULL CHECK (length(state_key) > 0),
    waits        bigint NOT NULL DEFAULT 0 CHECK (waits >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, run_id, state_key),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
];

interface StateContentionRow {
  waits: string | number;
}

/**
 * Durable backoff budget for a Routine State occurrence contending for a `concurrencyKey`.
 *
 * The executor `record`s the running total *before* it opens the wait that spends it, so the write
 * is an idempotent, monotonic upsert: `GREATEST` stops a stale or racing writer lowering a budget a
 * later pass already spent, and a crash between recording and opening costs a wait rather than
 * refunding one.
 */
export class RunStateContentionStore {
  constructor(private readonly transactions: TransactionPort) {}

  async load(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<StateContentionWaits | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<StateContentionRow>(
        `SELECT waits
           FROM state_concurrency_waits
          WHERE business_id = $1 AND run_id = $2 AND state_key = $3`,
        [businessId, runId, stateKey]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return { businessId, runId, stateKey, waits: Number(row.waits) };
    });
  }

  async record(input: StateContentionWaits): Promise<void> {
    await this.transactions.withTransaction((transaction) =>
      transaction.query(
        `INSERT INTO state_concurrency_waits
           (business_id, run_id, state_key, waits, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (business_id, run_id, state_key) DO UPDATE SET
           waits = GREATEST(state_concurrency_waits.waits, EXCLUDED.waits),
           updated_at = now()`,
        [input.businessId, input.runId, input.stateKey, input.waits]
      )
    );
  }
}
