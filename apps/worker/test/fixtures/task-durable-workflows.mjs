import { continueAsNew, patched, proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';

const legacy = proxyActivities({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '10 seconds' },
});
const activities = proxyActivities({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '1 second', maximumInterval: '10 seconds' },
});

export async function agentTaskStep(workspaceId, taskId) {
  if (!patched('agent-task-durable-progress-v1')) {
    await legacy.processAgentTask(workspaceId, taskId);
    return;
  }
  for (let step = 0; step < 100; step++) {
    const result = await activities.processAgentTaskStep(workspaceId, taskId);
    switch (result.kind) {
      case 'terminal':
      case 'waiting':
        return;
      case 'accounting':
      case 'runnable':
        await sleep('2 seconds');
        break;
      default:
        throw new Error('Invalid task progress');
    }
    if (workflowInfo().continueAsNewSuggested) break;
  }
  await continueAsNew(workspaceId, taskId);
}
