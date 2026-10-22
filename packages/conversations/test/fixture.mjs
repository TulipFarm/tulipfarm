import { readFile } from 'node:fs/promises';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createConversations } from '../src/index.ts';

export const reverseReply = async ({ messages }) =>
  [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(messages.at(-1).text)]
    .map(item => item.segment)
    .reverse()
    .join('');

export async function conversationFixture(extend = async stream => stream, prepareInitialAdmin) {
  const db = await fixture();
  let prepared;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await extend(await workspaceTableMigrations());
    prepared = await prepareInitialAdmin?.(db);
    const workspace = await db.create(stream, prepared);
    const createRuntime = () =>
      createWorkspaceRuntime({
        replicaCount: 1,
        maxPools: 2,
        connectionsPerPool: 4,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
      });
    const runtime = createRuntime();
    return {
      db,
      workspace,
      runtime,
      createRuntime,
      store: createConversations(runtime),
      table: name => qualified(workspace.names.schema, name),
      close: async () => {
        await runtime.close();
        await prepared?.close?.();
        await db.close();
      },
    };
  } catch (error) {
    try {
      await prepared?.close?.();
    } finally {
      await db.close();
    }
    throw error;
  }
}
