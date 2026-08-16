import type { TransactionPort } from "../ports";

/** Durable per-State-occurrence retry counter, so a transient-fault retry budget survives a park. */
export interface StateRetryAttempts {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly attempts: number;
}

export const STATE_RETRY_STORAGE_STATEMENTS: readonly string[] = [
  // Keyed by the State occurrence, not the attempt: a park re-enters the same (business, run,
  // state) and must reload the attempts earlier passes already spent. Retention mirrors
  // run_budgets and agent_loop_checkpoints — one row per State occurrence, held for the life of
  // the Run by the same FK.
  `CREATE TABLE IF NOT EXISTS state_retry_attempts (
    business_id  text NOT NULL,
    run_id       uuid NOT NULL,
    state_key    text NOT NULL CHECK (length(state_key) > 0),
    attempts     bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, run_id, state_key),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
];

interface StateRetryRow {
  attempts: string | number;
}

/**
 * Durable retry counter for a Routine State occurrence. The executor `record`s the running total
 * before every attempt, so the write is an idempotent, monotonic upsert: a counter only ever
 * climbs. `GREATEST` makes a stale or racing writer unable to lower a budget a later pass already
 * spent, so a crash-and-reclaim continues from the attempts already made rather than restarting.
 */
export class RunStateRetryStore {
  constructor(private readonly transactions: TransactionPort) {}

  async load(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<StateRetryAttempts | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<StateRetryRow>(
        `SELECT attempts
           FROM state_retry_attempts
          WHERE business_id = $1 AND run_id = $2 AND state_key = $3`,
        [businessId, runId, stateKey]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return { businessId, runId, stateKey, attempts: Number(row.attempts) };
    });
  }

  async record(input: StateRetryAttempts): Promise<void> {
    await this.transactions.withTransaction((transaction) =>
      transaction.query(
        `INSERT INTO state_retry_attempts
           (business_id, run_id, state_key, attempts, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (business_id, run_id, state_key) DO UPDATE SET
           attempts = GREATEST(state_retry_attempts.attempts, EXCLUDED.attempts),
           updated_at = now()`,
        [input.businessId, input.runId, input.stateKey, input.attempts]
      )
    );
  }
}
