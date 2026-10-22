import { proxyActivities } from '@temporalio/workflow';
import type { createGitHubKnowledgeActivities } from './knowledge-github-activities.ts';

const { processGitHubKnowledge } = proxyActivities<ReturnType<typeof createGitHubKnowledgeActivities>>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 1 },
});

export async function githubKnowledgeSync(work: Parameters<typeof processGitHubKnowledge>[0]): Promise<void> {
  await processGitHubKnowledge(work);
}
