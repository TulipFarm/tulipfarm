import { ApplicationFailure } from '@temporalio/common';
import type { DefaultKnowledge } from '@tulipfarm/knowledge';
import { defaultKnowledgeWorkSchema, type DefaultKnowledgeWork } from '@tulipfarm/knowledge/default-contracts';
import { observeCall } from '@tulipfarm/observability';

export function createDefaultKnowledgeActivities(service: Pick<DefaultKnowledge, 'process'>) {
  return {
    async processDefaultKnowledge(value: DefaultKnowledgeWork): Promise<void> {
      const parsed = defaultKnowledgeWorkSchema.safeParse(value);
      if (!parsed.success)
        throw ApplicationFailure.nonRetryable('Invalid default Knowledge work', 'InvalidDefaultKnowledgeWork');
      try {
        await observeCall('activity', 'knowledge.defaults.process', () => service.process(parsed.data));
      } catch {
        throw ApplicationFailure.nonRetryable(
          'Default Knowledge processing unavailable',
          'DefaultKnowledgeUnavailable',
        );
      }
    },
  };
}
