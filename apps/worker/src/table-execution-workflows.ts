import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';

export async function executeTableProposal(
  workspaceId: string,
  proposalId: string,
  storageQueue: string,
): Promise<void> {
  const { publishTableProposal } = proxyActivities<{ publishTableProposal: ReturnType<typeof createTablePublication> }>(
    {
      startToCloseTimeout: '2 minutes',
      retry: { initialInterval: '1 second', maximumInterval: '30 seconds', maximumAttempts: 5 },
    },
  );
  const { advanceTableProposal } = proxyActivities<{ advanceTableProposal: ReturnType<typeof createTableExecution> }>({
    taskQueue: storageQueue,
    startToCloseTimeout: '30 seconds',
    retry: { initialInterval: '1 second', maximumInterval: '10 seconds', maximumAttempts: 10 },
  });
  for (let i = 0; i < 100; i++) {
    const status = await advanceTableProposal(workspaceId, proposalId);
    if (status === 'completed' || status === 'blocked') return;
    if (status === 'publish') await publishTableProposal(workspaceId, proposalId);
    await sleep('100 milliseconds');
  }
  await continueAsNew<typeof executeTableProposal>(workspaceId, proposalId, storageQueue);
}
