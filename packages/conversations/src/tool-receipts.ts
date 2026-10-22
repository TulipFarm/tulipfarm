import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export async function interruptToolReceipts(
  tx: AuthorizationTransaction,
  turnId: string,
  status: 'blocked' | 'failed',
) {
  await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_conversation_tool_calls')} SET status = $2 WHERE turn_id = $1 AND status = 'running'`,
    [turnId, status],
  );
}
