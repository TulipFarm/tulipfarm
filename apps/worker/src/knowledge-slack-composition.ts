import { extname } from 'node:path';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';
import { fileURLToPath } from 'node:url';
import { Worker, type NativeConnection } from '@temporalio/worker';
import { createSlackKnowledge, type SlackCorpusProvider } from '@tulipfarm/knowledge';
import type { KnowledgeSourceGate } from '@tulipfarm/knowledge';
import { slackCorpusFromEnvironment } from '@tulipfarm/slack/corpus';
import { createSlackKnowledgeActivities } from './knowledge-slack-activities.ts';

export function createWorkerSlackKnowledge(dependencies: {
  runtime: Parameters<typeof createSlackKnowledge>[0]['runtime'];
  gate?: KnowledgeSourceGate;
  slackCorpus?: SlackCorpusProvider;
  env?: NodeJS.ProcessEnv;
}) {
  return createSlackKnowledge({
    runtime: dependencies.runtime,
    provider:
      dependencies.slackCorpus ??
      slackCorpusFromEnvironment({
        runtime: dependencies.runtime,
        ...(dependencies.env ? { env: dependencies.env } : {}),
      }),
    ...(dependencies.gate ? { gate: dependencies.gate } : {}),
  });
}

export async function createSlackKnowledgeWorker(
  dependencies: Parameters<typeof createWorkerSlackKnowledge>[0] & {
    connection: NativeConnection;
    createWorker?: typeof Worker.create;
    telemetry?: WorkerTelemetry;
  },
) {
  const env = dependencies.env ?? process.env;
  const service = createWorkerSlackKnowledge(dependencies);
  const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
  const worker = await createWorker({
    ...workerTelemetry(dependencies.telemetry),
    connection: dependencies.connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge-slack`,
    workflowsPath: fileURLToPath(
      new URL(`./knowledge-slack-workflows${extname(import.meta.filename)}`, import.meta.url),
    ),
    activities: createSlackKnowledgeActivities(service),
    maxConcurrentActivityTaskExecutions: 2,
    shutdownGraceTime: '40 seconds',
  });
  return { worker, service };
}
