import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../workspace-storage/test/integration/fixture.mjs';
import {
  configureKeepPersonalMemory,
  createPersonalMemoryService,
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
    const content = '# Preferences\n\n' + '🌷'.repeat(9985);
    assert.equal(Array.from(content).length, 10000);
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
