import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';

/** Delay after `waits` consecutive attempts that made no progress: 250 ms, doubling to 1 minute. */
function tableProposalWaitMs(waits: number) {
  return Math.min(250 * 2 ** Math.max(0, waits - 1), 60_000);
}

export async function executeTableProposal(
  workspaceId: string,
  proposalId: string,
  storageQueue: string,
  waits = 0,
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
    waits = status === 'wait' ? waits + 1 : 0;
    await sleep(waits ? tableProposalWaitMs(waits) : 100);
  }
  await continueAsNew<typeof executeTableProposal>(workspaceId, proposalId, storageQueue, waits);
}
