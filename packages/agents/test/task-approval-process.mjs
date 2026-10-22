import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createAgentExecutor } from '../src/executor.ts';

const input = JSON.parse(process.env.TASK_APPROVAL_PROCESS);
const runtime = createWorkspaceRuntime({
  replicaCount: 1,
  reservedConnections: 2,
  databaseConnectionBudget: 20,
  resolveCredential: async workspaceId => ({ workspaceId, generation: 1, connectionString: input.connectionString }),
});
const storage = input.fault
  ? {
      transaction: (id, range, action) =>
        runtime.transaction(id, range, tx =>
          action({
            ...tx,
            client: {
              query: async (sql, args) => {
                if (sql.startsWith('UPDATE ') && sql.includes('tf_agent_tool_calls') && sql.includes('result=')) {
                  process.send({ at: 'write-before-receipt' });
                  await new Promise(() => {});
                }
                return tx.client.query(sql, args);
              },
            },
          }),
        ),
    }
  : runtime;
try {
  const status = await createAgentExecutor({ runtime: storage }).execute(input.ids);
  process.send({ at: 'committed', status });
  await new Promise(resolve => process.on('message', resolve));
} finally {
  await runtime.close();
}
