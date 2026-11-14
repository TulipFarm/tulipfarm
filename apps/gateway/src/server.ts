import '@tulipfarm/config/load-secret-files';
import { Pool } from 'pg';
import { readBuildInfo } from '@tulipfarm/build-info/node';
import { shutdownExtensions, startExtensions } from '@tulipfarm/extensions';
import { captureException, log, registerFlagSubjectResolver, startTelemetry } from '@tulipfarm/observability';
import { isolatedStorageEnabled, workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { workspaceFlagSubjects } from './flag-subjects.ts';
import { buildGateway } from './gateway.ts';
import { gatewayServerOptions } from './http.ts';
import { previewGatewayFromEnvironment } from './preview-environment.ts';
import { publicAppsFromEnvironment } from './public-apps-environment.ts';

const buildInfo = readBuildInfo('gateway', new URL('../version.json', import.meta.url));
// Bare package names in TULIPFARM_EXTENSIONS resolve from this app.
await startExtensions('gateway', { resolve: specifier => import.meta.resolve(specifier) });
const telemetry = startTelemetry(buildInfo);

const production = process.env.NODE_ENV === 'production';
if (production && !process.env.WEB_ORIGIN) throw new Error('Set WEB_ORIGIN in production');
const shellOrigin = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:5173').origin;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://tulipfarm:local-tulipfarm@127.0.0.1:5432/tulipfarm',
  options: '-c search_path=app',
  connectionTimeoutMillis: 5000,
  max: 10,
});
pool.on('error', () => log('error', 'dependency', 'database_connection_failed'));
registerFlagSubjectResolver(workspaceFlagSubjects(pool));
const runtime = isolatedStorageEnabled() ? workspaceRuntime(pool) : undefined;
const storage = runtime && { pool, runtime };

const preview = previewGatewayFromEnvironment(process.env, shellOrigin, () => storage);
if (!preview) throw new Error('Set TULIPFARM_APP_PREVIEW_DOMAIN and TULIPFARM_OBJECT_STORAGE_APPS_BUCKET');

const server = buildGateway({
  preview,
  apps: publicAppsFromEnvironment(process.env, pool),
  serverOptions: gatewayServerOptions(process.env),
  identity: { version: buildInfo.version, commit: buildInfo.commit },
});
server.addHook('onClose', async () => {
  await runtime?.close();
  await pool.end();
});

async function shutdown() {
  try {
    await server.close();
  } catch (error) {
    captureException(error);
    log('error', 'lifecycle', 'shutdown_failed');
    process.exitCode = 1;
  } finally {
    await Promise.all([telemetry?.shutdown(), shutdownExtensions()]);
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

const portValue = process.env.PORT ?? '3002';
const port = Number(portValue);
if (!/^\d+$/.test(portValue) || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
try {
  await server.listen({ host: process.env.HOST ?? '127.0.0.1', port });
} catch (error) {
  captureException(error);
  log('error', 'lifecycle', 'startup_failed');
  await shutdown();
  process.exitCode = 1;
}
