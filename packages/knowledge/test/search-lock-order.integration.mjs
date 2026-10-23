import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { lockAuthorization } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createKnowledgeEmbeddings, createKnowledgeSearch } from '../dist/index.js';

// A chat knowledge tool runs every transaction through the reply's guarded runtime, which takes the shared
// authorization lock and then the conversation row. Lease renewal and other tool receipts (web.search) take the
// same two locks in the same order. A submitted search must not then upgrade the authorization lock to write mode:
// the upgrade waits for the concurrent reply transaction's shared lock while that transaction waits for the
// conversation row, which Postgres reports as 40P01.
test('a submitted knowledge search in a guarded chat transaction does not deadlock concurrent reply transactions', async () => {
  const db = await fixture();
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 4,
    connectionsPerPool: 4,
    reservedConnections: 2,
    databaseConnectionBudget: 40,
    resolveCredential: async id => {
      const ws = db.workspaces.find(item => item.id === id);
      assert.ok(ws);
      return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
    },
  });
  let search;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const ws = await db.create(await workspaceTableMigrations());
    const conversations = qualified(ws.names.schema, 'tf_conversations');
    const membershipId = (
      await db.platform.query(`SELECT id FROM ${qualified(ws.names.schema, 'tf_memberships')} WHERE user_id=$1`, [
        ws.userId,
      ])
    ).rows[0].id;
    const conversationId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${conversations} (id,owner_user_id,owner_membership_id,title) VALUES ($1,$2,$3,'Lock order')`,
      [conversationId, ws.userId, membershipId],
    );
    const lockConversation = tx =>
      tx.client.query(`SELECT id FROM ${conversations} WHERE id=$1 FOR UPDATE`, [conversationId]);
    const waiting = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const blocked = await db.admin.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' LIMIT 1`,
          [new URL(db.connectionString).pathname.slice(1)],
        );
        if (blocked.rowCount) return;
        await sleep(10);
      }
      assert.fail('The concurrent reply transaction never waited for the conversation');
    };

    // The concurrent reply transaction: lease renewal and web.search receipts lock authorization, then the conversation.
    const replies = [];
    const concurrentReply = () => {
      let shared;
      const holdsShared = new Promise(resolve => (shared = resolve));
      replies.push(
        runtime
          .transaction(ws.id, { minimum: 1, maximum: 1000 }, async tx => {
            await lockAuthorization(tx);
            shared();
            await lockConversation(tx);
          })
          .then(
            () => null,
            error => error?.code ?? String(error),
          ),
      );
      return holdsShared;
    };
    const guarded = {
      ...runtime,
      transaction: (workspaceId, compatibility, operation) =>
        runtime.transaction(workspaceId, compatibility, async tx => {
          await lockAuthorization(tx);
          await lockConversation(tx);
          await concurrentReply();
          await waiting();
          return operation(tx);
        }),
    };
    const embeddings = createKnowledgeEmbeddings({ runtime, config: { kind: 'disabled' } });
    search = createKnowledgeSearch({ runtime: guarded, embeddings });
    const found = await search.search(
      ws.id,
      ws.userId,
      { kind: 'submitted', commandId: randomUUID(), query: 'quarterly plan', filters: {} },
      Date.now() + 20_000,
    );
    assert.equal(found.hits.length, 0);
    assert.deepEqual((await Promise.all(replies)).filter(Boolean), []);
    const saved = await db.platform.query(
      `SELECT count(*)::int AS count FROM ${qualified(ws.names.schema, 'tf_knowledge_search_sessions')} WHERE owner_membership_id=$1`,
      [membershipId],
    );
    assert.equal(saved.rows[0].count, 1);
  } finally {
    await search?.close();
    await runtime.close();
    await db.close();
  }
});
