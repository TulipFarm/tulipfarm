import { ApplicationFailure } from '@temporalio/common';
import { embeddingWorkSchema, type EmbeddingWork, type createKnowledgeEmbeddings } from '@tulipfarm/knowledge';

export function createKnowledgeEmbeddingActivities(
  service: Pick<ReturnType<typeof createKnowledgeEmbeddings>, 'process'>,
) {
  return {
    async processKnowledgeEmbedding(value: EmbeddingWork): Promise<void> {
      const parsed = embeddingWorkSchema.safeParse(value);
      if (!parsed.success)
        throw ApplicationFailure.nonRetryable('Invalid knowledge embedding work', 'InvalidKnowledgeEmbeddingWork');
      try {
        await service.process(parsed.data);
      } catch {
        throw ApplicationFailure.nonRetryable(
          'Knowledge embedding processing unavailable',
          'KnowledgeEmbeddingUnavailable',
        );
      }
    },
  };
}
