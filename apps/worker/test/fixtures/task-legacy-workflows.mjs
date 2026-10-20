import { proxyActivities } from '@temporalio/workflow';

const activities = proxyActivities({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '10 seconds' },
});
export async function agentTaskStep(workspaceId, taskId) {
  await activities.processAgentTask(workspaceId, taskId);
}
