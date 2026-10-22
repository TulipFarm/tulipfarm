import { proxyActivities } from '@temporalio/workflow';
import type { createDefaultKnowledgeActivities } from './knowledge-defaults-activities.ts';

const { processDefaultKnowledge } = proxyActivities<ReturnType<typeof createDefaultKnowledgeActivities>>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 1 },
});

export async function knowledgeDefaultsSync(work: Parameters<typeof processDefaultKnowledge>[0]): Promise<void> {
  await processDefaultKnowledge(work);
}
