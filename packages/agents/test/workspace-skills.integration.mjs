import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';

test('workspace procedures stay private to managers, require exact review, follow explicit grants, and ignore admin status', async () => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    const w = await db.create(migrations),
      other = await db.create(migrations);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({
        workspaceId: id,
        generation: 1,
        connectionString: db.login(id === w.id ? w : other),
      }),
    });
    const table = name => qualified(w.names.schema, name);
    const author = randomUUID(),
      reader = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'author','member'),($2,'reader','member')`,
      [author, reader],
    );
    const skills = createWorkspaceSkills(runtime),
      id = randomUUID();
    const initial = {
      requestId: randomUUID(),
      expectedVersion: 0,
      definition: {
        name: 'Cleanup',
        description: 'Review cleanup requests.',
        instructions: 'Ask before changing records.',
      },
    };
    const draft = await skills.save(w.id, 'author', id, initial);
    assert.deepEqual(
      { id: draft.id, version: draft.version, enabled: draft.enabled, activeRevision: draft.activeRevision },
      { id, version: 1, enabled: false, activeRevision: null },
    );
    assert.deepEqual(await skills.save(w.id, 'author', id.toUpperCase(), initial), draft);
    await assert.rejects(
      skills.save(w.id, 'author', id, { ...initial, definition: { ...initial.definition, name: 'Changed replay' } }),
      error => error.code === 'idempotency-conflict',
    );
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT membership_id,permission FROM ${table('tf_skill_person_grants')} WHERE skill_id=$1 ORDER BY permission`,
          [id],
        )
      ).rows,
      ['manage', 'read', 'use'].map(permission => ({ membership_id: author, permission })),
    );
    assert.deepEqual((await skills.read(w.id, 'author', id)).definition, initial.definition);
    for (const user of ['reader', w.userId]) {
      await assert.rejects(skills.read(w.id, user, id), AccessDenied);
      assert.deepEqual((await skills.list(w.id, user)).workspace, []);
      assert.deepEqual((await skills.list(w.id, user, { search: 'Cleanup' })).workspace, []);
    }
    await assert.rejects(skills.read(other.id, other.userId, id), AccessDenied);
    const selection = [{ id, revision: draft.savedRevision }];
    await assert.rejects(skills.resolve(w.id, 'author', selection), AccessDenied);
    await assert.rejects(
      skills.review(w.id, w.userId, id, { requestId: randomUUID(), expectedVersion: 1, revision: draft.savedRevision }),
      AccessDenied,
    );
    await assert.rejects(
      skills.setEnabled(w.id, 'author', id, { requestId: randomUUID(), expectedVersion: 1, enabled: true }),
      error => error.code === 'review-required',
    );
    await assert.rejects(
      skills.review(w.id, 'author', id, { requestId: randomUUID(), expectedVersion: 1, revision: 'a'.repeat(64) }),
      error => error.code === 'version-conflict',
    );
    const approved = await skills.review(w.id, 'author', id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      revision: draft.savedRevision,
    });
    assert.equal(approved.version, 2);
    assert.deepEqual(await skills.resolve(w.id, 'author', selection), [
      { id, revision: draft.savedRevision, ...initial.definition },
    ]);
    await assert.rejects(skills.resolve(w.id, 'reader', selection), AccessDenied);
    assert.deepEqual((await skills.list(w.id, 'reader')).workspace, []);
    await assert.rejects(
      skills.share(w.id, w.userId, id, {
        version: 2,
        grants: [],
        personGrants: [{ membershipId: w.membershipId, permissions: ['manage'] }],
      }),
      AccessDenied,
    );
    await assert.rejects(
      skills.share(w.id, 'author', id, {
        version: 2,
        grants: [],
        personGrants: [{ membershipId: reader, permissions: ['read', 'use'] }],
      }),
      AccessDenied,
    );
    const managers = [{ membershipId: author, permissions: ['manage', 'read', 'use'] }];
    await skills.share(w.id, 'author', id, {
      version: 2,
      grants: [],
      personGrants: [...managers, { membershipId: reader, permissions: ['read', 'use'] }],
    });
    assert.deepEqual(await skills.resolve(w.id, 'reader', selection), [
      { id, revision: draft.savedRevision, ...initial.definition },
    ]);
    assert.deepEqual((await skills.list(w.id, 'reader')).workspace, [
      {
        id,
        revision: draft.savedRevision,
        name: 'Cleanup',
        description: 'Review cleanup requests.',
        source: 'Legacy skill',
        status: 'enabled',
      },
    ]);
    assert.deepEqual((await skills.list(w.id, w.userId)).workspace, []);
    assert.equal((await skills.read(w.id, 'reader', id)).management, null);
    assert.equal((await skills.read(w.id, 'reader', id)).reviewedDefinition, null);
    assert.equal((await skills.list(w.id, 'reader', { search: 'CLEAN' })).workspace[0].id, id);
    assert.deepEqual((await skills.list(w.id, 'reader', { search: '%' })).workspace, []);
    await assert.rejects(
      skills.save(w.id, 'reader', id, { ...initial, requestId: randomUUID(), expectedVersion: 3 }),
      AccessDenied,
    );
    await assert.rejects(skills.sharing(w.id, 'reader', id), AccessDenied);
    const candidates = await Promise.allSettled(
      ['Draft A', 'Draft B'].map(name =>
        skills.save(w.id, 'author', id, {
          ...initial,
          requestId: randomUUID(),
          expectedVersion: 3,
          definition: {
            name,
            description: 'A private draft awaiting review.',
            instructions: 'Unreviewed private draft.',
          },
        }),
      ),
    );
    assert.equal(candidates.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(candidates.find(result => result.status === 'rejected').reason.code, 'version-conflict');
    const edited = candidates.find(result => result.status === 'fulfilled').value;
    assert.equal(edited.version, 4);
    assert.deepEqual((await skills.read(w.id, 'reader', id)).definition, initial.definition);
    assert.deepEqual((await skills.read(w.id, 'author', id)).reviewedDefinition, initial.definition);
    assert.deepEqual((await skills.list(w.id, 'reader', { search: 'Draft' })).workspace, []);
    await assert.rejects(skills.resolve(w.id, 'author', [{ id, revision: edited.savedRevision }]), AccessDenied);
    const second = await skills.review(w.id, 'author', id, {
      requestId: randomUUID(),
      expectedVersion: 4,
      revision: edited.savedRevision,
    });
    assert.equal(second.version, 5);
    assert.deepEqual(await skills.resolve(w.id, 'reader', selection), [
      { id, revision: draft.savedRevision, ...initial.definition },
    ]);
    const disable = { requestId: randomUUID(), expectedVersion: 5, enabled: false };
    const disabled = await skills.setEnabled(w.id, 'author', id, disable);
    assert.equal(disabled.version, 6);
    await assert.rejects(skills.resolve(w.id, 'reader', selection), AccessDenied);
    await assert.rejects(skills.resolve(w.id, 'reader', [{ id, revision: edited.savedRevision }]), AccessDenied);
    await assert.rejects(skills.read(w.id, 'reader', id), AccessDenied);
    assert.deepEqual((await skills.list(w.id, 'reader')).workspace, []);
    await skills.setEnabled(w.id, 'author', id, { requestId: randomUUID(), expectedVersion: 6, enabled: true });
    assert.deepEqual(await skills.setEnabled(w.id, 'author', id, disable), disabled);
    assert.deepEqual(await createWorkspaceSkills(runtime).resolve(w.id, 'reader', selection), [
      { id, revision: draft.savedRevision, ...initial.definition },
    ]);
    await skills.share(w.id, 'author', id, { version: 7, grants: [], personGrants: managers });
    await assert.rejects(skills.resolve(w.id, 'reader', selection), AccessDenied);
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [author]);
    await assert.rejects(skills.save(w.id, 'author', id, initial), AccessDenied);
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'author','member')`, [
      randomUUID(),
    ]);
    await assert.rejects(
      skills.save(w.id, 'author', id, { ...initial, requestId: randomUUID(), expectedVersion: 8 }),
      AccessDenied,
    );
    await assert.rejects(skills.read(w.id, 'author', id), AccessDenied);
    await assert.rejects(skills.read(w.id, w.userId, id), AccessDenied);
    const client = await connect(db.login(w));
    try {
      await denied(client, `UPDATE ${table('tf_workspace_skill_revisions')} SET definition='{}'`);
      await denied(client, `DELETE FROM ${table('tf_workspace_skill_revisions')}`);
      await denied(client, `UPDATE ${table('tf_workspace_skill_reviews')} SET reviewer_id=$1`, [reader]);
      await denied(client, `UPDATE ${table('tf_skill_person_grants')} SET membership_id=$1`, [reader]);
      await denied(client, `SELECT * FROM ${qualified(other.names.schema, 'tf_workspace_skills')}`);
    } finally {
      await client.end();
    }
  } finally {
    await runtime?.close();
    await db.close();
  }
});
