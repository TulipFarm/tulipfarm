import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { GitHubKnowledge } from '@tulipfarm/knowledge';
import { githubKnowledgeWorkSchema, type GitHubKnowledgeWork } from '@tulipfarm/knowledge/github-contracts';
import { observeCall } from '@tulipfarm/observability';

// Outside a Temporal activity (unit tests, direct calls) there is no heartbeat or cancellation to wire.
function activityContext() {
  try {
    const context = Context.current();
    return { heartbeat: () => context.heartbeat(), signal: context.cancellationSignal };
  } catch {
    return {};
  }
}

export function createGitHubKnowledgeActivities(service: Pick<GitHubKnowledge, 'process'>) {
  return {
    async processGitHubKnowledge(value: GitHubKnowledgeWork): Promise<void> {
      const parsed = githubKnowledgeWorkSchema.safeParse(value);
      if (!parsed.success)
        throw ApplicationFailure.nonRetryable('Invalid GitHub Knowledge work', 'InvalidGitHubKnowledgeWork');
      try {
        await observeCall('activity', 'knowledge.github.process', () =>
          service.process(parsed.data, activityContext()),
        );
      } catch {
        throw ApplicationFailure.nonRetryable('GitHub Knowledge processing unavailable', 'GitHubKnowledgeUnavailable');
      }
    },
  };
}
