import { proxyActivities } from '@temporalio/workflow';

const { prepareAgentDefinition } = proxyActivities<{
  prepareAgentDefinition(
    workspaceId: string,
    commandId: string,
  ): Promise<'preparing' | 'accepted' | 'conflict' | 'failed'>;
}>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 5, initialInterval: '2 seconds' } });

export async function prepareAgentSave(workspaceId: string, commandId: string) {
  return prepareAgentDefinition(workspaceId, commandId);
}
