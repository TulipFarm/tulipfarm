import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createFiles } from '@tulipfarm/files';
import { AccessDenied } from '@tulipfarm/access';
import { createLearnedKnowledge, createLocalKnowledge } from '../dist/index.js';
import { keepBackedSearch } from './fake-keep.mjs';

test('learned entries stay with the member who stated them and update in place', async t => {
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
    const member = async () => {
      const value = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        value.membershipId,
        value.userId,
      ]);
      return value;
    };
    const owner = await member();
    const other = await member();
    const unavailable = async () => {
      throw new Error('no file bytes');
    };
    const files = createFiles(runtime, { read: unavailable, putIfAbsent: unavailable, remove: unavailable });
    const api = createLocalKnowledge({ runtime, files });
    const indexed = keepBackedSearch({ runtime });
    const learned = createLearnedKnowledge({ runtime, files, enabled: async () => true });
    const chat = { kind: 'chat', id: randomUUID(), runId: null };
    const task = { kind: 'task', id: randomUUID(), runId: randomUUID() };
    const pricing = {
      title: 'Pro plan pricing',
      text: 'The Pro plan costs 49 dollars per seat a month.',
      documentId: null,
    };
    const index = async () => {
      for (const work of await api.due(one.id)) {
        await api.acknowledge(work);
        await api.process(work);
      }
    };

    let entry;
    await t.test('a learned fact is a note only its member can list, read or search', async () => {
      assert.equal(await learned.apply(one.id, owner.userId, chat, 'chat:a:0', [pricing]), 1);
      const [listed] = (await api.list(one.id, owner.userId, { filter: 'learned' })).items;
      assert.equal(listed.title, 'Pro plan pricing');
      assert.equal(listed.kind, 'note');
      assert.deepEqual(
        { ...listed.learned, learnedAt: undefined },
        {
          from: 'chat',
          sourceId: chat.id,
          runId: null,
          learnedAt: undefined,
        },
      );
      assert.ok(Date.parse(listed.learned.learnedAt));
      entry = listed;
      await index();
      const hits = (await indexed.query(one.id, owner.userId, 'Pro plan seat')).hits;
      assert.equal(hits[0]?.title, 'Pro plan pricing');

      assert.deepEqual((await api.list(one.id, other.userId, {})).items, []);
      assert.deepEqual((await api.list(one.id, other.userId, { filter: 'learned' })).items, []);
      assert.deepEqual((await indexed.query(one.id, other.userId, 'Pro plan seat')).hits, []);
      await assert.rejects(api.get(one.id, other.userId, entry.documentId));
      assert.deepEqual(await learned.entries(one.id, other.userId), []);
      await assert.rejects(api.evidence(one.id, other.userId, hits[0].citation));
    });

    await t.test('applying the same answer again changes nothing', async () => {
      assert.equal(await learned.apply(one.id, owner.userId, chat, 'chat:a:0', [pricing]), 0);
      assert.equal((await learned.entries(one.id, owner.userId)).length, 1);
    });

    await t.test('a newer fact updates the entry with the same subject instead of adding one', async () => {
      const newer = { ...pricing, title: 'pro plan  pricing', text: 'The Pro plan costs 59 dollars per seat a month.' };
      assert.equal(await learned.apply(one.id, owner.userId, task, 'task:b:0', [newer]), 1);
      const items = await learned.entries(one.id, owner.userId);
      assert.equal(items.length, 1);
      assert.equal(items[0].documentId, entry.documentId);
      assert.equal(items[0].text, newer.text);
      const current = await api.get(one.id, owner.userId, entry.documentId);
      assert.deepEqual(
        { from: current.learned.from, sourceId: current.learned.sourceId, runId: current.learned.runId },
        { from: 'task', sourceId: task.id, runId: task.runId },
      );

      const renamed = { title: 'Pro plan price', text: 'Pro costs 59 dollars per seat.', documentId: entry.documentId };
      assert.equal(await learned.apply(one.id, owner.userId, chat, 'chat:c:0', [renamed]), 1);
      const after = await learned.entries(one.id, owner.userId);
      assert.deepEqual(
        after.map(item => [item.documentId, item.title]),
        [[entry.documentId, 'Pro plan price']],
      );
    });

    await t.test('learning never changes another member’s entry or a note the member wrote', async () => {
      const theirs = { title: 'Pro plan price', text: 'Pro is free.', documentId: entry.documentId };
      assert.equal(await learned.apply(one.id, other.userId, chat, 'chat:d:0', [theirs]), 1);
      const mine = await learned.entries(one.id, owner.userId);
      assert.equal(mine[0].text, 'Pro costs 59 dollars per seat.');
      const otherEntries = await learned.entries(one.id, other.userId);
      assert.equal(otherEntries.length, 1);
      assert.notEqual(otherEntries[0].documentId, entry.documentId);

      const note = await api.save(one.id, owner.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Refund policy',
        input: { kind: 'note', text: 'Refunds within 30 days.' },
      });
      await assert.rejects(
        api.learn(
          one.id,
          owner.userId,
          {
            commandId: randomUUID(),
            documentId: note.documentId,
            expectedRevisionId: note.revisionId,
            title: 'Refund policy',
            text: 'Refunds within 14 days.',
          },
          chat,
        ),
        error => error instanceof AccessDenied,
      );
      assert.equal((await api.get(one.id, owner.userId, note.documentId)).learned, undefined);
      assert.deepEqual(
        (await api.list(one.id, owner.userId, { filter: 'learned' })).items.map(item => item.documentId),
        [entry.documentId],
      );
    });

    await t.test('members can edit and remove learned entries', async () => {
      const current = await api.get(one.id, owner.userId, entry.documentId);
      const edited = await api.save(one.id, owner.userId, {
        commandId: randomUUID(),
        documentId: entry.documentId,
        expectedRevisionId: current.revisionId,
        title: 'Pro plan price',
        input: { kind: 'note', text: 'Pro costs 59 dollars per seat, billed yearly.' },
      });
      assert.equal(edited.learned.from, 'chat');
      assert.equal(
        (await learned.entries(one.id, owner.userId))[0].text,
        'Pro costs 59 dollars per seat, billed yearly.',
      );
      const removal = { commandId: randomUUID(), documentId: entry.documentId, expectedRevisionId: edited.revisionId };
      assert.equal((await api.remove(one.id, owner.userId, removal)).removed, true);
      assert.deepEqual(await learned.entries(one.id, owner.userId), []);
      assert.deepEqual((await api.list(one.id, owner.userId, { filter: 'learned' })).items, []);
    });
  } finally {
    await runtime?.close();
    await db.close();
  }
});
