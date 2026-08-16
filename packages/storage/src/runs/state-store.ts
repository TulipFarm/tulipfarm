import type { Queryable } from "../ports";
import { RunPersistenceError } from "./run-persistence-error";
import { optionalTimestamp, timestamp } from "./timestamps";

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

export interface StartStateInput {
  readonly key: string;
  readonly definitionRef: string;
  readonly resolvedInput: Record<string, unknown>;
}

export interface EnsureStateInput extends StartStateInput {
  readonly businessId: string;
  readonly runId: string;
  readonly createdAt: string;
}

export interface EnsureStateResult {
  readonly outcome: "inserted" | "existing";
  readonly state: PersistedState;
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

export interface StateTransitionInput {
  readonly expectedVersion: number;
  readonly expectedStatus: PersistedStateStatus;
  readonly status: PersistedStateStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly resultArtifactId?: string;
  readonly errorEvidenceRef?: string;
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

const STATE_COLUMNS = `business_id, run_id, state_key, definition_ref, resolved_input, status,
  version, created_at, started_at, finished_at, result_artifact_id, error_evidence_ref`;

/** Inserts one scheduled State row within the enclosing Run's `start` transaction. */
export async function insertStateRow(
  transaction: Queryable,
  businessId: string,
  runId: string,
  state: StartStateInput,
  createdAt: string
): Promise<void> {
  await transaction.query(
    `INSERT INTO run_states (
       business_id, run_id, state_key, definition_ref, resolved_input, created_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
    [
      businessId,
      runId,
      state.key,
      state.definitionRef,
      JSON.stringify(state.resolvedInput),
      createdAt,
    ]
  );
}

/** Idempotent later-State insert; first schedule timestamp and resolved input win. */
export async function ensureStateRow(
  transaction: Queryable,
  input: EnsureStateInput
): Promise<EnsureStateResult> {
  const inserted = await transaction.query<StateRow>(
    `INSERT INTO run_states (
       business_id, run_id, state_key, definition_ref, resolved_input, created_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
     ON CONFLICT (business_id, run_id, state_key) DO NOTHING
     RETURNING ${STATE_COLUMNS}`,
    [
      input.businessId,
      input.runId,
      input.key,
      input.definitionRef,
      JSON.stringify(input.resolvedInput),
      input.createdAt,
    ]
  );
  const created = inserted.rows[0];
  if (created) return { outcome: "inserted", state: persistedState(created) };

  const existing = await transaction.query<StateRow>(
    `SELECT ${STATE_COLUMNS}
       FROM run_states
      WHERE business_id = $1
        AND run_id = $2
        AND state_key = $3
        AND definition_ref = $4
        AND resolved_input = $5::jsonb`,
    [
      input.businessId,
      input.runId,
      input.key,
      input.definitionRef,
      JSON.stringify(input.resolvedInput),
    ]
  );
  const state = existing.rows[0];
  if (!state) throw new RunPersistenceError("state_conflict");
  return { outcome: "existing", state: persistedState(state) };
}

export async function listStateRows(
  transaction: Queryable,
  businessId: string,
  runId: string
): Promise<readonly PersistedState[]> {
  const result = await transaction.query<StateRow>(
    `SELECT ${STATE_COLUMNS}
       FROM run_states
      WHERE business_id = $1 AND run_id = $2
      ORDER BY state_key`,
    [businessId, runId]
  );
  return result.rows.map(persistedState);
}

export async function findStateRow(
  transaction: Queryable,
  businessId: string,
  runId: string,
  stateKey: string
): Promise<PersistedState | null> {
  const result = await transaction.query<StateRow>(
    `SELECT ${STATE_COLUMNS}
       FROM run_states
      WHERE business_id = $1 AND run_id = $2 AND state_key = $3`,
    [businessId, runId, stateKey]
  );
  const row = result.rows[0];
  return row ? persistedState(row) : null;
}

export async function transitionStateRow(
  transaction: Queryable,
  businessId: string,
  runId: string,
  stateKey: string,
  transition: StateTransitionInput
): Promise<boolean> {
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
}
