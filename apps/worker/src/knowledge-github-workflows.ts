import { proxyActivities } from '@temporalio/workflow';
import type { createGitHubKnowledgeActivities } from './knowledge-github-activities.ts';

const { processGitHubKnowledge } = proxyActivities<ReturnType<typeof createGitHubKnowledgeActivities>>({
  // A run works through pages for up to five minutes and heartbeats after every item, so a silent activity is stuck.
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '5 minutes',
  retry: { maximumAttempts: 1 },
});

export async function githubKnowledgeSync(work: Parameters<typeof processGitHubKnowledge>[0]): Promise<void> {
  await processGitHubKnowledge(work);
}
