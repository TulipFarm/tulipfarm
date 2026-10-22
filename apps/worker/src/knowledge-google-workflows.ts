import { proxyActivities } from '@temporalio/workflow';
import type { createGoogleKnowledgeActivities } from './knowledge-google-activities.ts';

const { processGoogleKnowledge } = proxyActivities<ReturnType<typeof createGoogleKnowledgeActivities>>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 1 },
});

export async function googleKnowledgeSync(work: Parameters<typeof processGoogleKnowledge>[0]): Promise<void> {
  await processGoogleKnowledge(work);
}
