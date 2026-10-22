import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture, connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createPersonalMemoryService, readPersonalMemory, PersonalMemoryConflict } from '../../src/personal-memory.ts';

test(
  'membership-owned memory has strict revisions, content-free deletion and restricted capabilities',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
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
      const empty = { content: '', revision: 0 };
      assert.deepEqual(await service.read(w.id, memberUser), empty);
      await assert.rejects(
        service.save(w.id, memberUser, { content: 'not yet created', expectedRevision: 1 }),
        PersonalMemoryConflict,
      );
      const races = await Promise.allSettled([
        service.save(w.id, memberUser, { content: 'first', expectedRevision: 0 }),
        service.save(w.id, memberUser, { content: 'second', expectedRevision: 0 }),
      ]);
      assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(races.find(result => result.status === 'rejected').reason instanceof PersonalMemoryConflict);
      const saved = await service.read(w.id, memberUser);
      assert.equal(saved.revision, 1);
      assert.deepEqual(await service.read(w.id, w.userId), empty, 'workspace admin cannot read a member document');
      await assert.rejects(service.read(w.id, 'outsider'), AccessDenied);
      await assert.rejects(service.read(other.id, memberUser), AccessDenied);
      await assert.rejects(
        runtime.transaction(w.id, commonCompatibility, tx => readPersonalMemory(tx, { ...actor, userId: w.userId })),
        AccessDenied,
      );
      assert.deepEqual(
        await runtime.transaction(w.id, commonCompatibility, tx => readPersonalMemory(tx, actor)),
        saved,
      );
      const content = '# Preferences\n\n' + '🌷'.repeat(9985);
      assert.equal(Array.from(content).length, 10000);
      assert.deepEqual(await service.save(w.id, memberUser, { content, expectedRevision: 1 }), {
        content,
        revision: 2,
      });
      await assert.rejects(
        service.save(w.id, memberUser, { content: 'stale', expectedRevision: 1 }),
        PersonalMemoryConflict,
      );
      await assert.rejects(service.delete(w.id, memberUser, { expectedRevision: 1 }), PersonalMemoryConflict);
      assert.deepEqual(await service.delete(w.id, memberUser, { expectedRevision: 2 }), { content: '', revision: 3 });
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT content,revision FROM ${table('tf_personal_memory')} WHERE membership_id=$1`,
            [memberId],
          )
        ).rows,
        [{ content: '', revision: 3 }],
      );
      await assert.rejects(
        service.save(w.id, memberUser, { content: 'resurrect', expectedRevision: 2 }),
        PersonalMemoryConflict,
      );
      await assert.rejects(
        service.save(w.id, memberUser, { content: 'resurrect', expectedRevision: 0 }),
        PersonalMemoryConflict,
      );
      assert.deepEqual(await service.save(w.id, memberUser, { content: ' \n\t', expectedRevision: 3 }), {
        content: '',
        revision: 4,
      });
      assert.deepEqual(await service.save(w.id, memberUser, { content: 'replacement', expectedRevision: 4 }), {
        content: 'replacement',
        revision: 5,
      });
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_personal_memory')}`)).rows[0].count,
        1,
        'there is no content history',
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_audit_events')}`)).rows[0].count,
        0,
        'memory contents are never audited',
      );

      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [memberId]);
      await assert.rejects(service.read(w.id, memberUser), AccessDenied);
      await assert.rejects(service.save(w.id, memberUser, { content: 'removed', expectedRevision: 5 }), AccessDenied);
      await assert.rejects(service.delete(w.id, memberUser, { expectedRevision: 5 }), AccessDenied);
      const rejoined = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        rejoined,
        memberUser,
      ]);
      assert.deepEqual(await service.read(w.id, memberUser), empty);
      await assert.rejects(
        runtime.transaction(w.id, commonCompatibility, tx => readPersonalMemory(tx, actor)),
        AccessDenied,
      );
      assert.deepEqual(await service.save(w.id, memberUser, { content: 'new membership', expectedRevision: 0 }), {
        content: 'new membership',
        revision: 1,
      });

      for (const capability of ['migration', 'confirmation']) {
        const client = await connect(db.login(w, capability));
        try {
          await denied(client, `SELECT * FROM ${table('tf_personal_memory')}`);
          await denied(client, `UPDATE ${table('tf_personal_memory')} SET content='forged'`);
          if (capability === 'migration') {
            await client.query(`SET ROLE "${w.names.customOwner}"`);
            await denied(client, `SELECT * FROM ${table('tf_personal_memory')}`);
            await denied(client, `UPDATE ${table('tf_personal_memory')} SET content='forged'`);
          }
        } finally {
          await client.end();
        }
      }
      const client = await connect(db.login(w));
      try {
        await assert.rejects(
          client.query(`UPDATE ${table('tf_personal_memory')} SET content=$1 WHERE membership_id=$2`, [
            'x'.repeat(10001),
            rejoined,
          ]),
          error => error.code === '23514',
        );
        await denied(client, `DELETE FROM ${table('tf_personal_memory')}`);
        await denied(client, `SELECT * FROM ${qualified(other.names.schema, 'tf_personal_memory')}`);
        await denied(client, `ALTER TABLE ${table('tf_personal_memory')} DROP CONSTRAINT tf_personal_memory_pkey`);
      } finally {
        await client.end();
      }
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
