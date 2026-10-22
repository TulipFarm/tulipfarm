import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/dist/runtime.js';
import { createAgentComposition } from '../dist/agent-composition.js';

async function main() {
  let runtime;
  let connection;
  try {
    const workspaceId = process.env.INTEGRATION_ACCEPTANCE_WORKSPACE;
    const connectionString = process.env.INTEGRATION_ACCEPTANCE_DATABASE_URL;
    const endpoint = new URL(connectionString);
    if (
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.port !== '5432' ||
      !endpoint.pathname.startsWith('/integration_acceptance_')
    )
      throw new Error('Disposable database required');
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        if (id !== workspaceId) throw new Error('Unexpected workspace');
        return { workspaceId, generation: 1, connectionString };
      },
    });
    const executor = createAgentComposition(runtime);
    connection = await NativeConnection.connect({ address: '127.0.0.1:7233' });
    const worker = await Worker.create({
      connection,
      taskQueue: process.env.INTEGRATION_ACCEPTANCE_QUEUE,
      workflowsPath: fileURLToPath(new URL('../../../packages/agents/dist/workflows.js', import.meta.url)),
      activities: executor.activities,
    });
    const running = worker.run();
    process.send?.({ kind: 'ready' });
    await running;
  } finally {
    await connection?.close();
    await runtime?.close();
  }
}

try {
  await main();
} catch {
  console.error('Integration acceptance worker failed; details suppressed');
  process.exitCode = 1;
}
