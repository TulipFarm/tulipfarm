import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createFiles } from '@tulipfarm/files';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createKnowledgeKeepFeed, createKnowledgeRetention, createLocalKnowledge } from '../dist/index.js';
import { fakeKnowledgeKeep } from './fake-keep.mjs';

test('Knowledge retention purge', async t => {
  const db = await fixture();
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 16,
    connectionsPerPool: 2,
    reservedConnections: 2,
    databaseConnectionBudget: 40,
    resolveCredential: async id => {
      const ws = db.workspaces.find(item => item.id === id);
      assert.ok(ws);
      return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
    },
  });
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();

    async function setup() {
      const ws = await db.create(stream);
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      await db.platform.query(`UPDATE ${table('tf_credit_account')} SET available=$1,granted=$1`, ['10000000000000']);
      const bytes = new Map();
      const files = createFiles(runtime, {
        putIfAbsent: async (key, value) => {
          bytes.set(key, value);
        },
        read: async key => bytes.get(key),
      });
      const local = createLocalKnowledge({ runtime, files });
      const keep = fakeKnowledgeKeep();
      const live = { on: true };
      const feed = createKnowledgeKeepFeed({ runtime, client: () => keep.client });
      const retention = createKnowledgeRetention({ runtime, keepLive: () => live.on });
      const query = async (sql, values = []) => (await db.platform.query(sql, values)).rows;
      async function note(text) {
        const saved = await local.save(ws.id, ws.userId, {
          commandId: randomUUID(),
          documentId: randomUUID(),
          expectedRevisionId: null,
          title: text,
          input: { kind: 'note', text },
        });
        for (const work of await local.due(ws.id)) await local.process(work);
        return saved;
      }
      async function remove(doc) {
        await local.remove(ws.id, ws.userId, {
          commandId: randomUUID(),
          documentId: doc.documentId,
          expectedRevisionId: doc.revisionId,
        });
      }
      async function drainKeep() {
        for (const work of await feed.due(ws.id, null, 100)) await feed.sync(ws.id, work.document_id);
      }
      // Moves a tombstone back in time, as if its 30 days of retention had passed.
      const expire = documentId =>
        query(
          `UPDATE ${table('documents')} SET tombstoned_at=now()-interval '31 days', retain_until=now()-interval '1 day'
           WHERE id=$1 AND tombstoned_at IS NOT NULL`,
          [documentId],
        );
      // Counts every row stored for a document, so a purge that leaves any behind is caught.
      async function stored(documentId) {
        const [row] = await query(
          `SELECT (SELECT count(*) FROM ${table('documents')} WHERE id=$1)::int AS documents,
                  (SELECT count(*) FROM ${table('revisions')} WHERE document_id=$1)::int AS revisions,
                  (SELECT count(*) FROM ${table('publications')} WHERE document_id=$1)::int AS publications,
                  (SELECT count(*) FROM ${table('chunks')} c JOIN ${table('publications')} p ON p.id=c.publication_id
                    WHERE p.document_id=$1)::int AS chunks,
                  (SELECT count(*) FROM ${table('note_originals')} o JOIN ${table('revisions')} r ON r.id=o.revision_id
                    WHERE r.document_id=$1)::int AS originals,
                  (SELECT count(*) FROM ${table('tf_keep_knowledge')} WHERE document_id=$1)::int AS keep`,
          [documentId],
        );
        return row;
      }
      async function usageMatches() {
        const [row] = await query(
          `SELECT u.documents = (SELECT count(*) FROM ${table('documents')})
              AND u.chunks = (SELECT count(*) FROM ${table('chunks')}) AS matches
           FROM ${table('usage')} u`,
        );
        assert.equal(row.matches, true, 'usage totals match the stored rows');
      }
      async function purgeAll() {
        let removed = 0;
        for (;;) {
          const batch = await retention.purge(ws.id, 1);
          if (batch === 0) return removed;
          removed += batch;
        }
      }
      async function source(documentId) {
        return (await query(`SELECT source_id FROM ${table('documents')} WHERE id=$1`, [documentId]))[0].source_id;
      }
      return {
        ws,
        table,
        live,
        retention,
        query,
        note,
        remove,
        drainKeep,
        expire,
        stored,
        usageMatches,
        purgeAll,
        source,
      };
    }

    await t.test('an expired tombstone is deleted with everything stored for it once Keep forgot it', async () => {
      const w = await setup();
      const kept = await w.note('supplier payment deadline');
      const recent = await w.note('warehouse floor plan');
      const expired = await w.note('quarterly travel policy');
      await w.drainKeep();
      await w.remove(recent);
      await w.remove(expired);
      assert.ok((await w.stored(expired.documentId)).chunks > 0);
      await w.expire(expired.documentId);

      // Keep still holds the document until the feed forgets it.
      assert.equal(await w.retention.pending(w.ws.id), false);
      assert.equal(await w.purgeAll(), 0);
      assert.equal((await w.stored(expired.documentId)).documents, 1);

      await w.drainKeep();
      assert.equal(await w.retention.pending(w.ws.id), true);
      assert.equal(await w.purgeAll(), 1);
      assert.deepEqual(await w.stored(expired.documentId), {
        documents: 0,
        revisions: 0,
        publications: 0,
        chunks: 0,
        originals: 0,
        keep: 0,
      });
      assert.equal((await w.stored(recent.documentId)).documents, 1, 'a tombstone inside retention stays');
      assert.equal((await w.stored(kept.documentId)).documents, 1, 'a live document stays');
      assert.equal(await w.retention.pending(w.ws.id), false);
      await w.usageMatches();
    });

    await t.test('without Keep, a held document is purged and its Keep row stays to be forgotten later', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline');
      await w.drainKeep();
      await w.remove(doc);
      await w.expire(doc.documentId);
      w.live.on = false;
      assert.equal(await w.retention.pending(w.ws.id), true);
      assert.equal(await w.purgeAll(), 1);
      assert.deepEqual(await w.stored(doc.documentId), {
        documents: 0,
        revisions: 0,
        publications: 0,
        chunks: 0,
        originals: 0,
        keep: 1,
      });
      await w.usageMatches();
    });

    await t.test('a Keep lease or a sync holding the source lease defers the purge', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline');
      await w.remove(doc);
      await w.expire(doc.documentId);
      const sourceId = await w.source(doc.documentId);

      await w.query(
        `INSERT INTO ${w.table('tf_keep_knowledge')} (document_id, lease_token, lease_until)
         VALUES ($1, gen_random_uuid(), now()+interval '1 minute')
         ON CONFLICT (document_id) DO UPDATE SET lease_token=EXCLUDED.lease_token, lease_until=EXCLUDED.lease_until`,
        [doc.documentId],
      );
      assert.equal(await w.purgeAll(), 0);
      await w.query(`DELETE FROM ${w.table('tf_keep_knowledge')} WHERE document_id=$1`, [doc.documentId]);

      await w.query(
        `INSERT INTO ${w.table('github_sources')} (source_id, binding, selection, title, fingerprint, cursor, lease_token, lease_until)
         VALUES ($1, '{}', '{}', 'Repositories', 'f', '{}', gen_random_uuid(), now()+interval '1 minute')`,
        [sourceId],
      );
      assert.equal(await w.purgeAll(), 0);
      assert.equal((await w.stored(doc.documentId)).documents, 1);

      await w.query(`UPDATE ${w.table('github_sources')} SET lease_token=NULL, lease_until=NULL WHERE source_id=$1`, [
        sourceId,
      ]);
      assert.equal(await w.purgeAll(), 1);
      assert.equal((await w.stored(doc.documentId)).documents, 0);
    });

    await t.test('a document another transaction has locked, as a revival does, is skipped', async () => {
      const w = await setup();
      const doc = await w.note('supplier payment deadline');
      await w.remove(doc);
      await w.expire(doc.documentId);
      // A second session that locks the row and revives it, as a sync's revival does.
      const reviver = db.databaseAdmin;
      await reviver.query('BEGIN');
      await reviver.query(`SELECT 1 FROM ${w.table('documents')} WHERE id=$1 FOR UPDATE`, [doc.documentId]);
      assert.equal(await w.purgeAll(), 0);
      await reviver.query(`UPDATE ${w.table('documents')} SET tombstoned_at=NULL, retain_until=NULL WHERE id=$1`, [
        doc.documentId,
      ]);
      await reviver.query('COMMIT');
      assert.equal(await w.purgeAll(), 0);
      assert.equal(await w.retention.pending(w.ws.id), false);
      assert.equal((await w.stored(doc.documentId)).documents, 1, 'the revived document stays');
    });

    await t.test(
      'a removed source is deleted with its provider rows once retention passed and it is empty',
      async () => {
        const w = await setup();
        const [{ id: owner }] = await w.query(`SELECT id FROM ${w.table('tf_memberships')} WHERE user_id=$1`, [
          w.ws.userId,
        ]);
        const addSource = async (selection, retainUntil) => {
          const id = randomUUID();
          await w.query(
            `INSERT INTO ${w.table('sources')} (id, provider, account_namespace, selection, owner_membership_id, state, removed_at, retain_until)
           VALUES ($1, 'github', 'acct', $2, $3, 'removed', $4::timestamptz - interval '30 days', $4::timestamptz)`,
            [id, selection, owner, retainUntil],
          );
          await w.query(
            `INSERT INTO ${w.table('github_sources')} (source_id, binding, selection, title, fingerprint, cursor)
           VALUES ($1, '{}', '{}', 'Repositories', 'f', '{}')`,
            [id],
          );
          await w.query(`INSERT INTO ${w.table('github_members')} (source_id, membership_id) VALUES ($1, $2)`, [
            id,
            owner,
          ]);
          return id;
        };
        const expired = await addSource('expired', new Date(Date.now() - 86_400_000));
        const retained = await addSource('retained', new Date(Date.now() + 86_400_000));
        assert.equal(await w.retention.pending(w.ws.id), true);
        assert.equal(await w.purgeAll(), 1);
        const left = async id =>
          (await w.query(`SELECT count(*)::int AS n FROM ${w.table('sources')} WHERE id=$1`, [id]))[0].n;
        assert.equal(await left(expired), 0);
        assert.equal(await left(retained), 1);
        assert.equal(await w.retention.pending(w.ws.id), false);
      },
    );
  } finally {
    await runtime.close?.();
    await db.close();
  }
});
