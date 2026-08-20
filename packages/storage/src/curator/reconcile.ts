import { withTransaction } from "../pg/transaction-helpers";
import type { Queryable } from "../ports";
import { settleCuratorReservation } from "./admission";
import { releaseCuratorWork } from "./work";

/**
 * Retires a job that will never reason, in one transaction: terminal state, work back to `due`,
 * reservation released, and the Run that was doing it terminalized.
 *
 * All four or none. Releasing the work without terminalizing the job leaves the live-target unique
 * index holding the target forever, so the next mint is refused and the work it just freed can
 * never be claimed by anyone — the exact deadlock the index exists to prevent.
 */
export async function abandonCuratorJob(
  db: Queryable,
  jobId: string,
  state: "cancelled" | "failed" = "cancelled"
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    // Only a job that never settled: one that already recorded effects has answered, and replaying
    // its work would ask the model the same question twice.
    const { rows } = await tx.query<{ id: string; run_id: string | null }>(
      `UPDATE curator_job SET state = $2, updated_at = now()
        WHERE id = $1 AND state IN ('minted', 'running') AND output_digest IS NULL
        RETURNING id, run_id`,
      [jobId, state]
    );
    const abandoned = rows[0];
    if (!abandoned) return false;
    await releaseCuratorWork(tx, jobId);
    await settleCuratorReservation(tx, jobId, 0);
    if (abandoned.run_id) await failParkedRun(tx, abandoned.run_id);
    return true;
  });
}

/**
 * Closes the Run of a job the reconciler just gave up on.
 *
 * Guarded to the single `needs_reconciliation -> failed` move the kernel already allows, so this
 * can neither race a live Run nor invent a transition. Without it the operator is left a Run that
 * no sweep will ever drive again, describing work nobody is still doing.
 */
async function failParkedRun(tx: Queryable, runId: string): Promise<void> {
  await tx.query(
    `UPDATE runs
        SET status = 'failed',
            version = version + 1,
            finished_at = COALESCE(finished_at, now()),
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE id::text = $1 AND status = 'needs_reconciliation'`,
    [runId]
  );
}
