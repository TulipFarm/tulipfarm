import { createHash } from 'node:crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Context } from '@temporalio/activity';
import { Runtime } from '@temporalio/worker';
import { creditGate, creditRates, resourceMeter, type ResourceMeter } from '@tulipfarm/extensions';
import { errorAttributes } from '@tulipfarm/observability';
import { objectStorageClient } from '@tulipfarm/workspaces/object-storage';
import {
  chargeComputeSteps,
  chargeComputeWindow,
  chargeStorageDay,
  databaseBytes,
  releaseBytes,
  finishComputeStep,
  resourceCompatibility,
  runUnits,
  startComputeStep,
  storageDayUnits,
  storageMeasured,
  type StorageSource,
} from '@tulipfarm/workspace-storage/resource-credits';
import type { SqlClient } from '@tulipfarm/workspace-storage/runtime';

type Transaction = { client: SqlClient; schema: string };
type WorkspaceRuntime = {
  transaction<T>(
    workspaceId: string,
    compatibility: { readonly minimum: number; readonly maximum: number },
    action: (tx: Transaction) => Promise<T>,
  ): Promise<T>;
};

const hour = 3_600_000;
// Sandbox usage is read once the provider has settled an hour, and hours missed by earlier runs are read again.
const settleMs = 2 * hour;
const lookbackHours = 24;
const workspacePrefix = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A workflow step refused for lack of credits checks again after this long.
const creditWaitSeconds = 300;

/** Workspace that owns an object key: `<workspace>/…`, `workspaces/<workspace>/…` or `apps/<workspace>/…`. */
export function objectWorkspace(key: string) {
  const [first, second] = key.split('/');
  if (first && workspacePrefix.test(first)) return first;
  if ((first === 'workspaces' || first === 'apps') && second && workspacePrefix.test(second)) return second;
  return undefined;
}

function objectBuckets(env: NodeJS.ProcessEnv) {
  return [
    ...new Set(
      [
        env.TULIPFARM_OBJECT_STORAGE_FILES_BUCKET,
        env.TULIPFARM_OBJECT_STORAGE_SOUL_BUCKET ?? env.TULIPFARM_OBJECT_STORAGE_BUCKET,
        env.TULIPFARM_OBJECT_STORAGE_APPS_BUCKET,
      ].filter((bucket): bucket is string => Boolean(bucket)),
    ),
  ];
}

/**
 * Storage and compute metering, present only when an extension registers a resource meter. Charges are recorded in
 * the credit ledger as the `storage` and `compute` activities, after the use, so they are never refused and may take
 * the balance below zero; new work is refused while it is.
 */
export function createResourceBilling(options: {
  readonly runtime: WorkspaceRuntime;
  readonly discover: (after: string | null) => Promise<string[]>;
  readonly env?: NodeJS.ProcessEnv;
  readonly meter?: ResourceMeter;
}) {
  const meter = options.meter ?? resourceMeter();
  if (!meter) return undefined;
  const env = options.env ?? process.env;
  const transact = <T>(workspaceId: string, action: (tx: Transaction) => Promise<T>) =>
    options.runtime.transaction(workspaceId, resourceCompatibility, action);
  const logger = () => Runtime.instance().logger;

  async function* workspaces() {
    let after: string | null = null;
    for (;;) {
      const page = await options.discover(after);
      if (!page.length) return;
      yield* page;
      after = page.at(-1)!;
    }
  }

  async function objectBytes(wanted: ReadonlySet<string>, signal: AbortSignal) {
    const buckets = objectBuckets(env);
    if (!buckets.length) return undefined;
    const client = objectStorageClient(env);
    const totals = new Map<string, bigint>();
    try {
      for (const bucket of buckets) {
        let token: string | undefined;
        do {
          signal.throwIfAborted();
          const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }), {
            abortSignal: signal,
          });
          for (const object of page.Contents ?? []) {
            const workspaceId = object.Key ? objectWorkspace(object.Key) : undefined;
            if (!workspaceId || !wanted.has(workspaceId)) continue;
            totals.set(workspaceId, (totals.get(workspaceId) ?? 0n) + BigInt(object.Size ?? 0));
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
      }
    } finally {
      client.destroy();
    }
    return totals;
  }

  async function heldReleases(signal: AbortSignal) {
    if (!meter!.releaseStorage) return undefined;
    const totals = new Map<string, bigint>();
    for await (const { releaseId, bytes } of meter!.releaseStorage(signal))
      totals.set(releaseId.toLowerCase(), (totals.get(releaseId.toLowerCase()) ?? 0n) + bytes);
    return totals;
  }

  async function step<T>(
    kind: 'agent-task' | 'workflow',
    workspaceId: string,
    subjectId: string,
    run: () => Promise<T>,
    refused?: () => T,
  ): Promise<T> {
    const info = Context.current().info;
    const execution = info.workflowExecution;
    const id = createHash('sha256')
      .update(
        [info.workflowNamespace, execution?.workflowId, execution?.runId, info.activityId, info.attempt].join('\0'),
      )
      .digest('hex');
    const startedAt = new Date();
    const deadline = new Date(startedAt.getTime() + (info.startToCloseTimeoutMs || 5 * 60_000));
    let started = false;
    try {
      const blocked = await transact(workspaceId, async tx => {
        if (refused) {
          const available = await creditGate().available(tx);
          if (available !== null && available <= 0n) return true;
        }
        await startComputeStep(tx, { id, kind, subjectId, startedAt, deadline });
        return false;
      });
      if (blocked) return refused!();
      started = true;
    } catch (error) {
      logger().error('Run compute could not be recorded', { workspaceId, kind, ...errorAttributes(error) });
    }
    try {
      return await run();
    } finally {
      if (started)
        await transact(workspaceId, tx => finishComputeStep(tx, id, new Date())).catch(error =>
          logger().error('Run compute end could not be recorded', { workspaceId, kind, ...errorAttributes(error) }),
        );
    }
  }

  return {
    /** Times an agent task step as run compute. A task out of credits pauses at its next model call. */
    agentTaskStep: <T>(workspaceId: string, taskId: string, run: () => Promise<T>) =>
      step('agent-task', workspaceId, taskId, run),

    /** Times a workflow step as run compute, and holds the run while the workspace is out of credits. */
    workflowStep: <T>(work: unknown, run: () => Promise<T>) => {
      const { workspaceId, runId } = (work ?? {}) as { workspaceId?: unknown; runId?: unknown };
      if (typeof workspaceId !== 'string' || typeof runId !== 'string') return run();
      return step('workflow', workspaceId, runId, run, () => ({ kind: 'wait', seconds: creditWaitSeconds }) as T);
    },

    /**
     * Charges finished run steps, then each settled hour of sandbox compute in the last day that a workspace has not
     * been charged for. An hour the provider cannot report yet is read again next time. A failing workspace or hour
     * does not stop the others; the run then throws.
     */
    async meterCompute(signal: AbortSignal, now = Date.now()) {
      const unitsPerPicoUsd = creditRates().compute;
      const failures: unknown[] = [];
      for await (const workspaceId of workspaces()) {
        signal.throwIfAborted();
        try {
          await transact(workspaceId, tx =>
            chargeComputeSteps(tx, new Date(now), ms => runUnits(ms, meter.pricing.runPicoUsdPerHour, unitsPerPicoUsd)),
          );
        } catch (error) {
          failures.push(error);
        }
      }
      if (meter.computeUsage) {
        const settled = Math.floor((now - settleMs) / hour) * hour;
        for (let start = settled - lookbackHours * hour; start < settled; start += hour) {
          signal.throwIfAborted();
          const window = { start: new Date(start).toISOString(), end: new Date(start + hour).toISOString() };
          const usage = new Map<string, bigint>();
          try {
            for await (const { workspaceId, units } of meter.computeUsage(window, signal))
              usage.set(workspaceId, (usage.get(workspaceId) ?? 0n) + units);
          } catch (error) {
            failures.push(error);
            continue;
          }
          for (const [workspaceId, units] of usage) {
            if (units <= 0n) continue;
            try {
              await transact(workspaceId, tx => chargeComputeWindow(tx, { windowStart: window.start, units }));
            } catch (error) {
              failures.push(error);
            }
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Compute metering failed');
    },

    /**
     * Measures and charges each workspace's storage once per UTC day: its database tables, its objects in the files,
     * Soul and apps buckets, and the files of its published app releases. A source that cannot be measured is tried again
     * at the next run that day; a day missed entirely is not charged.
     */
    async meterStorage(signal: AbortSignal, now = Date.now()) {
      const day = new Date(now).toISOString().slice(0, 10);
      const sources: StorageSource[] = ['database'];
      if (objectBuckets(env).length) sources.push('objects');
      if (meter.releaseStorage) sources.push('apps');
      const failures: unknown[] = [];
      const pending = new Map<string, StorageSource[]>();
      for await (const workspaceId of workspaces()) {
        signal.throwIfAborted();
        try {
          const measured = await transact(workspaceId, tx => storageMeasured(tx, day));
          const missing = sources.filter(source => !measured.has(source));
          if (missing.length) pending.set(workspaceId, missing);
        } catch (error) {
          failures.push(error);
        }
      }
      if (pending.size) {
        const unread = async (read: () => Promise<Map<string, bigint> | undefined>) => {
          try {
            return await read();
          } catch (error) {
            failures.push(error);
            return undefined;
          }
        };
        const needs = (source: StorageSource) => [...pending.values()].some(missing => missing.includes(source));
        const objects = needs('objects') ? await unread(() => objectBytes(new Set(pending.keys()), signal)) : undefined;
        const releases = needs('apps') ? await unread(() => heldReleases(signal)) : undefined;
        const unitsPerPicoUsd = creditRates().storage;
        const { databasePicoUsdPerGibMonth: database, objectPicoUsdPerGibMonth: object } = meter.pricing;
        for (const [workspaceId, missing] of pending) {
          signal.throwIfAborted();
          try {
            await transact(workspaceId, async tx => {
              for (const source of missing) {
                const bytes =
                  source === 'database'
                    ? await databaseBytes(tx)
                    : source === 'objects'
                      ? objects && (objects.get(workspaceId) ?? 0n)
                      : releases && (await releaseBytes(tx, releases));
                if (bytes === undefined) continue;
                const price = source === 'database' ? database : object;
                await chargeStorageDay(tx, {
                  day,
                  source,
                  bytes,
                  units: storageDayUnits(bytes, price, unitsPerPicoUsd),
                });
              }
            });
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Storage metering failed');
    },
  };
}
