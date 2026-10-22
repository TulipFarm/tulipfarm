import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture.mjs';

test('integration events follow effective grants, not names, token rotations or identical writes', async () => {
  const f = await fixture();
  try {
    const { service: s, workspaceId: w, creator: actor, input } = f;
    const events = async () =>
      (
        await f.owner.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [input.id],
        )
      ).rows;
    await s.create(w, actor, input);
    assert.deepEqual(await events(), [{ membership_ids: [actor.membershipId], invalidate: false }]);
    await s.create(w, actor, input);
    await s.update(w, actor, input.id, { name: 'A new label', enabled: true });
    await s.rotate(w, actor, input.id, { expectedGeneration: 1, token: 'replacement-token' });
    assert.equal((await events()).length, 1);
    const grants = {
      expectedGrantsVersion: 1,
      grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
      sourceGrants: [{ teamId: f.teamId, sourceId: input.repositories[0].id }],
    };
    await s.setGrants(w, actor, input.id, grants);
    assert.deepEqual((await events()).at(-1).membership_ids, [actor.membershipId, f.member.membershipId].sort());
    const count = (await events()).length;
    await s.setGrants(w, actor, input.id, { ...grants, expectedGrantsVersion: 2 });
    assert.equal((await events()).length, count);
    await f.owner.query(
      `INSERT INTO ${f.table('tf_recommendation_snapshots')} (membership_id,fingerprint,items) VALUES ($1,$2,'[]')`,
      [f.member.membershipId, '0'.repeat(64)],
    );
    await s.setGrants(w, actor, input.id, { expectedGrantsVersion: 3, grants: [], sourceGrants: [] });
    assert.equal((await events()).at(-1).invalidate, true);
    assert.ok((await events()).at(-1).membership_ids.includes(f.member.membershipId));
    assert.equal(
      (
        await f.owner.query(`SELECT 1 FROM ${f.table('tf_recommendation_snapshots')} WHERE membership_id=$1`, [
          f.member.membershipId,
        ])
      ).rowCount,
      0,
    );
    await s.update(w, actor, input.id, { enabled: false });
    const disabled = (await events()).length;
    await s.update(w, actor, input.id, { enabled: false });
    assert.equal((await events()).length, disabled);
  } finally {
    await f.close();
  }
});

test('integration creation-grant events expand only recipient teams and skip identical grants', async () => {
  const f = await fixture();
  try {
    const input = { owningTeamId: f.teamId, teamIds: [f.teamId] };
    const events = async () =>
      (
        await f.owner.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [`creation:${f.teamId}`],
        )
      ).rows;
    await f.service.setCreationGrants(f.workspaceId, f.creator, input);
    assert.deepEqual(await events(), [
      { membership_ids: [f.creator.membershipId, f.member.membershipId].sort(), invalidate: false },
    ]);
    await f.service.setCreationGrants(f.workspaceId, f.creator, input);
    assert.equal((await events()).length, 1);
    await f.service.setCreationGrants(f.workspaceId, f.creator, { ...input, teamIds: [] });
    assert.equal((await events()).at(-1).invalidate, true);
    assert.deepEqual((await events()).at(-1).membership_ids, [f.creator.membershipId, f.member.membershipId].sort());
  } finally {
    await f.close();
  }
});
