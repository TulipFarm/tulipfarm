import type { Queryable } from "../ports";
import { RunPersistenceError } from "./run-persistence-error";

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

interface AttemptRow {
  event_digest: string;
}

export async function appendAttemptRow(
  transaction: Queryable,
  input: AppendAttemptInput
): Promise<AppendAttemptResult> {
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
}

/** Highest attempt number recorded per State key, for Run inspector read models. */
export async function countStateAttemptRows(
  transaction: Queryable,
  businessId: string,
  runId: string
): Promise<ReadonlyMap<string, number>> {
  const result = await transaction.query<{ state_key: string; attempts: string | number }>(
    `SELECT state_key, MAX(attempt) AS attempts
       FROM state_attempts
      WHERE business_id = $1 AND run_id = $2
      GROUP BY state_key`,
    [businessId, runId]
  );
  return new Map(result.rows.map((row) => [row.state_key, Number(row.attempts)]));
}
