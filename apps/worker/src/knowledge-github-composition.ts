import { createGitHubKnowledge, type GitHubCorpusProvider } from '@tulipfarm/knowledge';
import type { KnowledgeSourceGate } from '@tulipfarm/knowledge';
import { githubCorpusFromEnvironment } from '@tulipfarm/github/corpus';
import { createGitHubKnowledgeActivities } from './knowledge-github-activities.ts';

const defaultRecheckMinutes = 10;
function githubRecheckMs(value: string | undefined) {
  const text = value?.trim();
  if (!text) return defaultRecheckMinutes * 60_000;
  const minutes = Number(text);
  if (!/^[0-9]+$/.test(text) || minutes < 1 || minutes > 1440)
    throw new Error('GITHUB_KNOWLEDGE_RECHECK_MINUTES must be a whole number from 1 to 1440');
  return minutes * 60_000;
}

export function createWorkerGitHubKnowledge(dependencies: {
  runtime: Parameters<typeof createGitHubKnowledge>[0]['runtime'];
  gate?: KnowledgeSourceGate;
  githubCorpus?: GitHubCorpusProvider;
  env?: NodeJS.ProcessEnv;
}) {
  return createGitHubKnowledge({
    runtime: dependencies.runtime,
    provider:
      dependencies.githubCorpus ??
      githubCorpusFromEnvironment({
        runtime: dependencies.runtime,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
    ...(dependencies.gate ? { gate: dependencies.gate } : {}),
    sync: { idleRecheckMs: githubRecheckMs((dependencies.env ?? process.env).GITHUB_KNOWLEDGE_RECHECK_MINUTES) },
  });
}

/** The GitHub sync service and the activities the knowledge worker runs for it. */
export function createGitHubKnowledgeParts(dependencies: Parameters<typeof createWorkerGitHubKnowledge>[0]) {
  const service = createWorkerGitHubKnowledge(dependencies);
  return { service, activities: createGitHubKnowledgeActivities(service) };
}
