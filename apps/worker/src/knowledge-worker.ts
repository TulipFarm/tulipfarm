import { Worker, type NativeConnection } from '@temporalio/worker';
import { workerTelemetry, type WorkerTelemetry } from './telemetry.ts';
import { workflowSource } from './workflow-source.ts';

type Activities = Record<string, (...args: never[]) => unknown>;

/** Activity slots each part had when it polled its own task queue; the shared worker keeps the same total. */
const slotsPerPart = 2;

export function knowledgeTaskQueue(env: NodeJS.ProcessEnv = process.env) {
  return `${env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm'}-knowledge`;
}

function mergeActivities(parts: Record<string, Activities>) {
  const merged: Activities = {};
  const owners = new Map<string, string>();
  for (const [part, activities] of Object.entries(parts)) {
    for (const [name, activity] of Object.entries(activities)) {
      const owner = owners.get(name);
      if (owner) throw new Error(`Knowledge activity ${name} is registered by both ${owner} and ${part}`);
      owners.set(name, part);
      merged[name] = activity;
    }
  }
  return merged;
}

/**
 * One Temporal worker serves every knowledge workflow and the activities of each configured part, such as ingest,
 * a provider sync, default sources or Keep delivery. One worker means one workflow bundle and one workflow thread.
 */
export async function createKnowledgeWorker(dependencies: {
  connection: NativeConnection;
  parts: Record<string, Activities>;
  env?: NodeJS.ProcessEnv;
  createWorker?: typeof Worker.create;
  telemetry?: WorkerTelemetry;
}) {
  const env = dependencies.env ?? process.env;
  const activities = mergeActivities(dependencies.parts);
  const createWorker = dependencies.createWorker ?? Worker.create.bind(Worker);
  return createWorker({
    ...workflowSource('knowledge-all-workflows', workerTelemetry(dependencies.telemetry)),
    connection: dependencies.connection,
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: knowledgeTaskQueue(env),
    activities,
    maxConcurrentActivityTaskExecutions: slotsPerPart * Object.keys(dependencies.parts).length,
    shutdownGraceTime: '40 seconds',
  });
}
