import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../workspace-storage/test/integration/fixture.mjs';
import {
  configureKeepPersonalMemory,
  createPersonalMemoryService,
  MemoryEditsInvalid,
  MemoryFileNotFound,
  readPersonalMemory,
  PersonalMemoryConflict,
  PersonalMemoryUnavailable,
} from '../../src/personal-memory.ts';
import { fakeKeep } from '../fake-keep.mjs';

test(
  'membership-owned memory in Keep has strict revisions and is private to the current membership',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    const keep = fakeKeep();
    t.after(configureKeepPersonalMemory({ client: keep.client }));
    const w = await db.create();
    const other = await db.create();
    const table = name => qualified(w.names.schema, name);
    const memberId = randomUUID(),
      memberUser = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      memberId,
      memberUser,
    ]);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      connectionsPerPool: 3,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => ({
        workspaceId: id,
        generation: 1,
        connectionString: db.login(id === w.id ? w : other),
      }),
    });
    const service = createPersonalMemoryService(runtime);
    const actor = { kind: 'human', userId: memberUser, membershipId: memberId };
    const empty = { content: '', revision: 0, history: { trashed: false, undo: false } };
    assert.deepEqual(await service.read(w.id, memberUser), empty);
    await assert.rejects(
      service.save(w.id, memberUser, { content: 'not yet created', expectedRevision: 1 }),
      PersonalMemoryConflict,
    );
    const first = await service.save(w.id, memberUser, { content: 'first', expectedRevision: 0 });
    await assert.rejects(
      service.save(w.id, memberUser, { content: 'second', expectedRevision: 0 }),
      PersonalMemoryConflict,
    );
    assert.equal((await service.read(w.id, memberUser)).content, 'first');
    assert.deepEqual(await service.read(w.id, w.userId), empty, 'workspace admin cannot read a member document');
    await assert.rejects(service.read(w.id, 'outsider'), AccessDenied);
    await assert.rejects(service.read(other.id, memberUser), AccessDenied);
    await assert.rejects(
      runtime.transaction(w.id, commonCompatibility, tx => readPersonalMemory(tx, { ...actor, userId: w.userId })),
      AccessDenied,
    );
    assert.deepEqual(await runtime.transaction(w.id, commonCompatibility, tx => readPersonalMemory(tx, actor)), {
      content: 'first',
      revision: first.revision,
    });
    const content = '# Preferences\n\n' + '🌷'.repeat(2040);
    assert.equal(new TextEncoder().encode(content).length, 8175, "a file up to Keep's 8 KiB limit");
    const second = await service.save(w.id, memberUser, { content, expectedRevision: first.revision });
    assert.equal(second.content, content);
    await assert.rejects(
      service.save(w.id, memberUser, { content: 'stale', expectedRevision: first.revision }),
      PersonalMemoryConflict,
    );
    await assert.rejects(
      service.delete(w.id, memberUser, { expectedRevision: first.revision }),
      PersonalMemoryConflict,
    );
    const deleted = await service.delete(w.id, memberUser, { expectedRevision: second.revision });
    assert.equal(deleted.content, '');
    await assert.rejects(
      service.save(w.id, memberUser, { content: 'resurrect', expectedRevision: second.revision }),
      PersonalMemoryConflict,
    );
    assert.equal(
      (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_audit_events')}`)).rows[0].count,
      0,
      'memory contents are never audited',
    );

    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [memberId]);
    await assert.rejects(service.read(w.id, memberUser), AccessDenied);
    await assert.rejects(
      service.save(w.id, memberUser, { content: 'removed', expectedRevision: deleted.revision }),
      AccessDenied,
    );
    await assert.rejects(service.delete(w.id, memberUser, { expectedRevision: deleted.revision }), AccessDenied);
    const rejoined = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      rejoined,
      memberUser,
    ]);
    assert.deepEqual(await service.read(w.id, memberUser), empty, 'a new membership starts with empty memory');
    await assert.rejects(
      runtime.transaction(w.id, commonCompatibility, tx => readPersonalMemory(tx, actor)),
      AccessDenied,
    );
    assert.equal(
      (await service.save(w.id, memberUser, { content: 'new membership', expectedRevision: 0 })).content,
      'new membership',
    );
  },
);

test(
  'the old in-workspace memory tables are gone and memory without Keep is unavailable',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    const w = await db.create();
    for (const name of ['tf_personal_memory', 'tf_keep_memory'])
      assert.equal(
        (await db.platform.query('SELECT to_regclass($1) AS found', [qualified(w.names.schema, name)])).rows[0].found,
        null,
      );
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    t.after(configureKeepPersonalMemory({ client: undefined }));
    const service = createPersonalMemoryService(runtime);
    await assert.rejects(
      service.read(w.id, w.userId),
      error => error instanceof PersonalMemoryUnavailable && error.reason === 'not-configured',
    );
    await assert.rejects(
      service.save(w.id, w.userId, { content: 'x', expectedRevision: 0 }),
      PersonalMemoryUnavailable,
    );
  },
);

test(
  'memory files are listed, written and deleted per member, and an instruction applies its edits at once',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    const keep = fakeKeep();
    t.after(configureKeepPersonalMemory({ client: keep.client }));
    const w = await db.create();
    const table = name => qualified(w.names.schema, name);
    const memberId = randomUUID(),
      memberUser = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      memberId,
      memberUser,
    ]);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const requests = [];
    let reply = '';
    const service = createPersonalMemoryService(runtime, {
      instruct: async (_workspaceId, _userId, request) => {
        requests.push(request);
        return { text: reply };
      },
    });
    const paths = async user => (await service.files(w.id, user)).files.map(file => [file.path, file.revisionId]);
    assert.deepEqual(await paths(memberUser), [
      ['/profile.md', null],
      ['/you/about.md', null],
    ]);

    await service.save(w.id, memberUser, { content: '- Reply in French.', expectedRevision: 0 });
    const [preferences] = (await service.files(w.id, memberUser)).files;
    assert.equal(preferences.name, 'Preferences', 'earlier memory shows as Preferences');
    assert.equal(preferences.content, '- Reply in French.', 'the list carries each file’s text');
    assert.equal(preferences.description, 'How you want Bud to respond');
    assert.ok(preferences.updatedAt);

    const career = await service.saveFile(w.id, memberUser, {
      path: '/topics/career.md',
      content: '- Wants a COO role.',
      expectedRevisionId: null,
      name: 'Career',
      description: 'Goals and growth plans',
    });
    assert.deepEqual(
      [career.name, career.description, career.group, career.content],
      ['Career', 'Goals and growth plans', 'topics', '- Wants a COO role.'],
    );
    await assert.rejects(
      service.saveFile(w.id, memberUser, { path: '/topics/career.md', content: 'again', expectedRevisionId: null }),
      PersonalMemoryConflict,
      'creating needs a free path',
    );
    await assert.rejects(
      service.saveFile(w.id, memberUser, { path: '/notes/x.md', content: 'x', expectedRevisionId: null }),
      'only memory paths',
    );
    assert.equal(
      (await service.readFile(w.id, memberUser, { path: '/topics/career.md' })).content,
      '- Wants a COO role.',
    );
    assert.deepEqual(
      await paths(w.userId),
      [
        ['/profile.md', null],
        ['/you/about.md', null],
      ],
      'another member never sees these files',
    );
    await assert.rejects(service.readFile(w.id, w.userId, { path: '/topics/career.md' }), MemoryFileNotFound);

    reply = JSON.stringify({
      edits: [
        { path: '/you/about.md', kind: 'add', before: null, after: '- Works in the Berlin office.' },
        { path: '/topics/career.md', kind: 'delete', before: null, after: null },
        { path: '/notes/elsewhere.md', kind: 'add', before: null, after: 'ignored' },
      ],
    });
    const result = await service.instruct(w.id, memberUser, {
      requestId: randomUUID(),
      instruction: 'I moved to the Berlin office. Forget my career plans.',
    });
    assert.deepEqual(result.changed, [
      { path: '/you/about.md', name: 'Profile', operation: 'created' },
      { path: '/topics/career.md', name: 'Career', operation: 'deleted' },
    ]);
    assert.deepEqual(
      result.files.map(file => file.path),
      ['/profile.md', '/you/about.md'],
    );
    const sent = JSON.parse(requests[0].content);
    assert.equal(sent.instruction, 'I moved to the Berlin office. Forget my career plans.');
    assert.ok(sent.currentMemory.files.some(file => file.path === '/topics/career.md' && file.text));
    assert.match(requests[0].system, /untrusted data/);

    reply = 'not json';
    await assert.rejects(
      service.instruct(w.id, memberUser, { requestId: randomUUID(), instruction: 'Remember this.' }),
      MemoryEditsInvalid,
    );
    const profile = (await service.files(w.id, memberUser)).files[1];
    await assert.rejects(
      service.deleteFile(w.id, memberUser, { path: '/you/about.md', expectedRevisionId: 'stale' }),
      PersonalMemoryConflict,
    );
    const left = await service.deleteFile(w.id, memberUser, {
      path: '/you/about.md',
      expectedRevisionId: profile.revisionId,
    });
    assert.deepEqual(
      left.files.map(file => [file.path, file.revisionId === null, file.content]),
      [
        ['/profile.md', false, '- Reply in French.'],
        ['/you/about.md', true, ''],
      ],
      'a cleared You file stays listed',
    );
    await assert.rejects(
      createPersonalMemoryService(runtime).instruct(w.id, memberUser, {
        requestId: randomUUID(),
        instruction: 'Remember this.',
      }),
      error => error instanceof PersonalMemoryUnavailable && error.reason === 'not-configured',
    );
  },
);
