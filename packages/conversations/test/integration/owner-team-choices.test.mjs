import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { ownerTeamChoices } from '../../src/runtime.ts';
import { presentChoiceSchema } from '../../src/request-contracts.ts';
import { conversationFixture } from '../fixture.mjs';

test('owner team choices list real teams, Everyone first, with no model-written names', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace;
    const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const choices = await f.runtime.transaction(w.id, commonCompatibility, tx => ownerTeamChoices(tx, actor));
    const real = (await f.db.platform.query(`SELECT id, name FROM ${f.table('tf_teams')}`)).rows;
    assert.deepEqual(choices[0], { id: choices[0].id, label: 'Everyone', recommended: true });
    assert.equal(choices.length, real.length);
    assert.ok(choices.every(choice => real.some(team => team.id === choice.id)));
    assert.ok(choices.some(choice => choice.label === 'Admin'));
    assert.ok(!choices.some(choice => choice.label.startsWith('_')));
  } finally {
    await f.close();
  }
});

test('a choice names either its options or the server list, never both', () => {
  const base = { tool: 'present.choice', prompt: 'Which team?' };
  const two = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  assert.ok(presentChoiceSchema.safeParse({ ...base, from: 'owner-teams' }).success);
  assert.ok(presentChoiceSchema.safeParse({ ...base, choices: two }).success);
  assert.ok(!presentChoiceSchema.safeParse({ ...base, from: 'owner-teams', choices: two }).success);
  assert.ok(!presentChoiceSchema.safeParse(base).success);
});
