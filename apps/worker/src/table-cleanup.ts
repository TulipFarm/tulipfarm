import { Pool } from 'pg';
import { z } from 'zod';
import { createTableCleanup } from '@tulipfarm/tables/cleanup';
import type { AttachmentBytes } from '@tulipfarm/conversations/attachments';
import { createTableImportObjectCleanup } from '@tulipfarm/tables/imports';
import { createFiles } from '@tulipfarm/files';
import {
  sweepTableQueryTranslations,
  tableQueryTranslationCompatibility,
} from '@tulipfarm/agents/table-query-translator';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { errorAttributes, log, withErrorStage } from '@tulipfarm/observability';

export function createTableCleanupMaintenance(
  registry: Pick<Pool, 'query'>,
  resolve: (workspaceId: string) => Promise<{ connectionString: string }>,
) {
  const cleanup = createTableCleanup({
    resolveMigrationCredential: async workspaceId => (await resolve(workspaceId)).connectionString,
  });
  let after: string | null = null;
  const cleanupTableHistory = async (workspaceId: string) => {
    try {
      return await cleanup(workspaceId);
    } catch (error) {
      log('error', 'activity', 'call_failed', { ...errorAttributes(error), operation: 'table.cleanup' });
      throw new Error('table-cleanup-retry');
    }
  };
  return {
    cleanupTableHistory,
    async sweep() {
      const rows = await withErrorStage('table-cleanup-discovery', async () =>
        z
          .array(z.object({ workspace_id: z.uuid() }))
          .parse(
            (
              await registry.query(
                `SELECT workspace_id FROM app.workspace_storage WHERE stage='ready' AND ($1::uuid IS NULL OR workspace_id>$1) ORDER BY workspace_id LIMIT 10`,
                [after],
              )
            ).rows,
          ),
      );
      const failures: unknown[] = [];
      for (const { workspace_id: workspaceId } of rows) {
        try {
          await cleanup(workspaceId);
        } catch (error) {
          failures.push(error);
        }
        after = workspaceId;
      }
      if (rows.length < 10) after = null;
      if (failures.length) throw new AggregateError(failures, 'Table cleanup sweep incomplete');
    },
  };
}

/** Resumes object cleanup that a request left incomplete: table import snapshots and Files deletions. */
export function createObjectCleanupSweep(
  runtime: Parameters<typeof createTableImportObjectCleanup>[0] & Parameters<typeof createFiles>[0],
  objects: AttachmentBytes,
) {
  const registry = new Pool({
    connectionString: z.url().parse(process.env.WORKSPACE_AUTHORING_DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c search_path=pg_catalog',
  });
  registry.on('error', () => undefined);
  const imports = createTableImportObjectCleanup(runtime, objects);
  const files = createFiles(runtime, objects);
  const cleanup = async (workspaceId: string) => {
    const [imported, deleted] = await Promise.allSettled([imports(workspaceId), files.sweepDeletions(workspaceId)]);
    const failures = [imported, deleted].flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
    if (deleted.status === 'fulfilled' && deleted.value.failed) failures.push(new Error('object-cleanup-retry'));
    if (failures.length) throw new AggregateError(failures, 'object-cleanup-retry');
  };
  let after: string | null = null;
  return {
    async sweep() {
      const rows = z
        .array(z.object({ workspace_id: z.uuid() }))
        .parse(
          (
            await registry.query(
              `SELECT workspace_id FROM app.workspace_storage WHERE stage='ready' AND ($1::uuid IS NULL OR workspace_id>$1) ORDER BY workspace_id LIMIT 10`,
              [after],
            )
          ).rows,
        );
      const failures: unknown[] = [];
      for (const row of rows) {
        try {
          await cleanup(row.workspace_id);
        } catch (error) {
          failures.push(error);
        }
        after = row.workspace_id;
      }
      if (rows.length < 10) after = null;
      if (failures.length) throw new AggregateError(failures, 'object-cleanup-retry');
    },
    close: () => registry.end(),
  };
}

type TranslationRuntime = {
  transaction<T>(
    workspaceId: string,
    compatibility: { minimum: number; maximum: number },
    operation: (tx: Parameters<typeof sweepTableQueryTranslations>[0]) => Promise<T>,
  ): Promise<T>;
};

/** Retains Ask AI translation receipts and settles their unresolved credit holds. Workspaces without translation storage are skipped. */
export function createTableSearchSweep(
  runtime: TranslationRuntime,
  discover: (after: string | null) => Promise<string[]>,
) {
  let after: string | null = null;
  return async () => {
    const workspaces = await discover(after);
    let failed = false;
    for (const workspaceId of workspaces) {
      try {
        await runtime.transaction(workspaceId, tableQueryTranslationCompatibility, sweepTableQueryTranslations);
      } catch (error) {
        if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version')) failed = true;
      }
      after = workspaceId;
    }
    if (workspaces.length < 10) after = null;
    if (failed) throw new Error('table-search-sweep-retry');
  };
}
