import { withTransaction } from "../pg/transaction-helpers";
import type { Queryable } from "../ports";
import { settleCuratorReservation } from "./admission";
import { releaseCuratorWork } from "./work";

/**
 * Retires a job that will never reason, in one transaction: terminal state, work back to `due`,
 * reservation released.
 *
 * All three or none. Releasing the work without terminalizing the job leaves the live-target unique
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
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE curator_job SET state = $2, updated_at = now()
        WHERE id = $1 AND state IN ('minted', 'running') AND output_digest IS NULL
        RETURNING id`,
      [jobId, state]
    );
    if (rows.length === 0) return false;
    await releaseCuratorWork(tx, jobId);
    await settleCuratorReservation(tx, jobId, 0);
    return true;
  });
}
