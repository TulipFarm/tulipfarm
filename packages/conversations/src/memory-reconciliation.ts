import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { createMemoryReconciliation } from '@tulipfarm/memory-core/memory/reconciliation';
import {
  createPostgresMemoryReconciliationRepository,
  createPostgresTranscriptSource,
} from '@tulipfarm/memory-postgres';
import type { MaintenanceFence } from './maintenance-contracts.ts';
import type { ConversationCompactor, EffectiveCompactionPolicy } from './compaction.ts';
import { legacyPersonalMemory, personalMemoryMode } from './personal-memory.ts';
export { preferenceSystemPrompt, parsePreferenceReconciliation } from '@tulipfarm/memory-core/memory/reconciliation';

type MemoryTransaction = <T>(
  operation: (
    tx: AuthorizationTransaction,
    current: {
      actor: HumanActor;
      coveredThrough: number | null;
      policy: EffectiveCompactionPolicy | null;
    },
  ) => Promise<T>,
) => Promise<T>;

const repository = (tx: AuthorizationTransaction) =>
  createPostgresMemoryReconciliationRepository(tx.client, { schema: tx.schema, tablePrefix: 'tf_' });
const reconcile = createMemoryReconciliation<AuthorizationTransaction>({
  memory: legacyPersonalMemory,
  repository,
  transcript: tx => createPostgresTranscriptSource(tx.client, { schema: tx.schema, tablePrefix: 'tf_' }),
});
export async function reconcileMaintenanceMemory(
  transaction: MemoryTransaction,
  fence: MaintenanceFence,
  compactor: ConversationCompactor,
): Promise<boolean> {
  // Background learning writes only the workspace's own store. With Keep, memory changes only when the member asks.
  const keep = await transaction(async (tx, current) => {
    if ((await personalMemoryMode(tx, current.actor)).kind === 'legacy') return false;
    await repository(tx).complete([fence.jobId]);
    return true;
  });
  return keep || reconcile<MaintenanceFence>(transaction, fence, compactor);
}
