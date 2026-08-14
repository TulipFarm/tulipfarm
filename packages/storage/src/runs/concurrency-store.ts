import type { TransactionPort } from "../ports";

/** SPEC §9.1 target-concurrency policies. */
export type PersistedConcurrencyPolicy =
  | "parallel"
  | "serialize"
  | "queue"
  | "coalesce"
  | "reject"
  | "supersede";

export type PersistedConcurrencySlotStatus = "held" | "queued" | "superseded";

export interface PersistedConcurrencySlot {
  readonly runId: string;
  readonly status: PersistedConcurrencySlotStatus;
  /** Monotonic arrival order within the target key; decides FIFO promotion. */
  readonly sequence: number;
}

export type ConcurrencyAdmissionAction =
  | { readonly kind: "hold" }
  | { readonly kind: "queue" }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "coalesce"; readonly withRunId: string }
  | { readonly kind: "supersede"; readonly supersedeRunIds: readonly string[] };

export interface ConcurrencyAdmitInput {
  readonly businessId: string;
  readonly runId: string;
  readonly targetKey: string;
  readonly stateKey: string;
  readonly policy: string;
  readonly requestedAt: string;
}

export interface ConcurrencyAdmitResult {
  readonly action: ConcurrencyAdmissionAction;
  /** Live slots this admission contended with, ordered by arrival; excludes the caller's own. */
  readonly slots: readonly PersistedConcurrencySlot[];
}

export interface ConcurrencyReleaseResult {
  readonly released: boolean;
  readonly promotedRunId: string | null;
}

/** Caller-owned admission decision, evaluated inside the target key's row lock. */
export type ConcurrencyDecision = (
  slots: readonly PersistedConcurrencySlot[]
) => ConcurrencyAdmissionAction;

const POLICY_SQL = "'parallel', 'serialize', 'queue', 'coalesce', 'reject', 'supersede'";
const SLOT_STATUS_SQL = "'held', 'queued', 'superseded'";

export const CONCURRENCY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_concurrency_keys (
    business_id           text NOT NULL,
    target_key            text NOT NULL CHECK (length(target_key) > 0),
    created_at            timestamptz NOT NULL,
    PRIMARY KEY (business_id, target_key)
  )`,
  `CREATE TABLE IF NOT EXISTS run_concurrency_slots (
    business_id           text NOT NULL,
    target_key            text NOT NULL,
    run_id                uuid NOT NULL,
    state_key             text NOT NULL CHECK (length(state_key) > 0),
    policy                text NOT NULL CHECK (policy IN (${POLICY_SQL})),
    status                text NOT NULL CHECK (status IN (${SLOT_STATUS_SQL})),
    sequence              bigint NOT NULL CHECK (sequence > 0),
    requested_at          timestamptz NOT NULL,
    resolved_at           timestamptz,
    PRIMARY KEY (business_id, target_key, run_id),
    UNIQUE (business_id, target_key, sequence),
    CHECK ((status = 'superseded') = (resolved_at IS NOT NULL)),
    FOREIGN KEY (business_id, target_key)
      REFERENCES run_concurrency_keys(business_id, target_key),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS run_concurrency_slots_queue_idx
    ON run_concurrency_slots (business_id, target_key, status, sequence)`,
  `CREATE INDEX IF NOT EXISTS run_concurrency_slots_run_idx
    ON run_concurrency_slots (business_id, run_id)`,
];

interface SlotRow {
  run_id: string;
  status: PersistedConcurrencySlotStatus;
  sequence: string | number;
}

function persistedSlot(row: SlotRow): PersistedConcurrencySlot {
  return { runId: row.run_id, status: row.status, sequence: Number(row.sequence) };
}

const SLOT_COLUMNS = "run_id, status, sequence";

/** Target-key locks preserve concurrency policy, FIFO promotion, and superseded visibility. */
export class ConcurrencyStore {
  constructor(private readonly transactions: TransactionPort) {}

  async admit(
    input: ConcurrencyAdmitInput,
    decide: ConcurrencyDecision
  ): Promise<ConcurrencyAdmitResult> {
    return this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO run_concurrency_keys (business_id, target_key, created_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (business_id, target_key) DO NOTHING`,
        [input.businessId, input.targetKey, input.requestedAt]
      );
      await transaction.query(
        `SELECT target_key FROM run_concurrency_keys
          WHERE business_id = $1 AND target_key = $2
          FOR UPDATE`,
        [input.businessId, input.targetKey]
      );

      const existing = await transaction.query<SlotRow>(
        `SELECT ${SLOT_COLUMNS}
           FROM run_concurrency_slots
          WHERE business_id = $1 AND target_key = $2
          ORDER BY sequence`,
        [input.businessId, input.targetKey]
      );
      const all = existing.rows.map(persistedSlot);
      const contenders = all.filter(
        (slot) => slot.runId !== input.runId && slot.status !== "superseded"
      );
      const action = decide(contenders);
      const nextSequence = all.reduce((max, slot) => Math.max(max, slot.sequence), 0) + 1;

      if (action.kind === "supersede" && action.supersedeRunIds.length > 0) {
        await transaction.query(
          `UPDATE run_concurrency_slots
              SET status = 'superseded', resolved_at = $4::timestamptz
            WHERE business_id = $1
              AND target_key = $2
              AND run_id = ANY($3::uuid[])
              AND status <> 'superseded'`,
          [input.businessId, input.targetKey, action.supersedeRunIds, input.requestedAt]
        );
      }

      if (action.kind === "hold" || action.kind === "queue" || action.kind === "supersede") {
        const status = action.kind === "queue" ? "queued" : "held";
        await transaction.query(
          `INSERT INTO run_concurrency_slots (
             business_id, target_key, run_id, state_key, policy, status, sequence, requested_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
           ON CONFLICT (business_id, target_key, run_id) DO UPDATE
             SET status = EXCLUDED.status
           WHERE run_concurrency_slots.status <> 'superseded'`,
          [
            input.businessId,
            input.targetKey,
            input.runId,
            input.stateKey,
            input.policy,
            status,
            nextSequence,
            input.requestedAt,
          ]
        );
      }

      return { action, slots: contenders };
    });
  }

  /** Frees a held slot and promotes the earliest queued contender into it. */
  async release(
    businessId: string,
    targetKey: string,
    runId: string,
    now: string
  ): Promise<ConcurrencyReleaseResult> {
    return this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `SELECT target_key FROM run_concurrency_keys
          WHERE business_id = $1 AND target_key = $2
          FOR UPDATE`,
        [businessId, targetKey]
      );

      const removed = await transaction.query<{ run_id: string }>(
        `DELETE FROM run_concurrency_slots
          WHERE business_id = $1 AND target_key = $2 AND run_id = $3 AND status <> 'superseded'
          RETURNING run_id`,
        [businessId, targetKey, runId]
      );
      if (removed.rows.length === 0) return { released: false, promotedRunId: null };

      const promoted = await transaction.query<{ run_id: string }>(
        `UPDATE run_concurrency_slots
            SET status = 'held', requested_at = $3::timestamptz
          WHERE business_id = $1
            AND target_key = $2
            AND run_id = (
              SELECT run_id
                FROM run_concurrency_slots
               WHERE business_id = $1 AND target_key = $2 AND status = 'queued'
               ORDER BY sequence
               LIMIT 1
            )
          RETURNING run_id`,
        [businessId, targetKey, now]
      );
      return { released: true, promotedRunId: promoted.rows[0]?.run_id ?? null };
    });
  }

  async listSlots(
    businessId: string,
    targetKey: string
  ): Promise<readonly PersistedConcurrencySlot[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<SlotRow>(
        `SELECT ${SLOT_COLUMNS}
           FROM run_concurrency_slots
          WHERE business_id = $1 AND target_key = $2
          ORDER BY sequence`,
        [businessId, targetKey]
      );
      return result.rows.map(persistedSlot);
    });
  }
}
