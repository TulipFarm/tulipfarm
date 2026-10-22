import { proxyActivities } from '@temporalio/workflow';
import type { createAtlassianKnowledgeActivities } from './knowledge-atlassian-activities.ts';

const { processAtlassianKnowledge } = proxyActivities<ReturnType<typeof createAtlassianKnowledgeActivities>>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 1 },
});

export async function atlassianKnowledgeSync(work: Parameters<typeof processAtlassianKnowledge>[0]): Promise<void> {
  await processAtlassianKnowledge(work);
}
