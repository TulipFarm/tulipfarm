import { ApplicationFailure } from '@temporalio/common';
import type { SlackKnowledge } from '@tulipfarm/knowledge';
import { slackKnowledgeWorkSchema, type SlackKnowledgeWork } from '@tulipfarm/knowledge/slack-contracts';

export function createSlackKnowledgeActivities(service: Pick<SlackKnowledge, 'process'>) {
  return {
    async processSlackKnowledge(value: SlackKnowledgeWork): Promise<void> {
      const parsed = slackKnowledgeWorkSchema.safeParse(value);
      if (!parsed.success)
        throw ApplicationFailure.nonRetryable('Invalid Slack Knowledge work', 'InvalidSlackKnowledgeWork');
      try {
        await service.process(parsed.data);
      } catch {
        throw ApplicationFailure.nonRetryable('Slack Knowledge processing unavailable', 'SlackKnowledgeUnavailable');
      }
    },
  };
}
