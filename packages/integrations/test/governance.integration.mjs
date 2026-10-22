import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGovernanceService, GovernanceConflict } from '../../workspaces/dist/governance.js';
import { commonCompatibility } from '../../workspaces/dist/storage.js';
import { fixture } from './fixture.mjs';

const compatibility = { minimum: 1, maximum: commonCompatibility.maximum };

function governance(f) {
  return createGovernanceService({
    runtime: f.runtime,
    compatibility,
    identity: {
      query() {
        throw new Error('Team deletion must not query identity storage');
      },
    },
  });
}

test('governance blocks active integration ownership and permits deletion after tombstoning', async () => {
  const f = await fixture();
  try {
    const g = governance(f);
    const role = await f.runtime.transaction(
      f.workspaceId,
      compatibility,
      async transaction =>
        (
          await transaction.client.query(
            'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
          )
        ).rows[0],
    );
    assert.deepEqual(role, { role: new URL(f.url('runtime')).username, rolsuper: false, rolbypassrls: false });
    await f.service.create(f.workspaceId, f.creator, f.input);
    await f.service.setGrants(f.workspaceId, f.creator, f.input.id, {
      expectedGrantsVersion: 1,
      grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
      sourceGrants: [{ teamId: f.teamId, sourceId: f.input.repositories[0].id }],
    });
    const before = await f.service.get(f.workspaceId, f.creator, f.input.id);
    await assert.rejects(
      g.deleteTeam(f.workspaceId, f.creator.userId, f.teamId),
      error => error instanceof GovernanceConflict && error.code === 'team-owns-integrations',
    );
    assert.deepEqual(await f.service.get(f.workspaceId, f.creator, f.input.id), before);
    assert.equal((await f.service.readIssue(f.workspaceId, f.member, f.request())).title, 'Issue title');
    assert.deepEqual(
      (await f.owner.query(`SELECT id FROM ${f.table('tf_retired_teams')} WHERE id = $1`, [f.teamId])).rows,
      [],
    );

    assert.deepEqual(await f.service.remove(f.workspaceId, f.creator, f.input.id), { removed: true });
    assert.deepEqual(await g.deleteTeam(f.workspaceId, f.creator.userId, f.teamId), { ok: true });
    assert.deepEqual((await f.owner.query(`SELECT id FROM ${f.table('tf_teams')} WHERE id = $1`, [f.teamId])).rows, []);
    assert.deepEqual(
      (await f.owner.query(`SELECT id FROM ${f.table('tf_retired_teams')} WHERE id = $1`, [f.teamId])).rows,
      [{ id: f.teamId }],
    );
    assert.deepEqual(
      (
        await f.owner.query(
          `SELECT owning_team_id, live_owning_team_id, deleted_at IS NOT NULL AS deleted, credential, grants_version FROM ${f.table('tf_integrations')} WHERE id = $1`,
          [f.input.id],
        )
      ).rows,
      [{ owning_team_id: f.teamId, live_owning_team_id: null, deleted: true, credential: null, grants_version: 3 }],
    );
    await assert.rejects(
      g.createTeam(f.workspaceId, f.creator.userId, f.teamId, { name: 'Engineering' }),
      error => error instanceof GovernanceConflict && error.code === 'team-id-retired',
    );
  } finally {
    await f.close();
  }
});

for (const scope of ['integration', 'source', 'both']) {
  test(`governance revokes nonowning team ${scope} grants and invalidates stale replacements`, async () => {
    const f = await fixture();
    try {
      const g = governance(f);
      const { workspaceId: w, creator: a, service: s } = f;
      const input = { ...f.input, owningTeamId: f.otherTeamId };
      await s.create(w, a, input);
      const unaffected = { ...input, id: randomUUID(), repositories: [{ ...input.repositories[0], id: randomUUID() }] };
      await s.create(w, a, unaffected);
      const preservedGrants = [{ teamId: f.otherTeamId, permissions: ['read', 'use'] }];
      const preservedSources = [{ teamId: f.otherTeamId, sourceId: input.repositories[0].id }];
      const policy = {
        expectedGrantsVersion: 1,
        grants: [
          ...preservedGrants,
          ...(scope === 'source' ? [] : [{ teamId: f.teamId, permissions: ['read', 'use'] }]),
        ],
        sourceGrants: [
          ...preservedSources,
          ...(scope === 'integration' ? [] : [{ teamId: f.teamId, sourceId: input.repositories[0].id }]),
        ],
      };
      assert.equal((await s.setGrants(w, a, input.id, policy)).grantsVersion, 2);
      await s.setGrants(w, a, unaffected.id, {
        expectedGrantsVersion: 1,
        grants: preservedGrants,
        sourceGrants: [{ teamId: f.otherTeamId, sourceId: unaffected.repositories[0].id }],
      });
      const untouched = await s.get(w, a, unaffected.id);
      await s.setCreationGrants(w, a, { owningTeamId: f.otherTeamId, teamIds: [f.teamId, f.otherTeamId] });
      await s.setCreationGrants(w, a, { owningTeamId: f.teamId, teamIds: [f.otherTeamId] });
      assert.deepEqual(await s.creationContext(w, f.member), { teams: [{ id: f.teamId, name: 'Engineering' }] });
      if (scope === 'both') assert.equal((await s.readIssue(w, f.member, f.request())).title, 'Issue title');

      assert.deepEqual(await g.deleteTeam(w, a.userId, f.teamId), { ok: true });
      const after = await s.get(w, a, input.id);
      assert.equal(after.grantsVersion, 3);
      assert.deepEqual(after.grants, preservedGrants);
      assert.deepEqual(after.sourceGrants, preservedSources);
      assert.deepEqual(await s.get(w, a, unaffected.id), untouched);
      assert.deepEqual(await s.creationContext(w, f.member), { teams: [] });
      assert.deepEqual(await s.list(w, f.member), { integrations: [] });
      await assert.rejects(s.readIssue(w, f.member, f.request()), /not found/);
      assert.deepEqual(
        (await f.owner.query(`SELECT team_id, owning_team_id FROM ${f.table('tf_integration_creation_grants')}`)).rows,
        [{ team_id: f.otherTeamId, owning_team_id: f.otherTeamId }],
      );
      assert.deepEqual(
        (
          await f.owner.query(`SELECT team_id FROM ${f.table('tf_member_teams')} WHERE membership_id = $1`, [
            f.member.membershipId,
          ])
        ).rows,
        [],
      );
      assert.deepEqual(
        (await f.owner.query(`SELECT id FROM ${f.table('tf_retired_teams')} WHERE id = $1`, [f.teamId])).rows,
        [{ id: f.teamId }],
      );

      await assert.rejects(
        s.setGrants(w, a, input.id, { ...policy, expectedGrantsVersion: 2 }),
        error => error.code === 'conflict',
      );
      assert.deepEqual(await s.get(w, a, input.id), after);
      assert.deepEqual(await s.get(w, a, unaffected.id), untouched);
      assert.deepEqual(await g.setEnrollment(w, a.userId, f.otherTeamId, f.member.membershipId, { enrolled: true }), {
        ok: true,
      });
      assert.equal((await s.readIssue(w, f.member, f.request())).title, 'Issue title');
      assert.deepEqual(await s.creationContext(w, f.member), { teams: [{ id: f.otherTeamId, name: 'Other' }] });
    } finally {
      await f.close();
    }
  });
}
