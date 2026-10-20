import Fastify from 'fastify';
import { Pool } from 'pg';
import { workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createTemporalClient } from '../dist/temporal.js';
import { registerTableDispatch } from '../dist/table-dispatch.js';

const original = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const target = new URL(String(url));
  if (target.hostname === 'api.github.com')
    return original(`${process.env.TEST_PROVIDER_ORIGIN}/${target.hostname}${target.pathname}${target.search}`, init);
  throw new Error('Unexpected test network destination');
};
const pool = new Pool({ connectionString: process.env.WORKSPACE_AUTHORING_DATABASE_URL });
const raw = workspaceRuntime(pool),
  runtime = withGitHubSourceAuthorization(raw),
  temporal = createTemporalClient();
const app = Fastify({ logger: false });
registerTableDispatch(app, { pool, runtime, temporal });
await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.('ready');
process.on('SIGTERM', async () => {
  await app.close();
  await raw.close();
  await pool.end();
  await temporal.connection.close();
});
