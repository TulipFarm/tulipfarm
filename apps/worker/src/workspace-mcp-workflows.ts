import { proxyActivities } from '@temporalio/workflow';
import type { createWorkspaceMcpDiscoveryActivities } from './workspace-mcp-composition.ts';

const { discoverWorkspaceMcp } = proxyActivities<ReturnType<typeof createWorkspaceMcpDiscoveryActivities>>({
  // A hosted package may build for 10 minutes and start for 2 before discovery's own 3 minutes.
  startToCloseTimeout: '16 minutes',
  retry: { maximumAttempts: 1 },
});
export async function workspaceMcpDiscovery(
  workspaceId: string,
  userId: string,
  integrationId: string,
  requestId: string,
  expectedVersion: number,
) {
  await discoverWorkspaceMcp(workspaceId, userId, integrationId, requestId, expectedVersion);
}
