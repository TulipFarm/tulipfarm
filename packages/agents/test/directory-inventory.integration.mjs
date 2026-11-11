import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { projectWorkspaceMemberProfile } from '@tulipfarm/tables/store';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { findMembers } from '../src/members.ts';
import { readWorkspaceInventory } from '../src/workspace-inventory.ts';

test('directory admission names respect visible directory facts and stay bounded', { timeout: 55000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const people = ['Admin person', 'Reader person', 'Restricted person'].map((name, index) => ({
    name,
    kind: 'human',
    userId: index ? randomUUID() : w.userId,
    membershipId: index ? randomUUID() : w.membershipId,
  }));
  for (const actor of people) {
    if (actor !== people[0])
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        actor.membershipId,
        actor.userId,
      ]);
    const [{ member_id: memberId }] = (
      await f.db.platform.query(`SELECT member_id FROM ${f.table('tf_workspace_member_accounts')} WHERE user_id=$1`, [
        actor.userId,
      ])
    ).rows;
    await f.runtime.transaction(w.id, commonCompatibility, tx =>
      projectWorkspaceMemberProfile(tx, {
        memberId,
        membershipId: actor.membershipId,
        profile: {
          id: actor.userId,
          revision: '1',
          name: actor.name,
          email: `${actor.userId}@example.test`,
          image: null,
        },
      }),
    );
  }
  const teamId = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Operations')`, [teamId]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
    people[1].membershipId,
    teamId,
  ]);
  const elapsed = [];
  let names;
  const human = ({ kind, userId, membershipId }) => ({ kind, userId, membershipId });
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    names = (await readWorkspaceInventory(f.runtime, w.id, human(people[0]))).inventory.directoryNames;
    elapsed.push(performance.now() - start);
  }
  t.diagnostic(`Inventory fixture latency: ${elapsed.map(ms => ms.toFixed(2)).join(', ')} ms`);
  assert.deepEqual(names?.members.toSorted(), people.map(actor => actor.name).toSorted());
  assert.deepEqual(names.teams.toSorted(), ['Operations', 'Workspace admins']);
  for (const actor of people.slice(1)) {
    const result = await readWorkspaceInventory(f.runtime, w.id, human(actor));
    const visible = await f.runtime.transaction(w.id, commonCompatibility, tx => findMembers(tx, human(actor)));
    assert.deepEqual(
      result.inventory.directoryNames.members.toSorted(),
      visible.members.map(person => person.name).toSorted(),
    );
    assert.deepEqual(result.inventory.directoryNames.teams.toSorted(), visible.teams.map(team => team.name).toSorted());
    assert.ok(visible.teams.some(team => team.people === 'not-visible'));
    const serialized = JSON.stringify(result.inventory.directoryNames);
    assert.doesNotMatch(serialized, /@example\.test|membershipId|teamId|peopleCount|manager/);
    for (const person of people)
      assert.ok(!serialized.includes(person.membershipId) && !serialized.includes(person.userId));
  }
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_teams')}(id,name) SELECT gen_random_uuid(),'Extra '||i FROM generate_series(1,101) i`,
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) SELECT gen_random_uuid(),gen_random_uuid()::text,'member' FROM generate_series(1,101)`,
  );
  assert.deepEqual((await readWorkspaceInventory(f.runtime, w.id, human(people[0]))).inventory.directoryNames, {
    members: [],
    teams: [],
  });
});
