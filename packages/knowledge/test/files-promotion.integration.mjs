import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createFiles } from '@tulipfarm/files';
import { AccessDenied } from '@tulipfarm/access';
import { createLocalKnowledge } from '../dist/index.js';

test(
  'Knowledge added from a shared file stops answering once the source is revoked or deleted forever',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const one = await db.create(await workspaceTableMigrations());
      const table = name => qualified(one.names.schema, name);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        maxPools: 2,
        connectionsPerPool: 4,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => {
          const workspace = db.workspaces.find(item => item.id === id);
          assert.ok(workspace);
          return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
        },
      });
      const owner = { userId: randomUUID(), membershipId: randomUUID() },
        reader = { userId: randomUUID(), membershipId: randomUUID() };
      for (const person of [owner, reader])
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          person.membershipId,
          person.userId,
        ]);
      const objects = new Map();
      const files = createFiles(runtime, {
        putIfAbsent: async (key, bytes) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
        },
        read: async key => Buffer.from(objects.get(key)),
        remove: async key => {
          objects.delete(key);
        },
      });
      const knowledge = createLocalKnowledge({ runtime, files });
      const fileId = randomUUID();
      await files.upload(
        one.id,
        owner.userId,
        fileId,
        { name: 'Returns.md', parentId: null, mediaType: 'text/markdown' },
        Buffer.from('# Returns\nReturn orders within thirty days.'),
      );
      const add = {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Returns.md',
        input: { kind: 'file', fileId },
      };
      const events = async () =>
        (
          await db.platform.query(
            `SELECT membership_ids FROM ${table('tf_recommendation_events')} WHERE kind='knowledge' AND source_id=$1`,
            [add.documentId],
          )
        ).rows;

      await assert.rejects(
        knowledge.save(one.id, reader.userId, add),
        AccessDenied,
        'adding to Knowledge requires read access',
      );
      await files.share(one.id, owner.userId, fileId, { kind: 'individual', id: reader.membershipId }, 'viewer');
      assert.equal((await knowledge.save(one.id, reader.userId, add)).parsing, 'queued');
      assert.deepEqual(await events(), [], 'pending parsing is not usable publication');
      const work = (await knowledge.due(one.id)).find(item => item.revisionId === add.commandId);
      await knowledge.acknowledge(work);
      assert.equal((await knowledge.process(work)).disposition, 'ready');
      assert.deepEqual(await events(), [{ membership_ids: [reader.membershipId] }]);
      assert.equal((await knowledge.process(work)).disposition, 'ready');
      assert.equal((await events()).length, 1, 'a repeated parse receipt is not a new publication');
      const search = async () =>
        (await knowledge.search(one.id, reader.userId, { query: 'thirty days' })).hits.map(
          hit => hit.citation.documentId,
        );
      assert.deepEqual(await search(), [add.documentId]);

      await files.share(one.id, owner.userId, fileId, { kind: 'individual', id: reader.membershipId }, null);
      assert.deepEqual(await search(), [], 'revocation removes the entry from retrieval');
      await assert.rejects(knowledge.get(one.id, reader.userId, add.documentId), AccessDenied);
      assert.deepEqual((await knowledge.list(one.id, reader.userId)).items, []);

      await files.share(one.id, owner.userId, fileId, { kind: 'individual', id: reader.membershipId }, 'viewer');
      assert.deepEqual(await search(), [add.documentId], 'restored access restores retrieval');
      await files.trash(one.id, owner.userId, fileId, true);
      assert.equal((await files.deleteForever(one.id, owner.userId, fileId)).state, 'deleted');
      assert.deepEqual(await search(), [], 'a deleted-forever source is excluded');
      await assert.rejects(knowledge.get(one.id, reader.userId, add.documentId), AccessDenied);
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
