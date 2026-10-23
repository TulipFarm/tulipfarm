import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createBackgroundJob, withErrorStage, type BackgroundJob } from '@tulipfarm/observability';

type Sweep = { run: (stopped: () => boolean) => Promise<void>; failure: string; job: BackgroundJob };

const sweepIntervalMs = 2000;
const maxFailureBackoffMs = 60_000;

/** Wait after `failures` consecutive failed runs: 4 s, 8 s, 16 s, 32 s, then 60 s. */
export function sweepFailureBackoffMs(failures: number) {
  return failures < 1 ? 0 : Math.min(sweepIntervalMs * 2 ** failures, maxFailureBackoffMs);
}

export function backgroundSweep(
  app: FastifyInstance,
  sweep: Sweep['run'],
  failure: string,
  job: BackgroundJob,
  immediate = true,
) {
  backgroundSweeps(app, [{ run: sweep, failure, job }], immediate);
}

export function backgroundSweeps(app: FastifyInstance, sweeps: readonly Sweep[], immediate = true) {
  let stopping = false;
  const tasks = sweeps.map(sweep => {
    const observation = createBackgroundJob(sweep.job, 2);
    let pending: Promise<void> | undefined;
    // While the database is failing, a sweep that retried every tick would keep queueing for
    // pool connections that requests need, so consecutive failures back off.
    let failures = 0;
    let resumeAt = 0;
    function tick() {
      if (stopping || pending || Date.now() < resumeAt) return;
      pending = observation
        .run(() => sweep.run(() => stopping))
        .then(
          () => {
            failures = 0;
            resumeAt = 0;
          },
          () => {
            failures++;
            resumeAt = Date.now() + sweepFailureBackoffMs(failures);
            app.log.error(sweep.failure);
          },
        )
        .finally(() => {
          pending = undefined;
        });
    }
    const timer = setInterval(tick, sweepIntervalMs);
    timer.unref();
    return {
      tick,
      stop: async () => {
        clearInterval(timer);
        await pending;
        observation.close();
      },
    };
  });
  if (immediate)
    app.addHook('onReady', async () => {
      for (const task of tasks) task.tick();
    });
  app.addHook('onClose', async () => {
    stopping = true;
    await Promise.all(tasks.map(task => task.stop()));
  });
}

export async function readyWorkspaces(pool: Pick<Pool, 'query'>, after: string | null, limit: number) {
  return withErrorStage('workspace-discovery', async () =>
    z
      .array(z.object({ workspace_id: z.uuid() }))
      .parse(
        (
          await pool.query(
            `SELECT workspace_id FROM app.workspace_storage WHERE stage = 'ready' AND ($1::uuid IS NULL OR workspace_id > $1) ORDER BY workspace_id LIMIT ${z.number().int().positive().parse(limit)}`,
            [after],
          )
        ).rows,
      ),
  );
}
