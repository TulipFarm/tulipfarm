import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { createProjectMembership } from '../../src/project-membership.ts';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';

const version = (await workspaceTableMigrations()).length;
const compatibility = { minimum: version, maximum: version };

test('project roles grant no admin access, require a manager handoff, and follow current membership', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      projects = createProjectMembership(f.runtime, compatibility);
    const creator = { id: randomUUID(), user: randomUUID() },
      reader = { id: randomUUID(), user: randomUUID() };
    for (const person of [creator, reader])
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        person.id,
        person.user,
      ]);
    const admin = (
      await f.db.platform.query(
        `SELECT id FROM ${f.table('tf_memberships')} WHERE user_id=$1 AND role='admin' AND removed_at IS NULL`,
        [w.userId],
      )
    ).rows[0].id;
    const id = randomUUID();
    assert.deepEqual(await projects.create(w.id, creator.user, { id, name: 'Marketing' }), {
      id,
      name: 'Marketing',
      instructions: '',
      revision: 0,
      archived: false,
      manager: true,
    });
    assert.deepEqual((await projects.read(w.id, creator.user, id)).members, [
      { membershipId: creator.id, userId: creator.user, role: 'manager' },
    ]);
    // An unrelated workspace admin cannot list, read, edit, or add themselves.
    assert.deepEqual(await projects.list(w.id, w.userId), []);
    await assert.rejects(projects.read(w.id, w.userId, id), /Resource not found/);
    await assert.rejects(
      projects.edit(w.id, w.userId, id, { expectedRevision: 0, name: 'Taken', instructions: '', archived: false }),
      /Resource not found/,
    );
    await assert.rejects(
      projects.member(w.id, w.userId, id, { membershipId: admin, role: 'manager', removed: false }),
      /Resource not found/,
    );
    await assert.rejects(projects.read(w.id, reader.user, id), /Resource not found/);
    await projects.member(w.id, creator.user, id, { membershipId: reader.id, role: 'member', removed: false });
    assert.equal((await projects.read(w.id, reader.user, id)).project.manager, false);
    await assert.rejects(
      projects.edit(w.id, reader.user, id, { expectedRevision: 0, name: 'Stolen', instructions: '', archived: false }),
      /Resource not found/,
    );
    // A member who leaves cannot promote themselves on the way out.
    await projects.member(w.id, reader.user, id, { membershipId: reader.id, role: 'manager', removed: true });
    await assert.rejects(projects.read(w.id, reader.user, id), /Resource not found/);
    await projects.member(w.id, creator.user, id, { membershipId: reader.id, role: 'member', removed: false });
    assert.equal((await projects.read(w.id, reader.user, id)).project.manager, false);
    // The last manager cannot leave or step down before handing off.
    await assert.rejects(
      projects.member(w.id, creator.user, id, { membershipId: creator.id, role: 'manager', removed: true }),
      /project-manager-required/,
    );
    await assert.rejects(
      projects.member(w.id, creator.user, id, { membershipId: creator.id, role: 'member', removed: false }),
      /project-manager-required/,
    );
    await projects.member(w.id, creator.user, id, { membershipId: reader.id, role: 'manager', removed: false });
    await projects.member(w.id, creator.user, id, { membershipId: creator.id, role: 'manager', removed: true });
    await assert.rejects(projects.read(w.id, creator.user, id), /Resource not found/);
    assert.equal((await projects.read(w.id, reader.user, id)).project.manager, true);
    await assert.rejects(
      projects.member(w.id, reader.user, id, { membershipId: reader.id, role: 'manager', removed: true }),
      /project-manager-required/,
    );
    // An unexpected departure leaves the project managerless and locked; admins cannot take it over.
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [reader.id]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      randomUUID(),
      reader.user,
    ]);
    await assert.rejects(projects.read(w.id, reader.user, id), /Resource not found/);
    await assert.rejects(
      projects.member(w.id, w.userId, id, { membershipId: admin, role: 'manager', removed: false }),
      /Resource not found/,
    );
    assert.deepEqual(await projects.list(w.id, w.userId), []);
  } finally {
    await f.close();
  }
});

test('project edits compare revisions, replay once, archive and restore without erasing instructions', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      projects = createProjectMembership(f.runtime, compatibility),
      id = randomUUID();
    await projects.create(w.id, w.userId, { id, name: 'Launch' });
    const command = { expectedRevision: 0, name: 'Launch', instructions: 'Use metric units.', archived: true };
    const result = await projects.edit(w.id, w.userId, id, command);
    assert.deepEqual(result, {
      id,
      name: 'Launch',
      instructions: 'Use metric units.',
      revision: 1,
      archived: true,
      manager: true,
    });
    assert.deepEqual(await projects.edit(w.id, w.userId, id, command), result);
    await assert.rejects(
      projects.edit(w.id, w.userId, id, { ...command, instructions: 'Stale overwrite' }),
      /project-conflict/,
    );
    assert.equal(
      (await projects.edit(w.id, w.userId, id, { ...command, expectedRevision: 1, archived: false })).instructions,
      'Use metric units.',
    );
    await assert.rejects(
      projects.edit(w.id, w.userId, id, { ...command, expectedRevision: 2, instructions: '🌿'.repeat(20000) }),
    );
    assert.equal((await projects.read(w.id, w.userId, id)).project.revision, 2);
  } finally {
    await f.close();
  }
});
