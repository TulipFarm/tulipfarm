import { createAtlassianKnowledge, type AtlassianCorpusProvider } from '@tulipfarm/knowledge';
import { atlassianCorpusFromEnvironment } from '@tulipfarm/atlassian/corpus';
import { createAtlassianKnowledgeActivities } from './knowledge-atlassian-activities.ts';

export function createWorkerAtlassianKnowledge(dependencies: {
  runtime: Parameters<typeof createAtlassianKnowledge>[0]['runtime'];
  atlassianCorpus?: AtlassianCorpusProvider;
  env?: NodeJS.ProcessEnv;
}) {
  return createAtlassianKnowledge({
    runtime: dependencies.runtime,
    provider:
      dependencies.atlassianCorpus ??
      atlassianCorpusFromEnvironment({
        runtime: dependencies.runtime,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
  });
}

/** The Atlassian sync service and the activities the knowledge worker runs for it. */
export function createAtlassianKnowledgeParts(dependencies: Parameters<typeof createWorkerAtlassianKnowledge>[0]) {
  const service = createWorkerAtlassianKnowledge(dependencies);
  return { service, activities: createAtlassianKnowledgeActivities(service) };
}
