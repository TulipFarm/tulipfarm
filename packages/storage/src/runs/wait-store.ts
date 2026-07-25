import type { TransactionPort } from "../ports";

/** SPEC §7.2 `RunWait` kinds. */
export type PersistedWaitKind =
  | "timer"
  | "event"
  | "approval"
  | "human_task"
  | "form"
  | "child_run";

/** SPEC §9.2 external-event wait aggregation semantics. */
export type WaitAggregation = "first" | "all" | "quorum" | "window";

export type PersistedWaitStatus = "pending" | "satisfied" | "timed_out";

export interface PersistedWait {
  readonly id: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly kind: PersistedWaitKind;
  readonly aggregation: WaitAggregation;
  readonly status: PersistedWaitStatus;
  /** Schema reference every accepted signal must declare. */
  readonly schemaRef: string;
  /** Canonical `kind:id` principals authorized to signal this wait. */
  readonly allowedPrincipals: readonly string[];
  readonly expectedSignals: number;
  readonly quorum: number | null;
  readonly deadlineAt: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly version: number;
}

export interface CreateWaitInput {
  readonly id: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly kind: PersistedWaitKind;
  readonly aggregation: WaitAggregation;
  readonly schemaRef: string;
  readonly allowedPrincipals: readonly string[];
  readonly expectedSignals: number;
  readonly quorum: number | null;
  /** SHA-256 of the one-use resume token; the token itself is never persisted. */
  readonly tokenHash: string;
  readonly deadlineAt: string;
  readonly createdAt: string;
}

/**
 * One recorded signal. Only correlation identity, principal, and a content digest are stored —
 * never the signal payload, which may carry protected data or Secret values.
 */
export interface PersistedWaitSignal {
  readonly id: string;
  readonly businessId: string;
  readonly waitId: string;
  readonly correlationKey: string;
  readonly signalDigest: string;
  readonly principal: string;
  readonly receivedAt: string;
}

export interface WaitSignalInput {
  readonly id: string;
  readonly businessId: string;
  readonly tokenHash: string;
  readonly runId: string;
  readonly correlationKey: string;
  readonly signalDigest: string;
  readonly principal: string;
  readonly receivedAt: string;
}

/**
 * Caller-owned policy evaluated inside the wait's row lock. `authorize` returns a denial reason
 * code (never a payload) or `null`, and is told whether this correlation key was already
 * recorded so an at-least-once redelivery stays idempotent; `isSatisfied` decides resolution
 * from the post-insert count.
 */
export interface WaitSignalPolicy {
  authorize(wait: PersistedWait, isDuplicate: boolean): string | null;
  isSatisfied(wait: PersistedWait, signalCount: number): boolean;
}

export type WaitDeliveryOutcome =
  | "unknown_token"
  | "denied"
  | "duplicate"
  | "recorded"
  | "resolved";

export interface WaitDeliveryResult {
  readonly outcome: WaitDeliveryOutcome;
  /** Denial reason code from the policy; absent for accepted deliveries. */
  readonly reason: string | null;
  readonly wait: PersistedWait | null;
  readonly signalCount: number;
}

/** Decides how a due wait resolves; called inside the sweep's row lock. */
export type DueWaitDecision = (
  wait: PersistedWait,
  signalCount: number
) => "satisfied" | "timed_out";

export interface ResolvedDueWait {
  readonly wait: PersistedWait;
  readonly signalCount: number;
}

const WAIT_KIND_SQL = "'timer', 'event', 'approval', 'human_task', 'form', 'child_run'";
const WAIT_AGGREGATION_SQL = "'first', 'all', 'quorum', 'window'";
const WAIT_STATUS_SQL = "'pending', 'satisfied', 'timed_out'";

export const WAIT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_waits (
    id                    uuid PRIMARY KEY,
    business_id           text NOT NULL,
    run_id                uuid NOT NULL,
    state_key             text NOT NULL,
    kind                  text NOT NULL CHECK (kind IN (${WAIT_KIND_SQL})),
    aggregation           text NOT NULL CHECK (aggregation IN (${WAIT_AGGREGATION_SQL})),
    status                text NOT NULL DEFAULT 'pending'
      CHECK (status IN (${WAIT_STATUS_SQL})),
    schema_ref            text NOT NULL CHECK (length(schema_ref) > 0),
    allowed_principals    jsonb NOT NULL CHECK (jsonb_typeof(allowed_principals) = 'array'),
    expected_signals      integer NOT NULL CHECK (expected_signals > 0),
    quorum                integer,
    token_hash            text NOT NULL CHECK (length(token_hash) > 0),
    token_consumed_at     timestamptz,
    deadline_at           timestamptz NOT NULL,
    created_at            timestamptz NOT NULL,
    resolved_at           timestamptz,
    version               integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    UNIQUE (business_id, id),
    UNIQUE (business_id, token_hash),
    CHECK (deadline_at > created_at),
    CHECK (
      (aggregation = 'quorum' AND quorum IS NOT NULL AND quorum > 0 AND quorum <= expected_signals)
      OR (aggregation <> 'quorum' AND quorum IS NULL)
    ),
    CHECK (kind <> 'timer' OR (aggregation = 'first' AND expected_signals = 1)),
    CHECK (kind = 'timer' OR jsonb_array_length(allowed_principals) > 0),
    CHECK (
      (status = 'pending' AND resolved_at IS NULL AND token_consumed_at IS NULL)
      OR (status <> 'pending' AND resolved_at IS NOT NULL AND token_consumed_at IS NOT NULL)
    ),
    FOREIGN KEY (business_id, run_id, state_key)
      REFERENCES run_states(business_id, run_id, state_key)
  )`,
  `CREATE TABLE IF NOT EXISTS run_wait_signals (
    id                    uuid PRIMARY KEY,
    business_id           text NOT NULL,
    wait_id               uuid NOT NULL,
    correlation_key       text NOT NULL CHECK (length(correlation_key) > 0),
    signal_digest         text NOT NULL CHECK (length(signal_digest) > 0),
    principal             text NOT NULL CHECK (length(principal) > 0),
    received_at           timestamptz NOT NULL,
    UNIQUE (business_id, wait_id, correlation_key),
    FOREIGN KEY (business_id, wait_id) REFERENCES run_waits(business_id, id)
  )`,
  "DROP TRIGGER IF EXISTS run_wait_signals_append_only ON run_wait_signals",
  `CREATE TRIGGER run_wait_signals_append_only
    BEFORE UPDATE OR DELETE ON run_wait_signals
    FOR EACH ROW EXECUTE FUNCTION reject_run_append_only_change()`,
  `CREATE OR REPLACE FUNCTION reject_run_wait_identity_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.business_id IS DISTINCT FROM NEW.business_id
        OR OLD.run_id IS DISTINCT FROM NEW.run_id
        OR OLD.state_key IS DISTINCT FROM NEW.state_key
        OR OLD.kind IS DISTINCT FROM NEW.kind
        OR OLD.aggregation IS DISTINCT FROM NEW.aggregation
        OR OLD.schema_ref IS DISTINCT FROM NEW.schema_ref
        OR OLD.allowed_principals IS DISTINCT FROM NEW.allowed_principals
        OR OLD.expected_signals IS DISTINCT FROM NEW.expected_signals
        OR OLD.quorum IS DISTINCT FROM NEW.quorum
        OR OLD.token_hash IS DISTINCT FROM NEW.token_hash
        OR OLD.deadline_at IS DISTINCT FROM NEW.deadline_at
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'run_wait_identity_immutable';
      END IF;
      IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'run_wait_already_resolved';
      END IF;
      RETURN NEW;
    END;
    $$`,
  "DROP TRIGGER IF EXISTS run_waits_identity_immutable ON run_waits",
  `CREATE TRIGGER run_waits_identity_immutable
    BEFORE UPDATE ON run_waits
    FOR EACH ROW EXECUTE FUNCTION reject_run_wait_identity_change()`,
  `CREATE INDEX IF NOT EXISTS run_waits_due_idx
    ON run_waits (business_id, status, deadline_at)`,
  `CREATE INDEX IF NOT EXISTS run_waits_run_idx
    ON run_waits (business_id, run_id, state_key)`,
];

interface WaitRow {
  id: string;
  business_id: string;
  run_id: string;
  state_key: string;
  kind: PersistedWaitKind;
  aggregation: WaitAggregation;
  status: PersistedWaitStatus;
  schema_ref: string;
  allowed_principals: string[];
  expected_signals: number;
  quorum: number | null;
  deadline_at: string | Date;
  created_at: string | Date;
  resolved_at: string | Date | null;
  version: number;
}

interface SignalRow {
  id: string;
  business_id: string;
  wait_id: string;
  correlation_key: string;
  signal_digest: string;
  principal: string;
  received_at: string | Date;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function persistedWait(row: WaitRow): PersistedWait {
  return {
    id: row.id,
    businessId: row.business_id,
    runId: row.run_id,
    stateKey: row.state_key,
    kind: row.kind,
    aggregation: row.aggregation,
    status: row.status,
    schemaRef: row.schema_ref,
    allowedPrincipals: row.allowed_principals,
    expectedSignals: row.expected_signals,
    quorum: row.quorum,
    deadlineAt: timestamp(row.deadline_at),
    createdAt: timestamp(row.created_at),
    resolvedAt: row.resolved_at === null ? null : timestamp(row.resolved_at),
    version: row.version,
  };
}

function persistedSignal(row: SignalRow): PersistedWaitSignal {
  return {
    id: row.id,
    businessId: row.business_id,
    waitId: row.wait_id,
    correlationKey: row.correlation_key,
    signalDigest: row.signal_digest,
    principal: row.principal,
    receivedAt: timestamp(row.received_at),
  };
}

const WAIT_COLUMNS = `id, business_id, run_id, state_key, kind, aggregation, status, schema_ref,
  allowed_principals, expected_signals, quorum, deadline_at, created_at, resolved_at, version`;
const SIGNAL_COLUMNS =
  "id, business_id, wait_id, correlation_key, signal_digest, principal, received_at";

/**
 * PostgreSQL persistence for durable Runs waits, their recorded signals, and one-use resume
 * tokens. Every delivery and every due resolution runs inside the wait's row lock, so a duplicate
 * delivery, a concurrent worker, or a restart resolves the wait — and consumes its token — once.
 */
export class WaitStore {
  constructor(private readonly transactions: TransactionPort) {}

  async create(input: CreateWaitInput): Promise<PersistedWait> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<WaitRow>(
        `INSERT INTO run_waits (
           id, business_id, run_id, state_key, kind, aggregation, schema_ref, allowed_principals,
           expected_signals, quorum, token_hash, deadline_at, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::timestamptz, $13::timestamptz
         )
         RETURNING ${WAIT_COLUMNS}`,
        [
          input.id,
          input.businessId,
          input.runId,
          input.stateKey,
          input.kind,
          input.aggregation,
          input.schemaRef,
          JSON.stringify(input.allowedPrincipals),
          input.expectedSignals,
          input.quorum,
          input.tokenHash,
          input.deadlineAt,
          input.createdAt,
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("run_wait_insert_without_row");
      return persistedWait(row);
    });
  }

  async find(businessId: string, waitId: string): Promise<PersistedWait | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<WaitRow>(
        `SELECT ${WAIT_COLUMNS} FROM run_waits WHERE business_id = $1 AND id = $2`,
        [businessId, waitId]
      );
      const row = result.rows[0];
      return row ? persistedWait(row) : null;
    });
  }

  async listSignals(businessId: string, waitId: string): Promise<readonly PersistedWaitSignal[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<SignalRow>(
        `SELECT ${SIGNAL_COLUMNS}
           FROM run_wait_signals
          WHERE business_id = $1 AND wait_id = $2
          ORDER BY received_at, correlation_key`,
        [businessId, waitId]
      );
      return result.rows.map(persistedSignal);
    });
  }

  /**
   * Redeems a resume token: locks the wait, applies the caller's policy, records the signal
   * (deduplicated by correlation key), and resolves the wait exactly once when satisfied.
   */
  async deliverSignal(
    input: WaitSignalInput,
    policy: WaitSignalPolicy
  ): Promise<WaitDeliveryResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const locked = await transaction.query<WaitRow>(
        `SELECT ${WAIT_COLUMNS}
           FROM run_waits
          WHERE business_id = $1 AND token_hash = $2
          FOR UPDATE`,
        [input.businessId, input.tokenHash]
      );
      const row = locked.rows[0];
      if (!row) return { outcome: "unknown_token", reason: null, wait: null, signalCount: 0 };

      const wait = persistedWait(row);
      const known = await transaction.query<{ id: string }>(
        `SELECT id
           FROM run_wait_signals
          WHERE business_id = $1 AND wait_id = $2 AND correlation_key = $3`,
        [input.businessId, wait.id, input.correlationKey]
      );
      const isDuplicate = known.rows.length === 1;

      const denial = policy.authorize(wait, isDuplicate);
      if (denial !== null) {
        return { outcome: "denied", reason: denial, wait, signalCount: 0 };
      }

      const inserted = await transaction.query<{ id: string }>(
        `INSERT INTO run_wait_signals (
           id, business_id, wait_id, correlation_key, signal_digest, principal, received_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT (business_id, wait_id, correlation_key) DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.businessId,
          wait.id,
          input.correlationKey,
          input.signalDigest,
          input.principal,
          input.receivedAt,
        ]
      );
      const counted = await transaction.query<{ count: string | number }>(
        "SELECT count(*)::int AS count FROM run_wait_signals WHERE business_id = $1 AND wait_id = $2",
        [input.businessId, wait.id]
      );
      const signalCount = Number(counted.rows[0]?.count ?? 0);

      if (inserted.rows.length === 0) {
        return { outcome: "duplicate", reason: null, wait, signalCount };
      }
      if (!policy.isSatisfied(wait, signalCount)) {
        return { outcome: "recorded", reason: null, wait, signalCount };
      }

      const resolved = await transaction.query<WaitRow>(
        `UPDATE run_waits
            SET status = 'satisfied',
                version = version + 1,
                resolved_at = $3::timestamptz,
                token_consumed_at = $3::timestamptz
          WHERE business_id = $1
            AND id = $2
            AND status = 'pending'
          RETURNING ${WAIT_COLUMNS}`,
        [input.businessId, wait.id, input.receivedAt]
      );
      const resolvedRow = resolved.rows[0];
      if (!resolvedRow) throw new Error("run_wait_resolution_lost");
      return {
        outcome: "resolved",
        reason: null,
        wait: persistedWait(resolvedRow),
        signalCount,
      };
    });
  }

  /** Resolves waits whose deadline has passed, consuming each token exactly once. */
  async resolveDue(
    businessId: string,
    now: string,
    limit: number,
    decide: DueWaitDecision
  ): Promise<readonly ResolvedDueWait[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const due = await transaction.query<WaitRow>(
        `SELECT ${WAIT_COLUMNS}
           FROM run_waits
          WHERE business_id = $1
            AND status = 'pending'
            AND deadline_at <= $2::timestamptz
          ORDER BY deadline_at
          FOR UPDATE SKIP LOCKED
          LIMIT $3`,
        [businessId, now, Math.max(0, limit)]
      );

      const resolved: ResolvedDueWait[] = [];
      for (const row of due.rows) {
        const wait = persistedWait(row);
        const counted = await transaction.query<{ count: string | number }>(
          "SELECT count(*)::int AS count FROM run_wait_signals WHERE business_id = $1 AND wait_id = $2",
          [businessId, wait.id]
        );
        const signalCount = Number(counted.rows[0]?.count ?? 0);
        const status = decide(wait, signalCount);
        const updated = await transaction.query<WaitRow>(
          `UPDATE run_waits
              SET status = $3,
                  version = version + 1,
                  resolved_at = $4::timestamptz,
                  token_consumed_at = $4::timestamptz
            WHERE business_id = $1
              AND id = $2
              AND status = 'pending'
            RETURNING ${WAIT_COLUMNS}`,
          [businessId, wait.id, status, now]
        );
        const updatedRow = updated.rows[0];
        if (updatedRow) resolved.push({ wait: persistedWait(updatedRow), signalCount });
      }
      return resolved;
    });
  }
}
