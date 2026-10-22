import { Pool } from 'pg';
import { z } from 'zod';
import { prepareSoulRevision, readVerifiedProjection, type SoulChange } from './soul-revisions.ts';
import { definitionSchema } from '@tulipfarm/tables/definition';
import { createTableNameConversion } from './table-name-conversion.ts';
import { soulStorageConfig } from './soul.ts';
import { workspaceRuntime } from './storage.ts';
import { memberProfileSource } from './member-profiles.ts';

const seedRow = z.object({
  id: z.uuid(),
  created_by: z.uuid(),
  created_at: z.date(),
  soul_commit: z.string(),
  soul_bucket: z.string(),
  soul_key: z.string(),
});

export function createWorkspaceTableAuthoring() {
  const pool = new Pool({
    connectionString: z.url().parse(process.env.WORKSPACE_AUTHORING_DATABASE_URL),
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c search_path=pg_catalog',
  });
  pool.on('error', () => undefined);
  const runtime = workspaceRuntime(pool);
  const storage = soulStorageConfig();
  async function prepare(
    input: {
      workspaceId: string;
      commandId: string;
      expectedParentCommit: string;
      createdAt: string;
      parent: { key: string; sha256: string } | null;
    },
    change: SoulChange,
  ) {
    const row = seedRow.parse(
      (
        await pool.query(
          `SELECT id, created_by, created_at, soul_commit, soul_bucket, soul_key FROM app.workspaces WHERE id = $1`,
          [input.workspaceId],
        )
      ).rows[0],
    );
    const seed = { workspaceId: row.id, createdBy: row.created_by, createdAt: row.created_at.toISOString() };
    const parent = input.parent
      ? { ...input.parent, commit: input.expectedParentCommit, bucket: row.soul_bucket }
      : { commit: row.soul_commit, bucket: row.soul_bucket, key: row.soul_key };
    return prepareSoulRevision(storage, seed, parent, change);
  }
  return {
    runtime,
    convertTableName: createTableNameConversion({
      runtime,
      readDefinition: async (workspaceId, projection) =>
        definitionSchema.parse(await readVerifiedProjection(storage, workspaceId, projection)),
      prepare: input =>
        prepare(input, {
          kind: 'table',
          commandId: input.commandId,
          expectedParentCommit: input.expectedParentCommit,
          createdAt: input.createdAt,
          definition: input.definition,
          tableNames: input.tableNames,
          previousSha256: input.previousSha256,
        }),
    }),
    memberProfiles: memberProfileSource(pool),
    async readyTaskWorkspaces(after: string | null) {
      return z
        .array(z.object({ workspace_id: z.uuid() }))
        .parse(
          (
            await pool.query(
              `SELECT workspace_id FROM app.workspace_storage WHERE stage='ready' AND ($1::uuid IS NULL OR workspace_id>$1) ORDER BY workspace_id LIMIT 10`,
              [after],
            )
          ).rows,
        )
        .map(row => row.workspace_id);
    },
    async prepareTableDefinition(input: Parameters<import('@tulipfarm/tables/execution').PrepareTableDefinition>[0]) {
      return prepare(input, {
        kind: 'table',
        commandId: input.commandId,
        expectedParentCommit: input.expectedParentCommit,
        createdAt: input.createdAt,
        definition: input.definition,
        tableNames: input.tableNames,
      });
    },
    async prepareAgentRevision(input: {
      workspaceId: string;
      commandId: string;
      expectedParentCommit: string;
      createdAt: string;
      parent: { key: string; sha256: string } | null;
      definition: Extract<SoulChange, { kind: 'agent' }>['definition'];
    }) {
      const prepared = await prepare(input, {
        kind: 'agent',
        commandId: input.commandId,
        expectedParentCommit: input.expectedParentCommit,
        createdAt: input.createdAt,
        definition: input.definition,
      });
      return { ...prepared, projection: { ...prepared.projection, kind: 'agent' as const } };
    },
    async close() {
      await runtime.close();
      storage.client.destroy();
      await pool.end();
    },
  };
}
