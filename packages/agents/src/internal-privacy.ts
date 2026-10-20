import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export async function requireHumanRun(transaction: AuthorizationTransaction, runId: string) {
  if (
    (
      await transaction.client.query(
        `SELECT 1 FROM ${qualified(transaction.schema, 'tf_internal_conversations')} WHERE id = $1`,
        [runId],
      )
    ).rowCount
  )
    throw new AccessDenied();
}
