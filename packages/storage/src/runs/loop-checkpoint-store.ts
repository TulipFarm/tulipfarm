import type { TransactionPort } from "../ports";

/** Durable Agent-loop counters for one State occurrence, so limits survive an approval park. */
export interface LoopCheckpoint {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly repairs: number;
}

export const LOOP_CHECKPOINT_STORAGE_STATEMENTS: readonly string[] = [
  // Keyed by the State occurrence, not the attempt: an approval park re-enters the same
  // (business, run, state) and must reload what earlier passes already spent. Retention mirrors
  // run_budgets — one row per State occurrence, held for the life of the Run by the same FK.
  `CREATE TABLE IF NOT EXISTS agent_loop_checkpoints (
    business_id  text NOT NULL,
    run_id       uuid NOT NULL,
    state_id     text NOT NULL CHECK (length(state_id) > 0),
    iterations   bigint NOT NULL DEFAULT 0 CHECK (iterations >= 0),
    tool_calls   bigint NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
    repairs      bigint NOT NULL DEFAULT 0 CHECK (repairs >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, run_id, state_id),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
];

interface LoopCheckpointRow {
  iterations: string | number;
  tool_calls: string | number;
  repairs: string | number;
}

/**
 * Durable Agent-loop counters. The loop `save`s the same key repeatedly, so the write is an
 * idempotent, monotonic upsert: a counter only ever climbs. `GREATEST` makes a stale or racing
 * writer unable to lower a ceiling that a later pass already advanced past.
 */
export class RunLoopCheckpointStore {
  constructor(private readonly transactions: TransactionPort) {}

  async load(
    businessId: string,
    runId: string,
    stateId: string
  ): Promise<LoopCheckpoint | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<LoopCheckpointRow>(
        `SELECT iterations, tool_calls, repairs
           FROM agent_loop_checkpoints
          WHERE business_id = $1 AND run_id = $2 AND state_id = $3`,
        [businessId, runId, stateId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        businessId,
        runId,
        stateId,
        iterations: Number(row.iterations),
        toolCalls: Number(row.tool_calls),
        repairs: Number(row.repairs),
      };
    });
  }

  async save(checkpoint: LoopCheckpoint): Promise<void> {
    await this.transactions.withTransaction((transaction) =>
      transaction.query(
        `INSERT INTO agent_loop_checkpoints
           (business_id, run_id, state_id, iterations, tool_calls, repairs, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (business_id, run_id, state_id) DO UPDATE SET
           iterations = GREATEST(agent_loop_checkpoints.iterations, EXCLUDED.iterations),
           tool_calls = GREATEST(agent_loop_checkpoints.tool_calls, EXCLUDED.tool_calls),
           repairs = GREATEST(agent_loop_checkpoints.repairs, EXCLUDED.repairs),
           updated_at = now()`,
        [
          checkpoint.businessId,
          checkpoint.runId,
          checkpoint.stateId,
          checkpoint.iterations,
          checkpoint.toolCalls,
          checkpoint.repairs,
        ]
      )
    );
  }
}
