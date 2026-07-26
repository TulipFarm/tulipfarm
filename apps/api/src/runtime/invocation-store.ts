import type { Queryable } from "../db";
import { withTransaction } from "../db";
import type { DurableInvocationRecord, DurableInvocationStore } from "./invocation-gateway";

export const CUTOVER_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS durable_invocations (
    business_id      text NOT NULL,
    source           text NOT NULL,
    idempotency_key  text NOT NULL,
    run_id           uuid NOT NULL,
    created_at       timestamptz NOT NULL,
    PRIMARY KEY (business_id, source, idempotency_key),
    UNIQUE (business_id, run_id),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
      DEFERRABLE INITIALLY DEFERRED
  )`,
];

interface InvocationRow {
  run_id: string;
}

/**
 * PostgreSQL cutover adapter. The deduplication claim, Run, and initial State commit together, so
 * an API crash cannot acknowledge work that the durable dispatcher cannot subsequently claim.
 */
export class PgDurableInvocationStore implements DurableInvocationStore {
  constructor(private readonly database: Queryable) {}

  async persist(record: DurableInvocationRecord) {
    return withTransaction(this.database, async (transaction) => {
      const claimed = await transaction.query(
        `INSERT INTO durable_invocations (
           business_id, source, idempotency_key, run_id, created_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (business_id, source, idempotency_key) DO NOTHING
         RETURNING run_id`,
        [record.businessId, record.source, record.idempotencyKey, record.runId, record.createdAt]
      );
      if (claimed.rows.length === 0) {
        const existing = await transaction.query(
          `SELECT run_id
             FROM durable_invocations
            WHERE business_id = $1 AND source = $2 AND idempotency_key = $3`,
          [record.businessId, record.source, record.idempotencyKey]
        );
        const row = existing.rows[0] as unknown as InvocationRow | undefined;
        if (!row) throw new Error("durable_invocation_conflict_without_run");
        return { outcome: "duplicate" as const, runId: row.run_id };
      }

      await transaction.query(
        `INSERT INTO runs (id, business_id, bundle, identity, bounds, created_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::timestamptz)`,
        [
          record.runId,
          record.businessId,
          JSON.stringify(record.bundle),
          JSON.stringify({
            initiator: record.initiator,
            effectiveSubject: record.effectiveSubject,
            guardrailContextRef:
              record.identityMappingEvidenceRef ?? `identity:${record.initiator.kind}`,
          }),
          JSON.stringify({
            wallTimeMs: 3_600_000,
            activeTimeMs: 900_000,
            attempts: 3,
            sideEffects: 100,
          }),
          record.createdAt,
        ]
      );
      await transaction.query(
        `INSERT INTO run_states (
           business_id, run_id, state_key, definition_ref, resolved_input, created_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
        [
          record.businessId,
          record.runId,
          record.state.key,
          record.state.definitionRef,
          JSON.stringify(record.state.resolvedInput),
          record.createdAt,
        ]
      );

      return { outcome: "started" as const, runId: record.runId };
    });
  }
}
