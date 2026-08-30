import type { TransactionPort } from "../ports";
import {
  type AppendAttemptInput,
  type AppendAttemptResult,
  appendAttemptRow,
  countStateAttemptRows,
} from "./attempt-store";
import {
  insertLineageRow,
  listLineageRows,
  type RunLineage,
  type RunLineageRelation,
} from "./lineage-store";
import {
  claimNextQueuedRunRows,
  heartbeatRun,
  reclaimExpiredRunRows,
  requeueParkedRunRows,
  requeueWaitingRunRow,
} from "./run-lease-store";
import { RunPersistenceError } from "./run-persistence-error";
import { persistedRun, type RunRow } from "./run-row";
import {
  type EnsureStateInput,
  type EnsureStateResult,
  ensureStateRow,
  findStateRow,
  insertStateRow,
  listStateRows,
  type PersistedState,
  type StartStateInput,
  type StateTransitionInput,
  transitionStateRow,
} from "./state-store";

export type {
  AppendAttemptInput,
  AppendAttemptResult,
  AttemptEvent,
  AttemptEvidence,
} from "./attempt-store";
export type { RunLineage, RunLineageRelation } from "./lineage-store";
export type { RunPersistenceErrorCode } from "./run-persistence-error";
export { RunPersistenceError } from "./run-persistence-error";
export type {
  EnsureStateInput,
  EnsureStateResult,
  PersistedState,
  PersistedStateStatus,
  StartStateInput,
  StateTransitionInput,
} from "./state-store";

export type PersistedRunStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "attention_required"
  | "needs_reconciliation";

export interface RunBundle {
  readonly digest: string;
  readonly routineId: string;
  readonly routineVersion: string;
}

export interface RunPrincipal {
  readonly kind: string;
  readonly id: string;
}

export interface RunIdentity {
  readonly initiator: RunPrincipal;
  readonly effectiveSubject: RunPrincipal;
  readonly guardrailContextRef: string;
}

export interface StartRunInput {
  readonly id: string;
  readonly businessId: string;
  /** Selects the Worker executor; independent of the Routine identity pinned in `bundle`. */
  readonly source: string;
  readonly bundle: RunBundle;
  readonly identity: RunIdentity;
  readonly createdAt: string;
  readonly states: readonly StartStateInput[];
  readonly parentRunId?: string;
  readonly lineage?: RunLineageRelation;
}

export interface PersistedRun {
  readonly id: string;
  readonly businessId: string;
  /** Selects the Worker executor; independent of the Routine identity pinned in `bundle`. */
  readonly source: string;
  readonly bundle: RunBundle;
  readonly identity: RunIdentity;
  readonly status: PersistedRunStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly resultArtifactId: string | null;
  readonly errorEvidenceRef: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
}

export interface RunTransitionInput {
  readonly expectedVersion: number;
  readonly expectedStatus: PersistedRunStatus;
  readonly status: PersistedRunStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly resultArtifactId?: string;
  readonly errorEvidenceRef?: string;
  /** Worker lease: required non-null for `claimed`/`running`, required null otherwise. */
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
}

export interface HeartbeatInput {
  readonly expectedVersion: number;
  readonly leaseExpiresAt: string;
}

export interface ClaimNextQueuedInput {
  readonly now: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

export interface ListRunsInput {
  readonly businessId: string;
  readonly limit: number;
  /** Opaque cursor returned as `nextCursor` by a previous page. */
  readonly cursor?: string;
  /** Keeps only Runs executing this Routine, as pinned in `bundle.routineId`. */
  readonly routineId?: string;
}

export interface RunPage {
  readonly items: readonly PersistedRun[];
  readonly nextCursor: string | null;
}

export const MAX_RUN_PAGE_SIZE = 100;

const RUN_STATUS_SQL =
  "'queued', 'claimed', 'running', 'waiting', 'succeeded', 'failed', " +
  "'cancelling', 'cancelled', 'attention_required', 'needs_reconciliation'";
/** A Run in one of these has finished; anything else still holds the Routine's overlap slot. */
const TERMINAL_RUN_STATUS_SQL = "'succeeded', 'failed', 'cancelled'";
const STATE_STATUS_SQL =
  "'pending', 'ready', 'claimed', 'running', 'waiting', 'succeeded', 'failed', " +
  "'skipped', 'cancelling', 'cancelled', 'needs_reconciliation'";
const ATTEMPT_EVENT_SQL =
  "'claimed', 'started', 'waiting', 'succeeded', 'failed', 'cancelled', " +
  "'lease_expired', 'reconciliation_required'";

/** Separate Run browser keyset index for migrations added after base Run storage. */
export const RUN_BROWSE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS runs_recent_idx
    ON runs (business_id, created_at DESC, id DESC)`,
];

/** Immutable Run identity. Kept separate because the bounds removal must replace it in place. */
const RUN_IDENTITY_IMMUTABLE_FUNCTION = `CREATE OR REPLACE FUNCTION reject_run_identity_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.business_id IS DISTINCT FROM NEW.business_id
        OR OLD.bundle IS DISTINCT FROM NEW.bundle
        OR OLD.identity IS DISTINCT FROM NEW.identity
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'run_identity_immutable';
      END IF;
      RETURN NEW;
    END;
    $$`;

export const RUN_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id                    uuid PRIMARY KEY,
    business_id           text NOT NULL,
    source                text NOT NULL CHECK (length(source) > 0),
    bundle                jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
    identity              jsonb NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
    status                text NOT NULL DEFAULT 'queued'
      CHECK (status IN (${RUN_STATUS_SQL})),
    version               integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at            timestamptz NOT NULL,
    started_at            timestamptz,
    finished_at           timestamptz,
    result_artifact_id    text,
    error_evidence_ref    text,
    lease_owner           text,
    lease_expires_at      timestamptz,
    UNIQUE (business_id, id),
    CHECK (
      (status IN ('claimed', 'running') AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status NOT IN ('claimed', 'running') AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS run_states (
    business_id           text NOT NULL,
    run_id                uuid NOT NULL,
    state_key             text NOT NULL CHECK (length(state_key) > 0),
    definition_ref        text NOT NULL CHECK (length(definition_ref) > 0),
    resolved_input        jsonb NOT NULL CHECK (jsonb_typeof(resolved_input) = 'object'),
    status                text NOT NULL DEFAULT 'pending'
      CHECK (status IN (${STATE_STATUS_SQL})),
    version               integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at            timestamptz NOT NULL,
    started_at            timestamptz,
    finished_at           timestamptz,
    result_artifact_id    text,
    error_evidence_ref    text,
    output                jsonb,
    PRIMARY KEY (business_id, run_id, state_key),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS state_attempts (
    id                    uuid PRIMARY KEY,
    business_id           text NOT NULL,
    run_id                uuid NOT NULL,
    state_key             text NOT NULL,
    attempt               integer NOT NULL CHECK (attempt > 0),
    sequence              integer NOT NULL CHECK (sequence > 0),
    event                 text NOT NULL CHECK (event IN (${ATTEMPT_EVENT_SQL})),
    event_digest          text NOT NULL CHECK (length(event_digest) > 0),
    occurred_at           timestamptz NOT NULL,
    evidence              jsonb NOT NULL CHECK (
      jsonb_typeof(evidence) = 'object'
      AND evidence - ARRAY[
        'agentId',
        'modelProfileId',
        'toolIntentId',
        'auditEventId',
        'resultArtifactId',
        'errorEvidenceRef'
      ] = '{}'::jsonb
    ),
    UNIQUE (business_id, id),
    UNIQUE (business_id, run_id, state_key, attempt, sequence),
    FOREIGN KEY (business_id, run_id, state_key)
      REFERENCES run_states(business_id, run_id, state_key)
  )`,
  `CREATE TABLE IF NOT EXISTS run_lineage (
    business_id           text NOT NULL,
    source_run_id         uuid NOT NULL,
    target_run_id         uuid NOT NULL,
    relation              text NOT NULL CHECK (relation IN ('child', 'replay')),
    created_at            timestamptz NOT NULL,
    PRIMARY KEY (business_id, source_run_id, target_run_id, relation),
    FOREIGN KEY (business_id, source_run_id) REFERENCES runs(business_id, id),
    FOREIGN KEY (business_id, target_run_id) REFERENCES runs(business_id, id),
    CHECK (source_run_id <> target_run_id)
  )`,
  `CREATE OR REPLACE FUNCTION reject_run_append_only_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'run_append_only_record';
    END;
    $$`,
  "DROP TRIGGER IF EXISTS state_attempts_append_only ON state_attempts",
  `CREATE TRIGGER state_attempts_append_only
    BEFORE UPDATE OR DELETE ON state_attempts
    FOR EACH ROW EXECUTE FUNCTION reject_run_append_only_change()`,
  "DROP TRIGGER IF EXISTS run_lineage_append_only ON run_lineage",
  `CREATE TRIGGER run_lineage_append_only
    BEFORE UPDATE OR DELETE ON run_lineage
    FOR EACH ROW EXECUTE FUNCTION reject_run_append_only_change()`,
  RUN_IDENTITY_IMMUTABLE_FUNCTION,
  "DROP TRIGGER IF EXISTS runs_identity_immutable ON runs",
  `CREATE TRIGGER runs_identity_immutable
    BEFORE UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION reject_run_identity_change()`,
  `CREATE OR REPLACE FUNCTION reject_state_identity_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.business_id IS DISTINCT FROM NEW.business_id
        OR OLD.run_id IS DISTINCT FROM NEW.run_id
        OR OLD.state_key IS DISTINCT FROM NEW.state_key
        OR OLD.definition_ref IS DISTINCT FROM NEW.definition_ref
        OR OLD.resolved_input IS DISTINCT FROM NEW.resolved_input
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'run_state_identity_immutable';
      END IF;
      RETURN NEW;
    END;
    $$`,
  "DROP TRIGGER IF EXISTS run_states_identity_immutable ON run_states",
  `CREATE TRIGGER run_states_identity_immutable
    BEFORE UPDATE ON run_states
    FOR EACH ROW EXECUTE FUNCTION reject_state_identity_change()`,
  `CREATE INDEX IF NOT EXISTS runs_status_idx
    ON runs (business_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS runs_lease_reclaim_idx
    ON runs (business_id, status, lease_expires_at)`,
  `CREATE INDEX IF NOT EXISTS runs_bundle_digest_idx
    ON runs (business_id, (bundle->>'digest'))`,
  `CREATE INDEX IF NOT EXISTS run_states_status_idx
    ON run_states (business_id, run_id, status)`,
  `CREATE INDEX IF NOT EXISTS state_attempts_order_idx
    ON state_attempts (business_id, run_id, state_key, attempt, sequence)`,
  `CREATE INDEX IF NOT EXISTS run_lineage_target_idx
    ON run_lineage (business_id, target_run_id, created_at)`,
  ...RUN_BROWSE_STORAGE_STATEMENTS,
];

/**
 * Drops the `runs.bounds` column, whose four fields no reader ever consulted (L3-10).
 *
 * A Run's real ceilings live in the compiled Routine — `bounds`/`retry` per State — and in the Run
 * budget ledger; the column only ever held constants a single writer invented. The immutability
 * trigger names its columns, so its function must stop naming `bounds` before the column goes,
 * or the next `UPDATE` on a Run would raise inside the trigger.
 */
export const RUN_BOUNDS_REMOVAL_STATEMENTS: readonly string[] = [
  RUN_IDENTITY_IMMUTABLE_FUNCTION,
  "ALTER TABLE runs DROP COLUMN IF EXISTS bounds",
];

interface RunCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Keyset cursors are this store's business: the page order lives here, so callers pass the cursor
 * back untouched and a malformed one fails closed rather than silently reordering a page.
 */
function encodeRunCursor(run: PersistedRun): string {
  return `${run.createdAt}|${run.id}`;
}

function decodeRunCursor(decoded: string | undefined): RunCursor | null {
  if (decoded === undefined) return null;
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0) throw new RunPersistenceError("invalid_cursor");
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (id.length === 0 || Number.isNaN(Date.parse(createdAt))) {
    throw new RunPersistenceError("invalid_cursor");
  }
  return { createdAt, id };
}

/** PostgreSQL persistence for business-scoped Runs, States, attempts, and lineage. */
export const RUN_COLUMNS = `id, business_id, source, bundle, identity, status, version, created_at,
  started_at, finished_at, result_artifact_id, error_evidence_ref, lease_owner, lease_expires_at`;

export class RunStore {
  constructor(private readonly transactions: TransactionPort) {}

  async start(input: StartRunInput): Promise<PersistedRun> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<RunRow>(
        `INSERT INTO runs (id, business_id, source, bundle, identity, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz)
         RETURNING ${RUN_COLUMNS}`,
        [
          input.id,
          input.businessId,
          input.source,
          JSON.stringify(input.bundle),
          JSON.stringify(input.identity),
          input.createdAt,
        ]
      );
      const run = inserted.rows[0];
      if (!run) throw new Error("run_insert_without_row");

      for (const state of input.states) {
        await insertStateRow(transaction, input.businessId, input.id, state, input.createdAt);
      }

      if (input.parentRunId !== undefined) {
        await insertLineageRow(
          transaction,
          input.businessId,
          input.parentRunId,
          input.id,
          input.lineage ?? "child",
          input.createdAt
        );
      }

      return persistedRun(run);
    });
  }

  async find(businessId: string, runId: string): Promise<PersistedRun | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE business_id = $1 AND id = $2`,
        [businessId, runId]
      );
      const row = result.rows[0];
      return row ? persistedRun(row) : null;
    });
  }

  /** Idempotent later-State insert; first schedule timestamp and resolved input win. */
  async ensureState(input: EnsureStateInput): Promise<EnsureStateResult> {
    return this.transactions.withTransaction((transaction) => ensureStateRow(transaction, input));
  }

  /** Keyset-paged newest Runs; offsets would skip/repeat under live inserts. */
  async list(input: ListRunsInput): Promise<RunPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_RUN_PAGE_SIZE);
    const cursor = decodeRunCursor(input.cursor);
    return this.transactions.withTransaction(async (transaction) => {
      const params: unknown[] = [input.businessId, limit + 1];
      if (cursor) params.push(cursor.createdAt, cursor.id);
      const keyset = cursor ? "AND (created_at, id) < ($3::timestamptz, $4::uuid)" : "";
      let filter = "";
      if (input.routineId !== undefined) {
        params.push(input.routineId);
        // `bundle` is the pinned publication, so this is the Routine the Run actually executes —
        // not the Routine that carried the slug when the request was made.
        filter = `AND bundle->>'routineId' = $${params.length}`;
      }
      const result = await transaction.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
           FROM runs
          WHERE business_id = $1 ${keyset} ${filter}
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        params
      );
      const items = result.rows.slice(0, limit).map(persistedRun);
      const last = items.at(-1);
      const hasMore = result.rows.length > limit;
      return { items, nextCursor: hasMore && last ? encodeRunCursor(last) : null };
    });
  }

  /**
   * How many Runs of `routineId` have not reached a terminal status, so a scheduler can apply
   * `overlapPolicy` before starting another. `cancelling` counts as active: its effects are still
   * in flight, and treating it as finished would let a replacement start alongside the Run it
   * replaces.
   */
  async countActiveByRoutine(input: {
    readonly businessId: string;
    readonly routineId: string;
  }): Promise<number> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ active: string }>(
        `SELECT COUNT(*)::text AS active
           FROM runs
          WHERE business_id = $1
            AND bundle->>'routineId' = $2
            AND status NOT IN (${TERMINAL_RUN_STATUS_SQL})`,
        [input.businessId, input.routineId]
      );
      return Number(result.rows[0]?.active ?? 0);
    });
  }

  /**
   * The ids behind {@link countActiveByRoutine}, for `overlapPolicy: "supersede"` — which means
   * the newest occurrence replaces the running one, so the dispatcher needs something to cancel.
   * Oldest first, so a caller that stops partway leaves the newest Run standing.
   */
  async listActiveByRoutine(input: {
    readonly businessId: string;
    readonly routineId: string;
  }): Promise<readonly string[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        `SELECT id
           FROM runs
          WHERE business_id = $1
            AND bundle->>'routineId' = $2
            AND status NOT IN (${TERMINAL_RUN_STATUS_SQL})
          ORDER BY created_at ASC`,
        [input.businessId, input.routineId]
      );
      return result.rows.map((row) => row.id);
    });
  }

  async listStates(businessId: string, runId: string): Promise<readonly PersistedState[]> {
    return this.transactions.withTransaction((transaction) =>
      listStateRows(transaction, businessId, runId)
    );
  }

  async findState(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<PersistedState | null> {
    return this.transactions.withTransaction((transaction) =>
      findStateRow(transaction, businessId, runId, stateKey)
    );
  }

  async transitionRun(
    businessId: string,
    runId: string,
    transition: RunTransitionInput
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        `UPDATE runs
            SET status = $5,
                version = version + 1,
                started_at = COALESCE($6::timestamptz, started_at),
                finished_at = COALESCE($7::timestamptz, finished_at),
                result_artifact_id = COALESCE($8, result_artifact_id),
                error_evidence_ref = COALESCE($9, error_evidence_ref),
                lease_owner = $10,
                lease_expires_at = $11::timestamptz
          WHERE business_id = $1
            AND id = $2
            AND version = $3
            AND status = $4
          RETURNING id`,
        [
          businessId,
          runId,
          transition.expectedVersion,
          transition.expectedStatus,
          transition.status,
          transition.startedAt ?? null,
          transition.finishedAt ?? null,
          transition.resultArtifactId ?? null,
          transition.errorEvidenceRef ?? null,
          transition.leaseOwner,
          transition.leaseExpiresAt,
        ]
      );
      return result.rows.length === 1;
    });
  }

  /** Extends an owned lease without changing status; fails if the lease moved to another worker. */
  async heartbeat(
    businessId: string,
    runId: string,
    owner: string,
    heartbeat: HeartbeatInput
  ): Promise<boolean> {
    return this.transactions.withTransaction((transaction) =>
      heartbeatRun(transaction, businessId, runId, owner, heartbeat)
    );
  }

  /** Requeues Runs whose worker lease expired so another worker can claim them. */
  async reclaimExpiredRuns(
    businessId: string,
    now: string,
    limit: number
  ): Promise<readonly PersistedRun[]> {
    return this.transactions.withTransaction((transaction) =>
      reclaimExpiredRunRows(transaction, businessId, now, limit)
    );
  }

  /**
   * Requeues Runs parked by a crashed dispatch handler. Bounded to one requeue per Run by the
   * evidence ref the update itself consumes.
   */
  async requeueParkedRuns(businessId: string, limit: number): Promise<readonly PersistedRun[]> {
    return this.transactions.withTransaction((transaction) =>
      requeueParkedRunRows(transaction, businessId, limit)
    );
  }

  /** Claims a batch of queued Runs with an owned, timed lease so a worker can start them. */
  async claimNextQueued(
    businessId: string,
    owner: string,
    input: ClaimNextQueuedInput
  ): Promise<readonly PersistedRun[]> {
    return this.transactions.withTransaction((transaction) =>
      claimNextQueuedRunRows(transaction, businessId, owner, input)
    );
  }

  /**
   * Requeues a waiting Run whose durable wait resolved. Idempotent by construction: only a Run
   * still in `waiting` moves, so a duplicate resume never requeues the same Run twice.
   */
  async requeueWaitingRun(businessId: string, runId: string): Promise<boolean> {
    return this.transactions.withTransaction((transaction) =>
      requeueWaitingRunRow(transaction, businessId, runId)
    );
  }

  async transitionState(
    businessId: string,
    runId: string,
    stateKey: string,
    transition: StateTransitionInput
  ): Promise<boolean> {
    return this.transactions.withTransaction((transaction) =>
      transitionStateRow(transaction, businessId, runId, stateKey, transition)
    );
  }

  async appendAttempt(input: AppendAttemptInput): Promise<AppendAttemptResult> {
    return this.transactions.withTransaction((transaction) => appendAttemptRow(transaction, input));
  }

  /** Highest attempt number recorded per State key, for Run inspector read models. */
  async countStateAttempts(
    businessId: string,
    runId: string
  ): Promise<ReadonlyMap<string, number>> {
    return this.transactions.withTransaction((transaction) =>
      countStateAttemptRows(transaction, businessId, runId)
    );
  }

  async listLineage(businessId: string, targetRunId: string): Promise<readonly RunLineage[]> {
    return this.transactions.withTransaction((transaction) =>
      listLineageRows(transaction, businessId, targetRunId)
    );
  }
}
