import type { TransactionPort } from "../ports";

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

export type PersistedStateStatus =
  | "pending"
  | "ready"
  | "claimed"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelling"
  | "cancelled"
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

export interface RunBounds {
  readonly wallTimeMs: number;
  readonly activeTimeMs: number;
  readonly attempts: number;
  readonly sideEffects: number;
}

export interface StartStateInput {
  readonly key: string;
  readonly definitionRef: string;
  readonly resolvedInput: Record<string, unknown>;
}

export type RunLineageRelation = "child" | "replay";

export interface StartRunInput {
  readonly id: string;
  readonly businessId: string;
  readonly bundle: RunBundle;
  readonly identity: RunIdentity;
  readonly bounds: RunBounds;
  readonly createdAt: string;
  readonly states: readonly StartStateInput[];
  readonly parentRunId?: string;
  readonly lineage?: RunLineageRelation;
}

export interface PersistedRun {
  readonly id: string;
  readonly businessId: string;
  readonly bundle: RunBundle;
  readonly identity: RunIdentity;
  readonly bounds: RunBounds;
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

export interface PersistedState {
  readonly businessId: string;
  readonly runId: string;
  readonly key: string;
  readonly definitionRef: string;
  readonly resolvedInput: Record<string, unknown>;
  readonly status: PersistedStateStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly resultArtifactId: string | null;
  readonly errorEvidenceRef: string | null;
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

export interface StateTransitionInput {
  readonly expectedVersion: number;
  readonly expectedStatus: PersistedStateStatus;
  readonly status: PersistedStateStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly resultArtifactId?: string;
  readonly errorEvidenceRef?: string;
}

export type AttemptEvent =
  | "claimed"
  | "started"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lease_expired"
  | "reconciliation_required";

/** Opaque evidence references only; protected payloads and Secret values are not accepted. */
export interface AttemptEvidence {
  readonly agentId?: string;
  readonly modelProfileId?: string;
  readonly toolIntentId?: string;
  readonly auditEventId?: string;
  readonly resultArtifactId?: string;
  readonly errorEvidenceRef?: string;
}

export interface AppendAttemptInput {
  readonly id: string;
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly event: AttemptEvent;
  readonly eventDigest: string;
  readonly occurredAt: string;
  readonly evidence: AttemptEvidence;
}

export interface AppendAttemptResult {
  readonly outcome: "appended" | "duplicate";
}

export interface RunLineage {
  readonly businessId: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly relation: RunLineageRelation;
  readonly createdAt: string;
}

export interface ListRunsInput {
  readonly businessId: string;
  readonly limit: number;
  /** Opaque cursor returned as `nextCursor` by a previous page. */
  readonly cursor?: string;
}

export interface RunPage {
  readonly items: readonly PersistedRun[];
  readonly nextCursor: string | null;
}

export const MAX_RUN_PAGE_SIZE = 100;

export type RunPersistenceErrorCode = "attempt_conflict" | "invalid_cursor";

export class RunPersistenceError extends Error {
  readonly name = "RunPersistenceError";

  constructor(readonly code: RunPersistenceErrorCode) {
    super(code);
  }
}

const RUN_STATUS_SQL =
  "'queued', 'claimed', 'running', 'waiting', 'succeeded', 'failed', " +
  "'cancelling', 'cancelled', 'attention_required', 'needs_reconciliation'";
const STATE_STATUS_SQL =
  "'pending', 'ready', 'claimed', 'running', 'waiting', 'succeeded', 'failed', " +
  "'skipped', 'cancelling', 'cancelled', 'needs_reconciliation'";
const ATTEMPT_EVENT_SQL =
  "'claimed', 'started', 'waiting', 'succeeded', 'failed', 'cancelled', " +
  "'lease_expired', 'reconciliation_required'";

/**
 * Backs the operational Run browser's keyset page order. Exported separately from
 * {@link RUN_STORAGE_STATEMENTS} so a deployment created before the browser existed picks it up
 * through its own migration instead of silently sequential-scanning `runs`.
 */
export const RUN_BROWSE_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS runs_recent_idx
    ON runs (business_id, created_at DESC, id DESC)`,
];

export const RUN_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id                    uuid PRIMARY KEY,
    business_id           text NOT NULL,
    bundle                jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
    identity              jsonb NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
    bounds                jsonb NOT NULL CHECK (
      jsonb_typeof(bounds) = 'object'
      AND bounds ?& ARRAY['wallTimeMs', 'activeTimeMs', 'attempts', 'sideEffects']
      AND (bounds->>'wallTimeMs')::bigint > 0
      AND (bounds->>'activeTimeMs')::bigint > 0
      AND (bounds->>'attempts')::integer >= 0
      AND (bounds->>'sideEffects')::integer >= 0
    ),
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
  `CREATE OR REPLACE FUNCTION reject_run_identity_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.business_id IS DISTINCT FROM NEW.business_id
        OR OLD.bundle IS DISTINCT FROM NEW.bundle
        OR OLD.identity IS DISTINCT FROM NEW.identity
        OR OLD.bounds IS DISTINCT FROM NEW.bounds
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'run_identity_immutable';
      END IF;
      RETURN NEW;
    END;
    $$`,
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
  `CREATE INDEX IF NOT EXISTS run_states_status_idx
    ON run_states (business_id, run_id, status)`,
  `CREATE INDEX IF NOT EXISTS state_attempts_order_idx
    ON state_attempts (business_id, run_id, state_key, attempt, sequence)`,
  `CREATE INDEX IF NOT EXISTS run_lineage_target_idx
    ON run_lineage (business_id, target_run_id, created_at)`,
  ...RUN_BROWSE_STORAGE_STATEMENTS,
];

interface RunRow {
  id: string;
  business_id: string;
  bundle: RunBundle;
  identity: RunIdentity;
  bounds: RunBounds;
  status: PersistedRunStatus;
  version: number;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  result_artifact_id: string | null;
  error_evidence_ref: string | null;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
}

interface StateRow {
  business_id: string;
  run_id: string;
  state_key: string;
  definition_ref: string;
  resolved_input: Record<string, unknown>;
  status: PersistedStateStatus;
  version: number;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  result_artifact_id: string | null;
  error_evidence_ref: string | null;
}

interface AttemptRow {
  event_digest: string;
}

interface LineageRow {
  business_id: string;
  source_run_id: string;
  target_run_id: string;
  relation: RunLineageRelation;
  created_at: string | Date;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function optionalTimestamp(value: string | Date | null): string | null {
  return value === null ? null : timestamp(value);
}

function persistedRun(row: RunRow): PersistedRun {
  return {
    id: row.id,
    businessId: row.business_id,
    bundle: row.bundle,
    identity: row.identity,
    bounds: row.bounds,
    status: row.status,
    version: row.version,
    createdAt: timestamp(row.created_at),
    startedAt: optionalTimestamp(row.started_at),
    finishedAt: optionalTimestamp(row.finished_at),
    resultArtifactId: row.result_artifact_id,
    errorEvidenceRef: row.error_evidence_ref,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: optionalTimestamp(row.lease_expires_at),
  };
}

function persistedState(row: StateRow): PersistedState {
  return {
    businessId: row.business_id,
    runId: row.run_id,
    key: row.state_key,
    definitionRef: row.definition_ref,
    resolvedInput: row.resolved_input,
    status: row.status,
    version: row.version,
    createdAt: timestamp(row.created_at),
    startedAt: optionalTimestamp(row.started_at),
    finishedAt: optionalTimestamp(row.finished_at),
    resultArtifactId: row.result_artifact_id,
    errorEvidenceRef: row.error_evidence_ref,
  };
}

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

const RUN_COLUMNS = `id, business_id, bundle, identity, bounds, status, version, created_at,
  started_at, finished_at, result_artifact_id, error_evidence_ref, lease_owner, lease_expires_at`;
const STATE_COLUMNS = `business_id, run_id, state_key, definition_ref, resolved_input, status,
  version, created_at, started_at, finished_at, result_artifact_id, error_evidence_ref`;

/** PostgreSQL persistence for business-scoped Runs, States, attempts, and lineage. */
export class RunStore {
  constructor(private readonly transactions: TransactionPort) {}

  async start(input: StartRunInput): Promise<PersistedRun> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<RunRow>(
        `INSERT INTO runs (id, business_id, bundle, identity, bounds, created_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::timestamptz)
         RETURNING ${RUN_COLUMNS}`,
        [
          input.id,
          input.businessId,
          JSON.stringify(input.bundle),
          JSON.stringify(input.identity),
          JSON.stringify(input.bounds),
          input.createdAt,
        ]
      );
      const run = inserted.rows[0];
      if (!run) throw new Error("run_insert_without_row");

      for (const state of input.states) {
        await transaction.query(
          `INSERT INTO run_states (
             business_id, run_id, state_key, definition_ref, resolved_input, created_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
          [
            input.businessId,
            input.id,
            state.key,
            state.definitionRef,
            JSON.stringify(state.resolvedInput),
            input.createdAt,
          ]
        );
      }

      if (input.parentRunId !== undefined) {
        await transaction.query(
          `INSERT INTO run_lineage (
             business_id, source_run_id, target_run_id, relation, created_at
           ) VALUES ($1, $2, $3, $4, $5::timestamptz)`,
          [input.businessId, input.parentRunId, input.id, input.lineage ?? "child", input.createdAt]
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

  /**
   * One page of a business's Runs, newest first. Keyset paging on `(created_at, id)` — an offset
   * would skip or repeat rows as new Runs land between pages, which an operator watching a live
   * system would see as Runs vanishing.
   */
  async list(input: ListRunsInput): Promise<RunPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_RUN_PAGE_SIZE);
    const cursor = decodeRunCursor(input.cursor);
    return this.transactions.withTransaction(async (transaction) => {
      const params: unknown[] = [input.businessId, limit + 1];
      if (cursor) params.push(cursor.createdAt, cursor.id);
      const keyset = cursor ? "AND (created_at, id) < ($3::timestamptz, $4::uuid)" : "";
      const result = await transaction.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
           FROM runs
          WHERE business_id = $1 ${keyset}
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

  async listStates(businessId: string, runId: string): Promise<readonly PersistedState[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<StateRow>(
        `SELECT ${STATE_COLUMNS}
           FROM run_states
          WHERE business_id = $1 AND run_id = $2
          ORDER BY state_key`,
        [businessId, runId]
      );
      return result.rows.map(persistedState);
    });
  }

  async findState(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<PersistedState | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<StateRow>(
        `SELECT ${STATE_COLUMNS}
           FROM run_states
          WHERE business_id = $1 AND run_id = $2 AND state_key = $3`,
        [businessId, runId, stateKey]
      );
      const row = result.rows[0];
      return row ? persistedState(row) : null;
    });
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
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        `UPDATE runs
            SET version = version + 1,
                lease_expires_at = $5::timestamptz
          WHERE business_id = $1
            AND id = $2
            AND version = $3
            AND lease_owner = $4
            AND status IN ('claimed', 'running')
          RETURNING id`,
        [businessId, runId, heartbeat.expectedVersion, owner, heartbeat.leaseExpiresAt]
      );
      return result.rows.length === 1;
    });
  }

  /** Requeues Runs whose worker lease expired so another worker can claim them. */
  async reclaimExpiredRuns(
    businessId: string,
    now: string,
    limit: number
  ): Promise<readonly PersistedRun[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunRow>(
        `WITH candidates AS (
           SELECT id
             FROM runs
            WHERE business_id = $1
              AND status IN ('claimed', 'running')
              AND lease_expires_at <= $2::timestamptz
            ORDER BY lease_expires_at
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         )
         UPDATE runs
            SET status = 'queued',
                version = version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL
           FROM candidates
          WHERE runs.id = candidates.id
         RETURNING runs.id, runs.business_id, runs.bundle, runs.identity, runs.bounds,
                   runs.status, runs.version, runs.created_at, runs.started_at, runs.finished_at,
                   runs.result_artifact_id, runs.error_evidence_ref, runs.lease_owner,
                   runs.lease_expires_at`,
        [businessId, now, Math.max(0, limit)]
      );
      return result.rows.map(persistedRun);
    });
  }

  /** Claims a batch of queued Runs with an owned, timed lease so a worker can start them. */
  async claimNextQueued(
    businessId: string,
    owner: string,
    input: ClaimNextQueuedInput
  ): Promise<readonly PersistedRun[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const leaseExpiresAt = new Date(
        new Date(input.now).getTime() + input.leaseDurationMs
      ).toISOString();
      const result = await transaction.query<RunRow>(
        `WITH candidates AS (
           SELECT id
             FROM runs
            WHERE business_id = $1
              AND status = 'queued'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $4
         )
         UPDATE runs
            SET status = 'claimed',
                version = version + 1,
                lease_owner = $2,
                lease_expires_at = $3::timestamptz
           FROM candidates
          WHERE runs.id = candidates.id
         RETURNING runs.id, runs.business_id, runs.bundle, runs.identity, runs.bounds,
                   runs.status, runs.version, runs.created_at, runs.started_at, runs.finished_at,
                   runs.result_artifact_id, runs.error_evidence_ref, runs.lease_owner,
                   runs.lease_expires_at`,
        [businessId, owner, leaseExpiresAt, Math.max(0, input.limit)]
      );
      return result.rows.map(persistedRun);
    });
  }

  /**
   * Requeues a waiting Run whose durable wait resolved. Idempotent by construction: only a Run
   * still in `waiting` moves, so a duplicate resume never requeues the same Run twice.
   */
  async requeueWaitingRun(businessId: string, runId: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ id: string }>(
        `UPDATE runs
            SET status = 'queued',
                version = version + 1
          WHERE business_id = $1
            AND id = $2
            AND status = 'waiting'
          RETURNING id`,
        [businessId, runId]
      );
      return result.rows.length === 1;
    });
  }

  async transitionState(
    businessId: string,
    runId: string,
    stateKey: string,
    transition: StateTransitionInput
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ state_key: string }>(
        `UPDATE run_states
            SET status = $6,
                version = version + 1,
                started_at = COALESCE($7::timestamptz, started_at),
                finished_at = COALESCE($8::timestamptz, finished_at),
                result_artifact_id = COALESCE($9, result_artifact_id),
                error_evidence_ref = COALESCE($10, error_evidence_ref)
          WHERE business_id = $1
            AND run_id = $2
            AND state_key = $3
            AND version = $4
            AND status = $5
          RETURNING state_key`,
        [
          businessId,
          runId,
          stateKey,
          transition.expectedVersion,
          transition.expectedStatus,
          transition.status,
          transition.startedAt ?? null,
          transition.finishedAt ?? null,
          transition.resultArtifactId ?? null,
          transition.errorEvidenceRef ?? null,
        ]
      );
      return result.rows.length === 1;
    });
  }

  async appendAttempt(input: AppendAttemptInput): Promise<AppendAttemptResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<{ id: string }>(
        `INSERT INTO state_attempts (
           id, business_id, run_id, state_key, attempt, sequence, event,
           event_digest, occurred_at, evidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)
         ON CONFLICT (business_id, run_id, state_key, attempt, sequence) DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.businessId,
          input.runId,
          input.stateKey,
          input.attempt,
          input.sequence,
          input.event,
          input.eventDigest,
          input.occurredAt,
          JSON.stringify(input.evidence),
        ]
      );
      if (inserted.rows.length === 1) return { outcome: "appended" };

      const existing = await transaction.query<AttemptRow>(
        `SELECT event_digest
           FROM state_attempts
          WHERE business_id = $1
            AND run_id = $2
            AND state_key = $3
            AND attempt = $4
            AND sequence = $5`,
        [input.businessId, input.runId, input.stateKey, input.attempt, input.sequence]
      );
      if (existing.rows[0]?.event_digest !== input.eventDigest) {
        throw new RunPersistenceError("attempt_conflict");
      }
      return { outcome: "duplicate" };
    });
  }

  /** Highest attempt number recorded per State key, for Run inspector read models. */
  async countStateAttempts(
    businessId: string,
    runId: string
  ): Promise<ReadonlyMap<string, number>> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ state_key: string; attempts: string | number }>(
        `SELECT state_key, MAX(attempt) AS attempts
           FROM state_attempts
          WHERE business_id = $1 AND run_id = $2
          GROUP BY state_key`,
        [businessId, runId]
      );
      return new Map(result.rows.map((row) => [row.state_key, Number(row.attempts)]));
    });
  }

  async listLineage(businessId: string, targetRunId: string): Promise<readonly RunLineage[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<LineageRow>(
        `SELECT business_id, source_run_id, target_run_id, relation, created_at
           FROM run_lineage
          WHERE business_id = $1 AND target_run_id = $2
          ORDER BY created_at, source_run_id`,
        [businessId, targetRunId]
      );
      return result.rows.map((row) => ({
        businessId: row.business_id,
        sourceRunId: row.source_run_id,
        targetRunId: row.target_run_id,
        relation: row.relation,
        createdAt: timestamp(row.created_at),
      }));
    });
  }
}
