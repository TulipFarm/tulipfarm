import { createDefaultKnowledge } from '@tulipfarm/knowledge';
import { createDefaultKnowledgeActivities } from './knowledge-defaults-activities.ts';

type Options = Parameters<typeof createDefaultKnowledge>[0];

/** The default-source service, built on the provider services, and the activities the knowledge worker runs for it. */
export function createDefaultKnowledgeParts(dependencies: {
  runtime: Options['runtime'];
  engines: Options['engines'];
}) {
  const service = createDefaultKnowledge({
    runtime: dependencies.runtime,
    engines: dependencies.engines,
  });
  return { service, activities: createDefaultKnowledgeActivities(service) };
}
