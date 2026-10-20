import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { createDefaultKnowledge } from '@tulipfarm/knowledge';
import { createDefaultKnowledgeActivities } from './knowledge-defaults-activities.ts';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';

type Options = Parameters<typeof createDefaultKnowledge>[0];

export async function createDefaultKnowledgeWorker(dependencies: {
  runtime: Options['runtime'];
  engines: Options['engines'];
  connection: NativeConnection;
  env?: NodeJS.ProcessEnv;
  createWorker?: typeof Worker.create;
  telemetry?: WorkerTelemetry;
  enabled?: Options['enabled'];
}) {
  const env = dependencies.env ?? process.env;
  const service = createDefaultKnowledge({
    runtime: dependencies.runtime,
    engines: dependencies.engines,
    ...(dependencies.enabled ? { enabled: dependencies.enabled } : {}),
  });
  const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
  const worker = await createWorker({
    ...workerTelemetry(dependencies.telemetry),
    connection: dependencies.connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-defaults`,
    workflowsPath: fileURLToPath(
      new URL(`./knowledge-defaults-workflows${extname(import.meta.filename)}`, import.meta.url),
    ),
    activities: createDefaultKnowledgeActivities(service),
    maxConcurrentActivityTaskExecutions: 2,
    shutdownGraceTime: '40 seconds',
  });
  return { worker, service };
}
