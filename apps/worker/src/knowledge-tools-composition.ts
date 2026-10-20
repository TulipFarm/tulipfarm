import { Pool } from 'pg';
import { z } from 'zod';
import { parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import { createKnowledgeAgentTools, createKnowledgeEmbeddings, createKnowledgeSearch } from '@tulipfarm/knowledge';
import { createKnowledgeEmbeddingCapacity } from '@tulipfarm/knowledge/embedding-capacity';
import type { KnowledgeToolsFactory } from '@tulipfarm/agents/tools';
import { log } from '@tulipfarm/observability';
import { createWorkerGoogleKnowledge } from './knowledge-google-composition.ts';
import { createWorkerSlackKnowledge } from './knowledge-slack-composition.ts';
import { createWorkerGitHubKnowledge } from './knowledge-github-composition.ts';
import { createWorkerAtlassianKnowledge } from './knowledge-atlassian-composition.ts';

type EmbeddingOptions = Parameters<typeof createKnowledgeEmbeddings>[0];
let sharedPool: Pool | undefined;

function capacityPool(env: NodeJS.ProcessEnv) {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: z.url().parse(env.WORKSPACE_AUTHORING_DATABASE_URL),
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      allowExitOnIdle: true,
    });
    sharedPool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
  }
  return sharedPool;
}

// Chat and task knowledge tools. Each call receives the caller's guarded runtime for
// search and evidence reads; metered embedding work keeps the worker runtime so a late
// provider result can still be recorded after the calling turn finishes.
export function createKnowledgeTools(dependencies: {
  runtime: EmbeddingOptions['runtime'];
  env?: NodeJS.ProcessEnv;
  provider?: EmbeddingOptions['provider'];
  capacity?: EmbeddingOptions['capacity'];
}): KnowledgeToolsFactory {
  const env = dependencies.env ?? process.env;
  const config = parseKnowledgeEmbeddingsConfig(env);
  const adapters = {
    google: createWorkerGoogleKnowledge({ runtime: dependencies.runtime }),
    slack: createWorkerSlackKnowledge({ runtime: dependencies.runtime, env }),
    github: createWorkerGitHubKnowledge({ runtime: dependencies.runtime, env }),
    atlassian: createWorkerAtlassianKnowledge({ runtime: dependencies.runtime, env }),
  };
  const capacity =
    dependencies.capacity ??
    (config.kind === 'enabled' ? createKnowledgeEmbeddingCapacity(capacityPool(env)).acquire : undefined);
  const embeddings = createKnowledgeEmbeddings({
    runtime: dependencies.runtime,
    config,
    ...adapters,
    ...(dependencies.provider ? { provider: dependencies.provider } : {}),
    ...(capacity ? { capacity } : {}),
  });
  return runtime =>
    createKnowledgeAgentTools({ runtime, search: createKnowledgeSearch({ runtime, embeddings, ...adapters }) });
}
