import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { ExecutionIds, ExecutionStatus } from './contracts.ts';

export const resumeAgentTool = defineSignal('resumeAgentTool');
const activities = proxyActivities<{
  executeAgentTool(ids: ExecutionIds): Promise<ExecutionStatus>;
}>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', maximumInterval: '10 seconds', maximumAttempts: 5 },
});

export async function boundedAgentTool(ids: ExecutionIds): Promise<ExecutionStatus> {
  let resume = false;
  setHandler(resumeAgentTool, () => {
    resume = true;
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await activities.executeAgentTool(ids);
    if (status !== 'waiting') return status;
    await condition(() => resume, '30 seconds');
    resume = false;
  }
  return 'waiting';
}
