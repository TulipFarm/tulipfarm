import { Pool } from 'pg';
import { z } from 'zod';
import { modelBundleStore } from '@tulipfarm/agents/model-bundles';
import { log } from '@tulipfarm/observability';

/** Model bundle store over the authoring registry login, which may only call the bundle routines. */
export function createModelBundleRegistry(env: NodeJS.ProcessEnv = process.env) {
  const pool = new Pool({
    connectionString: z.url().parse(env.WORKSPACE_AUTHORING_DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c search_path=pg_catalog',
  });
  pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
  return { store: modelBundleStore(pool), close: () => pool.end() };
}
