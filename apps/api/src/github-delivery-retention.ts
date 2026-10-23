import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { githubDeliveryRetentionHours, pruneGitHubEventDeliveries } from '@tulipfarm/github/event-retention';
import { createBackgroundJob } from '@tulipfarm/observability';

const intervalMs = 60_000;

/**
 * Deletes processed GitHub webhook deliveries once they are older than GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS. It runs
 * with any platform database, so deliveries recorded before webhooks were turned off are still removed.
 */
export function registerGitHubDeliveryRetention(
  app: FastifyInstance,
  pool: Pick<Pool, 'query'>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const retentionHours = githubDeliveryRetentionHours(env.GITHUB_WEBHOOK_DELIVERY_RETENTION_HOURS);
  const job = createBackgroundJob('github-delivery-retention', intervalMs / 1000);
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    running ??= job
      .run(() => pruneGitHubEventDeliveries(pool, { retentionHours }))
      .then(deleted => {
        if (deleted) app.log.info({ deleted }, 'Deleted processed GitHub webhook deliveries');
      })
      .catch(() => app.log.error('GitHub webhook delivery cleanup will retry'))
      .finally(() => {
        running = undefined;
      });
  }, intervalMs);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
    job.close();
  });
}
