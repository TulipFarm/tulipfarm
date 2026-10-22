import { proxyActivities } from '@temporalio/workflow';
import type { createKnowledgeEmbeddingActivities } from './knowledge-embedding-activities.ts';

const { processKnowledgeEmbedding } = proxyActivities<ReturnType<typeof createKnowledgeEmbeddingActivities>>({
  startToCloseTimeout: '4 minutes',
  retry: { maximumAttempts: 1 },
});

export async function knowledgeEmbed(work: Parameters<typeof processKnowledgeEmbedding>[0]): Promise<void> {
  await processKnowledgeEmbedding(work);
}
