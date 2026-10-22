import { ApplicationFailure } from '@temporalio/common';
import type { AtlassianKnowledge } from '@tulipfarm/knowledge';
import { atlassianKnowledgeWorkSchema, type AtlassianKnowledgeWork } from '@tulipfarm/knowledge/atlassian-contracts';

export function createAtlassianKnowledgeActivities(service: Pick<AtlassianKnowledge, 'process'>) {
  return {
    async processAtlassianKnowledge(value: AtlassianKnowledgeWork): Promise<void> {
      const parsed = atlassianKnowledgeWorkSchema.safeParse(value);
      if (!parsed.success)
        throw ApplicationFailure.nonRetryable('Invalid Atlassian Knowledge work', 'InvalidAtlassianKnowledgeWork');
      try {
        await service.process(parsed.data);
      } catch {
        throw ApplicationFailure.nonRetryable(
          'Atlassian Knowledge processing unavailable',
          'AtlassianKnowledgeUnavailable',
        );
      }
    },
  };
}
