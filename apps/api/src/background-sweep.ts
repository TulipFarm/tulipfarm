import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createBackgroundJob, withErrorStage, type BackgroundJob } from '@tulipfarm/observability';

type Sweep = { run: (stopped: () => boolean) => Promise<void>; failure: string; job: BackgroundJob };

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
    function tick() {
      if (stopping || pending) return;
      pending = observation
        .run(() => sweep.run(() => stopping))
        .catch(() => app.log.error(sweep.failure))
        .finally(() => {
          pending = undefined;
        });
    }
    const timer = setInterval(tick, 2000);
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
