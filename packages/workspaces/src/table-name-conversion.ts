import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockAuthorization } from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { definitionSchema, type TableDefinition } from '@tulipfarm/tables/definition';
import { reserveDefinitionNames, tableIdentityStorageReady } from '@tulipfarm/tables/identities';
import type { TableNames } from '@tulipfarm/tables/names';
import type { PrepareTableDefinition } from '@tulipfarm/tables/execution';
import { soulProjectionSchema, type SoulProjection } from './soul-revisions.ts';
import type { WorkspaceStore } from './storage.ts';

const candidateSchema = z.object({ table_id: z.uuid(), projection: soulProjectionSchema });
const commandSchema = z.object({
  id: z.uuid(),
  table_id: z.uuid(),
  parent_revision: z.string(),
  created_at: z.date(),
  revision: z.string().nullable(),
});
type Prepared = Awaited<ReturnType<PrepareTableDefinition>>;
type Conversion = Parameters<PrepareTableDefinition>[0] & { tableNames: TableNames; previousSha256: string };

export function createTableNameConversion(options: {
  runtime: WorkspaceStore['runtime'];
  readDefinition(workspaceId: string, projection: SoulProjection): Promise<TableDefinition>;
  prepare(input: Conversion): Promise<Prepared>;
}) {
  return async (workspaceId: string) => {
    const selected = await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      if (!(await tableIdentityStorageReady(tx))) return { status: 'schema-pending' } as const;
      const table = (name: string) => qualified(tx.schema, name);
      const candidate = candidateSchema.optional().parse(
        (
          await tx.client.query(`
        SELECT saved.table_id,saved.projection FROM (
          SELECT DISTINCT ON(e.table_id) e.table_id,e.projection
          FROM ${table('tf_table_executions')} e JOIN ${table('tf_soul_revisions')} r ON r.revision=e.revision
          LEFT JOIN ${table('tf_table_catalog')} c ON c.id=e.table_id
          LEFT JOIN ${table('tf_table_soul_files')} f ON f.table_id=e.table_id
          WHERE e.projection IS NOT NULL AND f.table_id IS NULL AND (c.target_revision=e.revision OR c.id IS NULL)
          ORDER BY e.table_id,r.accepted_at DESC,r.revision DESC
        ) saved ORDER BY saved.table_id LIMIT 1`)
        ).rows[0],
      );
      if (!candidate) return { status: 'ready' } as const;
      if (
        candidate.projection.workspaceId !== workspaceId ||
        candidate.projection.kind !== 'table' ||
        candidate.projection.id !== candidate.table_id ||
        candidate.projection.tableNames
      )
        throw new Error('Invalid legacy table conversion source');
      const busy = (
        await tx.client.query(
          `SELECT 1 FROM ${table('tf_table_executions')} WHERE table_id=$1 AND phase IN ('publishing','copying','reconciling') LIMIT 1`,
          [candidate.table_id],
        )
      ).rowCount;
      if (busy) return { status: 'work-pending' } as const;
      const head = z
        .string()
        .parse((await tx.client.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0]?.revision);
      const parent = z
        .object({ key: z.string(), sha256: z.string() })
        .parse(
          (
            await tx.client.query(
              `SELECT bundle_key AS key,bundle_sha256 AS sha256 FROM ${table('tf_soul_revisions')} WHERE revision=$1`,
              [head],
            )
          ).rows[0],
        );
      return { status: 'selected', candidate, head, parent } as const;
    });
    if (selected.status !== 'selected') return selected.status;
    const definition = definitionSchema.parse(await options.readDefinition(workspaceId, selected.candidate.projection));
    if (definition.id !== selected.candidate.table_id) throw new Error('Table conversion identity mismatch');
    const pending = await options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const table = (name: string) => qualified(tx.schema, name);
      const tableNames = await reserveDefinitionNames(tx, definition);
      if (!tableNames) throw new Error('Table name storage is not ready');
      const head = (await tx.client.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1 FOR UPDATE`))
        .rows[0]?.revision;
      if (
        head !== selected.head ||
        (await tx.client.query(`SELECT 1 FROM ${table('tf_table_soul_files')} WHERE table_id=$1`, [definition.id]))
          .rowCount
      )
        return null;
      await tx.client.query(
        `INSERT INTO ${table('tf_table_name_conversions')}(id,table_id,parent_revision) VALUES($1,$2,$3) ON CONFLICT(parent_revision) DO NOTHING`,
        [randomUUID(), definition.id, head],
      );
      const command = commandSchema.parse(
        (await tx.client.query(`SELECT * FROM ${table('tf_table_name_conversions')} WHERE parent_revision=$1`, [head]))
          .rows[0],
      );
      if (command.table_id !== definition.id || command.revision) throw new Error('Table conversion command conflict');
      return { command, tableNames };
    });
    if (!pending) return 'retry';
    const prepared = await options.prepare({
      workspaceId,
      commandId: pending.command.id,
      expectedParentCommit: selected.head,
      createdAt: pending.command.created_at.toISOString(),
      parent: selected.parent,
      definition,
      tableNames: pending.tableNames,
      previousSha256: selected.candidate.projection.sha256,
    });
    return options.runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      const table = (name: string) => qualified(tx.schema, name);
      const head = (await tx.client.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1 FOR UPDATE`))
        .rows[0]?.revision;
      const command = commandSchema.parse(
        (await tx.client.query(`SELECT * FROM ${table('tf_table_name_conversions')} WHERE id=$1`, [pending.command.id]))
          .rows[0],
      );
      if (command.revision) return 'converted';
      if (head !== selected.head) return 'retry';
      const projection = soulProjectionSchema.parse(prepared.projection);
      if (
        prepared.parentCommit !== head ||
        projection.workspaceId !== workspaceId ||
        projection.id !== definition.id ||
        projection.kind !== 'table' ||
        projection.commit !== prepared.commit ||
        projection.path !== `tables/${pending.tableNames[definition.id]}.json` ||
        JSON.stringify(projection.tableNames) !== JSON.stringify(pending.tableNames)
      )
        throw new Error('Invalid table naming revision');
      await tx.client.query(
        `INSERT INTO ${table('tf_soul_revisions')}(revision,parent_revision,table_name_conversion_id,bundle_key,bundle_sha256) VALUES($1,$2,$3,$4,$5)`,
        [prepared.commit, head, command.id, prepared.bundle.key, prepared.bundle.sha256],
      );
      await tx.client.query(
        `INSERT INTO ${table('tf_table_soul_files')}(table_id,projection,revision) VALUES($1,$2,$3)`,
        [definition.id, projection, prepared.commit],
      );
      await tx.client.query(`UPDATE ${table('tf_table_name_conversions')} SET revision=$2 WHERE id=$1`, [
        command.id,
        prepared.commit,
      ]);
      await tx.client.query(`UPDATE ${table('tf_soul_head')} SET revision=$1,updated_at=clock_timestamp() WHERE id=1`, [
        prepared.commit,
      ]);
      return 'converted';
    });
  };
}
