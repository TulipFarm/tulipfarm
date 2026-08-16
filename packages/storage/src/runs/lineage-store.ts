import type { Queryable } from "../ports";
import { timestamp } from "./timestamps";

export type RunLineageRelation = "child" | "replay";

export interface RunLineage {
  readonly businessId: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly relation: RunLineageRelation;
  readonly createdAt: string;
}

interface LineageRow {
  business_id: string;
  source_run_id: string;
  target_run_id: string;
  relation: RunLineageRelation;
  created_at: string | Date;
}

/** Inserts one parent→child (or replay) lineage edge within the enclosing Run's `start` transaction. */
export async function insertLineageRow(
  transaction: Queryable,
  businessId: string,
  sourceRunId: string,
  targetRunId: string,
  relation: RunLineageRelation,
  createdAt: string
): Promise<void> {
  await transaction.query(
    `INSERT INTO run_lineage (
       business_id, source_run_id, target_run_id, relation, created_at
     ) VALUES ($1, $2, $3, $4, $5::timestamptz)`,
    [businessId, sourceRunId, targetRunId, relation, createdAt]
  );
}

export async function listLineageRows(
  transaction: Queryable,
  businessId: string,
  targetRunId: string
): Promise<readonly RunLineage[]> {
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
}
