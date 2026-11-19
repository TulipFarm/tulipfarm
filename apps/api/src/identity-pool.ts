import type { FastifyInstance } from 'fastify';
import { Pool, type PoolConfig } from 'pg';
import { databasePools } from '@tulipfarm/config/database-connections';
import { log } from '@tulipfarm/observability';

/** A pool for the application registry (`app` schema): accounts, memberships and workspace storage. */
export function createIdentityPool(app: FastifyInstance, config: PoolConfig = {}) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
    options: '-c search_path=app',
    connectionTimeoutMillis: 5000,
    max: databasePools.identity,
    ...config,
  });
  pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return pool;
}
