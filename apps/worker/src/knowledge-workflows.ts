import { proxyActivities } from '@temporalio/workflow';
import type { KnowledgeWork } from '@tulipfarm/knowledge';
import type { createKnowledgeActivities } from './knowledge-activities.ts';

const { processKnowledge } = proxyActivities<ReturnType<typeof createKnowledgeActivities>>({
  startToCloseTimeout: '4 minutes',
  retry: { maximumAttempts: 1 },
});

export async function knowledgeIngest(work: KnowledgeWork): Promise<void> {
  await processKnowledge(work);
}
