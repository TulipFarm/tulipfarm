import '@tulipfarm/config/load-secret-files';
import { shutdownExtensions, startExtensions } from '@tulipfarm/extensions';
import { captureException, log, startTelemetry } from '@tulipfarm/observability';
import { buildInfo } from './build-info.ts';

// Bare package names in TULIPFARM_EXTENSIONS resolve from this app.
await startExtensions('api', { resolve: specifier => import.meta.resolve(specifier) });
const telemetry = startTelemetry(buildInfo);
const { buildApp } = await import('./app.ts');
const { logUnconfiguredIntegrations } = await import('./integration-status.ts');

// Fails startup on an invalid model catalog or provider environment.
const { loadModelCatalog } = await import('@tulipfarm/config');
const { publicGuideWarnings } = await import('./public-guide-model.ts');
// Fails startup on removed Firecrawl settings or an invalid public web endpoint.
const { publicWebConfiguration } = await import('@tulipfarm/config/public-web');
publicWebConfiguration();
for (const msg of [...loadModelCatalog().warnings, ...publicGuideWarnings()])
  console.warn(JSON.stringify({ level: 'warn', msg }));

const app = buildApp();

async function shutdown() {
  try {
    await app.close();
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

try {
  const portValue = process.env.PORT ?? '3001';
  const port = Number(portValue);

  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }

  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
  logUnconfiguredIntegrations();
} catch (error) {
  captureException(error);
  log('error', 'lifecycle', 'startup_failed');
  process.exitCode = 1;
  await app.close();
  await Promise.all([telemetry?.shutdown(), shutdownExtensions()]);
}
