import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { createGitHubKnowledge, type GitHubCorpusProvider } from '@tulipfarm/knowledge';
import type { KnowledgeSourceGate } from '@tulipfarm/knowledge';
import { githubCorpusFromEnvironment } from '@tulipfarm/github/corpus';
import { createGitHubKnowledgeActivities } from './knowledge-github-activities.ts';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';

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
  });
}

export async function createGitHubKnowledgeWorker(
  dependencies: Parameters<typeof createWorkerGitHubKnowledge>[0] & {
    connection: NativeConnection;
    createWorker?: typeof Worker.create;
    telemetry?: WorkerTelemetry;
  },
) {
  const env = dependencies.env ?? process.env;
  const service = createWorkerGitHubKnowledge(dependencies);
  const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
  const worker = await createWorker({
    ...workerTelemetry(dependencies.telemetry),
    connection: dependencies.connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-github`,
    workflowsPath: fileURLToPath(
      new URL(`./knowledge-github-workflows${extname(import.meta.filename)}`, import.meta.url),
    ),
    activities: createGitHubKnowledgeActivities(service),
    maxConcurrentActivityTaskExecutions: 2,
    shutdownGraceTime: '40 seconds',
  });
  return { worker, service };
}
