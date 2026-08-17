import type { TransactionPort } from "@tulipfarm/storage";

/** What one user's Memory erasure removed. */
export interface MemoryErasureCounts {
  readonly documents: number;
  readonly revisions: number;
}

export class MemoryErasureService {
  constructor(private readonly transactions: TransactionPort) {}

  /**
   * Erases everything Memory holds for one user, in one transaction. A partial erase is worse
   * than none: the caller is told the fact is gone while the half that survived still supplies it.
   *
   * Curator work, effects and Run Artifacts join this sweep when they exist; until then there is
   * nothing of the user's in them to erase.
   */
  async eraseUser(businessId: string, userId: string): Promise<MemoryErasureCounts> {
    return this.transactions.withTransaction(async (tx) => {
      // `Queryable` exposes `rows`, not `rowCount`, across pg and PGlite — so count what returns.
      const deleted = async (sql: string, params: readonly unknown[]): Promise<number> =>
        (await tx.query(`${sql} RETURNING 1`, [...params])).rows.length;

      // Revisions first: they are the document's history, and deleting the document first would
      // report success while every superseded copy of the same fact survived.
      const revisions = await deleted(
        "DELETE FROM user_memory_revisions WHERE business_id = $1 AND user_id = $2",
        [businessId, userId]
      );
      const documents = await deleted(
        "DELETE FROM user_memory WHERE business_id = $1 AND user_id = $2",
        [businessId, userId]
      );

      return { documents, revisions };
    });
  }
}
