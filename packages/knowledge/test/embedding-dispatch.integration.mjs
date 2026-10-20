import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createKnowledgeEmbeddings } from '../dist/index.js';

test('cancellation releases proven-unsent embedding attempts without fabricated usage', async t => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 8,
      connectionsPerPool: 2,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        const ws = db.workspaces.find(item => item.id === id);
        assert.ok(ws);
        return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
      },
    });
    for (const boundary of ['reservation', 'committed-marker', 'provider-unsent'])
      await t.test(boundary, async () => {
        const ws = await db.create(stream);
        const table = name => qualified(ws.names.schema, `tf_knowledge_${name}`);
        await db.platform.query(
          `UPDATE ${qualified(ws.names.schema, 'tf_credit_account')} SET available=1000000000000,granted=1000000000000`,
        );
        const controller = new AbortController();
        let calls = 0;
        const intercepted = {
          transaction: async (workspaceId, compatibility, operation) => {
            const value = await runtime.transaction(workspaceId, compatibility, tx =>
              operation({
                ...tx,
                client: {
                  query: async (sql, params) => {
                    const result = await tx.client.query(sql, params);
                    if (
                      boundary === 'reservation' &&
                      sql.startsWith('INSERT INTO') &&
                      sql.includes('tf_knowledge_credit_attempts')
                    )
                      controller.abort();
                    return result;
                  },
                },
              }),
            );
            if (boundary === 'committed-marker' && value === 'dispatch') controller.abort();
            return value;
          },
        };
        const api = createKnowledgeEmbeddings({
          runtime: intercepted,
          config: {
            kind: 'enabled',
            endpoint: 'https://example.services.ai.azure.com/',
            apiKey: 'fixture-only',
            profile: knowledgeEmbeddingProfile,
          },
          capacity: async () => true,
          provider: async () => {
            calls++;
            return {
              dispatch: 'undispatched',
              inputTokensUpperBound: 0,
              requestId: null,
              usage: { kind: 'unknown', reason: 'undispatched' },
              result: { kind: 'error', code: 'cancelled' },
            };
          },
        });
        const prepared = await api.prepareQuery(ws.id, ws.userId, {
          commandId: randomUUID(),
          query: `cancel at ${boundary}`,
        });
        await api.process({ workspaceId: ws.id, jobId: prepared.jobId }, undefined, controller.signal);
        assert.equal(calls, boundary === 'provider-unsent' ? 1 : 0, 'cancellation must prevent provider invocation');
        assert.deepEqual((await db.platform.query(`SELECT state FROM ${table('credit_attempts')}`)).rows, [
          { state: 'released' },
        ]);
        assert.equal(
          (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('credit_observations')}`)).rows[0].count,
          0,
        );
        assert.deepEqual((await db.platform.query(`SELECT known,pending FROM ${table('credit_group')}`)).rows, [
          { known: '0', pending: '0' },
        ]);
        assert.equal(
          (await db.platform.query(`SELECT available FROM ${qualified(ws.names.schema, 'tf_credit_account')}`)).rows[0]
            .available,
          '1000000000000',
        );
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int AS count FROM ${table('embedding_cache')} WHERE state IN ('claimed','dispatched','unknown')`,
            )
          ).rows[0].count,
          0,
        );
      });
  } finally {
    await runtime?.close();
    await db.close();
  }
});
