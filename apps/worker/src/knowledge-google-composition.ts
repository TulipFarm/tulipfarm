import { extname } from 'node:path';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';
import { fileURLToPath } from 'node:url';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleCorpusProvider } from '@tulipfarm/google-workspace/corpus';
import { createGoogleKnowledge } from '@tulipfarm/knowledge';
import type { KnowledgeSourceGate } from '@tulipfarm/knowledge';
import { createGoogleKnowledgeActivities } from './knowledge-google-activities.ts';

export function createWorkerGoogleKnowledge(dependencies: {
  runtime: Parameters<typeof createGoogleKnowledge>[0]['runtime'];
  gate?: KnowledgeSourceGate;
  googleService?: ReturnType<typeof createGoogleWorkspaceService>;
  providerFetch?: typeof fetch;
}) {
  return createGoogleKnowledge({
    runtime: dependencies.runtime,
    provider: createGoogleCorpusProvider({
      service:
        dependencies.googleService ??
        createGoogleWorkspaceService({
          runtime: dependencies.runtime,
          ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
        }),
      ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
    }),
    ...(dependencies.gate ? { gate: dependencies.gate } : {}),
  });
}

export async function createGoogleKnowledgeWorker(
  dependencies: Parameters<typeof createWorkerGoogleKnowledge>[0] & {
    connection: NativeConnection;
    env?: NodeJS.ProcessEnv;
    createWorker?: typeof Worker.create;
    telemetry?: WorkerTelemetry;
  },
) {
  const env = dependencies.env ?? process.env;
  const service = createWorkerGoogleKnowledge(dependencies);
  const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
  const worker = await createWorker({
    ...workerTelemetry(dependencies.telemetry),
    connection: dependencies.connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-google`,
    workflowsPath: fileURLToPath(
      new URL(`./knowledge-google-workflows${extname(import.meta.filename)}`, import.meta.url),
    ),
    activities: createGoogleKnowledgeActivities(service),
    maxConcurrentActivityTaskExecutions: 2,
    shutdownGraceTime: '40 seconds',
  });
  return { worker, service };
}
