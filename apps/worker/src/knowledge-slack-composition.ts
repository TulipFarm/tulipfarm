import { createSlackKnowledge, type SlackCorpusProvider } from '@tulipfarm/knowledge';
import type { KnowledgeSourceGate } from '@tulipfarm/knowledge';
import { slackCorpusFromEnvironment } from '@tulipfarm/slack/corpus';
import { createSlackKnowledgeActivities } from './knowledge-slack-activities.ts';

export function createWorkerSlackKnowledge(dependencies: {
  runtime: Parameters<typeof createSlackKnowledge>[0]['runtime'];
  gate?: KnowledgeSourceGate;
  slackCorpus?: SlackCorpusProvider;
  env?: NodeJS.ProcessEnv;
}) {
  return createSlackKnowledge({
    runtime: dependencies.runtime,
    provider:
      dependencies.slackCorpus ??
      slackCorpusFromEnvironment({
        runtime: dependencies.runtime,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
    ...(dependencies.gate ? { gate: dependencies.gate } : {}),
  });
}

/** The Slack sync service and the activities the knowledge worker runs for it. */
export function createSlackKnowledgeParts(dependencies: Parameters<typeof createWorkerSlackKnowledge>[0]) {
  const service = createWorkerSlackKnowledge(dependencies);
  return { service, activities: createSlackKnowledgeActivities(service) };
}
