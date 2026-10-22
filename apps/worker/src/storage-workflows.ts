import { proxyActivities } from '@temporalio/workflow';
import type { createWorkspaceMaintenance } from '@tulipfarm/workspaces/lifecycle';
import type { createTableCleanupMaintenance } from './table-cleanup.ts';

const { initializeWorkspaceStorage } = proxyActivities<
  Pick<ReturnType<typeof createWorkspaceMaintenance>, 'initializeWorkspaceStorage'>
>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '5 seconds', maximumInterval: '5 minutes', maximumAttempts: 5 },
});

export async function initializeIsolatedWorkspace(workspaceId: string) {
  await initializeWorkspaceStorage(workspaceId);
}

export async function storageHealthCheck() {
  return 'isolated-v1';
}

export async function reconcileTableCleanup(workspaceId: string) {
  const { cleanupTableHistory } = proxyActivities<
    Pick<ReturnType<typeof createTableCleanupMaintenance>, 'cleanupTableHistory'>
  >({
    startToCloseTimeout: '30 seconds',
    retry: { initialInterval: '1 second', maximumInterval: '10 seconds', maximumAttempts: 5 },
  });
  for (let batch = 0; batch < 20; batch++) {
    if ((await cleanupTableHistory(workspaceId)) === 'completed') return 'completed';
  }
  return 'more';
}
