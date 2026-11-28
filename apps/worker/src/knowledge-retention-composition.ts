import { keepConfiguration } from '@tulipfarm/config/keep';
import { createKnowledgeRetention, type KnowledgeRetentionDependencies } from '@tulipfarm/knowledge';
import { createKnowledgeRetentionActivities } from './knowledge-retention-activities.ts';

/** The Knowledge retention purge and its activities. */
export function createKnowledgeRetentionParts(dependencies: {
  runtime: KnowledgeRetentionDependencies['runtime'];
  env?: NodeJS.ProcessEnv;
}) {
  const env = dependencies.env ?? process.env;
  const retention = createKnowledgeRetention({
    runtime: dependencies.runtime,
    keepLive: () => keepConfiguration(env).status === 'configured',
  });
  return { retention, activities: createKnowledgeRetentionActivities(retention) };
}
