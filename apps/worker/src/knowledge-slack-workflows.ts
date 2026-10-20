import { proxyActivities } from '@temporalio/workflow';
import type { createSlackKnowledgeActivities } from './knowledge-slack-activities.ts';

const { processSlackKnowledge } = proxyActivities<ReturnType<typeof createSlackKnowledgeActivities>>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 1 },
});

export async function slackKnowledgeSync(work: Parameters<typeof processSlackKnowledge>[0]): Promise<void> {
  await processSlackKnowledge(work);
}
