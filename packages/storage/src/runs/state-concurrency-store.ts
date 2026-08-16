import type { TransactionPort } from "../ports";

/** Durable holder of a Routine State's authored `concurrencyKey`, with a crash-bounding expiry. */
export interface StateConcurrencyLease {
  readonly businessId: string;
  readonly concurrencyKey: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly expiresAt: string;
}

export interface AcquireStateConcurrencyInput {
  readonly businessId: string;
  readonly concurrencyKey: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly now: string;
  readonly expiresAt: string;
}

export type StateConcurrencyAcquisition =
  | { readonly kind: "acquired" }
  | { readonly kind: "reentrant" }
  | { readonly kind: "busy"; readonly heldByRunId: string };

export const STATE_CONCURRENCY_STORAGE_STATEMENTS: readonly string[] = [
  // One row per live key, so the primary key *is* the mutual exclusion: a second holder cannot
  // exist. `expires_at` is what makes a crashed holder recoverable — release runs in the executor
  // and a dead process never reaches it, so without expiry one crash would wedge the key forever.
  // The `runs` FK ties a lease to a real Run and lets Run deletion take its leases with it.
  `CREATE TABLE IF NOT EXISTS state_concurrency_leases (
    business_id      text NOT NULL,
    concurrency_key  text NOT NULL CHECK (length(concurrency_key) > 0),
    run_id           uuid NOT NULL,
    state_key        text NOT NULL CHECK (length(state_key) > 0),
    acquired_at      timestamptz NOT NULL,
    expires_at       timestamptz NOT NULL,
    PRIMARY KEY (business_id, concurrency_key),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS state_concurrency_leases_run_idx
    ON state_concurrency_leases (business_id, run_id)`,
];

interface HolderRow {
  run_id: string;
  state_key: string;
}

/**
 * Durable mutual exclusion for Routine State `concurrencyKey`s, contended across worker processes.
 *
 * `acquire` is one conditional upsert: the row is taken when the key is free, when the recorded
 * holder's lease has expired, or when this exact State occurrence already holds it. Anything else
 * leaves the row untouched and reports who holds it, so a contender never overwrites a live lease.
 */
export class RunStateConcurrencyStore {
  constructor(private readonly transactions: TransactionPort) {}

  async acquire(input: AcquireStateConcurrencyInput): Promise<StateConcurrencyAcquisition> {
    return this.transactions.withTransaction(async (transaction) => {
      const taken = await transaction.query<HolderRow>(
        `INSERT INTO state_concurrency_leases
           (business_id, concurrency_key, run_id, state_key, acquired_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)
         ON CONFLICT (business_id, concurrency_key) DO UPDATE SET
           run_id = EXCLUDED.run_id,
           state_key = EXCLUDED.state_key,
           acquired_at = EXCLUDED.acquired_at,
           expires_at = EXCLUDED.expires_at
         WHERE state_concurrency_leases.expires_at <= $5::timestamptz
            OR (state_concurrency_leases.run_id = EXCLUDED.run_id
                AND state_concurrency_leases.state_key = EXCLUDED.state_key)
         RETURNING run_id, state_key`,
        [
          input.businessId,
          input.concurrencyKey,
          input.runId,
          input.stateKey,
          input.now,
          input.expiresAt,
        ]
      );
      if (taken.rows.length > 0) return { kind: "acquired" };

      const held = await transaction.query<HolderRow>(
        `SELECT run_id, state_key
           FROM state_concurrency_leases
          WHERE business_id = $1 AND concurrency_key = $2`,
        [input.businessId, input.concurrencyKey]
      );
      const holder = held.rows[0];
      // The conditional upsert only declines when a live holder exists, so a missing row here
      // means it was released between the two statements: the key is free, take it next attempt.
      if (holder === undefined) return { kind: "busy", heldByRunId: input.runId };
      if (holder.run_id === input.runId) return { kind: "reentrant" };
      return { kind: "busy", heldByRunId: holder.run_id };
    });
  }

  async release(
    businessId: string,
    concurrencyKey: string,
    runId: string,
    stateKey: string
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const removed = await transaction.query<{ concurrency_key: string }>(
        `DELETE FROM state_concurrency_leases
          WHERE business_id = $1 AND concurrency_key = $2 AND run_id = $3 AND state_key = $4
          RETURNING concurrency_key`,
        [businessId, concurrencyKey, runId, stateKey]
      );
      return removed.rows.length > 0;
    });
  }

  async find(
    businessId: string,
    concurrencyKey: string
  ): Promise<StateConcurrencyLease | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<HolderRow & { expires_at: string | Date }>(
        `SELECT run_id, state_key, expires_at
           FROM state_concurrency_leases
          WHERE business_id = $1 AND concurrency_key = $2`,
        [businessId, concurrencyKey]
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        businessId,
        concurrencyKey,
        runId: row.run_id,
        stateKey: row.state_key,
        expiresAt:
          row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      };
    });
  }
}
