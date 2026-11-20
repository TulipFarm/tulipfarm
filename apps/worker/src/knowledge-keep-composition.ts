import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { keepConfiguration } from '@tulipfarm/config/keep';
import { createKnowledgeKeepFeed, type KnowledgeKeepDependencies } from '@tulipfarm/knowledge';
import { createKnowledgeKeepActivities } from './knowledge-keep-activities.ts';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';

export async function createKnowledgeKeepWorker(
  dependencies: {
    runtime: Parameters<typeof createKnowledgeKeepFeed>[0]['runtime'];
    connection: NativeConnection;
    env?: NodeJS.ProcessEnv;
    createWorker?: typeof Worker.create;
    telemetry?: WorkerTelemetry;
  } & KnowledgeKeepDependencies,
) {
  const env = dependencies.env ?? process.env;
  // Without a Keep endpoint there is nothing to deliver to, so the queue is not served.
  if (!dependencies.client && keepConfiguration(env).status !== 'configured') return undefined;
  const feed = createKnowledgeKeepFeed({
    runtime: dependencies.runtime,
    ...(dependencies.client ? { client: dependencies.client } : {}),
    ...(dependencies.enabled ? { enabled: dependencies.enabled } : {}),
  });
  const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
  const worker = await createWorker({
    ...workerTelemetry(dependencies.telemetry),
    connection: dependencies.connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-keep`,
    workflowsPath: fileURLToPath(
      new URL(`./knowledge-keep-workflows${extname(import.meta.filename)}`, import.meta.url),
    ),
    activities: createKnowledgeKeepActivities(feed),
    maxConcurrentActivityTaskExecutions: 2,
    shutdownGraceTime: '40 seconds',
  });
  return { worker, feed };
}
