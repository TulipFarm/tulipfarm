import { randomUUID } from 'node:crypto';
import type { createTemporalClient } from './temporal.ts';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { healthSchema, livenessSchema, rootSchema } from './health-schema.ts';
import { isolatedStorageEnabled } from '@tulipfarm/workspaces/storage';
import { log, observeCall } from '@tulipfarm/observability';
import { buildInfo } from './build-info.ts';
import { publicWebConfiguration } from '@tulipfarm/config/public-web';

type ServiceHealth = { status: 'ok'; latencyMs: number } | { status: 'unavailable'; latencyMs: number };

export function registerRoot(app: FastifyInstance) {
  app.get('/', { schema: rootSchema }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      name: 'TulipFarm API',
      version: buildInfo.version,
      commit: buildInfo.commit,
      docs: '/v1/docs',
      health: '/v1/health',
    };
  });
}

export function registerHealth(
  app: FastifyInstance,
  { connection, namespace, client }: ReturnType<typeof createTemporalClient>,
) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    statement_timeout: 2000,
    max: 3,
  });
  pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));

  app.addHook('onClose', async () => {
    await pool.end();
  });

  async function check(service: string, probe: () => Promise<unknown>): Promise<ServiceHealth> {
    const start = performance.now();
    try {
      await observeCall('dependency', service, probe);
      return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { status: 'unavailable', latencyMs: Math.round(performance.now() - start) };
    }
  }

  const identity = { version: buildInfo.version, commit: buildInfo.commit };
  app.get('/health/live', { schema: livenessSchema }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', ...identity };
  });

  app.get('/health', { schema: healthSchema }, async (_request, reply) => {
    const publicWebEndpoint = process.env.PUBLIC_WEB_ENDPOINT;
    // Empty skips the probe, for Temporal deployments without a reachable UI.
    const temporalUiUrl = process.env.TEMPORAL_UI_URL ?? 'http://127.0.0.1:8233';
    const [postgres, temporal, workers, temporalUi, publicWeb] = await Promise.all([
      check('postgres', () => pool.query('SELECT 1')),
      check('temporal', () =>
        connection.withDeadline(Date.now() + 2000, () => connection.workflowService.describeNamespace({ namespace })),
      ),
      check('workers', () =>
        connection.withDeadline(Date.now() + 6000, async () => {
          const result: unknown = await client.workflow.execute('healthCheck', {
            workflowId: `health-${randomUUID()}`,
            taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
            workflowExecutionTimeout: '5 seconds',
          });
          if (result !== 'ok') throw new Error('Worker returned an unexpected health result');
        }),
      ),
      temporalUiUrl
        ? check('temporalUi', async () => {
            const response = await fetch(temporalUiUrl, { signal: AbortSignal.timeout(2000) });
            await response.body?.cancel();
            if (!response.ok) throw new Error(`Temporal UI returned ${response.status}`);
          })
        : undefined,
      publicWebEndpoint
        ? check('publicWeb', async () => {
            const config = publicWebConfiguration();
            if (!config) throw new Error('Public web configuration unavailable');
            const response = await fetch(new URL(config.healthPath, config.endpoint), {
              headers: config.headers,
              redirect: 'error',
              signal: AbortSignal.timeout(2000),
            });
            await response.body?.cancel();
            if (!response.ok) throw new Error(`Public web gateway returned ${response.status}`);
          })
        : undefined,
    ]);

    const services = {
      api: { status: 'ok' },
      postgres,
      temporal,
      workers,
      ...(temporalUi ? { temporalUi } : {}),
      ...(publicWeb ? { publicWeb } : {}),
    };
    const storage = isolatedStorageEnabled()
      ? await check('storageMaintenance', () =>
          connection.withDeadline(Date.now() + 6000, async () => {
            const result = await client.workflow.execute('storageHealthCheck', {
              workflowId: `storage-health-${randomUUID()}`,
              taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE ?? 'tulipfarm-storage-v1',
              workflowExecutionTimeout: '5 seconds',
            });
            if (result !== 'isolated-v1') throw new Error('Storage maintenance capability mismatch');
          }),
        )
      : undefined;
    const healthy =
      Object.values(services).every(service => service.status === 'ok') && (!storage || storage.status === 'ok');
    reply.header('Cache-Control', 'no-store').code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      ...identity,
      services: { ...services, ...(storage ? { storageMaintenance: storage } : {}) },
    };
  });
}
