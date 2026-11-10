import { proxyActivities } from '@temporalio/workflow';
import type { createWorkspaceMcpDiscoveryActivities } from './workspace-mcp-composition.ts';

const { discoverWorkspaceMcp } = proxyActivities<ReturnType<typeof createWorkspaceMcpDiscoveryActivities>>({
  startToCloseTimeout: '3 minutes',
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
