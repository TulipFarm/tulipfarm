import { ApplicationFailure } from '@temporalio/common';
import type { GitHubKnowledge } from '@tulipfarm/knowledge';
import { githubKnowledgeWorkSchema, type GitHubKnowledgeWork } from '@tulipfarm/knowledge/github-contracts';
import { observeCall } from '@tulipfarm/observability';

export function createGitHubKnowledgeActivities(service: Pick<GitHubKnowledge, 'process'>) {
  return {
    async processGitHubKnowledge(value: GitHubKnowledgeWork): Promise<void> {
      const parsed = githubKnowledgeWorkSchema.safeParse(value);
      if (!parsed.success)
        throw ApplicationFailure.nonRetryable('Invalid GitHub Knowledge work', 'InvalidGitHubKnowledgeWork');
      try {
        await observeCall('activity', 'knowledge.github.process', () => service.process(parsed.data));
      } catch {
        throw ApplicationFailure.nonRetryable('GitHub Knowledge processing unavailable', 'GitHubKnowledgeUnavailable');
      }
    },
  };
}
