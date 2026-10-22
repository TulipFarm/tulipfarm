import type { AuthorizationTransaction, HumanActor } from '@tulipfarm/access';
import { createMemoryReconciliation } from '@tulipfarm/memory-core/memory/reconciliation';
import {
  createPostgresMemoryReconciliationRepository,
  createPostgresTranscriptSource,
} from '@tulipfarm/memory-postgres';
import type { MaintenanceFence } from './maintenance-contracts.ts';
import type { ConversationCompactor, EffectiveCompactionPolicy } from './compaction.ts';
import { personalMemory } from './personal-memory.ts';
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

const reconcile = createMemoryReconciliation<AuthorizationTransaction>({
  memory: personalMemory,
  repository: tx => createPostgresMemoryReconciliationRepository(tx.client, { schema: tx.schema, tablePrefix: 'tf_' }),
  transcript: tx => createPostgresTranscriptSource(tx.client, { schema: tx.schema, tablePrefix: 'tf_' }),
});
export async function reconcileMaintenanceMemory(
  transaction: MemoryTransaction,
  fence: MaintenanceFence,
  compactor: ConversationCompactor,
): Promise<boolean> {
  return reconcile<MaintenanceFence>(transaction, fence, compactor);
}
