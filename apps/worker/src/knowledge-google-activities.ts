import { ApplicationFailure } from '@temporalio/common';
import type { GoogleKnowledge } from '@tulipfarm/knowledge';
import { googleKnowledgeWorkSchema, type GoogleKnowledgeWork } from '@tulipfarm/knowledge/google-contracts';

export function createGoogleKnowledgeActivities(service: Pick<GoogleKnowledge, 'process'>) {
  return {
    async processGoogleKnowledge(value: GoogleKnowledgeWork): Promise<void> {
      const parsed = googleKnowledgeWorkSchema.safeParse(value);
      if (!parsed.success)
        throw ApplicationFailure.nonRetryable('Invalid Google Knowledge work', 'InvalidGoogleKnowledgeWork');
      try {
        await service.process(parsed.data);
      } catch {
        throw ApplicationFailure.nonRetryable('Google Knowledge processing unavailable', 'GoogleKnowledgeUnavailable');
      }
    },
  };
}
