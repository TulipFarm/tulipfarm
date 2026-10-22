import '@tulipfarm/config/load-secret-files';
import { temporalConnectionOptions } from '@tulipfarm/config/temporal';
import { extname } from 'node:path';
import { readBuildInfo } from '@tulipfarm/build-info/node';
import { captureException, createBackgroundJob, retryError, startTelemetry } from '@tulipfarm/observability';
import { shutdownExtensions, startExtensions } from '@tulipfarm/extensions';
import { workerTelemetry } from './telemetry.ts';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createWorkspaceMaintenance } from '@tulipfarm/workspaces/lifecycle';
import { createMigrationCredentialResolver } from '@tulipfarm/workspaces/capabilities';
import { Pool } from 'pg';
import { z } from 'zod';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createInvitationExpirySweep } from '@tulipfarm/workspaces/invitation-expiry';
import { createTableExecution } from '@tulipfarm/tables/execution';
import { requireTableSources, requireTableFiles, requireTableImportReference } from '@tulipfarm/agents/table-sources';
import { createTableCleanupMaintenance } from './table-cleanup.ts';

// Bare package names in TULIPFARM_EXTENSIONS resolve from this app.
await startExtensions('storage-worker', { resolve: specifier => import.meta.resolve(specifier) });
const telemetry = startTelemetry(readBuildInfo('storage-maintenance', new URL('../version.json', import.meta.url)));

async function run() {
  const maintenance = createWorkspaceMaintenance({ migrations: await workspaceTableMigrations() });
  const registry = new Pool({
    connectionString: z.url().parse(process.env.WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL),
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c search_path=pg_catalog',
  });
  registry.on('error', () => undefined);
  const resolve = createMigrationCredentialResolver(registry);
  const sweepInvitations = createInvitationExpirySweep(registry, resolve);
  const cleanupTables = createTableCleanupMaintenance(registry, resolve);
  let sweep: Promise<unknown> | undefined;
  const invitationJob = createBackgroundJob('invitation-expiry', 60);
  const tableJob = createBackgroundJob('table-cleanup', 60);
  const expire = () => {
    sweep ??= (async () => {
      await invitationJob
        .run(sweepInvitations)
        .catch(() => Runtime.instance().logger.error('Invitation expiry sweep failed'));
      await tableJob
        .run(() => cleanupTables.sweep())
        .catch(() => Runtime.instance().logger.error('Table cleanup sweep failed'));
    })().finally(() => {
      sweep = undefined;
    });
  };
  const expiryTimer = setInterval(expire, 60_000);
  expiryTimer.unref();
  expire();
  const access = {
    requireSources: requireTableSources,
    requireFiles: requireTableFiles,
    requireImportReference: requireTableImportReference,
  };
  const advanceTableProposal = createTableExecution({
    ...access,
    resolveMigrationCredential: async workspaceId => (await resolve(workspaceId)).connectionString,
  });
  let connection: NativeConnection | undefined;
  try {
    connection = await NativeConnection.connect(temporalConnectionOptions());
    const worker = await Worker.create({
      ...workerTelemetry(telemetry),
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: process.env.TEMPORAL_STORAGE_TASK_QUEUE ?? 'tulipfarm-storage-v1',
      workflowsPath: fileURLToPath(new URL(`./storage-workflows${extname(import.meta.filename)}`, import.meta.url)),
      activities: {
        initializeWorkspaceStorage: maintenance.initializeWorkspaceStorage,
        cleanupTableHistory: cleanupTables.cleanupTableHistory,
        async advanceTableProposal(workspaceId: string, proposalId: string) {
          try {
            return await advanceTableProposal(workspaceId, proposalId);
          } catch (error) {
            throw retryError('table-execution-retry', error);
          }
        },
      },
      maxConcurrentActivityTaskExecutions: 1,
      shutdownGraceTime: '60 seconds',
    });
    await worker.run();
  } finally {
    clearInterval(expiryTimer);
    await sweep;
    invitationJob.close();
    tableJob.close();
    await connection?.close();
    await registry.end();
    await maintenance.close();
  }
}

run()
  .catch(error => {
    captureException(error);
    Runtime.instance().logger.error('Storage maintenance worker failed');
    process.exitCode = 1;
  })
  .finally(() => Promise.all([telemetry?.shutdown(), shutdownExtensions()]));
