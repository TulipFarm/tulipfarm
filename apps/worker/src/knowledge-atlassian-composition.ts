import { extname } from 'node:path';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';
import { fileURLToPath } from 'node:url';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { createAtlassianKnowledge, type AtlassianCorpusProvider } from '@tulipfarm/knowledge';
import type { KnowledgeSourceGate } from '@tulipfarm/knowledge';
import { atlassianCorpusFromEnvironment } from '@tulipfarm/atlassian/corpus';
import { createAtlassianKnowledgeActivities } from './knowledge-atlassian-activities.ts';

export function createWorkerAtlassianKnowledge(dependencies: {
  runtime: Parameters<typeof createAtlassianKnowledge>[0]['runtime'];
  gate?: KnowledgeSourceGate;
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
    ...(dependencies.gate ? { gate: dependencies.gate } : {}),
  });
}

export async function createAtlassianKnowledgeWorker(
  dependencies: Parameters<typeof createWorkerAtlassianKnowledge>[0] & {
    connection: NativeConnection;
    createWorker?: typeof Worker.create;
    telemetry?: WorkerTelemetry;
  },
) {
  const env = dependencies.env ?? process.env;
  const service = createWorkerAtlassianKnowledge(dependencies);
  const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
  const worker = await createWorker({
    ...workerTelemetry(dependencies.telemetry),
    connection: dependencies.connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-atlassian`,
    workflowsPath: fileURLToPath(
      new URL(`./knowledge-atlassian-workflows${extname(import.meta.filename)}`, import.meta.url),
    ),
    activities: createAtlassianKnowledgeActivities(service),
    maxConcurrentActivityTaskExecutions: 2,
    shutdownGraceTime: '40 seconds',
  });
  return { worker, service };
}
