import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  githubDeliveryRetentionHours,
  pruneGitHubEventBodies,
  pruneGitHubEventDeliveries,
} from '@tulipfarm/github/event-retention';
import { createBackgroundJob } from '@tulipfarm/observability';

const intervalMs = 60_000;
// Bodies live one minute, so they are swept far more often than deliveries.
const bodyIntervalMs = 10_000;

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
  const bodyJob = createBackgroundJob('github-body-retention', bodyIntervalMs / 1000);
  let bodyRunning: Promise<void> | undefined;
  const bodyTimer = setInterval(() => {
    bodyRunning ??= bodyJob
      .run(() => pruneGitHubEventBodies(pool))
      .then(() => undefined)
      .catch(() => app.log.error('GitHub webhook body cleanup will retry'))
      .finally(() => {
        bodyRunning = undefined;
      });
  }, bodyIntervalMs);
  bodyTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(bodyTimer);
    await running;
    await bodyRunning;
    bodyJob.close();
    job.close();
  });
}
