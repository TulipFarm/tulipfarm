import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createAgentChat } from '../dist/chat.js';
import { syntheticContinuity } from './continuity-fixture.mjs';

const { CONTINUITY_RUNTIME_URL, CONTINUITY_WORKSPACE_ID, CONTINUITY_RUN_ID, CONTINUITY_INTERRUPT } = process.env;
const runtime = createWorkspaceRuntime({
  replicaCount: 1,
  reservedConnections: 2,
  databaseConnectionBudget: 20,
  resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: CONTINUITY_RUNTIME_URL }),
});
try {
  const settings = syntheticContinuity(async () => ({ kind: 'answer', text: 'Unused' }));
  settings.infer = async resolution => {
    if (CONTINUITY_INTERRUPT === '1') {
      process.stdout.write('attempt-dispatched\n');
      await new Promise(resolve => setTimeout(resolve, 120000));
    }
    return {
      kind: 'failure',
      reason: 'unavailable',
      status: 503,
      retryAfterMs: null,
      actualModel: resolution.modelId,
      requestId: null,
      usage: { kind: 'unknown' },
    };
  };
  await createAgentChat(runtime, settings).processTurn(CONTINUITY_WORKSPACE_ID, CONTINUITY_RUN_ID);
} finally {
  await runtime.close();
}
