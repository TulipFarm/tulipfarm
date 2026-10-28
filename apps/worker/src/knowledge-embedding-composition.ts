import { extname } from 'node:path';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { z } from 'zod';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { parseKnowledgeEmbeddingsConfig } from '@tulipfarm/config';
import { createKnowledgeEmbeddings } from '@tulipfarm/knowledge';
import { createKnowledgeEmbeddingCapacity } from '@tulipfarm/knowledge/embedding-capacity';
import { log } from '@tulipfarm/observability';
import { createKnowledgeEmbeddingActivities } from './knowledge-embedding-activities.ts';
import { createWorkerGoogleKnowledge } from './knowledge-google-composition.ts';
import { createWorkerSlackKnowledge } from './knowledge-slack-composition.ts';
import { createWorkerGitHubKnowledge } from './knowledge-github-composition.ts';
import { createWorkerAtlassianKnowledge } from './knowledge-atlassian-composition.ts';

type EmbeddingOptions = Parameters<typeof createKnowledgeEmbeddings>[0];

export async function createKnowledgeEmbeddingWorker(dependencies: {
  runtime: EmbeddingOptions['runtime'];
  connection: NativeConnection;
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
  provider?: EmbeddingOptions['provider'];
  createWorker?: typeof Worker.create;
  telemetry?: WorkerTelemetry;
  google?: EmbeddingOptions['google'];
  slack?: EmbeddingOptions['slack'];
  github?: EmbeddingOptions['github'];
  atlassian?: EmbeddingOptions['atlassian'];
  gate?: NonNullable<EmbeddingOptions['gate']>;
  googleService?: NonNullable<Parameters<typeof createWorkerGoogleKnowledge>[0]['googleService']>;
  providerFetch?: typeof fetch;
  /** False builds only the embedding service, for a process that does not run knowledge task queues. */
  serve?: boolean;
}) {
  const env = dependencies.env ?? process.env;
  const config = parseKnowledgeEmbeddingsConfig(env);
  if (config.kind === 'disabled') return undefined;
  const pool =
    dependencies.pool ??
    new Pool({
      connectionString: z.url().parse(env.WORKSPACE_AUTHORING_DATABASE_URL),
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
  if (!dependencies.pool) pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
  const close = async () => {
    if (!dependencies.pool) await pool.end();
  };
  try {
    const service = createKnowledgeEmbeddings({
      runtime: dependencies.runtime,
      config,
      google: dependencies.google ?? createWorkerGoogleKnowledge(dependencies),
      slack:
        dependencies.slack ??
        createWorkerSlackKnowledge({
          runtime: dependencies.runtime,
          ...(dependencies.env ? { env: dependencies.env } : {}),
        }),
      github:
        dependencies.github ??
        createWorkerGitHubKnowledge({
          runtime: dependencies.runtime,
          ...(dependencies.env ? { env: dependencies.env } : {}),
        }),
      atlassian:
        dependencies.atlassian ??
        createWorkerAtlassianKnowledge({
          runtime: dependencies.runtime,
          ...(dependencies.env ? { env: dependencies.env } : {}),
        }),
      ...(dependencies.gate ? { gate: dependencies.gate } : {}),
      ...(dependencies.provider ? { provider: dependencies.provider } : {}),
      capacity: createKnowledgeEmbeddingCapacity(pool).acquire,
    });
    if (dependencies.serve === false) return { worker: undefined, close, service };
    const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
    const worker = await createWorker({
      ...workerTelemetry(dependencies.telemetry),
      connection: dependencies.connection,
      namespace: env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-embeddings`,
      workflowsPath: fileURLToPath(
        new URL(`./knowledge-embedding-workflows${extname(import.meta.filename)}`, import.meta.url),
      ),
      activities: createKnowledgeEmbeddingActivities(service),
      maxConcurrentActivityTaskExecutions: 2,
      shutdownGraceTime: '40 seconds',
    });
    return { worker, close, service };
  } catch (error) {
    await close();
    throw error;
  }
}
