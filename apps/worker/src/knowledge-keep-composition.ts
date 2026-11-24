import { keepConfiguration } from '@tulipfarm/config/keep';
import { createKnowledgeKeepFeed, type KnowledgeKeepDependencies } from '@tulipfarm/knowledge';
import { createKnowledgeKeepActivities } from './knowledge-keep-activities.ts';

/** The Keep delivery feed and its activities, or undefined when Keep is not configured. */
export function createKnowledgeKeepParts(
  dependencies: {
    runtime: Parameters<typeof createKnowledgeKeepFeed>[0]['runtime'];
    env?: NodeJS.ProcessEnv;
  } & KnowledgeKeepDependencies,
) {
  const env = dependencies.env ?? process.env;
  // Without a Keep endpoint there is nothing to deliver to, so Keep activities are not served.
  if (!dependencies.client && keepConfiguration(env).status !== 'configured') return undefined;
  const feed = createKnowledgeKeepFeed({
    runtime: dependencies.runtime,
    ...(dependencies.client ? { client: dependencies.client } : {}),
  });
  return { feed, activities: createKnowledgeKeepActivities(feed) };
}
